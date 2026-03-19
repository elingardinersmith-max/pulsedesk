// api/sources/reddit.js
// Reddit search via public JSON API + OAuth for higher rate limits

import { quickSentiment, scoreStory, findEntities, jsonResponse, errorResponse } from '../../lib/scoring.js';

export const config = { runtime: 'edge' };

let _redditToken = null;
let _tokenExpiry = 0;

async function getRedditToken() {
  if (_redditToken && Date.now() < _tokenExpiry) return _redditToken;

  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;

  if (!clientId || !clientSecret) return null; // Fall back to public API

  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': process.env.REDDIT_USER_AGENT || 'PulseDesk/1.0'
    },
    body: 'grant_type=client_credentials'
  });

  if (!res.ok) return null;
  const data = await res.json();
  _redditToken = data.access_token;
  _tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return _redditToken;
}

async function searchReddit(query, token) {
  const baseUrl = token ? 'https://oauth.reddit.com' : 'https://www.reddit.com';
  const headers = {
    'User-Agent': process.env.REDDIT_USER_AGENT || 'PulseDesk/1.0',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {})
  };

  const url = `${baseUrl}/search.json?q=${encodeURIComponent(query)}&sort=new&limit=25&t=day&type=link`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Reddit search failed: ${res.status}`);
  const data = await res.json();
  return data?.data?.children?.map(c => c.data) || [];
}

async function searchSubreddit(subreddit, query, token) {
  const baseUrl = token ? 'https://oauth.reddit.com' : 'https://www.reddit.com';
  const headers = {
    'User-Agent': process.env.REDDIT_USER_AGENT || 'PulseDesk/1.0',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {})
  };

  const url = `${baseUrl}/r/${subreddit}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=new&limit=10&t=week`;
  const res = await fetch(url, { headers });
  if (!res.ok) return [];
  const data = await res.json();
  return data?.data?.children?.map(c => c.data) || [];
}

async function getPostComments(postId, subreddit, token) {
  const baseUrl = token ? 'https://oauth.reddit.com' : 'https://www.reddit.com';
  const headers = {
    'User-Agent': process.env.REDDIT_USER_AGENT || 'PulseDesk/1.0',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {})
  };

  try {
    const url = `${baseUrl}/r/${subreddit}/comments/${postId}.json?limit=100&depth=2`;
    const res = await fetch(url, { headers });
    if (!res.ok) return [];
    const data = await res.json();
    const comments = data?.[1]?.data?.children || [];
    return comments
      .filter(c => c.kind === 't1' && c.data?.body)
      .map(c => ({
        id: c.data.id,
        author: c.data.author,
        body: c.data.body,
        score: c.data.score,
        created: new Date(c.data.created_utc * 1000).toISOString(),
        sentiment: quickSentiment(c.data.body),
        platform: 'reddit'
      }));
  } catch { return []; }
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });

  try {
    const { searchParams } = new URL(req.url);
    const entities = JSON.parse(searchParams.get('entities') || '[]');
    const highImportance = JSON.parse(searchParams.get('highImportance') || '[]');
    const mode = searchParams.get('mode') || 'stories'; // 'stories' | 'comments'
    const postId = searchParams.get('postId');
    const subreddit = searchParams.get('subreddit');

    const token = await getRedditToken();

    // Comment mode — fetch comments for a specific post
    if (mode === 'comments' && postId && subreddit) {
      const comments = await getPostComments(postId, subreddit, token);
      return jsonResponse({ comments });
    }

    // Story search mode
    const allPosts = [];
    const FINANCE_SUBS = ['investing', 'stocks', 'business', 'finance', 'news', 'worldnews', 'technology'];

    for (const entity of entities.slice(0, 8)) { // limit to avoid rate limiting
      try {
        // Global Reddit search
        const posts = await searchReddit(entity.name, token);
        allPosts.push(...posts);

        // Also search key subreddits for companies/campaigns
        if (entity.type === 'company' || entity.importance >= 4) {
          for (const sub of FINANCE_SUBS.slice(0, 3)) {
            const subPosts = await searchSubreddit(sub, entity.name, token);
            allPosts.push(...subPosts);
          }
        }
      } catch (e) {
        console.error(`Reddit fetch failed for ${entity.name}:`, e.message);
      }
    }

    // Deduplicate
    const seen = new Set();
    const unique = allPosts.filter(p => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });

    const stories = unique
      .filter(p => p.title && p.score > 0) // filter out removed/deleted
      .map(post => {
        const fullText = `${post.title} ${post.selftext || ''} ${post.url || ''}`;
        const sentiment = quickSentiment(fullText);
        const reach = Math.max(post.score * 100, post.num_comments * 50, 1000); // estimate
        const matched = findEntities(fullText, entities);
        const { priority, score, reasons } = scoreStory({
          title: post.title,
          content: post.selftext,
          url: `https://reddit.com${post.permalink}`,
          sentiment,
          reach,
          trackedEntities: matched,
          highImportanceEntities: highImportance
        });

        return {
          id: `reddit-${post.id}`,
          source: 'reddit',
          sourceName: `r/${post.subreddit}`,
          title: post.title,
          description: post.selftext?.slice(0, 300) || null,
          url: `https://reddit.com${post.permalink}`,
          externalUrl: post.url !== `https://reddit.com${post.permalink}` ? post.url : null,
          publishedAt: new Date(post.created_utc * 1000).toISOString(),
          author: post.author,
          upvotes: post.score,
          sentiment,
          reach,
          entities: matched.map(e => e.name),
          priority,
          score,
          scoreReasons: reasons,
          paywalled: false,
          commentCount: post.num_comments,
          subreddit: post.subreddit,
          redditPostId: post.id,
        };
      });

    // Sort by score desc
    stories.sort((a, b) => b.score - a.score);

    return jsonResponse({ source: 'reddit', count: stories.length, stories });

  } catch (err) {
    return errorResponse(err.message);
  }
}
