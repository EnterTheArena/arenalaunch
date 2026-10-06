// ============================================================================
// arenalaunch ACCOUNTS — the account IS the user's Phantom wallet, plus a saved wallet vault per account.
//
// The server never sees a private key or the key that encrypts the vault: the wallet signs a fresh login message
// (verified here) and, separately, a fixed message whose signature the browser hashes into the vault key (never sent).
// The vault is an AES-GCM blob encrypted in the browser; this file stores it as opaque text.
//
// HTTP (all POST, JSON; site gate required):
//   /account/nonce    {}                        → {nonce}          (single use, 5 minutes)
//   /account/wallet   {address, message, sig}   → {session, id, vault, ver}   (Sign In With Solana; creates the account on first sign-in)
//   /account/vault    {session}                 → {vault, ver}
//   /account/save     {session, vault, ver}     → {ver}            (ver must match: no silent overwrite from a stale tab)
//   /account/email-start {email}                       → {ticket}   (emails a 6-digit code; says nothing about whether the account exists)
//   /account/email-check {email, ticket, code}         → {exists}   (code right? does this email have an account yet?)
//   /account/email-login {email, ticket, code, auth}   → {session, id, vault, ver}   (uses the code up; creates the account on first sign-in)
// A code belongs to the browser that asked for it (its ticket): someone else asking for codes for your email, or guessing
// wrong, never touches yours.
//
// Email accounts are zero-knowledge too: the browser stretches the password (PBKDF2, 600k rounds, salted with the email)
// and splits it into an AUTH key, sent here and stored only as an HMAC, and a VAULT key that never leaves the browser.
// Every email sign-in needs the emailed code AND the password, so a leaked password alone opens nothing.
// ============================================================================
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import { record } from './stats.js';

const te = new TextEncoder();
const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hmac(secret, msg) { const k = await crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return b64u(new Uint8Array(await crypto.subtle.sign('HMAC', k, te.encode(msg)))); }
const eq = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const SESSION_MS = 30 * 86400000;
// fail closed: with no secret configured nothing can mint or read a session (an empty key would let anyone forge one)
const secretOf = (env) => { const s = env.ACCOUNT_SECRET || env.GATE_SECRET; if (!s) throw new Error('accounts are not configured'); return s + ':account-session'; };

// ---- Sign In With Solana: "<domain> wants you to sign in with your Solana account:\n<address>\n...\nNonce: …\nIssued At: …"
// The nonce is ours (HMAC-stamped, 5 minutes, used once) and the domain must be one of this site's, so a signature
// collected on another site, or replayed, is refused.
const NONCE_MS = 5 * 60000;
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
async function newNonce(env) { const t = Date.now().toString(36).padStart(9, '0'); const r = hex(crypto.getRandomValues(new Uint8Array(8))); return t + r + (await hmac(secretOf(env), 'nonce:' + t + r)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16); }
async function nonceOk(env, n) { if (!/^[0-9a-z]{9}[0-9a-f]{16}[A-Za-z0-9]{16}$/.test(n)) return false; const t = n.slice(0, 9), r = n.slice(9, 25); if (!eq((await hmac(secretOf(env), 'nonce:' + t + r)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16), n.slice(25))) return false; const at = parseInt(t, 36); return Date.now() - at < NONCE_MS && at - Date.now() < 30000; }
// localhost is a sign-in domain only when the DEV var is set (wrangler dev), never in production
export const siteHosts = (env) => [...(env.ALLOWED_ORIGINS || '').split(',').map((o) => { try { return new URL(o.trim()).host; } catch { return null; } }).filter(Boolean), ...(env.DEV ? ['localhost:5182', '127.0.0.1:5182'] : [])];
// returns {nonce} when the message is a valid sign-in for this address on one of our domains, else {error}
export function readSiws(env, text, address) {
  const lines = String(text).split('\n'); const m = /^(.+) wants you to sign in with your Solana account:$/.exec(lines[0] || '');
  if (!m || !siteHosts(env).includes(m[1])) return { error: 'sign-in message is for another site' };
  if (lines[1] !== address) return { error: 'sign-in message is for another wallet' };
  const field = (k) => (lines.find((l) => l.startsWith(k + ': ')) || '').slice(k.length + 2);
  const nonce = field('Nonce'); const issued = Date.parse(field('Issued At'));
  if (!nonce) return { error: 'sign-in message has no nonce' };
  if (!(Math.abs(Date.now() - issued) < NONCE_MS)) return { error: 'sign-in message expired — try again' };
  const exp = field('Expiration Time'); if (exp && Date.parse(exp) < Date.now()) return { error: 'sign-in message expired — try again' };
  return { nonce };
}
export async function mintSession(env, id) { const exp = Date.now() + SESSION_MS; const body = b64u(te.encode(id + '|' + exp)); return body + '.' + (await hmac(secretOf(env), body)); }
export async function readSession(env, token) {
  if (!env.ACCOUNT_SECRET && !env.GATE_SECRET) return null;
  const [body, mac] = String(token || '').split('.'); if (!body || !mac) return null;
  if (!eq(await hmac(secretOf(env), body), mac)) return null;
  let s; try { s = atob(body.replace(/-/g, '+').replace(/_/g, '/')); } catch { return null; }
  const i = s.lastIndexOf('|'); const id = s.slice(0, i), exp = Number(s.slice(i + 1));
  return exp > Date.now() ? id : null;
}

// ---- email sign-in ----
const CODE_MS = 10 * 60000, CODE_TRIES = 5, SEND_GAP_MS = 30000, SENDS_PER_HOUR = 8, PW_FAILS = 10, PW_LOCK_MS = 60 * 60000;
// lower-cased, trimmed; a plain address only (no quotes, spaces or '|', which the session token uses as a separator)
export const cleanEmail = (v) => { const e = String(v || '').trim().toLowerCase(); return e.length <= 254 && /^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}$/.test(e) ? e : null; };
const codeHash = (env, email, code) => hmac(secretOf(env), 'code:' + email + ':' + code);
const authHash = (env, email, auth) => hmac(secretOf(env), 'email-auth:' + email + ':' + auth);
async function sendCode(env, email, code) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) throw new Error('email sign-in is not set up yet');
  const text = 'Your arenalaunch sign-in code is ' + code + '\n\nIt works for 10 minutes. If you did not ask for it, ignore this email: nobody can sign in without your password too.\n\nWe will never ask you for this code or your password.';
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ from: env.EMAIL_FROM, to: [email], subject: 'arenalaunch code: ' + code, text }) });
  if (!r.ok) throw new Error('could not send the email (' + r.status + ') — try again in a minute');
}
// the code for this email, checked (does not use it up); returns {rec} or {error, status}
const codeKey = async (env, email, ticket) => 'c:' + email + ':' + (await hmac(secretOf(env), 'ticket:' + ticket)).slice(0, 22);
async function codeOk(env, S, email, ticket, code) {
  if (!/^[A-Za-z0-9_-]{22}$/.test(String(ticket || ''))) return { error: 'send yourself a new code', status: 400 };
  const key = await codeKey(env, email, ticket); const c = await S.get(key);
  if (!c || Date.now() > c.exp) return { error: 'that code expired — send a new one', status: 400 };
  if (c.tries >= CODE_TRIES) return { error: 'too many wrong codes — send a new one', status: 429 };
  if (!/^\d{6}$/.test(String(code || '')) || !eq(await codeHash(env, email, String(code)), c.hash)) { c.tries++; await S.put(key, c); return { error: 'wrong code', status: 401 }; }
  return { rec: c, key };
}

// ---- the owner's account numbers, kept as a running summary ('sum') so the dashboard never scans every record ----
// test accounts (vault 'blob1' / 'stale', written by tools/account-check.mjs) are left out, as before
const counted = (rec) => !!rec && rec.vault !== 'blob1' && rec.vault !== 'stale';
async function adjustSum(S, id, before, after) {
  const sum = await S.get('sum'); if (!sum) return; // not seeded yet: the first dashboard read builds it from a full scan
  const day = (r) => new Date(r.created || 0).toISOString().slice(0, 10);
  if (counted(before)) { sum.total--; if (before.vault) sum.withWallets--; const d = day(before); sum.byDay[d] = (sum.byDay[d] || 1) - 1; if (!sum.byDay[d]) delete sum.byDay[d]; }
  if (counted(after)) { sum.total++; if (after.vault) sum.withWallets++; const d = day(after); sum.byDay[d] = (sum.byDay[d] || 0) + 1; }
  if (!before && after) sum.latest = [id, ...sum.latest.filter((x) => x !== id)].slice(0, 60);
  if (!after) sum.latest = sum.latest.filter((x) => x !== id);
  await S.put('sum', sum);
}
const ABANDONED_MS = 30 * 86400000; // a wallet account that never saved anything: gone after 30 days (signing in again recreates it)
// a few records per sign-in, round-robin: delete wallet accounts with nothing saved (no vault), plus stale email code/send records
async function prune(S) {
  const now = Date.now(); const cur = (await S.get('prunecur')) || 'w:';
  const page = await S.list({ prefix: 'w:', start: cur, limit: 40 }); let last = null;
  for (const [k, rec] of page) { last = k; if (!rec.vault && now - (rec.seen || rec.created || 0) > ABANDONED_MS) { await S.delete(k); await adjustSum(S, k, rec, null); } }
  await S.put('prunecur', page.size < 40 || !last ? 'w:' : last + ' ');
  for (const [k, q] of await S.list({ prefix: 'q:', limit: 40 })) if (!(q.sends || []).some((t) => now - t < 3600000)) await S.delete(k);
  for (const [k, c] of await S.list({ prefix: 'c:', limit: 40 })) if (now > c.exp) await S.delete(k);
}

// One Durable Object holds every account (small records, strictly serialized writes).
export class Accounts {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(req) {
    const op = new URL(req.url).pathname.slice(1); const b = await req.json().catch(() => ({}));
    const S = this.ctx.storage; const out = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
    const view = async (id, rec) => out({ session: await mintSession(this.env, id), id, kind: rec.kind, vault: rec.vault || null, ver: rec.ver || 0 });

    if (op === 'nonce') return out({ nonce: await newNonce(this.env) });
    if (op === 'wallet') {
      const a = String(b.address || '');
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return out({ error: 'address' }, 400);
      let ok = false;
      if (b.message != null) {
        // Sign In With Solana: the signed bytes are the message itself (UTF-8), sent back as base58
        let bytes; try { bytes = bs58.decode(String(b.message)); } catch { return out({ error: 'bad sign-in message' }, 400); }
        if (bytes.length > 2000) return out({ error: 'bad sign-in message' }, 400);
        const r = readSiws(this.env, new TextDecoder().decode(bytes), a); if (r.error) return out({ error: r.error }, 400);
        if (!(await nonceOk(this.env, r.nonce))) return out({ error: 'sign-in expired — try again' }, 400);
        try { ok = ed25519.verify(bs58.decode(String(b.sig || '')), bytes, bs58.decode(a)); } catch {}
        if (!ok) return out({ error: 'signature rejected' }, 401);
        // single use: a nonce that already signed someone in never works again (kept until it would have expired anyway)
        if (await S.get('n:' + r.nonce)) return out({ error: 'sign-in already used — try again' }, 400);
        await S.put('n:' + r.nonce, Date.now());
        const old = await S.list({ prefix: 'n:', limit: 100 }); for (const [k, t] of old) if (Date.now() - t > NONCE_MS * 2) await S.delete(k);
      } else return out({ error: 'this page is out of date — reload it to sign in' }, 400); // the old fixed-message sign-in is gone
      const id = 'w:' + a; let rec = await S.get(id);
      const isNew = !rec; if (!rec) { rec = { kind: 'wallet', name: a, vault: null, ver: 0, created: Date.now() }; await S.put(id, rec); await adjustSum(S, id, null, rec); }
      else if (!rec.vault) { rec.seen = Date.now(); await S.put(id, rec); } // nothing saved yet: keep it off the prune list while it is used
      await prune(S);
      await record(this.env, 'signin', { isNew });
      return view(id, rec);
    }
    if (op === 'email-start' || op === 'email-check' || op === 'email-login') {
      const email = cleanEmail(b.email); if (!email) return out({ error: 'enter a valid email address' }, 400);
      if (op === 'email-start') {
        const now = Date.now(); const q = (await S.get('q:' + email)) || { sends: [] }; q.sends = q.sends.filter((t) => now - t < 3600000);
        if (q.sends.length && now - q.sends[q.sends.length - 1] < SEND_GAP_MS) return out({ error: 'a code was just sent — wait a minute before asking for another' }, 429);
        if (q.sends.length >= SENDS_PER_HOUR) return out({ error: 'too many codes for this email — try again in an hour' }, 429);
        const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
        try { await sendCode(this.env, email, code); } catch (e) { return out({ error: e.message }, 503); }
        q.sends.push(now); await S.put('q:' + email, q);
        for (const [k, c] of await S.list({ prefix: 'c:' + email + ':' })) if (now > c.exp) await S.delete(k); // expired codes
        const ticket = b64u(crypto.getRandomValues(new Uint8Array(16)));
        await S.put(await codeKey(this.env, email, ticket), { hash: await codeHash(this.env, email, code), exp: now + CODE_MS, tries: 0 });
        return out({ ok: true, ticket });
      }
      const c = await codeOk(this.env, S, email, b.ticket, b.code); if (c.error) return out({ error: c.error }, c.status);
      const id = 'e:' + email; let rec = await S.get(id);
      if (op === 'email-check') return out({ exists: !!rec });
      // email-login: auth is 32 bytes from the browser's key stretch (base64url), never the password itself
      const auth = String(b.auth || ''); if (!/^[A-Za-z0-9_-]{43}$/.test(auth)) return out({ error: 'this page is out of date — reload it to sign in' }, 400);
      const h = await authHash(this.env, email, auth); const isNew = !rec;
      if (rec) {
        const now = Date.now(); if (rec.lockUntil > now) return out({ error: 'too many wrong passwords — try again in ' + Math.ceil((rec.lockUntil - now) / 60000) + ' min' }, 429);
        if (!eq(h, rec.auth)) {
          rec.fails = (rec.fails || 0) + 1; if (rec.fails >= PW_FAILS) { rec.fails = 0; rec.lockUntil = now + PW_LOCK_MS; }
          await S.put(id, rec); return out({ error: 'wrong password' }, 401);
        }
        if (rec.fails || rec.lockUntil) { rec.fails = 0; rec.lockUntil = 0; await S.put(id, rec); }
      } else { rec = { kind: 'email', name: email, auth: h, vault: null, ver: 0, created: Date.now() }; await S.put(id, rec); await adjustSum(S, id, null, rec); }
      await S.delete(c.key); // the code is used up
      await record(this.env, 'signin', { isNew });
      return view(id, rec);
    }
    if (op === 'count') {
      let sum = await S.get('sum');
      if (!sum) { // first read: one full scan seeds the running summary; from then on sign-ins and saves keep it current
        sum = { total: 0, withWallets: 0, byDay: {}, latest: [] }; const all = [];
        for (const [id, rec] of [...(await S.list({ prefix: 'w:' })), ...(await S.list({ prefix: 'e:' }))]) { if (!counted(rec)) continue; sum.total++; if (rec.vault) sum.withWallets++; const d = new Date(rec.created || 0).toISOString().slice(0, 10); sum.byDay[d] = (sum.byDay[d] || 0) + 1; all.push([rec.created || 0, id]); }
        sum.latest = all.sort((x, y) => y[0] - x[0]).slice(0, 60).map((x) => x[1]); await S.put('sum', sum);
      }
      const recs = await S.get(sum.latest.slice(0, 60)); const latest = [];
      for (const id of sum.latest) { const rec = recs.get(id); if (!counted(rec)) continue; latest.push({ created: rec.created || 0, wallet: rec.kind === 'email' ? rec.name.replace(/^(.).*@/, '$1…@') : rec.name.slice(0, 4) + '…' + rec.name.slice(-4), saved: !!rec.vault }); if (latest.length === 25) break; }
      return out({ total: sum.total, withWallets: sum.withWallets, byDay: sum.byDay, latest });
    }
    if (op === 'vault' || op === 'save') {
      const id = await readSession(this.env, b.session); if (!id) return out({ error: 'session expired — log in again' }, 401);
      const rec = await S.get(id); if (!rec) return out({ error: 'no such account' }, 404);
      if (op === 'vault') return out({ vault: rec.vault || null, ver: rec.ver || 0, kind: rec.kind, name: rec.name });
      // 64 KB holds a few hundred wallets; an account that is already bigger (saved under the old cap) may keep saving at its size
      const v = String(b.vault || ''); if (v.length > 65536 && v.length > String(rec.vault || '').length) return out({ error: 'too many saved wallets — remove some first' }, 413);
      if (Number(b.ver) !== (rec.ver || 0)) return out({ error: 'your wallets changed in another tab — reload to get the latest', ver: rec.ver || 0, conflict: true }, 409);
      const before = { ...rec }; rec.vault = v; rec.ver = (rec.ver || 0) + 1; rec.saved = Date.now(); await S.put(id, rec); await adjustSum(S, id, before, rec);
      return out({ ver: rec.ver });
    }
    return out({ error: 'not found' }, 404);
  }
}
