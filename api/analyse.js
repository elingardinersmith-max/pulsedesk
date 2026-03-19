// api/analyse.js
// Claude-powered analysis: story scoring, comment sentiment, digest generation

import { jsonResponse, errorResponse, corsHeaders } from '../lib/scoring.js';

export const config = { runtime: 'nodejs' };
async function callClaude(messages, system, maxTokens = 800) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system,
      messages
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.content?.[0]?.text || '';
}

// ── Analysis modes ────────────────────────────────────────────────────

async function analyseStory(story, entities) {
  const system = `You are a communications intelligence analyst for PulseDesk. You analyse news stories for a communications team that monitors media on behalf of organisations. Be concise, direct, and actionable. Always respond in valid JSON.`;

  const prompt = `Analyse this story for a communications team:

Title: ${story.title}
Source: ${story.sourceName || story.source}
URL: ${story.url}
Reach: ~${story.reach?.toLocaleString() || 'unknown'} people
Quick sentiment score: ${story.sentiment?.toFixed(2) || 'unknown'} (scale: -1 negative to +1 positive)
Tracked entities mentioned: ${(story.entities || []).join(', ') || 'none detected'}
Description: ${story.description || 'n/a'}

Respond with JSON only (no markdown):
{
  "sentiment": <number -1 to 1>,
  "sentimentLabel": "positive|negative|neutral|mixed",
  "riskLevel": "critical|high|medium|low",
  "summary": "<2 sentence summary>",
  "keyRisk": "<main risk or opportunity in 1 sentence>",
  "recommendedAction": "<what the comms team should do, 2-3 sentences>",
  "suggestedTone": "<tone for any response>",
  "themes": ["<theme1>", "<theme2>", "<theme3>"],
  "urgencyWindow": "<e.g. 'respond within 2 hours' or 'monitor only'>"
}`;

  const text = await callClaude(
    [{ role: 'user', content: prompt }],
    system,
    600
  );

  try {
    return JSON.parse(text);
  } catch {
    // Try to extract JSON if wrapped in markdown
    const match = text.match(/\{[\s\S]+\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Claude returned non-JSON response');
  }
}

async function analyseComments(comments, storyTitle) {
  const system = `You are a comment analysis AI for a media monitoring platform. Analyse comment sentiment, extract themes, and identify influencers. Respond in valid JSON only.`;

  const sample = comments.slice(0, 40).map(c => `[${c.sentiment > 0.1 ? 'POS' : c.sentiment < -0.1 ? 'NEG' : 'NEU'}] ${c.author}: ${c.text?.slice(0, 150)}`).join('\n');

  const prompt = `Analyse these ${comments.length} comments on the story "${storyTitle}":

${sample}

Respond with JSON only:
{
  "overallSentiment": <number -1 to 1>,
  "sentimentBreakdown": { "positive": <pct>, "neutral": <pct>, "negative": <pct> },
  "dominantNarrative": "<what most people think, 1 sentence>",
  "themes": [
    { "name": "<theme>", "sentiment": "positive|negative|neutral", "percentage": <0-100>, "exampleComment": "<quote>" }
  ],
  "hostileCommentCount": <number>,
  "narrativeRisks": ["<risk1>", "<risk2>"],
  "recommendations": "<what the team should address, 2 sentences>"
}`;

  const text = await callClaude([{ role: 'user', content: prompt }], system, 800);
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]+\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Claude returned non-JSON response');
  }
}

async function analyseInfluencer(handle, platform, followers, recentPosts, context) {
  const system = `You are a communications analyst specialising in influencer engagement strategy. Be direct and tactical. Respond in valid JSON only.`;

  const prompt = `Generate an influencer engagement brief:

Handle: ${handle}
Platform: ${platform}
Followers/Reach: ${followers?.toLocaleString() || 'unknown'}
Context: ${context}
Recent posts/comments: ${recentPosts?.join('\n') || 'not available'}

Respond with JSON only:
{
  "audienceProfile": "<who follows this account, 1 sentence>",
  "riskLevel": "critical|high|medium|low",
  "riskRationale": "<why they matter, 1 sentence>",
  "engagementStrategy": "engage_publicly|respond_privately|monitor_only|do_not_engage",
  "strategyRationale": "<why this approach, 2 sentences>",
  "suggestedTone": "<tone if engaging>",
  "talkingPoints": ["<point1>", "<point2>", "<point3>"],
  "avoidTopics": ["<topic1>", "<topic2>"]
}`;

  const text = await callClaude([{ role: 'user', content: prompt }], system, 600);
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]+\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Non-JSON response');
  }
}

async function generateDigest(stories, teamStats, commentThemes, dateStr) {
  const system = `You are PulseDesk AI, a media intelligence system. Generate professional, concise briefings for senior communications teams. Be analytical, not generic. Respond in valid JSON only.`;

  const storyList = stories.slice(0, 15).map(s =>
    `[${s.priority}] "${s.title}" — ${s.sourceName}, reach ~${s.reach?.toLocaleString()}, sentiment ${s.sentiment?.toFixed(2)}`
  ).join('\n');

  const prompt = `Generate a daily intelligence digest for ${dateStr}.

Stories monitored today: ${stories.length}
P1 Critical: ${stories.filter(s => s.priority === 'P1').length}
P2 Monitor: ${stories.filter(s => s.priority === 'P2').length}
P3 Routine: ${stories.filter(s => s.priority === 'P3').length}
Average sentiment: ${stories.length ? (stories.reduce((a, s) => a + (s.sentiment || 0), 0) / stories.length).toFixed(2) : 'n/a'}
Total estimated reach: ${stories.reduce((a, s) => a + (s.reach || 0), 0).toLocaleString()}

Top stories:
${storyList}

Team performance:
${JSON.stringify(teamStats || {})}

Top comment themes:
${(commentThemes || []).map(t => `- ${t.name}: ${t.percentage}%`).join('\n')}

Respond with JSON only:
{
  "executiveSummary": "<3-4 sentences, most important things happening today>",
  "topPriority": "<single most urgent issue and why>",
  "sentimentTrend": "improving|stable|deteriorating|mixed",
  "sentimentNarrative": "<1 sentence on overall sentiment direction>",
  "keyThemes": [{ "theme": "<name>", "significance": "<why it matters>" }],
  "teamHighlight": "<notable team achievement or concern>",
  "watchlist": ["<thing to watch 1>", "<thing to watch 2>"],
  "recommendedFocus": "<what the team should prioritise today, 2 sentences>"
}`;

  const text = await callClaude([{ role: 'user', content: prompt }], system, 1000);
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]+\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Non-JSON response');
  }
}

async function engagementAnalysis(beforeComments, afterComments, teamComments) {
  const system = `You are a media engagement analyst. Measure the effectiveness of communications team engagement. Respond in valid JSON only.`;

  const prompt = `Analyse engagement effectiveness before and after team intervention:

Before engagement (${beforeComments.length} comments):
Avg sentiment: ${beforeComments.length ? (beforeComments.reduce((a, c) => a + c.sentiment, 0) / beforeComments.length).toFixed(2) : 'n/a'}
Sample: ${beforeComments.slice(0, 5).map(c => `"${c.text?.slice(0, 100)}"`).join('; ')}

After engagement (${afterComments.length} comments):
Avg sentiment: ${afterComments.length ? (afterComments.reduce((a, c) => a + c.sentiment, 0) / afterComments.length).toFixed(2) : 'n/a'}
Sample: ${afterComments.slice(0, 5).map(c => `"${c.text?.slice(0, 100)}"`).join('; ')}

Team comments (${teamComments.length}):
${teamComments.slice(0, 3).map(c => `"${c.text?.slice(0, 150)}"`).join('\n')}

Respond with JSON only:
{
  "sentimentShift": <number, positive = improved>,
  "hostileVolumeChange": <percentage change, negative = reduction>,
  "positiveReplyRate": <percentage of positive replies to team>,
  "narrativeAlignment": <0-100, how much public themes mirror team messaging>,
  "effectivenessRating": "highly_effective|effective|partially_effective|ineffective",
  "keyWin": "<what worked best>",
  "keyGap": "<what still needs addressing>",
  "nextSteps": ["<action1>", "<action2>"]
}`;

  const text = await callClaude([{ role: 'user', content: prompt }], system, 700);
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]+\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Non-JSON response');
  }
}

// ── Route handler ─────────────────────────────────────────────────────

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: corsHeaders() });

  try {
    const { searchParams } = new URL(req.url);
    const mode = searchParams.get('mode');

    let body = {};
    if (req.method === 'POST') {
      body = await req.json().catch(() => ({}));
    }

    switch (mode) {
      case 'story':
        if (!body.story) return errorResponse('story required', 400);
        return jsonResponse(await analyseStory(body.story, body.entities || []));

      case 'comments':
        if (!body.comments) return errorResponse('comments required', 400);
        return jsonResponse(await analyseComments(body.comments, body.storyTitle || ''));

      case 'influencer':
        if (!body.handle) return errorResponse('handle required', 400);
        return jsonResponse(await analyseInfluencer(body.handle, body.platform, body.followers, body.recentPosts, body.context));

      case 'digest':
        return jsonResponse(await generateDigest(body.stories || [], body.teamStats, body.commentThemes, body.date || new Date().toLocaleDateString()));

      case 'engagement':
        return jsonResponse(await engagementAnalysis(body.before || [], body.after || [], body.team || []));

      case 'chat': {
        // General chat with context
        const system = `You are PulseDesk AI, a communications intelligence analyst. You help comms teams understand media coverage, sentiment, and develop response strategies. Be direct and actionable.`;
        const text = await callClaude(
          body.messages || [{ role: 'user', content: body.message || '' }],
          system,
          600
        );
        return jsonResponse({ response: text });
      }

      default:
        return errorResponse('Invalid mode. Use: story, comments, influencer, digest, engagement, chat', 400);
    }

  } catch (err) {
    return errorResponse(err.message);
  }
}
