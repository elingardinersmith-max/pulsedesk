// api/sources/twitter.js
// Nitter RSS scraping for X/Twitter content (no API key needed)
// Falls back gracefully if Nitter instances are down

import { quickSentiment, scoreStory, findEntities, jsonResponse, errorResponse } from '../../lib/scoring.js';

export const config = { runtime: 'edge' };

// Public Nitter instances — rotated for reliability
const NITTER_INSTANCES = [
  'https://nitter.net',
  'https://nitter.it',
  'https://nitter.nl',
  'https://nitter.1d4.us',
  'https://nitter.kavin.rocks',
];

async function fetchNitterRSS(query, instance) {
  const url = `${instance}/search/rss?f=tweets&q=${encodeURIComponent(query)}&since_id=&max_position=&lang=en`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; PulseDesk/1.0; RSS Reader)',
      'Accept': 'application/rss+xml, application/xml, text/xml'
    },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

function parseNitterXML(xml) {
  const items = [];
  const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);

  for (const match of itemMatches) {
    const item = match[1];
    const title = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/s)?.[1]
      || item.match(/<title>(.*?)<\/title>/s)?.[1] || '';
    const link = item.match(/<link>(.*?)<\/link>/)?.[1] || '';
    const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
    const description = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/s)?.[1] || '';

    // Extract author from link (nitter.net/username/status/id)
    const authorMatch = link.match(/\/([^\/]+)\/status\//);
    const author = authorMatch?.[1] || 'unknown';

    // Clean HTML from description
    const cleanDesc = description.replace(/<[^>]+>/g, '').trim();

    if (title && link) {
      items.push({ title: cleanDesc || title, link, pubDate, author, rawDescription: description });
    }
  }

  return items;
}

// Try each Nitter instance until one works
async function fetchWithFallback(query) {
  for (const instance of NITTER_INSTANCES) {
    try {
      const xml = await fetchNitterRSS(query, instance);
      const items = parseNitterXML(xml);
      if (items.length > 0) return { items, instance };
    } catch (e) {
      console.warn(`Nitter instance ${instance} failed:`, e.message);
      continue;
    }
  }
  return { items: [], instance: null };
}

// Also fetch X/Twitter API if bearer token is set
async function fetchTwitterAPI(query, bearerToken) {
  const url = new URL('https://api.twitter.com/2/tweets/search/recent');
  url.searchParams.set('query', `${query} -is:retweet lang:en`);
  url.searchParams.set('max_results', '20');
  url.searchParams.set('tweet.fields', 'created_at,author_id,public_metrics,entities');
  url.searchParams.set('expansions', 'author_id');
  url.searchParams.set('user.fields', 'name,username,public_metrics');

  const res = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${bearerToken}` }
  });
  if (!res.ok) throw new Error(`Twitter API error: ${res.status}`);
  const data = await res.json();

  const users = {};
  for (const u of (data.includes?.users || [])) users[u.id] = u;

  return (data.data || []).map(tweet => {
    const user = users[tweet.author_id] || {};
    return {
      id: tweet.id,
      text: tweet.text,
      author: user.username || tweet.author_id,
      authorFollowers: user.public_metrics?.followers_count || 0,
      created: tweet.created_at,
      metrics: tweet.public_metrics,
      url: `https://twitter.com/${user.username}/status/${tweet.id}`
    };
  });
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });

  try {
    const { searchParams } = new URL(req.url);
    const entities = JSON.parse(searchParams.get('entities') || '[]');
    const highImportance = JSON.parse(searchParams.get('highImportance') || '[]');
    const bearerToken = process.env.TWITTER_BEARER_TOKEN;

    const allItems = [];

    for (const entity of entities.slice(0, 6)) {
      try {
        if (bearerToken) {
          // Use official API if key available
          const tweets = await fetchTwitterAPI(entity.name, bearerToken);
          allItems.push(...tweets.map(t => ({
            title: t.text,
            link: t.url,
            pubDate: t.created,
            author: `@${t.author}`,
            followers: t.authorFollowers,
            metrics: t.metrics,
            fromAPI: true
          })));
        } else {
          // Nitter RSS fallback
          const { items } = await fetchWithFallback(`"${entity.name}"`);
          allItems.push(...items);
        }
      } catch (e) {
        console.error(`Twitter/Nitter failed for ${entity.name}:`, e.message);
      }
    }

    // Deduplicate
    const seen = new Set();
    const unique = allItems.filter(i => {
      if (seen.has(i.link)) return false;
      seen.add(i.link);
      return true;
    });

    const stories = unique.map((item, idx) => {
      const fullText = item.title;
      const sentiment = quickSentiment(fullText);
      const followers = item.followers || 0;
      const reach = item.metrics
        ? (item.metrics.retweet_count * 500 + item.metrics.like_count * 50 + followers * 0.01)
        : Math.max(followers * 0.05, 1000);
      const matched = findEntities(fullText, entities);
      const { priority, score, reasons } = scoreStory({
        title: item.title,
        content: null,
        url: item.link,
        sentiment,
        reach,
        trackedEntities: matched,
        highImportanceEntities: highImportance
      });

      return {
        id: `twitter-${idx}-${Date.now()}`,
        source: bearerToken ? 'twitter' : 'nitter',
        sourceName: bearerToken ? 'X / Twitter' : 'X (via Nitter)',
        title: item.title,
        description: null,
        url: item.link,
        publishedAt: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
        author: item.author,
        sentiment,
        reach,
        entities: matched.map(e => e.name),
        priority,
        score,
        scoreReasons: reasons,
        paywalled: false,
        commentCount: null,
        metrics: item.metrics || null,
      };
    });

    return jsonResponse({
      source: bearerToken ? 'twitter' : 'nitter',
      usingNitter: !bearerToken,
      count: stories.length,
      stories
    });

  } catch (err) {
    return errorResponse(err.message);
  }
}
