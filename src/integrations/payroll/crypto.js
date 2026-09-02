/**
 * Encrypts payroll-provider credentials (Gusto/ADP/Intuit access tokens
 * and client secrets) before they're written to the database, and
 * decrypts them when a connector needs to make a live API call.
 *
 * Requires PAYROLL_CREDENTIALS_KEY in the environment — a 32-byte
 * key, base64 encoded. Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 * and set it in the Render dashboard (or render.yaml as generateValue: true).
 */
const crypto = require('crypto');

function getKey() {
  const raw = process.env.PAYROLL_CREDENTIALS_KEY;
  if (!raw) {
    throw new Error('PAYROLL_CREDENTIALS_KEY is not set — cannot store or read payroll provider credentials securely.');
  }
  // Derive a proper 256-bit key from whatever string Render/the operator
  // provides, so this works whether the env var was set via
  // `generateValue: true` (an arbitrary random string) or manually.
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

function encryptCredentials(obj) {
  const key = getKey();
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  // store as iv:tag:ciphertext, all base64
  return [iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':');
}

function decryptCredentials(stored) {
  const key = getKey();
  const [ivB64, tagB64, dataB64] = stored.split(':');
  const iv  = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

function maskCredential(obj) {
  // Build a safe display reference like "sk_live_...ab12" from whichever
  // field looks like the primary secret, without ever exposing the full value.
  const primary = obj.accessToken || obj.clientSecret || obj.apiKey || '';
  if (!primary) return null;
  return primary.length > 8 ? `${primary.slice(0, 4)}…${primary.slice(-4)}` : '••••';
}

module.exports = { encryptCredentials, decryptCredentials, maskCredential };
