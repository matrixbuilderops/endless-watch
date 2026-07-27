// Web Push (RFC 8291 message encryption + RFC 8188 aes128gcm + VAPID/RFC 8292).
// Zero dependencies — Node's crypto has every primitive. Lets the server send a
// notification to a locked phone when a show is leaving a platform.

'use strict';
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const b64uDec = (s) => Buffer.from(s, 'base64url');
const b64uEnc = (b) => Buffer.from(b).toString('base64url');

// ---- key encoding: raw uncompressed EC point (0x04|X|Y) <-> KeyObject via JWK ----

function jwkFromRaw(rawPub, rawPriv) {
  const jwk = { kty: 'EC', crv: 'P-256', x: b64uEnc(rawPub.subarray(1, 33)), y: b64uEnc(rawPub.subarray(33, 65)) };
  if (rawPriv) jwk.d = b64uEnc(rawPriv);
  return jwk;
}

// ---- VAPID application-server keypair (persisted) ----

function loadOrCreateVapid(dataDir) {
  const file = path.join(dataDir, 'vapid.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* create below */ }
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const keys = { publicKey: b64uEnc(ecdh.getPublicKey()), privateKey: b64uEnc(ecdh.getPrivateKey()) };
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // VAPID private key is a secret — owner-only
  fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

// ---- SSRF guard: a push subscription's endpoint is user-controlled, and the
// server makes an outbound request to it. Reject non-HTTPS and anything that
// resolves to a private/loopback/link-local address (cloud metadata, LAN,
// tailnet), and connect to the resolved IP with TLS SNI pinned to the hostname
// so DNS can't rebind between the check and the request.

const dns = require('dns').promises;
const net = require('net');

// URL.hostname keeps the brackets on an IPv6 literal ("[::1]"), and net.isIP()
// says 0 for that — so every IPv6 check below used to be skipped whenever the
// address came from a URL. Always unwrap before testing.
const hostOf = (url) => url.hostname.replace(/^\[|\]$/g, '');

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0
      || (p[0] === 169 && p[1] === 254)                 // link-local / metadata
      || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
      || (p[0] === 192 && p[1] === 168)
      || (p[0] === 100 && p[1] >= 64 && p[1] <= 127)    // CGNAT / tailnet
      || p[0] >= 224;                                   // multicast + broadcast
  }
  const lower = ip.replace(/^\[|\]$/g, '').toLowerCase();
  // IPv4-mapped, in either spelling: URL normalizes ::ffff:10.0.0.1 to the hex
  // form ::ffff:a00:1, which the dotted-quad pattern alone never matched.
  const mapped = lower.match(/^::ffff:(.+)$/);
  if (mapped) {
    if (net.isIPv4(mapped[1])) return isPrivateIp(mapped[1]);
    const parts = mapped[1].split(':');
    if (parts.length === 2) {
      const hi = parseInt(parts[0], 16), lo = parseInt(parts[1], 16);
      if (Number.isFinite(hi) && Number.isFinite(lo))
        return isPrivateIp([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'));
    }
    return true;                                        // unrecognized mapping: refuse
  }
  return lower === '::1' || lower === '::'
    || lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd');
}

// cheap synchronous check for obviously-bad endpoints (used at subscribe time)
function endpointLooksSafe(endpoint) {
  if (process.env.ALLOW_INSECURE_PUSH === '1') return true;
  let url; try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  const host = hostOf(url);
  if (net.isIP(host) && isPrivateIp(host)) return false;
  if (/^(localhost|.*\.local)$/i.test(host)) return false;
  return true;
}

// full async check: resolve and reject private targets; returns a safe IP to dial
async function resolveSafeTarget(url) {
  if (process.env.ALLOW_INSECURE_PUSH === '1') return null; // dial hostname directly (tests)
  if (url.protocol !== 'https:') throw new Error('push endpoint must be https');
  const host = hostOf(url);
  // a literal address needs checking, not resolving — dns.lookup('[::1]') just
  // throws ENOTFOUND, which hid the bracket bug rather than catching it
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('push endpoint resolves to a private address');
    return host;
  }
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs.length) throw new Error('push endpoint does not resolve');
  for (const a of addrs) if (isPrivateIp(a.address)) throw new Error('push endpoint resolves to a private address');
  return addrs[0].address;
}

// ---- VAPID JWT (ES256, signature must be raw R||S, not DER) ----

function vapidHeaders(endpoint, vapid, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64uEnc(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64uEnc(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject || 'mailto:endless-watch@example.com',
  }));
  const signingInput = `${header}.${payload}`;
  const privKey = crypto.createPrivateKey({
    key: jwkFromRaw(b64uDec(vapid.publicKey), b64uDec(vapid.privateKey)), format: 'jwk',
  });
  const sig = crypto.sign('SHA256', Buffer.from(signingInput), { key: privKey, dsaEncoding: 'ieee-p1363' });
  const jwt = `${signingInput}.${b64uEnc(sig)}`;
  return { Authorization: `vapid t=${jwt}, k=${vapid.publicKey}` };
}

// ---- RFC 8291 payload encryption (aes128gcm) ----

function encryptPayload(uaPublicRaw, authSecret, plaintext, opts = {}) {
  const ecdh = crypto.createECDH('prime256v1');
  if (opts.asPrivate) ecdh.setPrivateKey(opts.asPrivate); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();                 // 65-byte uncompressed
  const shared = ecdh.computeSecret(uaPublicRaw);       // ECDH shared secret

  const salt = opts.salt || crypto.randomBytes(16);
  // key_info = "WebPush: info" \0 ua_public as_public  (recipient key BEFORE sender key)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublicRaw, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));

  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const record = Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])]); // single, last-record delimiter
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(record), cipher.final()]);
  const tag = cipher.getAuthTag();

  const rs = opts.rs || 4096;
  const rsBuf = Buffer.alloc(4); rsBuf.writeUInt32BE(rs);
  const header = Buffer.concat([salt, rsBuf, Buffer.from([asPublic.length]), asPublic]);
  return Buffer.concat([header, body, tag]);
}

// decrypt: only used by the local self-test (a real UA does this)
function decryptPayload(fullBody, uaPublicRaw, uaPrivateRaw, authSecret) {
  const salt = fullBody.subarray(0, 16);
  const idlen = fullBody[20];
  const asPublic = fullBody.subarray(21, 21 + idlen);
  const ct = fullBody.subarray(21 + idlen);

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivateRaw);
  const shared = ecdh.computeSecret(asPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublicRaw, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const tag = ct.subarray(ct.length - 16);
  const data = ct.subarray(0, ct.length - 16);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(tag);
  const out = Buffer.concat([d.update(data), d.final()]);
  return out.subarray(0, out.length - 1).toString(); // strip 0x02
}

// ---- send one notification; resolves { status } ----

async function sendNotification(subscription, payloadStr, vapid, subject) {
  let body, url, dialIp;
  try {
    const uaPublic = b64uDec(subscription.keys.p256dh);
    const auth = b64uDec(subscription.keys.auth);
    if (uaPublic.length !== 65 || auth.length !== 16) return { status: 0, error: 'bad subscription keys' };
    url = new URL(subscription.endpoint);
    dialIp = await resolveSafeTarget(url);   // throws if private / non-https
    body = encryptPayload(uaPublic, auth, payloadStr);
  } catch (e) { return { status: 0, error: e.message }; }

  return new Promise((resolve) => {
    const insecure = process.env.ALLOW_INSECURE_PUSH === '1';
    const lib = url.protocol === 'http:' ? http : https;
    const req = lib.request({
      method: 'POST',
      host: dialIp || url.hostname,                 // dial the vetted IP (no rebinding)
      servername: url.hostname,                     // but validate TLS against the hostname
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: url.pathname + url.search,
      headers: {
        Host: url.host,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'Content-Length': body.length,
        TTL: 86400,
        ...vapidHeaders(subscription.endpoint, vapid, subject),
      },
    }, (res) => { res.on('data', () => {}); res.on('end', () => resolve({ status: res.statusCode })); });
    req.on('error', () => resolve({ status: 0 }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0 }); });
    req.end(body);
  });
}

module.exports = { loadOrCreateVapid, encryptPayload, decryptPayload, sendNotification, endpointLooksSafe, jwkFromRaw, b64uEnc, b64uDec };
