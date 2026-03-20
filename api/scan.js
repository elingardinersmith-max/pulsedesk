// api/scan.js — calls source functions directly (no internal HTTP hops)
// stays well within Vercel free plan 10s limit

import { jsonResponse, errorResponse, corsHeaders } from '../lib/scoring.js';
import { fetchNewsAPI, fetchGNews, fetchReddit, fetchTwitter } from '../lib/sources.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: corsHeaders() });

  try {
    const { searchParams } = new URL(req.url);
    const entities = JSON.parse(searchParams.get('entities') || '[]');
    const highImportance = JSON.parse(searchParams.get('highImportance') || '[]');
    const sourcesParam = searchParams.get('sources') || 'newsapi,gnews';
    const sources = sourcesParam.split(',');

    // Run all enabled sources in parallel with individual timeouts inside each fn
    const fetches = [];
    if (sources.includes('newsapi')) fetches.push(fetchNewsAPI(entities, highImportance));
    if (sources.includes('gnews'))   fetches.push(fetchGNews(entities, highImportance));
    if (sources.includes('reddit'))  fetches.push(fetchReddit(entities, highImportance));
    if (sources.includes('twitter')) fetches.push(fetchTwitter(entities, highImportance));

    const results = await Promise.allSettled(fetches);

    const allStories = [];
    const sourceStats = {};

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { stories = [], source, error } = result.value;
        allStories.push(...stories);
        if (source) sourceStats[source] = { count: stories.length, error: error || null };
      }
    }

    // Deduplicate by URL
    const seen = new Set();
    const deduped = allStories.filter(story => {
      const key = story.url || story.title?.slice(0, 60);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Sort: P1 first, then score desc, then date desc
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
