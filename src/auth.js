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
async function verifyPlayerId(cookieHeader, secret) {
  const uid = getCookie(cookieHeader, 'db_uid');
  const sig = getCookie(cookieHeader, 'db_sig');
  if (!uid || !sig || !/^[0-9a-f-]{36}$/.test(uid)) return null;
  const expect = await hmacHex(secret, uid);
  if (expect.length !== sig.length) return null;
  // constant-time compare
  let diff = 0;
  for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? uid : null;
}

async function cookieFor(uid, secret) {
  const sig = await hmacHex(secret, uid);
  return `db_uid=${uid}; db_sig=${sig}; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000; Path=/`;
}

module.exports = { hmacHex, getCookie, verifyPlayerId, cookieFor };
