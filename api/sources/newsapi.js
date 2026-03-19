// api/sources/newsapi.js
// Fetches stories from NewsAPI.org for tracked entities

import { quickSentiment, estimateReach, scoreStory, findEntities, jsonResponse, errorResponse } from '../../lib/scoring.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });

  try {
    const { searchParams } = new URL(req.url);
    const query = searchParams.get('q') || '';
    const entities = JSON.parse(searchParams.get('entities') || '[]');
    const highImportance = JSON.parse(searchParams.get('highImportance') || '[]');
    const pageSize = parseInt(searchParams.get('pageSize') || '20');

    const apiKey = process.env.NEWSAPI_KEY;
    if (!apiKey) return errorResponse('NEWSAPI_KEY not configured', 503);

    // Build query — combine entity names with OR
    const entityQuery = entities.length > 0
      ? entities.map(e => `"${e.name}"`).join(' OR ')
      : query;

    const url = new URL('https://newsapi.org/v2/everything');
    url.searchParams.set('q', entityQuery);
    url.searchParams.set('language', 'en');
    url.searchParams.set('sortBy', 'publishedAt');
    url.searchParams.set('pageSize', String(Math.min(pageSize, 100)));
    url.searchParams.set('apiKey', apiKey);

    const res = await fetch(url.toString());
    if (!res.ok) {
      const err = await res.json();
      return errorResponse(`NewsAPI error: ${err.message || res.status}`, res.status);
    }

    const data = await res.json();
    if (data.status !== 'ok') return errorResponse(data.message || 'NewsAPI returned error', 400);

    // Normalise articles
    const stories = (data.articles || []).map(article => {
      const fullText = `${article.title} ${article.description || ''} ${article.content || ''}`;
      const sentiment = quickSentiment(fullText);
      const reach = estimateReach(article.url);
      const matched = findEntities(fullText, entities);
      const { priority, score, reasons } = scoreStory({
        title: article.title,
        content: article.description,
        url: article.url,
        sentiment,
        reach,
        trackedEntities: matched,
        highImportanceEntities: highImportance
      });

      return {
        id: `newsapi-${Buffer.from(article.url).toString('base64').slice(0, 12)}`,
        source: 'newsapi',
        sourceName: article.source?.name || 'News',
        title: article.title,
        description: article.description,
        url: article.url,
        imageUrl: article.urlToImage,
        publishedAt: article.publishedAt,
        author: article.author,
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

    return jsonResponse({
      source: 'newsapi',
      count: stories.length,
      stories
    });

  } catch (err) {
    return errorResponse(err.message);
  }
}
