// api/sources/gnews.js
// Google News RSS scraper — no API key required
// Also handles GNews API if key is provided

import { quickSentiment, estimateReach, scoreStory, findEntities, jsonResponse, errorResponse } from '../../lib/scoring.js';

export const config = { runtime: 'edge' };

function parseRSSDate(str) {
  try { return new Date(str).toISOString(); } catch { return new Date().toISOString(); }
}

// Parse Google News RSS XML
async function parseGoogleNewsRSS(query) {
  const encoded = encodeURIComponent(query);
  const rssUrl = `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`;

  const res = await fetch(rssUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PulseDesk/1.0)' }
  });
  if (!res.ok) throw new Error(`Google News RSS failed: ${res.status}`);

  const xml = await res.text();

  // Simple XML parser (edge-compatible, no DOM)
  const items = [];
  const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);

  for (const match of itemMatches) {
    const item = match[1];
    const title = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]
      || item.match(/<title>(.*?)<\/title>/)?.[1] || '';
    const link = item.match(/<link>(.*?)<\/link>/)?.[1]
      || item.match(/<link\s+href="(.*?)"/)?.[1] || '';
    const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
    const description = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/)?.[1]
      || item.match(/<description>(.*?)<\/description>/)?.[1] || '';
    const source = item.match(/<source[^>]*>(.*?)<\/source>/)?.[1] || 'Google News';

    // Google News links are redirect URLs — extract original
    const originalUrl = link.replace('https://news.google.com/rss/articles/', '')
      || link;

    if (title) items.push({ title, link: originalUrl || link, pubDate, description, source });
  }

  return items;
}

// GNews.io API (optional key)
async function fetchGNewsAPI(query, apiKey) {
  const url = new URL('https://gnews.io/api/v4/search');
  url.searchParams.set('q', query);
  url.searchParams.set('lang', 'en');
  url.searchParams.set('max', '10');
  url.searchParams.set('apikey', apiKey);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`GNews API error: ${res.status}`);
  const data = await res.json();
  return (data.articles || []).map(a => ({
    title: a.title,
    link: a.url,
    pubDate: a.publishedAt,
    description: a.description,
    source: a.source?.name || 'GNews'
  }));
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });

  try {
    const { searchParams } = new URL(req.url);
    const entities = JSON.parse(searchParams.get('entities') || '[]');
    const highImportance = JSON.parse(searchParams.get('highImportance') || '[]');

    const gnewsApiKey = process.env.GNEWS_API_KEY;
    const allItems = [];

    // Fetch for each entity (or combined query)
    const queries = entities.length > 0
      ? entities.slice(0, 5).map(e => e.name) // max 5 to avoid rate limits
      : [searchParams.get('q') || 'news'];

    for (const q of queries) {
      try {
        let items;
        if (gnewsApiKey) {
          items = await fetchGNewsAPI(q, gnewsApiKey);
        } else {
          items = await parseGoogleNewsRSS(q);
        }
        allItems.push(...items.map(i => ({ ...i, queryEntity: q })));
      } catch (e) {
        console.error(`Failed to fetch for "${q}":`, e.message);
      }
    }

    // Deduplicate by link
    const seen = new Set();
    const unique = allItems.filter(item => {
      if (seen.has(item.link)) return false;
      seen.add(item.link);
      return true;
    });

    // Normalise
    const stories = unique.map(item => {
      const fullText = `${item.title} ${item.description || ''}`;
      const sentiment = quickSentiment(fullText);
      const reach = estimateReach(item.link);
      const matched = findEntities(fullText, entities);
      const { priority, score, reasons } = scoreStory({
        title: item.title,
        content: item.description,
        url: item.link,
        sentiment,
        reach,
        trackedEntities: matched,
        highImportanceEntities: highImportance
      });

      return {
        id: `gnews-${Buffer.from(item.link).toString('base64').slice(0, 12)}`,
        source: 'gnews',
        sourceName: item.source || 'Google News',
        title: item.title,
        description: item.description,
        url: item.link,
        publishedAt: parseRSSDate(item.pubDate),
        sentiment,
        reach,
        entities: matched.map(e => e.name),
        priority,
        score,
        scoreReasons: reasons,
        paywalled: false,
        commentCount: null,
      };
    });

    return jsonResponse({ source: 'gnews', count: stories.length, stories });

  } catch (err) {
    return errorResponse(err.message);
  }
}
