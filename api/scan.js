// api/scan.js
// Optimised for Vercel free plan (10s limit)

import { jsonResponse, errorResponse, corsHeaders } from '../lib/scoring.js';

export const config = { runtime: 'nodejs' };

const BASE = (req) => {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
};

async function fetchSource(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { stories: [], error: `HTTP ${res.status}` };
    const data = await res.json();
    return { stories: data.stories || [], source: data.source, count: data.count };
  } catch (e) {
    clearTimeout(timer);
    return { stories: [], error: e.name === 'AbortError' ? 'timeout' : e.message };
  }
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: corsHeaders() });

  try {
    const { searchParams } = new URL(req.url);
    const entitiesParam = searchParams.get('entities') || '[]';
    const highImportanceParam = searchParams.get('highImportance') || '[]';
    const sourcesParam = searchParams.get('sources') || 'newsapi,gnews';
    const sources = sourcesParam.split(',');

    const base = BASE(req);
    const entityQ = `entities=${encodeURIComponent(entitiesParam)}&highImportance=${encodeURIComponent(highImportanceParam)}`;

    const fetches = [];
    if (sources.includes('newsapi')) fetches.push(fetchSource(`${base}/api/sources/newsapi?${entityQ}`, 4000));
    if (sources.includes('gnews'))   fetches.push(fetchSource(`${base}/api/sources/gnews?${entityQ}`, 4000));
    if (sources.includes('reddit'))  fetches.push(fetchSource(`${base}/api/sources/reddit?${entityQ}`, 4000));
    if (sources.includes('twitter')) fetches.push(fetchSource(`${base}/api/sources/twitter?${entityQ}`, 4000));

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

    const seen = new Set();
    const deduped = allStories.filter(story => {
      const key = story.url || story.title?.slice(0, 50);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

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
