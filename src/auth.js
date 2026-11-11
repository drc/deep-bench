// Cookie identity — HMAC-signed player id. Pure WebCrypto, edge-safe.
const enc = new TextEncoder();

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function getCookie(header, wanted) {
  for (const part of (header || '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === wanted) return rest.join('=');
  }
  return null;
}

// returns player id or null
// single cookie "db_uid=<uuid>.<hmac>" — two cookies in one Set-Cookie header
// silently drops the second one (it parses as an attribute), so the sig rides
// inside the value.
async function verifyPlayerId(cookieHeader, secret) {
  const raw = getCookie(cookieHeader, 'db_uid');
  if (!raw) return null;
  const dot = raw.indexOf('.');
  if (dot === -1) return null;
  const uid = raw.slice(0, dot), sig = raw.slice(dot + 1);
  if (!/^[0-9a-f-]{36}$/.test(uid)) return null;
  const expect = await hmacHex(secret, uid);
  if (expect.length !== sig.length) return null;
  // constant-time compare
  let diff = 0;
  for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? uid : null;
}

async function cookieFor(uid, secret) {
  const sig = await hmacHex(secret, uid);
  return `db_uid=${uid}.${sig}; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000; Path=/`;
}

module.exports = { hmacHex, getCookie, verifyPlayerId, cookieFor };
