// Password hashing, opaque tokens, HMAC signing and field-level encryption.
const crypto = require('crypto');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  const [alg, s, k] = String(stored).split('$');
  if (alg !== 'scrypt' || !s || !k) return false;
  const key = crypto.scryptSync(pw, Buffer.from(s, 'base64'), 64, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(k, 'base64');
  return want.length === key.length && crypto.timingSafeEqual(want, key);
}
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Signed opaque reference: base64url(JSON payload) + "." + HMAC. Carries no bank or account data. */
function signRef(secret, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(secret, body)}`;
}
function verifyRef(secret, token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig || !safeEqual(sig, hmac(secret, body))) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
}

// AES-256-GCM for sensitive fields (bank account numbers, tax ids) at rest.
function makeCipher(keyB64) {
  const key = Buffer.from(keyB64, 'base64');
  return {
    encrypt(plain) {
      if (!plain) return '';
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
      return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
    },
    decrypt(blob) {
      if (!blob) return '';
      const [v, iv, tag, enc] = String(blob).split(':');
      if (v !== 'v1') return '';
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
    },
  };
}
const mask = v => (v ? `••••${String(v).slice(-4)}` : '');

module.exports = { hashPassword, verifyPassword, randomToken, sha256, hmac, safeEqual, signRef, verifyRef, makeCipher, mask };
