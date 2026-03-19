// lib/scorer.js
// AI-powered priority scoring for stories

import Anthropic from 'anthropic';

export async function scoreStory(story, entities, apiKey) {
  // Rule-based pre-score (fast, no API call needed for clear cases)
  const ruleScore = ruleBasedScore(story, entities);
  if (ruleScore.confidence > 0.9) return ruleScore;

  // AI scoring for ambiguous cases
  try {
    const aiScore = await aiBasedScore(story, entities, apiKey);
    return aiScore;
  } catch (e) {
    console.error('AI scoring failed, using rule-based:', e.message);
    return ruleScore;
  }
}

function ruleBasedScore(story, entities) {
  let score = 0;
  let reasons = [];

  // Reach scoring
  if (story.reach >= 1000000) { score += 40; reasons.push('reach >1M'); }
  else if (story.reach >= 500000) { score += 30; reasons.push('reach >500K'); }
  else if (story.reach >= 100000) { score += 20; reasons.push('reach >100K'); }
  else if (story.reach >= 10000) { score += 10; reasons.push('reach >10K'); }

  // Sentiment scoring (negative = higher priority)
  if (story.sentiment <= -0.6) { score += 35; reasons.push('strongly negative sentiment'); }
  else if (story.sentiment <= -0.3) { score += 20; reasons.push('negative sentiment'); }
  else if (story.sentiment <= 0) { score += 5; reasons.push('mildly negative'); }

  // High-importance entity mentioned
  const highImportanceEntities = entities.filter(e => e.importance >= 4 && e.active);
  const mentionedHigh = highImportanceEntities.filter(e =>
    story.title.toLowerCase().includes(e.name.toLowerCase()) ||
    (story.body || '').toLowerCase().includes(e.name.toLowerCase())
  );
  if (mentionedHigh.length > 0) {
    score += 25 * mentionedHigh.length;
    reasons.push(`high-importance entity: ${mentionedHigh.map(e => e.name).join(', ')}`);
  }

  // Virality signals
  if (story.commentCount >= 500) { score += 15; reasons.push('viral comment volume'); }
  else if (story.commentCount >= 100) { score += 8; reasons.push('high comment volume'); }

  // Source tier
  const tier1Sources = ['reuters', 'bloomberg', 'financial times', 'ft.com', 'wsj', 'wall street journal', 'new york times', 'guardian', 'bbc'];
  const sourceLower = (story.source || '').toLowerCase();
  if (tier1Sources.some(s => sourceLower.includes(s))) { score += 10; reasons.push('tier-1 publication'); }

  // Map score to priority
  let priority, confidence;
  if (score >= 70) { priority = 'P1'; confidence = score >= 90 ? 0.95 : 0.8; }
  else if (score >= 35) { priority = 'P2'; confidence = 0.75; }
  else { priority = 'P3'; confidence = 0.85; }

  return { priority, score, reasons, confidence, method: 'rules' };
}

async function aiBasedScore(story, entities, apiKey) {
  const client = new Anthropic({ apiKey });

  const entityList = entities
    .filter(e => e.active)
    .map(e => `- ${e.name} (${e.type}, importance: ${e.importance}/5)`)
    .join('\n');

  const prompt = `You are a media intelligence analyst scoring news stories for priority.

TRACKED ENTITIES:
${entityList}

STORY TO SCORE:
Title: ${story.title}
Source: ${story.source}
Estimated reach: ${story.reach?.toLocaleString() || 'unknown'} people
Sentiment score: ${story.sentiment} (scale: -1=very negative, 0=neutral, +1=very positive)
Comment count: ${story.commentCount || 0}
Summary: ${story.summary || story.title}

SCORING CRITERIA:
- P1 Critical: Requires immediate team action. High reach (>500K) OR strongly negative sentiment (<-0.5) OR high-importance entity (importance 4-5) mentioned OR viral/accelerating
- P2 Monitor: Should be tracked and may need response. Moderate reach/sentiment or medium-importance entity
- P3 Routine: Low-risk, informational, or positive coverage

Respond with ONLY valid JSON, no other text:
{
  "priority": "P1" | "P2" | "P3",
  "score": <number 0-100>,
  "reasons": ["reason 1", "reason 2"],
  "recommendedAction": "<one sentence on what team should do>",
  "sentiment": <refined sentiment score -1 to 1>,
  "confidence": <0-1>
}`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = response.content[0].text.trim();
  const parsed = JSON.parse(text);
  return { ...parsed, method: 'ai' };
}

// Auto-assign story to on-shift team member
export function assignStory(team) {
  const now = new Date();
  const currentHour = now.getHours();
  const currentMin = now.getMinutes();
  const currentMins = currentHour * 60 + currentMin;

  const onShift = team.filter(member => {
    if (!member.active) return false;
    const [sh, sm] = member.shiftStart.split(':').map(Number);
    const [eh, em] = member.shiftEnd.split(':').map(Number);
    const startMins = sh * 60 + sm;
    let endMins = eh * 60 + em;
    // Handle overnight shifts
    if (endMins < startMins) {
      return currentMins >= startMins || currentMins < endMins;
    }
    return currentMins >= startMins && currentMins < endMins;
  });

  if (onShift.length === 0) return null;

  // Random selection for even distribution
  return onShift[Math.floor(Math.random() * onShift.length)];
}
