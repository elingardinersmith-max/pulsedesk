// api/scan.js
// Master scan endpoint — fetches from all sources, deduplicates, scores, returns unified story list

import { jsonResponse, errorResponse, corsHeaders } from '../lib/scoring.js';

export const config = { runtime: 'edge' };

const BASE = (req) => {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
};

async function fetchSource(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { stories: [], error: `HTTP ${res.status}` };
    const data = await res.json();
    return { stories: data.stories || [], source: data.source, count: data.count };
  } catch (e) {
    return { stories: [], error: e.message };
  }
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: corsHeaders() });

  try {
    const { searchParams } = new URL(req.url);
    const entitiesParam = searchParams.get('entities') || '[]';
    const highImportanceParam = searchParams.get('highImportance') || '[]';
    const sourcesParam = searchParams.get('sources') || 'newsapi,gnews,reddit,twitter';
    const sources = sourcesParam.split(',');

    const base = BASE(req);
    const entityQ = `entities=${encodeURIComponent(entitiesParam)}&highImportance=${encodeURIComponent(highImportanceParam)}`;

    // Fetch all enabled sources in parallel
    const fetches = [];
    if (sources.includes('newsapi')) fetches.push(fetchSource(`${base}/api/sources/newsapi?${entityQ}`));
    if (sources.includes('gnews')) fetches.push(fetchSource(`${base}/api/sources/gnews?${entityQ}`));
    if (sources.includes('reddit')) fetches.push(fetchSource(`${base}/api/sources/reddit?${entityQ}`));
    if (sources.includes('twitter')) fetches.push(fetchSource(`${base}/api/sources/twitter?${entityQ}`));

    const results = await Promise.allSettled(fetches);
    const allStories = [];
    const sourceStats = {};

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { stories, source, error } = result.value;
        allStories.push(...stories);
        if (source) sourceStats[source] = { count: stories.length, error: error || null };
      }
    }

    // Deduplicate by URL and title similarity
    const seen = new Set();
    const deduped = allStories.filter(story => {
      const key = story.url || story.title?.slice(0, 50);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Sort: P1 first, then by score desc, then by publishedAt desc
    deduped.sort((a, b) => {
      const pMap = { P1: 3, P2: 2, P3: 1 };
      const pd = (pMap[b.priority] || 0) - (pMap[a.priority] || 0);
      if (pd !== 0) return pd;
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.publishedAt) - new Date(a.publishedAt);
    });

    return jsonResponse({
      scannedAt: new Date().toISOString(),
      totalStories: deduped.length,
      sourceStats,
      stories: deduped
    });

  } catch (err) {
    return errorResponse(err.message);
  }
}
