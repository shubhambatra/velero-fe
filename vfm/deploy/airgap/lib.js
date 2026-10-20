'use strict';
// Shared by drive.js and upgrade-drive.js (run inside the control-plane image; no dependencies).
require('/app/node_modules/reflect-metadata');
const crypto = require('node:crypto');

let passed = 0;
const ok = (what) => {
  passed += 1;
  console.log(`  PASS  ${what}`);
};
const fail = (what, extra) => {
  console.error(`  FAIL  ${what}${extra ? `: ${extra}` : ''}`);
  process.exit(1);
};
const check = (cond, what, extra) => (cond ? ok(what) : fail(what, extra));

function client(base) {
  const api = `${base}/api/v1`;
  const jar = {};
  async function call(method, path, body, expect) {
    const headers = { 'content-type': 'application/json' };
    if (Object.keys(jar).length)
      headers.cookie = Object.entries(jar)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
    if (jar.vfm_csrf) headers['x-csrf-token'] = jar.vfm_csrf;
    const res = await fetch(`${api}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar[pair.slice(0, i)] = pair.slice(i + 1);
    }
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (expect !== undefined && res.status !== expect)
      fail(`${method} ${path} -> ${res.status}`, `wanted ${expect}: ${text.slice(0, 200)}`);
    return { status: res.status, json, text, headers: res.headers };
  }
  return { call, api, base };
}

// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) from a base32 secret, so no library is needed.
function totp(secretBase32, stepOffset = 0) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretBase32.replace(/=+$/, '').toUpperCase())
    bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + stepOffset));
  const h = crypto.createHmac('sha1', key).update(counter).digest();
  const o = h[19] & 0xf;
  return String(
    (((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000,
  ).padStart(6, '0');
}

const until = async (what, fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fail(what, 'timed out');
};

module.exports = { ok, fail, check, client, totp, until, passed: () => passed };
