// lib/scoring.js — Priority scoring engine for stories

// Positive / negative word lists for fast sentiment estimation
// (Claude API does deep analysis; this is a quick pre-score)
const NEG_WORDS = ['backlash','crisis','lawsuit','scandal','controversy','fraud',
  'criticism','resign','fired','collapse','failure','warning','danger','threat',
  'violation','breach','illegal','corrupt','bankrupt','loss','drop','fall',
  'plunge','slump','anger','outrage','furious','disgusting','terrible','horrible',
  'disaster','catastrophe','problem','issue','concern','worrying','alarming',
  'hostile','attack','blame','accused','investigation','probe','fine','penalty'];

const POS_WORDS = ['success','growth','profit','award','praise','innovation',
  'partnership','launch','record','milestone','achievement','positive','strong',
  'rise','surge','gain','win','lead','best','top','excellent','outstanding',
  'breakthrough','expansion','recovery','improvement','opportunity'];

export function quickSentiment(text) {
  const lower = text.toLowerCase();
  let score = 0;
  for (const w of NEG_WORDS) if (lower.includes(w)) score -= 0.15;
  for (const w of POS_WORDS) if (lower.includes(w)) score += 0.1;
  return Math.max(-1, Math.min(1, score));
}

// Reach estimator by source domain
const SOURCE_REACH = {
  'ft.com': 5000000, 'wsj.com': 4000000, 'reuters.com': 8000000,
  'bloomberg.com': 6000000, 'theguardian.com': 10000000, 'nytimes.com': 9000000,
  'bbc.co.uk': 15000000, 'bbc.com': 15000000, 'cnn.com': 7000000,
  'techcrunch.com': 2000000, 'theverge.com': 1500000, 'wired.com': 1000000,
  'forbes.com': 3000000, 'businessinsider.com': 2500000, 'axios.com': 1200000,
  'politico.com': 1000000, 'theatlantic.com': 800000, 'economist.com': 1500000,
  'reddit.com': 500000, 'twitter.com': 300000, 'x.com': 300000,
};

export function estimateReach(url) {
  try {
    const domain = new URL(url).hostname.replace('www.', '');
    return SOURCE_REACH[domain] || 100000;
  } catch { return 50000; }
}

/**
 * Score a story and return { priority, score, reasons }
 * priority: 'P1' | 'P2' | 'P3'
 * score: 0-100
 */
export function scoreStory({ title, content, url, sentiment, reach, trackedEntities, highImportanceEntities }) {
  let score = 0;
  const reasons = [];

  // 1. Reach score (0-30 pts)
  const reachScore = Math.min(30, Math.log10(Math.max(reach, 1000)) * 5);
  score += reachScore;

  // 2. Sentiment score — more negative = higher priority (0-30 pts)
  if (sentiment < -0.6) { score += 30; reasons.push('Strongly negative sentiment'); }
  else if (sentiment < -0.3) { score += 20; reasons.push('Negative sentiment'); }
  else if (sentiment < 0) { score += 10; reasons.push('Mildly negative sentiment'); }

  // 3. High-importance entity mentioned (+25 pts per entity, max 25)
  const highMentioned = highImportanceEntities.filter(e =>
    (title + ' ' + (content || '')).toLowerCase().includes(e.toLowerCase())
  );
  if (highMentioned.length > 0) {
    score += 25;
    reasons.push(`High-importance entity mentioned: ${highMentioned.join(', ')}`);
  }

  // 4. Virality keywords (+10 pts)
  const viralKw = ['breaking','exclusive','leaked','scandal','crisis','urgent','alert'];
  const titleLower = title.toLowerCase();
  if (viralKw.some(k => titleLower.includes(k))) {
    score += 10;
    reasons.push('Virality keywords detected');
  }

  // 5. Multiple tracked entities (+5 pts)
  if (trackedEntities.length > 1) {
    score += 5;
    reasons.push(`${trackedEntities.length} tracked entities mentioned`);
  }

  // Map score to priority
  let priority;
  if (score >= 55) priority = 'P1';
  else if (score >= 30) priority = 'P2';
  else priority = 'P3';

  return { priority, score: Math.round(score), reasons };
}

/**
 * Find which tracked entities are mentioned in text
 */
export function findEntities(text, entities) {
  const lower = text.toLowerCase();
  return entities.filter(e => lower.includes(e.name.toLowerCase()));
}

/**
 * CORS headers for all API responses
 */
export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };
}

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders()
  });
}

export function errorResponse(message, status = 500) {
  return jsonResponse({ error: message }, status);
}
