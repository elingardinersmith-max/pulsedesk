// lib/sources.js — direct source fetching, no internal HTTP hops

import { quickSentiment, estimateReach, scoreStory, findEntities } from './scoring.js';

function parseRSSDate(str) {
  try { return new Date(str).toISOString(); } catch { return new Date().toISOString(); }
}

export async function fetchNewsAPI(entities, highImportance) {
  const apiKey = process.env.NEWSAPI_KEY;
  if (!apiKey) return { stories: [], error: 'NEWSAPI_KEY not set', source: 'newsapi' };
  try {
    const entityQuery = entities.length > 0 ? entities.slice(0,5).map(e=>`"${e.name}"`).join(' OR ') : 'news';
    const url = new URL('https://newsapi.org/v2/everything');
    url.searchParams.set('q', entityQuery);
    url.searchParams.set('language', 'en');
    url.searchParams.set('sortBy', 'publishedAt');
    url.searchParams.set('pageSize', '10');
    url.searchParams.set('apiKey', apiKey);
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { stories: [], error: `NewsAPI HTTP ${res.status}`, source: 'newsapi' };
    const data = await res.json();
    if (data.status !== 'ok') return { stories: [], error: data.message, source: 'newsapi' };
    const stories = (data.articles || []).map(article => {
      const fullText = `${article.title} ${article.description || ''}`;
      const sentiment = quickSentiment(fullText);
      const reach = estimateReach(article.url);
      const matched = findEntities(fullText, entities);
      const { priority, score, reasons } = scoreStory({ title: article.title, content: article.description, url: article.url, sentiment, reach, trackedEntities: matched, highImportanceEntities: highImportance });
      return { id: `newsapi-${Buffer.from(article.url).toString('base64').slice(0,12)}`, source: 'newsapi', sourceName: article.source?.name||'News', title: article.title, description: article.description, url: article.url, imageUrl: article.urlToImage, publishedAt: article.publishedAt, author: article.author, sentiment, reach, entities: matched.map(e=>e.name), priority, score, scoreReasons: reasons, paywalled: false, commentCount: null };
    });
    return { stories, source: 'newsapi' };
  } catch(e) { return { stories: [], error: e.message, source: 'newsapi' }; }
}

export async function fetchGNews(entities, highImportance) {
  try {
    const queries = entities.length > 0 ? entities.slice(0,3).map(e=>e.name) : ['latest news'];
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
    const unique = allItems.filter(i => { if(seen.has(i.link)) return false; seen.add(i.link); return true; });
    const stories = unique.map(item => {
      const fullText = `${item.title} ${item.description||''}`;
      const sentiment = quickSentiment(fullText);
      const reach = estimateReach(item.link);
      const matched = findEntities(fullText, entities);
      const { priority, score, reasons } = scoreStory({ title: item.title, content: item.description, url: item.link, sentiment, reach, trackedEntities: matched, highImportanceEntities: highImportance });
      return { id: `gnews-${Buffer.from(item.link).toString('base64').slice(0,12)}`, source: 'gnews', sourceName: item.source||'Google News', title: item.title, description: item.description?.replace(/<[^>]+>/g,'').slice(0,200), url: item.link, publishedAt: parseRSSDate(item.pubDate), sentiment, reach, entities: matched.map(e=>e.name), priority, score, scoreReasons: reasons, paywalled: false, commentCount: null };
    });
    return { stories, source: 'gnews' };
  } catch(e) { return { stories: [], error: e.message, source: 'gnews' }; }
}

export async function fetchReddit(entities, highImportance) {
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
    const headers = { 'User-Agent':'PulseDesk/1.0', ...(token?{Authorization:`Bearer ${token}`}:{}) };
    await Promise.allSettled(entities.slice(0,4).map(async entity => {
      try {
        const res = await fetch(`${base}/search.json?q=${encodeURIComponent(entity.name)}&sort=new&limit=10&t=day&type=link`, { headers, signal: AbortSignal.timeout(4000) });
        if (res.ok) { const d = await res.json(); allPosts.push(...(d?.data?.children?.map(c=>c.data)||[])); }
      } catch {}
    }));
    const seen = new Set();
    const stories = allPosts.filter(p=>p.title&&p.score>0&&!seen.has(p.id)&&seen.add(p.id)).map(post => {
      const fullText = `${post.title} ${post.selftext||''}`;
      const sentiment = quickSentiment(fullText);
      const reach = Math.max(post.score*100, post.num_comments*50, 1000);
      const matched = findEntities(fullText, entities);
      const { priority, score, reasons } = scoreStory({ title: post.title, content: post.selftext, url:`https://reddit.com${post.permalink}`, sentiment, reach, trackedEntities: matched, highImportanceEntities: highImportance });
      return { id:`reddit-${post.id}`, source:'reddit', sourceName:`r/${post.subreddit}`, title:post.title, description:post.selftext?.slice(0,200)||null, url:`https://reddit.com${post.permalink}`, publishedAt:new Date(post.created_utc*1000).toISOString(), author:post.author, upvotes:post.score, sentiment, reach, entities:matched.map(e=>e.name), priority, score, scoreReasons:reasons, paywalled:false, commentCount:post.num_comments, subreddit:post.subreddit, redditPostId:post.id };
    });
    return { stories, source: 'reddit' };
  } catch(e) { return { stories:[], error:e.message, source:'reddit' }; }
}

const NITTER = ['https://nitter.net','https://nitter.it','https://nitter.nl'];

export async function fetchTwitter(entities, highImportance) {
  try {
    const bearerToken = process.env.TWITTER_BEARER_TOKEN;
    const allItems = [];
    await Promise.allSettled(entities.slice(0,4).map(async entity => {
      try {
        if (bearerToken) {
          const url = new URL('https://api.twitter.com/2/tweets/search/recent');
          url.searchParams.set('query', `"${entity.name}" -is:retweet lang:en`);
          url.searchParams.set('max_results','10');
          url.searchParams.set('tweet.fields','created_at');
          const res = await fetch(url.toString(), { headers:{Authorization:`Bearer ${bearerToken}`}, signal:AbortSignal.timeout(4000) });
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
    const stories = allItems.filter(i=>i.title&&!seen.has(i.link)&&seen.add(i.link)).map((item,idx) => {
      const sentiment = quickSentiment(item.title);
      const matched = findEntities(item.title, entities);
      const { priority, score, reasons } = scoreStory({ title:item.title, content:null, url:item.link, sentiment, reach:5000, trackedEntities:matched, highImportanceEntities:highImportance });
      return { id:`twitter-${idx}-${Date.now()}`, source:bearerToken?'twitter':'nitter', sourceName:bearerToken?'X / Twitter':'X (via Nitter)', title:item.title, description:null, url:item.link, publishedAt:item.pubDate?new Date(item.pubDate).toISOString():new Date().toISOString(), sentiment, reach:5000, entities:matched.map(e=>e.name), priority, score, scoreReasons:reasons, paywalled:false, commentCount:null };
    });
    return { stories, source: bearerToken?'twitter':'nitter' };
  } catch(e) { return { stories:[], error:e.message, source:'nitter' }; }
}
