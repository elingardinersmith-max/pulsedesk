import CryptoJS from 'crypto-js';

function getKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error('ENCRYPTION_KEY environment variable not set');
  return key;
}

export function encrypt(plaintext) {
  if (!plaintext) return '';
  return CryptoJS.AES.encrypt(plaintext, getKey()).toString();
}

export function decrypt(ciphertext) {
  if (!ciphertext) return '';
  const bytes = CryptoJS.AES.decrypt(ciphertext, getKey());
  const decrypted = bytes.toString(CryptoJS.enc.Utf8);
  if (!decrypted) throw new Error('Decryption failed — wrong key?');
  return decrypted;
}

export function encryptCredential(cred) {
  return { ...cred, password: cred.password ? encrypt(cred.password) : '', encrypted: true };
}

export function decryptCredential(cred) {
  if (!cred.encrypted) return cred;
  return { ...cred, password: cred.password ? decrypt(cred.password) : '', encrypted: false };
}

export function encryptSettings(settings) {
  const result = { _encrypted: true };
  for (const [k, v] of Object.entries(settings)) {
    result[k] = v ? encrypt(String(v)) : '';
  }
  return result;
}

export function decryptSettings(settings) {
  if (!settings || !settings._encrypted) return settings || {};
  const result = {};
  for (const [k, v] of Object.entries(settings)) {
    if (k === '_encrypted') continue;
    try { result[k] = v ? decrypt(v) : ''; } catch { result[k] = ''; }
  }
  return result;
}

export function maskKey(key) {
  if (!key || key.length < 8) return '••••••••';
  return '••••••••' + key.slice(-4);
}
