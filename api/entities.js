// api/entities.js
// CRUD for tracked entities and app configuration — stored in Vercel KV

import { kvGet, kvSet, kvDel, kvList } from '../lib/crypto.js';
import { jsonResponse, errorResponse, corsHeaders } from '../lib/scoring.js';

export const config = { runtime: 'nodejs' };

const ENTITIES_KEY = 'config:entities';
const TEAM_KEY = 'config:team';
const SETTINGS_KEY = 'config:settings';

// Default entities for first run
const DEFAULT_ENTITIES = [
  { id: '1', name: 'Your Company', type: 'company', importance: 5, active: true, keywords: [] },
];

const DEFAULT_SETTINGS = {
  scanIntervalMinutes: 15,
  enabledSources: ['newsapi', 'gnews', 'reddit', 'twitter'],
  notificationRules: {
    p1Alert: true,
    hostileSpike: true,
    influencerEngaged: true,
    spikeThreshold: 200, // % increase to trigger hostile spike alert
    influencerFollowerThreshold: 10000,
  },
  slackWebhookUrl: '',
  emailNotifications: '',
};

async function getEntities() {
  const raw = await kvGet(ENTITIES_KEY);
  if (!raw) return DEFAULT_ENTITIES;
  try { return JSON.parse(raw); } catch { return DEFAULT_ENTITIES; }
}

async function saveEntities(entities) {
  await kvSet(ENTITIES_KEY, JSON.stringify(entities));
}

async function getTeam() {
  const raw = await kvGet(TEAM_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function saveTeam(team) {
  await kvSet(TEAM_KEY, JSON.stringify(team));
}

async function getSettings() {
  const raw = await kvGet(SETTINGS_KEY);
  if (!raw) return DEFAULT_SETTINGS;
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }; } catch { return DEFAULT_SETTINGS; }
}

async function saveSettings(settings) {
  await kvSet(SETTINGS_KEY, JSON.stringify(settings));
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: corsHeaders() });

  const { searchParams } = new URL(req.url);
  const resource = searchParams.get('resource') || 'entities';
  const action = searchParams.get('action') || 'list';

  try {
    let body = {};
    if (req.method === 'POST') {
      const text = await req.text();
      body = text ? JSON.parse(text) : {};
    }

    // ── Entities ───────────────────────────────────────
    if (resource === 'entities') {
      if (action === 'list') {
        return jsonResponse({ entities: await getEntities() });
      }

      if (action === 'save') {
        const entities = await getEntities();
        if (body.id) {
          // Update existing
          const idx = entities.findIndex(e => e.id === body.id);
          if (idx >= 0) entities[idx] = { ...entities[idx], ...body };
          else entities.push({ ...body, id: body.id || Date.now().toString() });
        } else {
          // Create new
          entities.push({ ...body, id: Date.now().toString() });
        }
        await saveEntities(entities);
        return jsonResponse({ success: true, entities });
      }

      if (action === 'delete') {
        const entities = (await getEntities()).filter(e => e.id !== body.id);
        await saveEntities(entities);
        return jsonResponse({ success: true });
      }

      if (action === 'reorder') {
        await saveEntities(body.entities);
        return jsonResponse({ success: true });
      }
    }

    // ── Team ───────────────────────────────────────────
    if (resource === 'team') {
      if (action === 'list') {
        return jsonResponse({ team: await getTeam() });
      }
      if (action === 'save') {
        const team = await getTeam();
        if (body.id) {
          const idx = team.findIndex(m => m.id === body.id);
          if (idx >= 0) team[idx] = { ...team[idx], ...body };
          else team.push({ ...body, id: body.id });
        } else {
          team.push({ ...body, id: Date.now().toString() });
        }
        await saveTeam(team);
        return jsonResponse({ success: true, team });
      }
      if (action === 'delete') {
        const team = (await getTeam()).filter(m => m.id !== body.id);
        await saveTeam(team);
        return jsonResponse({ success: true });
      }
      if (action === 'assign') {
        // Auto-assign stories to on-shift team members
        const team = await getTeam();
        const onShift = team.filter(m => m.onShift);
        if (onShift.length === 0) return jsonResponse({ assignments: [] });

        const assignments = (body.storyIds || []).map((storyId, idx) => ({
          storyId,
          assignedTo: onShift[idx % onShift.length]
        }));
        return jsonResponse({ assignments });
      }
    }

    // ── Settings ───────────────────────────────────────
    if (resource === 'settings') {
      if (action === 'get') {
        // Strip sensitive values before returning
        const settings = await getSettings();
        return jsonResponse({ settings });
      }
      if (action === 'save') {
        const current = await getSettings();
        const updated = { ...current, ...body };
        await saveSettings(updated);
        return jsonResponse({ success: true, settings: updated });
      }
    }

    return errorResponse(`Unknown resource: ${resource}`, 400);

  } catch (err) {
    return errorResponse(err.message);
  }
}
