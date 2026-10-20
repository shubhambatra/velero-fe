// Helpers for the real end-to-end run (e2e/golden.mjs): an API client that behaves like the UI (cookies, CSRF,
// sudo re-authentication), shell wrappers, waiting, and a tiny runner that reports each step.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function sh(cmd, args = [], opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
  } catch (e) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${(e.stderr || e.message).toString().trim().slice(0, 600)}`);
  }
}
export const CTX = process.env.VFM_KUBE_CONTEXT ?? 'kind-vfm-a';
export const kubectl = (...args) => sh('kubectl', ['--context', CTX, ...args]);
export const kubectlTry = (...args) => {
  try {
    return kubectl(...args);
  } catch {
    return undefined;
  }
};

export async function until(what, fn, { timeout = 60_000, every = 500 } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`timed out after ${Math.round(timeout / 1000)} s waiting for ${what}${last ? ` (last error: ${last.message})` : ''}`);
}

// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) from a base32 secret.
export function totp(secret, stepOffset = 0) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + stepOffset));
  const h = crypto.createHmac('sha1', key).update(counter).digest();
  const o = h[19] & 0xf;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1_000_000).padStart(6, '0');
}

/** The API the way the web app uses it. */
export class Api {
  constructor(base, password) {
    this.base = base;
    this.password = password;
    this.jar = {};
  }
  async raw(method, path, body, headers = {}) {
    // A fresh connection per request: a test that pauses (kubectl, waiting) must not reuse a socket the server closed.
    const h = { 'content-type': 'application/json', connection: 'close', ...headers };
    if (Object.keys(this.jar).length) h.cookie = Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (this.jar.vfm_csrf) h['x-csrf-token'] = this.jar.vfm_csrf;
    let res;
    try {
      res = await fetch(`${this.base}/api/v1${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      // undici says only "fetch failed"; the reason is on the cause.
      throw new Error(`${method} ${path}: ${e.message} (${e.cause?.code ?? e.cause?.message ?? 'no cause'})`);
    }
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.jar[pair.slice(0, i)] = pair.slice(i + 1);
    }
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text, headers: res.headers };
  }
  /** Like the UI: on "sudo required", re-authenticate with the password and repeat once. */
  async call(method, path, body, expect) {
    let r = await this.raw(method, path, body);
    if (r.status === 403 && r.json?.sudoRequired && this.password) {
      const s = await this.raw('POST', '/auth/sudo', { password: this.password });
      if (s.status >= 300) throw new Error(`sudo failed: ${s.status} ${s.text.slice(0, 200)}`);
      r = await this.raw(method, path, body);
    }
    if (expect !== undefined) {
      const ok = Array.isArray(expect) ? expect.includes(r.status) : r.status === expect;
      if (!ok) throw new Error(`${method} ${path} -> ${r.status} (wanted ${expect}): ${r.text.slice(0, 300)}`);
    }
    return r;
  }
}

/** A step runner: prints one line per step, keeps going after a failed golden path, exits non-zero if any failed. */
export function runner() {
  const results = [];
  let current;
  return {
    results,
    async path(name, fn) {
      current = { name, steps: [], ok: true, started: Date.now() };
      results.push(current);
      console.log(`\n=== ${name}`);
      try {
        await fn();
      } catch (e) {
        current.ok = false;
        console.log(`  FAIL  ${e.message}`);
      }
      current.seconds = Math.round((Date.now() - current.started) / 1000);
    },
    ok(what) {
      current.steps.push({ what, ok: true });
      console.log(`  PASS  ${what}`);
    },
    check(cond, what, detail) {
      if (!cond) throw new Error(`${what}${detail ? `: ${detail}` : ''}`);
      this.ok(what);
    },
    summary() {
      console.log('\n=== summary');
      for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name} (${r.seconds} s, ${r.steps.length} checks)`);
      const bad = results.filter((r) => !r.ok).length;
      console.log(bad === 0 ? '\nALL GOLDEN PATHS PASSED' : `\n${bad} GOLDEN PATH(S) FAILED`);
      return bad === 0 ? 0 : 1;
    },
  };
}

export const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
