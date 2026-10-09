const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // recommended for GCM
const TAG_LEN = 16;

let warned = false;

function getKey() {
  const secret = process.env.PORTAL_ENCRYPTION_KEY;
  if (!secret) {
    if (!warned) {
      console.warn('WARNING: PORTAL_ENCRYPTION_KEY is not set. Falling back to a key derived from ' +
        'JWT_SECRET/REFRESH_SECRET. For production, set a dedicated PORTAL_ENCRYPTION_KEY env var ' +
        '(a long random string) so portal credentials are encrypted with a key independent of your ' +
        'auth tokens.');
      warned = true;
    }
    const fallback = `${process.env.JWT_SECRET || ''}:${process.env.REFRESH_SECRET || ''}:portal-fallback`;
    return crypto.createHash('sha256').update(fallback).digest();
  }
  return crypto.createHash('sha256').update(String(secret)).digest();
}

/**
 * Encrypts a plaintext string. Returns base64(iv|authTag|ciphertext), or '' for empty input.
 */
function encrypt(plainText) {
  if (plainText === undefined || plainText === null || plainText === '') return '';
  const iv = crypto.randomBytes(IV_LEN);
  const key = getKey();
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/**
 * Decrypts a payload produced by encrypt(). Returns '' if the payload is empty,
 * malformed, or fails authentication (tampered / wrong key) rather than throwing,
 * so a bad record can never crash a list request.
 */
function decrypt(payload) {
  if (!payload || typeof payload !== 'string') return '';
  try {
    const buf = Buffer.from(payload, 'base64');
    if (buf.length < IV_LEN + TAG_LEN) return '';
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const encrypted = buf.subarray(IV_LEN + TAG_LEN);
    const key = getKey();
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err) {
    return '';
  }
}

module.exports = { encrypt, decrypt };
