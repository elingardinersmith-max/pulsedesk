// api/sources/disqus.js
// Fetches and analyses Disqus comments for a given article URL or forum

import { quickSentiment, jsonResponse, errorResponse } from '../../lib/scoring.js';

export const config = { runtime: 'edge' };

const DISQUS_BASE = 'https://disqus.com/api/3.0';

async function disqusGet(endpoint, params, apiKey) {
  const url = new URL(`${DISQUS_BASE}/${endpoint}.json`);
  url.searchParams.set('api_key', apiKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Disqus API error: ${res.status}`);
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Disqus error code ${data.code}: ${data.response}`);
  return data.response;
}

// Find Disqus thread by article URL
async function findThread(articleUrl, apiKey) {
  try {
    const threads = await disqusGet('threads/list', {
      'link:exact': articleUrl,
      limit: 1
    }, apiKey);
    return threads?.[0] || null;
  } catch {
    // Try by identifier
    try {
      const thread = await disqusGet('threads/details', {
        thread: `link:${articleUrl}`
      }, apiKey);
      return thread;
    } catch { return null; }
  }
}

// Get comments for a thread
async function getComments(threadId, apiKey, limit = 100) {
  const comments = await disqusGet('posts/list', {
    thread: threadId,
    limit: Math.min(limit, 100),
    order: 'desc'
  }, apiKey);
  return comments || [];
}

// Get forum threads (for monitored publications)
async function getForumThreads(forumShortname, query, apiKey) {
  try {
    const threads = await disqusGet('threads/list', {
      forum: forumShortname,
      order: 'date',
      limit: 25
    }, apiKey);
    return threads || [];
  } catch { return []; }
}

function normaliseComment(post) {
  const text = post.raw_message || post.message || '';
  return {
    id: `disqus-${post.id}`,
    platform: 'disqus',
    author: post.author?.name || post.author?.username || 'Anonymous',
    authorFollowers: post.author?.reputation || 0,
    text,
    sentiment: quickSentiment(text),
    likes: post.likes || 0,
    dislikes: post.dislikes || 0,
    points: post.points || 0,
    createdAt: post.createdAt,
    parentId: post.parent || null,
    isHighInfluence: (post.likes || 0) > 50 || (post.author?.reputation || 0) > 100,
  };
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });

  try {
    const { searchParams } = new URL(req.url);
    const mode = searchParams.get('mode') || 'url'; // 'url' | 'forum'
    const articleUrl = searchParams.get('url');
    const forumShortname = searchParams.get('forum');
    const threadId = searchParams.get('threadId');

    const apiKey = process.env.DISQUS_API_KEY;
    if (!apiKey) return errorResponse('DISQUS_API_KEY not configured', 503);

    if (mode === 'url' && articleUrl) {
      // Fetch comments for a specific article
      const thread = await findThread(articleUrl, apiKey);
      if (!thread) {
        return jsonResponse({ comments: [], threadFound: false, message: 'No Disqus thread found for this URL' });
      }

      const rawComments = await getComments(thread.id, apiKey);
      const comments = rawComments.map(normaliseComment);

      // Aggregate stats
      const sentiments = comments.map(c => c.sentiment);
      const avgSentiment = sentiments.length > 0
        ? sentiments.reduce((a, b) => a + b, 0) / sentiments.length
        : 0;
      const positive = comments.filter(c => c.sentiment > 0.1).length;
      const negative = comments.filter(c => c.sentiment < -0.1).length;
      const neutral = comments.length - positive - negative;

      // Theme extraction (top keywords)
      const allText = comments.map(c => c.text).join(' ').toLowerCase();
      const words = allText.split(/\W+/).filter(w => w.length > 4);
      const freq = {};
      for (const w of words) freq[w] = (freq[w] || 0) + 1;
      const themes = Object.entries(freq)
        .filter(([w]) => !['that','this','with','from','have','they','their','about','would','could','should'].includes(w))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([word, count]) => ({ word, count, pct: Math.round(count / words.length * 100) }));

      return jsonResponse({
        threadFound: true,
        thread: { id: thread.id, title: thread.title, posts: thread.posts, link: thread.link },
        comments,
        stats: { total: comments.length, positive, negative, neutral, avgSentiment },
        themes,
        influencers: comments.filter(c => c.isHighInfluence).slice(0, 5)
      });
    }

    if (mode === 'forum' && forumShortname) {
      const threads = await getForumThreads(forumShortname, null, apiKey);
      return jsonResponse({ forum: forumShortname, threads });
    }

    if (mode === 'thread' && threadId) {
      const rawComments = await getComments(threadId, apiKey);
      return jsonResponse({ comments: rawComments.map(normaliseComment) });
    }

    return errorResponse('Invalid mode or missing parameters', 400);

  } catch (err) {
    return errorResponse(err.message);
  }
}
