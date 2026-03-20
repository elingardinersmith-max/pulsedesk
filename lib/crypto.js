// lib/crypto.js — uses Node built-in crypto, no external dependency
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

function getKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error('ENCRYPTION_KEY not set');
  return Buffer.from(raw.length === 64 ? raw : raw, raw.length === 64 ? 'hex' : 'base64').slice(0, 32);
}

export async function encrypt(plaintext) {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export async function decrypt(b64) {
  const key = getKey();
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.slice(0, 12);
  const tag = buf.slice(12, 28);
  const encrypted = buf.slice(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export async function kvGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const { result } = await res.json();
  return result;
}

export async function kvSet(key, value) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('KV not configured');
  const res = await fetch(`${url}/set/${encodeURIComponent(key)}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ value }) });
  if (!res.ok) throw new Error(`KV set failed: ${res.status}`);
  return true;
}

export async function kvDel(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  await fetch(`${url}/del/${encodeURIComponent(key)}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  return true;
}

export async function kvList(prefix) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return [];
  const res = await fetch(`${url}/keys/${encodeURIComponent(prefix + '*')}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return [];
  const { result } = await res.json();
  return result || [];
}
