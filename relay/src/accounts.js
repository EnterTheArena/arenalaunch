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
export const siteHosts = (env) => [...(env.ALLOWED_ORIGINS || '').split(',').map((o) => { try { return new URL(o.trim()).host; } catch { return null; } }).filter(Boolean), 'localhost:5182', '127.0.0.1:5182'];
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
async function mintSession(env, id) { const exp = Date.now() + SESSION_MS; const body = b64u(te.encode(id + '|' + exp)); return body + '.' + (await hmac(secretOf(env), body)); }
export async function readSession(env, token) {
  if (!env.ACCOUNT_SECRET && !env.GATE_SECRET) return null;
  const [body, mac] = String(token || '').split('.'); if (!body || !mac) return null;
  if (!eq(await hmac(secretOf(env), body), mac)) return null;
  let s; try { s = atob(body.replace(/-/g, '+').replace(/_/g, '/')); } catch { return null; }
  const i = s.lastIndexOf('|'); const id = s.slice(0, i), exp = Number(s.slice(i + 1));
  return exp > Date.now() ? id : null;
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
      const isNew = !rec; if (!rec) { rec = { kind: 'wallet', name: a, vault: null, ver: 0, created: Date.now() }; await S.put(id, rec); }
      await record(this.env, 'signin', { isNew });
      return view(id, rec);
    }
    if (op === 'count') {
      const byDay = {}; let total = 0, withWallets = 0; const latest = [];
      for (const [, rec] of await S.list({ prefix: 'w:' })) { if (rec.vault === 'blob1' || rec.vault === 'stale') continue; total++; if (rec.vault) withWallets++; latest.push({ created: rec.created || 0, wallet: rec.name.slice(0, 4) + '…' + rec.name.slice(-4), saved: !!rec.vault }); const d = new Date(rec.created || 0).toISOString().slice(0, 10); byDay[d] = (byDay[d] || 0) + 1; }
      latest.sort((x, y) => y.created - x.created);
      return out({ total, withWallets, byDay, latest: latest.slice(0, 25) });
    }
    if (op === 'vault' || op === 'save') {
      const id = await readSession(this.env, b.session); if (!id) return out({ error: 'session expired — log in again' }, 401);
      const rec = await S.get(id); if (!rec) return out({ error: 'no such account' }, 404);
      if (op === 'vault') return out({ vault: rec.vault || null, ver: rec.ver || 0, kind: rec.kind, name: rec.name });
      // 64 KB holds a few hundred wallets; an account that is already bigger (saved under the old cap) may keep saving at its size
      const v = String(b.vault || ''); if (v.length > 65536 && v.length > String(rec.vault || '').length) return out({ error: 'too many saved wallets — remove some first' }, 413);
      if (Number(b.ver) !== (rec.ver || 0)) return out({ error: 'your wallets changed in another tab — reload to get the latest', ver: rec.ver || 0, conflict: true }, 409);
      rec.vault = v; rec.ver = (rec.ver || 0) + 1; rec.saved = Date.now(); await S.put(id, rec);
      return out({ ver: rec.ver });
    }
    return out({ error: 'not found' }, 404);
  }
}
