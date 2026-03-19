// lib/store.js
// All data persistence via Vercel KV (Redis)
// Keys:
//   stories          → JSON array of all stories
//   entities         → JSON array of tracked entities
//   team             → JSON array of team members
//   credentials      → JSON array of encrypted paywall credentials
//   settings         → JSON object of API keys (encrypted)
//   notifications    → JSON array of notifications
//   digest:latest    → latest AI digest text
//   comments:{id}    → comment analysis for story id

import { kv } from '@vercel/kv';

// ─── STORIES ──────────────────────────────────────────────────────────────────

export async function getStories() {
  const data = await kv.get('stories');
  return data || [];
}

export async function saveStories(stories) {
  await kv.set('stories', stories);
}

export async function addStory(story) {
  const stories = await getStories();
  // Dedup by URL
  if (stories.find(s => s.url === story.url)) return null;
  stories.unshift(story);
  // Keep last 500
  const trimmed = stories.slice(0, 500);
  await saveStories(trimmed);
  return story;
}

export async function updateStory(id, updates) {
  const stories = await getStories();
  const idx = stories.findIndex(s => s.id === id);
  if (idx === -1) return null;
  stories[idx] = { ...stories[idx], ...updates, updatedAt: new Date().toISOString() };
  await saveStories(stories);
  return stories[idx];
}

// ─── ENTITIES ─────────────────────────────────────────────────────────────────

export async function getEntities() {
  const data = await kv.get('entities');
  if (data && data.length > 0) return data;
  // Defaults
  return [
    { id: 'e1', name: 'Acme Corp', type: 'company', importance: 5, active: true, createdAt: new Date().toISOString() },
    { id: 'e2', name: 'James Whitmore', type: 'person', importance: 5, active: true, createdAt: new Date().toISOString() },
    { id: 'e3', name: 'Meridian Campaign', type: 'campaign', importance: 4, active: true, createdAt: new Date().toISOString() },
    { id: 'e4', name: 'Project Nova', type: 'campaign', importance: 3, active: true, createdAt: new Date().toISOString() },
    { id: 'e5', name: 'BrightBrand', type: 'company', importance: 3, active: true, createdAt: new Date().toISOString() },
  ];
}

export async function saveEntities(entities) {
  await kv.set('entities', entities);
}

// ─── TEAM ─────────────────────────────────────────────────────────────────────

export async function getTeam() {
  const data = await kv.get('team');
  if (data && data.length > 0) return data;
  return [
    { id: 't1', name: 'Emma L.', initials: 'EL', color: '#534AB7', role: 'Senior Analyst', shiftStart: '09:00', shiftEnd: '17:00', active: true },
    { id: 't2', name: 'Tom K.', initials: 'TK', color: '#0F6E56', role: 'Analyst', shiftStart: '09:00', shiftEnd: '17:00', active: true },
    { id: 't3', name: 'Priya S.', initials: 'PS', color: '#993C1D', role: 'Analyst', shiftStart: '07:00', shiftEnd: '15:00', active: true },
    { id: 't4', name: 'Marcus D.', initials: 'MD', color: '#185FA5', role: 'Senior Analyst', shiftStart: '12:00', shiftEnd: '20:00', active: true },
    { id: 't5', name: 'Zoe P.', initials: 'ZP', color: '#3B6D11', role: 'Analyst', shiftStart: '12:00', shiftEnd: '20:00', active: true },
    { id: 't6', name: 'Ryan C.', initials: 'RC', color: '#854F0B', role: 'Analyst', shiftStart: '20:00', shiftEnd: '04:00', active: true },
  ];
}

export async function saveTeam(team) {
  await kv.set('team', team);
}

// ─── SETTINGS / API KEYS ──────────────────────────────────────────────────────

export async function getSettings() {
  const data = await kv.get('settings');
  return data || {};
}

export async function saveSettings(settings) {
  await kv.set('settings', settings);
}

// ─── PAYWALL CREDENTIALS ──────────────────────────────────────────────────────

export async function getCredentials() {
  const data = await kv.get('credentials');
  return data || [];
}

export async function saveCredentials(credentials) {
  await kv.set('credentials', credentials);
}

export async function upsertCredential(credential) {
  const creds = await getCredentials();
  const idx = creds.findIndex(c => c.id === credential.id);
  if (idx >= 0) {
    creds[idx] = credential;
  } else {
    creds.push(credential);
  }
  await saveCredentials(creds);
  return credential;
}

export async function deleteCredential(id) {
  const creds = await getCredentials();
  await saveCredentials(creds.filter(c => c.id !== id));
}

// ─── NOTIFICATIONS ────────────────────────────────────────────────────────────

export async function getNotifications() {
  const data = await kv.get('notifications');
  return data || [];
}

export async function addNotification(notif) {
  const notifs = await getNotifications();
  notifs.unshift({ ...notif, id: `n_${Date.now()}`, createdAt: new Date().toISOString(), read: false });
  await kv.set('notifications', notifs.slice(0, 100));
}

export async function markNotificationsRead() {
  const notifs = await getNotifications();
  await kv.set('notifications', notifs.map(n => ({ ...n, read: true })));
}

// ─── COMMENTS ─────────────────────────────────────────────────────────────────

export async function getComments(storyId) {
  const data = await kv.get(`comments:${storyId}`);
  return data || null;
}

export async function saveComments(storyId, analysis) {
  await kv.set(`comments:${storyId}`, analysis, { ex: 3600 }); // 1h TTL
}

// ─── DIGEST ───────────────────────────────────────────────────────────────────

export async function getDigest() {
  return await kv.get('digest:latest');
}

export async function saveDigest(digest) {
  await kv.set('digest:latest', digest);
}

// ─── SCAN STATE ───────────────────────────────────────────────────────────────

export async function getLastScan() {
  return await kv.get('scan:last');
}

export async function setLastScan(ts) {
  await kv.set('scan:last', ts);
}
