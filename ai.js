// lib/ai.js
// All Claude API calls: sentiment, theme extraction, comment analysis, digest generation

import Anthropic from 'anthropic';

function client(apiKey) {
  return new Anthropic({ apiKey });
}

// ─── SENTIMENT ANALYSIS ───────────────────────────────────────────────────────

export async function analyzeSentiment(text, apiKey) {
  try {
    const res = await client(apiKey).messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: `Analyze the sentiment of this text and respond with ONLY valid JSON, no other text:
{"score": <-1 to 1>, "label": "positive"|"negative"|"neutral", "confidence": <0-1>}

Text: "${text.slice(0, 500)}"`
      }]
    });
    return JSON.parse(res.content[0].text.trim());
  } catch (e) {
    // Simple fallback
    const lower = text.toLowerCase();
    const negWords = ['crisis', 'fail', 'collapse', 'resign', 'scandal', 'backlash', 'lawsuit', 'fraud', 'loss'];
    const posWords = ['growth', 'success', 'profit', 'innovative', 'award', 'record', 'expansion'];
    const negCount = negWords.filter(w => lower.includes(w)).length;
    const posCount = posWords.filter(w => lower.includes(w)).length;
    const score = Math.max(-1, Math.min(1, (posCount - negCount) * 0.2));
    return { score, label: score < -0.1 ? 'negative' : score > 0.1 ? 'positive' : 'neutral', confidence: 0.5 };
  }
}

// ─── COMMENT ANALYSIS ─────────────────────────────────────────────────────────

export async function analyzeComments(comments, storyTitle, apiKey) {
  if (!comments || comments.length === 0) {
    return { themes: [], sentiment: { positive: 0, negative: 0, neutral: 0 }, influencers: [], totalAnalyzed: 0 };
  }

  const commentTexts = comments
    .slice(0, 50) // Analyze up to 50 comments
    .map((c, i) => `[${i + 1}] ${c.author} (followers: ${c.authorFollowers || c.score || 0}): ${c.body?.slice(0, 200)}`)
    .join('\n');

  try {
    const res = await client(apiKey).messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Analyze these comments about "${storyTitle}". Respond with ONLY valid JSON, no other text:

{
  "themes": [
    {"name": "<theme>", "percentage": <0-100>, "sentiment": "positive"|"negative"|"neutral"}
  ],
  "sentiment": {
    "positive": <percentage>,
    "negative": <percentage>,
    "neutral": <percentage>
  },
  "influencers": [
    {"commentIndex": <1-based index>, "reason": "<why influential>", "sentiment": "positive"|"negative"|"neutral"}
  ],
  "hostileVolume": <0-100 percentage of hostile comments>,
  "keyNarratives": ["<narrative 1>", "<narrative 2>"]
}

Comments:
${commentTexts}`
      }]
    });

    const parsed = JSON.parse(res.content[0].text.trim());

    // Map influencer indices back to comment objects
    const enrichedInfluencers = (parsed.influencers || []).map(inf => {
      const comment = comments[inf.commentIndex - 1];
      return { ...inf, comment };
    });

    return { ...parsed, influencers: enrichedInfluencers, totalAnalyzed: comments.length };
  } catch (e) {
    console.error('Comment analysis error:', e.message);
    return { themes: [], sentiment: { positive: 33, negative: 34, neutral: 33 }, influencers: [], totalAnalyzed: comments.length };
  }
}

// ─── BEFORE/AFTER ENGAGEMENT ANALYSIS ────────────────────────────────────────

export async function analyzeEngagementImpact(beforeComments, afterComments, teamComments, apiKey) {
  try {
    const res = await client(apiKey).messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `Analyze the impact of team engagement on public discourse. Respond with ONLY valid JSON, no other text:

{
  "hostileReduction": <percentage reduction in hostile comments, can be negative if increased>,
  "positiveReplyRate": <percentage of positive replies to team comments>,
  "narrativeAlignment": <0-100 percentage of public themes matching team messaging>,
  "beforeThemes": ["theme1", "theme2", "theme3"],
  "afterThemes": ["theme1", "theme2", "theme3"],
  "beforeSentiment": {"positive": <pct>, "negative": <pct>, "neutral": <pct>},
  "afterSentiment": {"positive": <pct>, "negative": <pct>, "neutral": <pct>},
  "assessment": "<1-2 sentence assessment of engagement effectiveness>"
}

BEFORE ENGAGEMENT (${beforeComments.length} comments):
${beforeComments.slice(0, 20).map(c => c.body?.slice(0, 150)).join('\n')}

AFTER ENGAGEMENT (${afterComments.length} comments):
${afterComments.slice(0, 20).map(c => c.body?.slice(0, 150)).join('\n')}

TEAM COMMENTS (${teamComments.length}):
${teamComments.slice(0, 10).map(c => c.body?.slice(0, 150)).join('\n')}`
      }]
    });

    return JSON.parse(res.content[0].text.trim());
  } catch (e) {
    console.error('Engagement analysis error:', e.message);
    return null;
  }
}

// ─── DAILY DIGEST ─────────────────────────────────────────────────────────────

export async function generateDailyDigest(stories, entities, team, apiKey) {
  const p1 = stories.filter(s => s.priority === 'P1');
  const p2 = stories.filter(s => s.priority === 'P2');
  const avgSentiment = stories.length > 0
    ? (stories.reduce((sum, s) => sum + (s.sentiment || 0), 0) / stories.length).toFixed(2)
    : 0;
  const totalReach = stories.reduce((sum, s) => sum + (s.reach || 0), 0);
  const onShift = team.filter(t => t.active).length;

  const topStories = stories.slice(0, 5).map(s =>
    `- [${s.priority}] "${s.title}" (${s.source}, reach: ${(s.reach / 1000).toFixed(0)}K, sentiment: ${s.sentiment?.toFixed(2)})`
  ).join('\n');

  try {
    const res = await client(apiKey).messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: `You are PulseDesk, a media intelligence platform. Generate a professional daily briefing for a communications team.

DATA:
- Total stories today: ${stories.length} (P1: ${p1.length}, P2: ${p2.length}, P3: ${stories.length - p1.length - p2.length})
- Average sentiment: ${avgSentiment} (-1=very negative, +1=positive)
- Total estimated reach: ${(totalReach / 1000000).toFixed(1)}M
- Team members active: ${onShift}
- Tracked entities: ${entities.filter(e => e.active).map(e => e.name).join(', ')}

TOP STORIES:
${topStories}

Generate a briefing with these exact sections (use these exact headings):

EXECUTIVE SUMMARY
[2-3 paragraph overview of the media landscape today, key risks, and priority actions needed]

KEY STORIES
[Bullet-point breakdown of top 3-5 stories and why they matter]

SENTIMENT OVERVIEW
[1 paragraph on overall sentiment trends and what's driving them]

RECOMMENDED PRIORITIES
[3-5 specific, actionable items for the team today in priority order]

Keep the entire briefing under 500 words. Be direct, specific, and actionable.`
      }]
    });

    return {
      content: res.content[0].text,
      generatedAt: new Date().toISOString(),
      storyCount: stories.length,
      p1Count: p1.length,
      avgSentiment: parseFloat(avgSentiment),
      totalReach,
    };
  } catch (e) {
    console.error('Digest generation error:', e.message);
    return {
      content: 'Digest generation failed. Check your Anthropic API key in Settings.',
      generatedAt: new Date().toISOString(),
      error: e.message,
    };
  }
}

// ─── STORY SUMMARY ────────────────────────────────────────────────────────────

export async function summarizeStory(title, body, apiKey) {
  try {
    const res = await client(apiKey).messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Summarize this news story in 2-3 sentences for a communications team monitoring brief. Be factual and concise.

Title: ${title}
Body: ${body?.slice(0, 1000) || 'N/A'}

Respond with only the summary, no preamble.`
      }]
    });
    return res.content[0].text.trim();
  } catch (e) {
    return title;
  }
}
