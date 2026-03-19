// api/sources/paywall.js
// Manages paywall credentials (AES-256 encrypted in Vercel KV)
// Uses fetch + cookie-based auth for content retrieval
// Note: Full Playwright unavailable in Vercel Edge — uses fetch-based login simulation
// For full Playwright support, deploy to Vercel's Node.js runtime or a separate service

import { encrypt, decrypt, kvGet, kvSet, kvDel, kvList } from '../../lib/crypto.js';
import { jsonResponse, errorResponse } from '../../lib/scoring.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

// ── Credential CRUD ──────────────────────────────────────────────────

async function listCredentials() {
  const keys = await kvList('paywall:');
  const creds = [];
  for (const key of keys) {
    const raw = await kvGet(key);
    if (!raw) continue;
    try {
      const data = JSON.parse(raw);
      // Never return the actual password
      creds.push({
        id: key.replace('paywall:', ''),
        domain: data.domain,
        username: data.username,
        loginUrl: data.loginUrl,
        method: data.method || 'form',
        usernameField: data.usernameField || 'email',
        passwordField: data.passwordField || 'password',
        addedAt: data.addedAt,
        lastTested: data.lastTested,
        lastStatus: data.lastStatus,
        hasPassword: true
      });
    } catch {}
  }
  return creds;
}

async function saveCredential(id, { domain, username, password, loginUrl, method, usernameField, passwordField, extraFields }) {
  const encryptedPassword = await encrypt(password);
  const data = {
    domain: domain.replace(/^https?:\/\//, '').split('/')[0],
    username,
    encryptedPassword,
    loginUrl,
    method: method || 'form',
    usernameField: usernameField || 'email',
    passwordField: passwordField || 'password',
    extraFields: extraFields || {},
    addedAt: new Date().toISOString(),
    lastTested: null,
    lastStatus: 'untested'
  };
  await kvSet(`paywall:${id}`, JSON.stringify(data));
  return { success: true, id };
}

async function deleteCredential(id) {
  await kvDel(`paywall:${id}`);
  return { success: true };
}

async function getDecryptedCred(id) {
  const raw = await kvGet(`paywall:${id}`);
  if (!raw) return null;
  const data = JSON.parse(raw);
  const password = await decrypt(data.encryptedPassword);
  return { ...data, password };
}

// ── Login strategies ─────────────────────────────────────────────────

// Strategy 1: Standard form-based login (FT, NYT, WSJ style)
async function formLogin(loginUrl, username, password, usernameField, passwordField, extraFields) {
  // Step 1: Get login page to collect any CSRF tokens
  const init = await fetch(loginUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml'
    },
    redirect: 'follow'
  });

  const cookies = init.headers.get('set-cookie') || '';
  const html = await init.text();

  // Extract CSRF token (common patterns)
  const csrfPatterns = [
    /name="[_]?csrf[_]?(?:token)?"\s+value="([^"]+)"/i,
    /name="authenticity_token"\s+value="([^"]+)"/i,
    /"csrfToken"\s*:\s*"([^"]+)"/i,
    /data-csrf="([^"]+)"/i,
    /<meta\s+name="csrf-token"\s+content="([^"]+)"/i,
  ];

  let csrfToken = null;
  for (const pattern of csrfPatterns) {
    const match = html.match(pattern);
    if (match) { csrfToken = match[1]; break; }
  }

  // Build form body
  const formData = new URLSearchParams();
  formData.set(usernameField, username);
  formData.set(passwordField, password);
  if (csrfToken) formData.set('_csrf_token', csrfToken);
  for (const [k, v] of Object.entries(extraFields || {})) formData.set(k, v);

  // Determine POST endpoint (may differ from loginUrl)
  const actionMatch = html.match(/<form[^>]+action="([^"]+)"/i);
  const postUrl = actionMatch
    ? new URL(actionMatch[1], loginUrl).toString()
    : loginUrl;

  // Step 2: Submit login
  const loginRes = await fetch(postUrl, {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': loginUrl,
      'Cookie': cookies,
      'Origin': new URL(loginUrl).origin
    },
    body: formData.toString(),
    redirect: 'manual'
  });

  const sessionCookies = loginRes.headers.get('set-cookie') || '';
  const allCookies = mergeCookies(cookies, sessionCookies);

  // Check success: redirect away from login page, or 200 with session cookie
  const redirected = loginRes.status >= 300 && loginRes.status < 400;
  const hasSessionCookie = sessionCookies.includes('session') || sessionCookies.includes('auth') || sessionCookies.includes('token');

  return {
    success: redirected || hasSessionCookie,
    cookies: allCookies,
    status: loginRes.status
  };
}

// Strategy 2: JSON API login (The Guardian, many modern sites)
async function apiLogin(loginUrl, username, password, usernameField, passwordField) {
  const res = await fetch(loginUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    },
    body: JSON.stringify({ [usernameField]: username, [passwordField]: password })
  });

  const cookies = res.headers.get('set-cookie') || '';
  const data = await res.json().catch(() => ({}));
  const success = res.ok && !data.error && !data.errors;

  return { success, cookies, token: data.token || data.access_token || null, status: res.status };
}

function mergeCookies(...cookieStrings) {
  const map = {};
  for (const str of cookieStrings) {
    if (!str) continue;
    for (const part of str.split(',')) {
      const [nameVal] = part.trim().split(';');
      const [name, val] = nameVal.split('=');
      if (name && val) map[name.trim()] = val.trim();
    }
  }
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ');
}

// Fetch content using stored session
async function fetchWithAuth(articleUrl, credId) {
  const cred = await getDecryptedCred(credId);
  if (!cred) throw new Error('Credential not found');

  // Login to get session
  let loginResult;
  if (cred.method === 'api') {
    loginResult = await apiLogin(cred.loginUrl, cred.username, cred.password, cred.usernameField, cred.passwordField);
  } else {
    loginResult = await formLogin(cred.loginUrl, cred.username, cred.password, cred.usernameField, cred.passwordField, cred.extraFields);
  }

  if (!loginResult.success) {
    throw new Error(`Login failed for ${cred.domain} (HTTP ${loginResult.status})`);
  }

  // Fetch the article with session cookies
  const articleRes = await fetch(articleUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Cookie': loginResult.cookies,
      'Referer': new URL(articleUrl).origin,
      'Authorization': loginResult.token ? `Bearer ${loginResult.token}` : undefined,
    }
  });

  if (!articleRes.ok) throw new Error(`Article fetch failed: ${articleRes.status}`);

  const html = await articleRes.text();

  // Extract article text (basic extraction — works for most news sites)
  const content = extractArticleText(html);
  const title = html.match(/<title[^>]*>(.*?)<\/title>/i)?.[1]?.replace(' - Site Name', '') || '';

  return { title, content, html: html.slice(0, 5000), url: articleUrl };
}

function extractArticleText(html) {
  // Remove scripts, styles, nav, ads
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '');

  // Find article body (common patterns)
  const articlePatterns = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<div[^>]*class="[^"]*(?:article|story|body|content|post)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<main[^>]*>([\s\S]*?)<\/main>/i,
  ];

  for (const pattern of articlePatterns) {
    const match = text.match(pattern);
    if (match) {
      text = match[1];
      break;
    }
  }

  // Strip remaining tags and decode entities
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);
}

// Test a credential without fetching a full article
async function testCredential(credId) {
  const cred = await getDecryptedCred(credId);
  if (!cred) throw new Error('Credential not found');

  let result;
  try {
    if (cred.method === 'api') {
      result = await apiLogin(cred.loginUrl, cred.username, cred.password, cred.usernameField, cred.passwordField);
    } else {
      result = await formLogin(cred.loginUrl, cred.username, cred.password, cred.usernameField, cred.passwordField, cred.extraFields);
    }

    // Update last tested status in KV
    const raw = await kvGet(`paywall:${credId}`);
    if (raw) {
      const data = JSON.parse(raw);
      data.lastTested = new Date().toISOString();
      data.lastStatus = result.success ? 'ok' : 'failed';
      await kvSet(`paywall:${credId}`, JSON.stringify(data));
    }

    return { success: result.success, httpStatus: result.status };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── Route handler ─────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const { searchParams } = new URL(req.url, `http://${req.headers.host}`);
  const action = searchParams.get('action');

  try {
    if (req.method === 'GET' && action === 'list') {
      const creds = await listCredentials();
      return res.json({ credentials: creds });
    }

    if (req.method === 'GET' && action === 'test') {
      const id = searchParams.get('id');
      if (!id) return res.status(400).json({ error: 'id required' });
      const result = await testCredential(id);
      return res.json(result);
    }

    if (req.method === 'GET' && action === 'fetch') {
      const url = searchParams.get('url');
      const id = searchParams.get('id');
      if (!url || !id) return res.status(400).json({ error: 'url and id required' });
      const content = await fetchWithAuth(url, id);
      return res.json(content);
    }

    if (req.method === 'POST' && action === 'save') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const id = body.id || body.domain.replace(/\W+/g, '_');
      const result = await saveCredential(id, body);
      return res.json(result);
    }

    if (req.method === 'DELETE' || (req.method === 'POST' && action === 'delete')) {
      const id = searchParams.get('id');
      if (!id) return res.status(400).json({ error: 'id required' });
      const result = await deleteCredential(id);
      return res.json(result);
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
