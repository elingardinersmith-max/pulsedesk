// api/scan.js — all source logic self-contained, no external imports needed
// Stays within Vercel free plan 10s limit

export const config = { runtime: 'nodejs' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

const NEG = ['backlash','crisis','lawsuit','scandal','fraud','criticism','resign','fired','collapse','failure','warning','danger','threat','breach','illegal','corrupt','bankrupt','loss','drop','fall','plunge','anger','outrage','disaster','problem','alarming','attack','accused','investigation','fine','penalty'];
const POS = ['success','growth','profit','award','praise','innovation','partnership','launch','record','milestone','achievement','positive','strong','rise','surge','gain','win','lead','excellent','breakthrough','expansion','recovery','improvement'];

function getSentiment(text) {
  const l = text.toLowerCase();
  let s = 0;
  for (const w of NEG) if (l.includes(w)) s -= 0.15;
  for (const w of POS) if (l.includes(w)) s += 0.1;
  return Math.max(-1, Math.min(1, s));
}

const REACH_MAP = { 'ft.com':5000000,'wsj.com':4000000,'reuters.com':8000000,'bloomberg.com':6000000,'theguardian.com':10000000,'nytimes.com':9000000,'bbc.co.uk':15000000,'bbc.com':15000000,'cnn.com':7000000,'techcrunch.com':2000000,'forbes.com':3000000,'reddit.com':500000 };

function getReach(url) {
  try { const d = new URL(url).hostname.replace('www.',''); return REACH_MAP[d] || 100000; } catch { return 50000; }
}

function getScore(title, content, url, sent, reachVal, matchedEntities, highImportance) {
  let s = Math.min(30, Math.log10(Math.max(reachVal, 1000)) * 5);
  const reasons = [];
  if (sent < -0.6) { s += 30; reasons.push('Strongly negative'); }
  else if (sent < -0.3) { s += 20; reasons.push('Negative sentiment'); }
  else if (sent < 0) { s += 10; reasons.push('Mildly negative'); }
  const fullText = `${title} ${content || ''}`.toLowerCase();
  const hi = highImportance.filter(e => fullText.includes(e.toLowerCase()));
  if (hi.length) { s += 25; reasons.push(`High-importance: ${hi.join(', ')}`); }
  if (['breaking','exclusive','leaked','scandal','crisis','urgent'].some(k => title.toLowerCase().includes(k))) { s += 10; reasons.push('Virality keywords'); }
  if (matchedEntities.length > 1) { s += 5; reasons.push(`${matchedEntities.length} entities`); }
  return { priority: s >= 55 ? 'P1' : s >= 30 ? 'P2' : 'P3', score: Math.round(s), scoreReasons: reasons };
}

function matchEntities(text, entities) {
  const l = text.toLowerCase();
  return entities.filter(e => l.includes(e.name.toLowerCase()));
}

async function fromNewsAPI(entities, highImportance) {
  const key = process.env.NEWSAPI_KEY;
  if (!key) return { stories: [], error: 'NEWSAPI_KEY not set', source: 'newsapi' };
  try {
    const q = entities.length ? entities.slice(0,5).map(e=>`"${e.name}"`).join(' OR ') : 'news';
    const res = await fetch(`https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&language=en&sortBy=publishedAt&pageSize=10&apiKey=${key}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { stories: [], error: `NewsAPI ${res.status}`, source: 'newsapi' };
    const data = await res.json();
    if (data.status !== 'ok') return { stories: [], error: data.message, source: 'newsapi' };
    const stories = (data.articles || []).map(a => {
      const text = `${a.title} ${a.description || ''}`;
      const sent = getSentiment(text);
      const r = getReach(a.url);
      const matched = matchEntities(text, entities);
      const scoring = getScore(a.title, a.description, a.url, sent, r, matched, highImportance);
      return { id: `newsapi-${Buffer.from(a.url).toString('base64').slice(0,12)}`, source: 'newsapi', sourceName: a.source?.name || 'News', title: a.title, description: a.description, url: a.url, imageUrl: a.urlToImage, publishedAt: a.publishedAt, sentiment: sent, reach: r, entities: matched.map(e=>e.name), ...scoring, paywalled: false, commentCount: null };
    });
    return { stories, source: 'newsapi' };
  } catch(e) { return { stories: [], error: e.message, source: 'newsapi' }; }
}

async function fromGNews(entities, highImportance) {
  try {
    const queries = entities.length ? entities.slice(0,3).map(e=>e.name) : ['latest news'];
    const allItems = [];
    await Promise.allSettled(queries.map(async q => {
      try {
        const res = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(4000) });
        if (!res.ok) return;
        const xml = await res.text();
        for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
          const item = match[1];
          const title = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] || item.match(/<title>(.*?)<\/title>/)?.[1] || '';
          const link = item.match(/<link>(.*?)<\/link>/)?.[1] || '';
          const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
          const description = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/)?.[1] || '';
          const source = item.match(/<source[^>]*>(.*?)<\/source>/)?.[1] || 'Google News';
          if (title && link) allItems.push({ title, link, pubDate, description, source });
        }
      } catch {}
    }));
    const seen = new Set();
    const stories = allItems
      .filter(i => { if(seen.has(i.link)) return false; seen.add(i.link); return true; })
      .map(item => {
        const text = `${item.title} ${item.description || ''}`;
        const sent = getSentiment(text);
        const r = getReach(item.link);
        const matched = matchEntities(text, entities);
        const scoring = getScore(item.title, item.description, item.link, sent, r, matched, highImportance);
        return { id: `gnews-${Buffer.from(item.link).toString('base64').slice(0,12)}`, source: 'gnews', sourceName: item.source || 'Google News', title: item.title, description: item.description?.replace(/<[^>]+>/g,'').slice(0,200), url: item.link, publishedAt: (() => { try { return new Date(item.pubDate).toISOString(); } catch { return new Date().toISOString(); } })(), sentiment: sent, reach: r, entities: matched.map(e=>e.name), ...scoring, paywalled: false, commentCount: null };
      });
    return { stories, source: 'gnews' };
  } catch(e) { return { stories: [], error: e.message, source: 'gnews' }; }
}

async function fromReddit(entities, highImportance) {
  try {
    const allPosts = [];
    const clientId = process.env.REDDIT_CLIENT_ID;
    const clientSecret = process.env.REDDIT_CLIENT_SECRET;
    let token = null;
    if (clientId && clientSecret) {
      try {
        const r = await fetch('https://www.reddit.com/api/v1/access_token', { method:'POST', headers:{ 'Authorization':`Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, 'Content-Type':'application/x-www-form-urlencoded', 'User-Agent':'PulseDesk/1.0' }, body:'grant_type=client_credentials', signal: AbortSignal.timeout(3000) });
        if (r.ok) { const d = await r.json(); token = d.access_token; }
      } catch {}
    }
    const base = token ? 'https://oauth.reddit.com' : 'https://www.reddit.com';
    const headers = { 'User-Agent':'PulseDesk/1.0', ...(token ? { Authorization:`Bearer ${token}` } : {}) };
    await Promise.allSettled(entities.slice(0,4).map(async entity => {
      try {
        const res = await fetch(`${base}/search.json?q=${encodeURIComponent(entity.name)}&sort=new&limit=10&t=day&type=link`, { headers, signal: AbortSignal.timeout(4000) });
        if (res.ok) { const d = await res.json(); allPosts.push(...(d?.data?.children?.map(c=>c.data)||[])); }
      } catch {}
    }));
    const seen = new Set();
    const stories = allPosts
      .filter(p => p.title && p.score > 0 && !seen.has(p.id) && seen.add(p.id))
      .map(post => {
        const text = `${post.title} ${post.selftext || ''}`;
        const sent = getSentiment(text);
        const r = Math.max(post.score * 100, post.num_comments * 50, 1000);
        const matched = matchEntities(text, entities);
        const scoring = getScore(post.title, post.selftext, `https://reddit.com${post.permalink}`, sent, r, matched, highImportance);
        return { id:`reddit-${post.id}`, source:'reddit', sourceName:`r/${post.subreddit}`, title:post.title, description:post.selftext?.slice(0,200)||null, url:`https://reddit.com${post.permalink}`, publishedAt:new Date(post.created_utc*1000).toISOString(), author:post.author, upvotes:post.score, sentiment:sent, reach:r, entities:matched.map(e=>e.name), ...scoring, paywalled:false, commentCount:post.num_comments, subreddit:post.subreddit, redditPostId:post.id };
      });
    return { stories, source: 'reddit' };
  } catch(e) { return { stories: [], error: e.message, source: 'reddit' }; }
}

async function fromTwitter(entities, highImportance) {
  const bearerToken = process.env.TWITTER_BEARER_TOKEN;
  const NITTER = ['https://nitter.net','https://nitter.it','https://nitter.nl'];
  try {
    const allItems = [];
    await Promise.allSettled(entities.slice(0,4).map(async entity => {
      try {
        if (bearerToken) {
          const url = `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(`"${entity.name}" -is:retweet lang:en`)}&max_results=10&tweet.fields=created_at`;
          const res = await fetch(url, { headers:{Authorization:`Bearer ${bearerToken}`}, signal:AbortSignal.timeout(4000) });
          if (res.ok) { const d = await res.json(); for(const t of(d.data||[])) allItems.push({title:t.text,link:`https://twitter.com/i/status/${t.id}`,pubDate:t.created_at}); }
        } else {
          for (const instance of NITTER) {
            try {
              const res = await fetch(`${instance}/search/rss?f=tweets&q=${encodeURIComponent(`"${entity.name}"`)}&lang=en`, { headers:{'User-Agent':'Mozilla/5.0'}, signal:AbortSignal.timeout(3000) });
              if (!res.ok) continue;
              const xml = await res.text();
              for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
                const item = match[1];
                const title = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/s)?.[1]?.replace(/<[^>]+>/g,'').trim()||'';
                const link = item.match(/<link>(.*?)<\/link>/)?.[1]||'';
                const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]||'';
                if(title) allItems.push({title,link,pubDate});
              }
              break;
            } catch { continue; }
          }
        }
      } catch {}
    }));
    const seen = new Set();
    const stories = allItems
      .filter(i => i.title && !seen.has(i.link) && seen.add(i.link))
      .map((item, idx) => {
        const sent = getSentiment(item.title);
        const matched = matchEntities(item.title, entities);
        const scoring = getScore(item.title, null, item.link, sent, 5000, matched, highImportance);
        return { id:`twitter-${idx}-${Date.now()}`, source:bearerToken?'twitter':'nitter', sourceName:bearerToken?'X / Twitter':'X (via Nitter)', title:item.title, description:null, url:item.link, publishedAt:item.pubDate?new Date(item.pubDate).toISOString():new Date().toISOString(), sentiment:sent, reach:5000, entities:matched.map(e=>e.name), ...scoring, paywalled:false, commentCount:null };
      });
    return { stories, source: bearerToken?'twitter':'nitter' };
  } catch(e) { return { stories: [], error: e.message, source: 'nitter' }; }
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS });
  try {
    const { searchParams } = new URL(req.url);
    const entities = JSON.parse(searchParams.get('entities') || '[]');
    const highImportance = JSON.parse(searchParams.get('highImportance') || '[]');
    const sources = (searchParams.get('sources') || 'newsapi,gnews').split(',');

    const fetches = [];
    if (sources.includes('newsapi')) fetches.push(fromNewsAPI(entities, highImportance));
    if (sources.includes('gnews'))   fetches.push(fromGNews(entities, highImportance));
    if (sources.includes('reddit'))  fetches.push(fromReddit(entities, highImportance));
    if (sources.includes('twitter')) fetches.push(fromTwitter(entities, highImportance));

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

    const seen = new Set();
    const deduped = allStories.filter(story => {
      const key = story.url || story.title?.slice(0, 60);
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

    return json({ scannedAt: new Date().toISOString(), totalStories: deduped.length, sourceStats, stories: deduped });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
