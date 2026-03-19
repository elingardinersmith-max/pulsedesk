// lib/sources.js
// Data source integrations: NewsAPI, Google News RSS, Reddit, Nitter RSS, Disqus, Playwright

import axios from 'axios';
import RSSParser from 'rss-parser';
import * as cheerio from 'cheerio';

const rss = new RSSParser({
  timeout: 10000,
  headers: { 'User-Agent': 'PulseDesk/1.0 MediaMonitor' }
});

// ─── NEWSAPI.ORG ──────────────────────────────────────────────────────────────

export async function fetchNewsAPI(entityName, apiKey) {
  if (!apiKey) return [];
  try {
    const res = await axios.get('https://newsapi.org/v2/everything', {
      params: {
        q: `"${entityName}"`,
        language: 'en',
        sortBy: 'publishedAt',
        pageSize: 10,
        from: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      },
      headers: { 'X-Api-Key': apiKey },
      timeout: 8000,
    });

    return (res.data.articles || []).map(a => ({
      title: a.title,
      url: a.url,
      source: a.source?.name || 'NewsAPI',
      publishedAt: a.publishedAt,
      summary: a.description || '',
      imageUrl: a.urlToImage,
      reach: estimateReach(a.source?.name),
      sourceType: 'newsapi',
      entityMention: entityName,
    }));
  } catch (e) {
    console.error(`NewsAPI error for "${entityName}":`, e.message);
    return [];
  }
}

// ─── GOOGLE NEWS RSS ──────────────────────────────────────────────────────────

export async function fetchGoogleNews(entityName) {
  try {
    const query = encodeURIComponent(`"${entityName}"`);
    const url = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
    const feed = await rss.parseURL(url);

    return (feed.items || []).slice(0, 10).map(item => ({
      title: item.title,
      url: item.link,
      source: item.source?.name || extractSourceFromGoogleNews(item.title),
      publishedAt: item.pubDate || new Date().toISOString(),
      summary: cheerio.load(item.content || item.contentSnippet || '')('*').text().slice(0, 300),
      reach: estimateReach(item.source?.name),
      sourceType: 'google_news',
      entityMention: entityName,
    }));
  } catch (e) {
    console.error(`Google News error for "${entityName}":`, e.message);
    return [];
  }
}

function extractSourceFromGoogleNews(title) {
  // Google News titles often end with " - Source Name"
  const match = title?.match(/\s[-–]\s([^-–]+)$/);
  return match ? match[1].trim() : 'Google News';
}

// ─── REDDIT ───────────────────────────────────────────────────────────────────

export async function fetchReddit(entityName, { clientId, clientSecret, userAgent = 'PulseDesk/1.0' } = {}) {
  // Use public Reddit JSON API (no auth needed for read-only)
  try {
    const query = encodeURIComponent(entityName);
    const res = await axios.get(`https://www.reddit.com/search.json`, {
      params: { q: query, sort: 'new', limit: 10, t: 'day' },
      headers: { 'User-Agent': userAgent },
      timeout: 8000,
    });

    const posts = res.data?.data?.children || [];
    return posts.map(p => {
      const post = p.data;
      return {
        title: post.title,
        url: `https://reddit.com${post.permalink}`,
        source: `r/${post.subreddit}`,
        publishedAt: new Date(post.created_utc * 1000).toISOString(),
        summary: post.selftext?.slice(0, 300) || '',
        reach: Math.max(post.score * 50, post.upvote_ratio * 10000),
        commentCount: post.num_comments,
        score: post.score,
        upvoteRatio: post.upvote_ratio,
        subreddit: post.subreddit,
        redditId: post.id,
        sourceType: 'reddit',
        entityMention: entityName,
      };
    });
  } catch (e) {
    console.error(`Reddit error for "${entityName}":`, e.message);
    return [];
  }
}

export async function fetchRedditComments(redditId, subreddit) {
  try {
    const res = await axios.get(
      `https://www.reddit.com/r/${subreddit}/comments/${redditId}.json`,
      { headers: { 'User-Agent': 'PulseDesk/1.0' }, timeout: 8000 }
    );
    const comments = res.data?.[1]?.data?.children || [];
    return comments
      .filter(c => c.kind === 't1')
      .map(c => ({
        id: c.data.id,
        author: c.data.author,
        body: c.data.body,
        score: c.data.score,
        authorKarma: null, // would need separate call
        platform: 'reddit',
        createdAt: new Date(c.data.created_utc * 1000).toISOString(),
      }));
  } catch (e) {
    console.error('Reddit comments error:', e.message);
    return [];
  }
}

// ─── NITTER RSS (Twitter fallback) ───────────────────────────────────────────

const NITTER_INSTANCES = [
  'https://nitter.net',
  'https://nitter.privacydev.net',
  'https://nitter.poast.org',
];

export async function fetchNitterSearch(entityName) {
  for (const instance of NITTER_INSTANCES) {
    try {
      const query = encodeURIComponent(entityName);
      const url = `${instance}/search/rss?q=${query}&f=tweets`;
      const feed = await rss.parseURL(url);

      return (feed.items || []).slice(0, 15).map(item => ({
        title: item.title,
        url: item.link?.replace(instance, 'https://twitter.com'),
        source: 'X / Twitter',
        publishedAt: item.pubDate || new Date().toISOString(),
        summary: item.contentSnippet || item.title,
        reach: extractFollowerCount(item.content) || 1000,
        sourceType: 'twitter_nitter',
        entityMention: entityName,
        author: extractNitterAuthor(item),
      }));
    } catch (e) {
      // Try next instance
      continue;
    }
  }
  console.warn(`Nitter unavailable for "${entityName}" — all instances failed`);
  return [];
}

function extractNitterAuthor(item) {
  const match = item.link?.match(/nitter\.[^/]+\/([^/]+)/);
  return match ? '@' + match[1] : null;
}

function extractFollowerCount(content) {
  // Nitter doesn't expose followers in RSS, return null
  return null;
}

// ─── DISQUS ───────────────────────────────────────────────────────────────────

export async function fetchDisqusComments(forumShortname, storyTitle, apiKey) {
  if (!apiKey) return [];
  try {
    // Search for threads matching story title
    const searchRes = await axios.get('https://disqus.com/api/3.0/threads/list.json', {
      params: {
        api_key: apiKey,
        forum: forumShortname,
        thread: `title:${storyTitle.slice(0, 100)}`,
        limit: 5,
      },
      timeout: 8000,
    });

    const threads = searchRes.data?.response || [];
    const allComments = [];

    for (const thread of threads.slice(0, 2)) {
      const commentsRes = await axios.get('https://disqus.com/api/3.0/posts/list.json', {
        params: {
          api_key: apiKey,
          thread: thread.id,
          limit: 50,
          order: 'desc',
        },
        timeout: 8000,
      });

      const posts = commentsRes.data?.response || [];
      for (const post of posts) {
        allComments.push({
          id: post.id,
          author: post.author?.name || 'Anonymous',
          authorFollowers: post.author?.followersCount || 0,
          body: post.raw_message || post.message,
          likes: post.likes,
          platform: 'disqus',
          forum: forumShortname,
          createdAt: post.createdAt,
        });
      }
    }
    return allComments;
  } catch (e) {
    console.error('Disqus error:', e.message);
    return [];
  }
}

// ─── PLAYWRIGHT — PAYWALL ACCESS ──────────────────────────────────────────────
// Note: Playwright requires @playwright/test and browser binaries.
// On Vercel, use the @sparticuz/chromium package for serverless.
// The scrapeWithCredentials function handles login + content extraction.

export async function scrapeWithCredentials(url, credential) {
  // Dynamic import — Playwright may not be available in all environments
  try {
    const chromium = await import('@sparticuz/chromium').then(m => m.default).catch(() => null);
    const { chromium: playwright } = await import('playwright-core');

    const browser = await playwright.launch({
      args: chromium ? chromium.args : [],
      executablePath: chromium ? await chromium.executablePath() : undefined,
      headless: true,
    });

    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' });

    try {
      // Navigate to login page
      const loginUrl = credential.loginUrl || new URL(url).origin + '/login';
      await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: 30000 });

      // Fill login form
      if (credential.usernameSelector && credential.passwordSelector) {
        await page.fill(credential.usernameSelector, credential.username);
        await page.fill(credential.passwordSelector, credential.password);
        await page.click(credential.submitSelector || 'button[type="submit"]');
        await page.waitForNavigation({ timeout: 15000 }).catch(() => {});
      }

      // Navigate to the article
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

      // Extract article content
      const content = await page.evaluate(() => {
        // Remove nav, ads, headers, footers
        const remove = document.querySelectorAll('nav, header, footer, .ad, .advertisement, script, style, [class*="paywall"], [class*="subscribe"]');
        remove.forEach(el => el.remove());

        // Get main content
        const article = document.querySelector('article, [role="main"], .article-body, .story-body, main');
        return {
          title: document.title,
          body: article?.innerText || document.body.innerText.slice(0, 3000),
          url: window.location.href,
        };
      });

      await browser.close();
      return content;
    } catch (e) {
      await browser.close();
      throw e;
    }
  } catch (e) {
    console.error('Playwright scrape error:', e.message);
    // Fallback: try direct fetch without login
    return await fetchDirect(url);
  }
}

async function fetchDirect(url) {
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PulseDesk/1.0)' },
      timeout: 10000,
    });
    const $ = cheerio.load(res.data);
    $('script, style, nav, header, footer, .ad').remove();
    return {
      title: $('title').text() || $('h1').first().text(),
      body: $('article, [role="main"], .article-body, main').text().slice(0, 3000) || $('body').text().slice(0, 3000),
      url,
    };
  } catch (e) {
    return { title: '', body: '', url };
  }
}

// ─── UTILITY ──────────────────────────────────────────────────────────────────

// Estimate reach based on publication name
export function estimateReach(sourceName) {
  const known = {
    'reuters': 2500000, 'bloomberg': 1800000, 'financial times': 1500000,
    'ft': 1500000, 'wall street journal': 2000000, 'wsj': 2000000,
    'new york times': 3000000, 'nyt': 3000000, 'guardian': 1200000,
    'bbc': 4000000, 'bbc news': 4000000, 'cnbc': 1000000,
    'techcrunch': 500000, 'the verge': 400000, 'wired': 350000,
    'business insider': 600000, 'forbes': 800000,
  };
  const lower = (sourceName || '').toLowerCase();
  for (const [key, val] of Object.entries(known)) {
    if (lower.includes(key)) return val;
  }
  // Default estimate for unknown sources
  return 50000;
}

// Deduplicate articles by URL and similar titles
export function deduplicateStories(stories) {
  const seen = new Set();
  const result = [];
  for (const story of stories) {
    const key = story.url || story.title?.slice(0, 80);
    if (key && !seen.has(key)) {
      seen.add(key);
      result.push(story);
    }
  }
  return result;
}
