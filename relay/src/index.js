// ============================================================================
// PUMPCALL LOBBY RELAY — Cloudflare Worker + one Durable Object per lobby.
//
// A dev opens a lobby; teammates join from their own copy of the app with their
// own wallet. When the dev launches, the relay fans the buy TEMPLATE out to every
// member; each member's app clones + signs its buy LOCALLY and returns only the
// signed transaction. The relay assembles create + buys into Jito bundles and
// submits them. Nothing here ever sees a private key — only public keys, a
// signed challenge (join), and signed transactions (launch).
//
// The DO hibernates between messages: member records live in the WebSocket
// attachments (rehydrated on every wake) and launch state lives in storage
// with an alarm, so an eviction mid-launch still assembles on time.
//
// HTTP:  POST /lobby/create → {code}        GET /lobby/:code/ws (WebSocket)
// WS (client→relay): hello | amount | ready | name | policy | kick | launch | signed | abort
// WS (relay→client): roster | sign | log | result | error
// ============================================================================
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
export { Accounts } from './accounts.js';
export { Stats } from './stats.js';
import { record } from './stats.js';
import { readSession } from './accounts.js';
import { pda, ata, text } from './pda.js';
import { verifyMessage, Transaction as EvmTx, Interface as EvmInterface, getAddress } from 'ethers';

// ---- Robinhood Chain (Pons v2) ----
// Squad launch on an EVM chain: no Jito. Pons tokens are CREATE2 (curve address known
// before the launch) and launchAndBuy takes snipeTaxExemptions, so: the dev launches
// with the squad whitelisted, members PRE-SIGN curve.buy() to the predicted curve, and
// the relay broadcasts them the instant the launch receipt is confirmed (65ms blocks).
// Snipers in the first 5s pay a 99%→0% snipe tax; the squad pays none.
const RH = { chainId: 4663, rpcs: ['https://rpc.mainnet.chain.robinhood.com'], curveBuy: new EvmInterface(['function buy(uint256 quoteIn,uint256 minTokensOut,address recipient) payable returns (uint256)']) };
async function rhRpc(method, params) {
  let last; for (const url of RH.rpcs) { try { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message || 'rpc'); return j.result; } catch (e) { last = e; } }
  throw last || new Error('rpc');
}
const isEvmAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || '');
const lc = (a) => String(a || '').toLowerCase();
async function balancesEvm(wallets) { const out = {}; for (const w of wallets) { try { out[w] = Number(BigInt(await rhRpc('eth_getBalance', [w, 'latest']))) / 1e18; } catch {} } return out; }
// a member's pre-signed buy must be exactly: curve.buy(amount, minOut, self) with value == amount, from the member, on chain 4663
export function validateEvmBuy(raw, member, L) {
  let tx; try { tx = EvmTx.from(raw); } catch { return 'unparseable tx'; }
  if (Number(tx.chainId) !== RH.chainId) return 'wrong chain';
  if (!tx.from || lc(tx.from) !== lc(member.wallet)) return 'not signed by your wallet';
  if (lc(tx.to) !== lc(L.predicted?.curve)) return 'not sent to the launch curve';
  const want = BigInt(Math.round(member.amount * 1e6)) * 10n ** 12n; // ETH → wei (6-dp precision)
  if (tx.value !== want) return 'value mismatch (' + tx.value + ' vs ' + want + ')';
  let d; try { d = RH.curveBuy.parseTransaction({ data: tx.data, value: tx.value }); } catch { return 'not a curve.buy call'; }
  if (!d || d.name !== 'buy') return 'not a curve.buy call';
  if (d.args[0] !== want) return 'quoteIn mismatch';
  if (lc(d.args[2]) !== lc(member.wallet)) return 'recipient is not you';
  if (tx.gasLimit < 120000n) return 'gas limit too low';
  return null;
}
const evmWei = (eth) => BigInt(Math.round(eth * 1e6)) * 10n ** 12n;
async function waitReceipt(hash, ms) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await rhRpc('eth_getTransactionReceipt', [hash]); if (r) return r; } catch {} await sleep(120); } return null; }

const JITO = ['https://mainnet.block-engine.jito.wtf', 'https://ny.mainnet.block-engine.jito.wtf', 'https://amsterdam.mainnet.block-engine.jito.wtf', 'https://frankfurt.mainnet.block-engine.jito.wtf', 'https://tokyo.mainnet.block-engine.jito.wtf', 'https://slc.mainnet.block-engine.jito.wtf', 'https://london.mainnet.block-engine.jito.wtf', 'https://dublin.mainnet.block-engine.jito.wtf', 'https://singapore.mainnet.block-engine.jito.wtf'];
const regionName = (u) => u.replace('https://', '').split('.')[0];
const MAX_TX = 5;
const MAX_MEMBERS = 20; // people in one lobby, dev included (pump.fun fee sharing takes 10; the rest just buy)
const LOBBY_IDLE_MS = 7 * 86400000; // a lobby nobody has opened for a week is deleted (its code becomes free again)
const MAX_LOCK_S = 7 * 86400 + 2 * 3600; // the page offers 1 h / 24 h / 7 days after go-live; nothing longer is ever signed
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (a) => (a && a.length > 12 ? a.slice(0, 4) + '…' + a.slice(-4) : a || '');

// ---- site gate (shared with the Vercel site): token = base64url(exp) + '.' + base64url(HMAC-SHA256(GATE_SECRET, exp))
async function gateOk(env, token) {
  if (!env.GATE_SECRET) return false; // fail closed: a missing secret must never open the relay
  const [expB, sigB] = String(token || '').split('.'); if (!expB || !sigB) return false;
  const exp = Number(atob(expB.replace(/-/g, '+').replace(/_/g, '/'))); if (!(exp > Date.now())) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.GATE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(exp))));
  const want = btoa(String.fromCharCode(...mac)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (want.length !== sigB.length) return false; let d = 0; for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ sigB.charCodeAt(i); return d === 0;
}
// constant-time string compare (hash both sides first so the length does not leak either)
async function safeEq(a, b) { const h = async (x) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(x)))); const [x, y] = await Promise.all([h(a), h(b)]); let d = 0; for (let i = 0; i < 32; i++) d |= x[i] ^ y[i]; return d === 0 && String(a).length > 0; }
// per-IP fixed-window counter (RateLimit DO). Generous limits aimed at scripts, not people. Fails open if the DO is unreachable.
async function overLimit(env, ip, bucket, limit, windowMs = 60000) { try { const r = await env.RATELIMIT.get(env.RATELIMIT.idFromName('b:' + bucket + ':' + ip)).fetch('https://rl/count', { method: 'POST', body: JSON.stringify({ limit, windowMs }) }); return !(await r.json()).allowed; } catch { return false; } }
// the owner: a session (from Sign In With Solana on the site) of the ADMIN_WALLET. Fails closed when the var is unset.
async function isAdmin(env, req) { if (!env.ADMIN_WALLET) return false; const id = await readSession(env, req.headers.get('x-session') || ''); return !!id && id === 'w:' + env.ADMIN_WALLET; }
// a teammate's extra wallets in a launch: {n, sol}, bounded (10 wallets, 100 SOL each)
const extraOf = (e) => { const n = Math.min(10, Math.max(0, Math.floor(Number(e?.n) || 0))); const sol = Math.min(n * 100, Math.max(0, Number(e?.sol) || 0)); return n && Number.isFinite(sol) && sol > 0 ? { n, sol } : null; };
const ipOf = (req) => req.headers.get('cf-connecting-ip') || 'unknown';
const ACCT_LIMITS = { wallet: [30, 60000], nonce: [60, 60000], save: [60, 60000], vault: [120, 60000], 'email-start': [10, 3600000], 'email-check': [30, 60000], 'email-login': [30, 60000] };
// a buy amount (SOL / ETH): a finite number in (0, 100]; anything else counts as 0
export const amountOf = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 && n <= 100 ? n : 0; };
const cookieToken = (req) => (/(?:^|;\s*)sq_gate=([^;]+)/.exec(req.headers.get('cookie') || '') || [])[1] || null;
// browsers send Origin; scripts usually do not (they still need the gate token). Localhost is allowed only when the DEV
// var is set (wrangler dev / .dev.vars), never in production.
const allowedOrigin = (env, o) => (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean).includes(o) || (!!env.DEV && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o));
export const originOk = (env, req) => { const o = req.headers.get('origin'); return !o || allowedOrigin(env, o); };
// CORS reflects an origin only when it is one of ours
export const cors = (env, req) => ({ ...(allowedOrigin(env, req.headers.get('origin') || '') ? { 'access-control-allow-origin': req.headers.get('origin') } : {}), 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'content-type,x-gate,authorization,x-session', 'access-control-allow-methods': 'POST,GET,OPTIONS', 'vary': 'origin' });

export default {
  async fetch(req, env) {
    useRpc(env);
    const u = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(env, req) });
    if (u.pathname === '/health') { let rpc = 'public only'; try { if (env.SOL_RPC_URL) rpc = new URL(env.SOL_RPC_URL).host + ' first'; } catch { rpc = 'SOL_RPC_URL set but not a URL'; } return json({ ok: true, t: Date.now(), gated: !!env.GATE_SECRET, rpc, order: RPCS.map((x) => { try { return new URL(x).host; } catch { return '?'; } }) }); } // hosts only, never the key
    if (!originOk(env, req)) return json({ error: 'forbidden origin' }, 403);
    // per-IP attempt limiter for the site's password form (called by the Vercel gate function with a shared key)
    if (req.method === 'POST' && u.pathname === '/ratelimit') {
      if (!env.RL_KEY || !(await safeEq(req.headers.get('x-rl-key') || '', env.RL_KEY))) return json({ error: 'forbidden' }, 403);
      const b = await req.json().catch(() => ({})); const ip = String(b.ip || 'unknown').slice(0, 64);
      // the site's API functions: a named bucket with its own limit (/api/sol, /api/ipfs, /api/pump)
      if (b.bucket) { const bucket = String(b.bucket).replace(/[^a-z0-9_-]/gi, '').slice(0, 24); const over = await overLimit(env, ip, 'site-' + bucket, Math.min(10000, Math.max(1, Number(b.limit) || 60)), Math.min(3600000, Math.max(1000, Number(b.windowMs) || 60000))); return json({ allowed: !over }); }
      return env.RATELIMIT.get(env.RATELIMIT.idFromName('ip:' + ip)).fetch('https://rl/hit', { method: 'POST', body: JSON.stringify({ ok: !!b.ok, limit: 8, windowMs: 15 * 60000 }) });
    }
    // the site's API functions checking a visitor's account session (server to server, shared RL_KEY)
    if (req.method === 'POST' && u.pathname === '/session/check') {
      if (!env.RL_KEY || !(await safeEq(req.headers.get('x-rl-key') || '', env.RL_KEY))) return json({ error: 'forbidden' }, 403);
      const b = await req.json().catch(() => ({})); return json({ id: await readSession(env, String(b.session || '').slice(0, 512)) });
    }
    // accounts: one Durable Object holds them all (see accounts.js)
    const acct = /^\/account\/(nonce|wallet|vault|save|email-start|email-check|email-login)$/.exec(u.pathname);
    if (acct && req.method === 'POST') {
      if (!(await gateOk(env, req.headers.get('x-gate') || cookieToken(req)))) return json({ error: 'gate' }, 401);
      if (!env.ACCOUNT_SECRET && !env.GATE_SECRET) return json({ error: 'accounts are not configured' }, 503); // never sign sessions with an empty key
      if (await overLimit(env, ipOf(req), 'acct-' + acct[1], ...ACCT_LIMITS[acct[1]])) return new Response(JSON.stringify({ error: 'too many requests — wait a minute' }), { status: 429, headers: { 'content-type': 'application/json', ...cors(env, req) } });
      const r = await env.ACCOUNTS.get(env.ACCOUNTS.idFromName('all')).fetch('https://acct/' + acct[1], { method: 'POST', body: await req.text() });
      return new Response(await r.text(), { status: r.status, headers: { 'content-type': 'application/json', ...cors(env, req) } });
    }
    if (req.method === 'POST' && u.pathname === '/stats/visit') {
      if (!(await gateOk(env, req.headers.get('x-gate') || cookieToken(req)))) return json({ error: 'gate' }, 401);
      if (await overLimit(env, ipOf(req), 'visit', 30)) return new Response('{}', { status: 429, headers: { 'content-type': 'application/json', ...cors(env, req) } });
      const b = await req.json().catch(() => ({})); await record(env, 'visit', { v: String(b.v || '') });
      return new Response('{}', { headers: { 'content-type': 'application/json', ...cors(env, req) } });
    }
    // a page reporting a problem a user hit (shown on the owner's dashboard): message, where, wallet, lobby, browser
    // signed-in sessions only (x-session), a small body, and a per-account limit: nobody can fill the owner's list anonymously
    if (req.method === 'POST' && u.pathname === '/stats/error') {
      if (!(await gateOk(env, req.headers.get('x-gate') || cookieToken(req)))) return json({ error: 'gate' }, 401);
      const h = { 'content-type': 'application/json', ...cors(env, req) };
      const who = await readSession(env, (req.headers.get('x-session') || '').slice(0, 512)); if (!who) return new Response('{"error":"sign in first"}', { status: 401, headers: h });
      if (await overLimit(env, ipOf(req), 'err', 30)) return new Response('{}', { status: 429, headers: h });
      if (await overLimit(env, who, 'err-acct', 20, 600000)) return new Response('{}', { status: 429, headers: h });
      const text = await req.text(); if (text.length > 2048) return new Response('{"error":"too long"}', { status: 413, headers: h });
      let b = {}; try { b = JSON.parse(text) || {}; } catch {}
      await record(env, 'error', { src: 'site', level: b.level, where: b.where, msg: b.msg, wallet: b.wallet, lobby: b.lobby, ua: b.ua, role: b.role, account: who });
      return new Response('{}', { headers: h });
    }
    if (req.method === 'POST' && u.pathname === '/stats/errors/clear') {
      if (!(await isAdmin(env, req))) return new Response(JSON.stringify({ error: 'admin only' }), { status: 403, headers: { 'content-type': 'application/json', ...cors(env, req) } });
      await env.STATS.get(env.STATS.idFromName('all')).fetch('https://stats/errclear', { method: 'POST' });
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json', ...cors(env, req) } });
    }
    if (req.method === 'GET' && u.pathname === '/stats/summary') {
      if (!(await isAdmin(env, req))) return new Response(JSON.stringify({ error: 'admin only' }), { status: 403, headers: { 'content-type': 'application/json', ...cors(env, req) } });
      const [s, a] = await Promise.all([env.STATS.get(env.STATS.idFromName('all')).fetch('https://stats/summary').then((r) => r.json()), env.ACCOUNTS.get(env.ACCOUNTS.idFromName('all')).fetch('https://acct/count', { method: 'POST', body: '{}' }).then((r) => r.json())]);
      return new Response(JSON.stringify({ ...s, accounts: a }), { headers: { 'content-type': 'application/json', ...cors(env, req) } });
    }
    // public showcase: coins that actually launched through arenalaunch — mint, time, and their on-chain name/ticker/image
    if (req.method === 'GET' && u.pathname === '/launches') {
      const h = { 'content-type': 'application/json', 'cache-control': 'public, max-age=60', ...cors(env, req) };
      if (await overLimit(env, ipOf(req), 'launches', 60)) return new Response('{"launches":[]}', { status: 429, headers: h });
      const cache = caches.default; const key = new Request('https://cache.arenalaunch/launches');
      const hit = await cache.match(key); if (hit) return new Response(hit.body, { headers: h });
      const body = await (await env.STATS.get(env.STATS.idFromName('all')).fetch('https://stats/public')).text();
      await cache.put(key, new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' } }));
      return new Response(body, { headers: h });
    }
    // owner (admin wallet session): hide a coin from the public list, or put it back — {mint, hide: true|false}
    if (req.method === 'POST' && u.pathname === '/launches/hide') {
      if (!(await isAdmin(env, req))) return new Response(JSON.stringify({ error: 'admin only' }), { status: 403, headers: { 'content-type': 'application/json', ...cors(env, req) } });
      const r = await env.STATS.get(env.STATS.idFromName('all')).fetch('https://stats/hide', { method: 'POST', body: await req.text() });
      await caches.default.delete(new Request('https://cache.arenalaunch/launches'));
      return new Response(await r.text(), { status: r.status, headers: { 'content-type': 'application/json', ...cors(env, req) } });
    }
    if (req.method === 'POST' && u.pathname === '/lobby/create') {
      if (!(await gateOk(env, req.headers.get('x-gate') || cookieToken(req)))) return json({ error: 'gate' }, 401);
      if (await overLimit(env, ipOf(req), 'lobby', 30)) return new Response(JSON.stringify({ error: 'too many lobbies from this connection — wait a minute' }), { status: 429, headers: { 'content-type': 'application/json', ...cors(env, req) } });
      const body = await req.json().catch(() => ({})); const chain = body.chain === 'rh' ? 'rh' : 'sol';
      let code = '';
      for (let tries = 0; tries < 5; tries++) {
        code = ''; for (const b of crypto.getRandomValues(new Uint8Array(6))) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
        const r = await env.LOBBY.get(env.LOBBY.idFromName(code)).fetch('https://lobby/init', { method: 'POST', body: JSON.stringify({ code, chain }) });
        if (r.ok) break; code = ''; // taken (never re-initialise a lobby that exists: its dev seat is permanent)
      }
      if (!code) return json({ error: 'could not open a lobby — try again' }, 503);
      await record(env, 'lobby');
      return new Response(JSON.stringify({ code, chain }), { headers: { 'content-type': 'application/json', ...cors(env, req) } });
    }
    const lb = /^\/lobby\/([A-Z2-9]{6})\/lastbundle$/.exec(u.pathname);
    if (lb) {
      if (!(await gateOk(env, req.headers.get('x-gate') || cookieToken(req) || u.searchParams.get('g')))) return json({ error: 'gate' }, 401);
      const r = await env.LOBBY.get(env.LOBBY.idFromName(lb[1])).fetch('https://lobby/lastbundle');
      return new Response(await r.text(), { status: r.status, headers: { 'content-type': 'application/json', ...cors(env, req) } });
    }
    const m = /^\/lobby\/([A-Z2-9]{6})\/ws$/.exec(u.pathname);
    if (m) {
      if (req.headers.get('upgrade') !== 'websocket') return json({ error: 'expected websocket' }, 426);
      // browsers can't set headers on a WebSocket: the gate token rides as ?g= (or the site cookie); the exe sends ?g= too
      if (!(await gateOk(env, u.searchParams.get('g') || cookieToken(req)))) return json({ error: 'gate' }, 401);
      return env.LOBBY.get(env.LOBBY.idFromName(m[1])).fetch(req);
    }
    return json({ error: 'not found' }, 404);
  },
};

// sliding-window attempt counter, one DO per IP (tiny, evicts itself)
export class RateLimit {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(req) {
    const b = await req.json();
    if (new URL(req.url).pathname === '/count') {
      // fixed window: one small record per IP and bucket, cleared by the alarm when the window is long gone
      const now = Date.now(); let w = (await this.ctx.storage.get('w')) || null;
      if (!w || now - w.start >= b.windowMs) { w = { start: now, n: 0 }; await this.ctx.storage.setAlarm(now + b.windowMs * 2); }
      w.n++; await this.ctx.storage.put('w', w);
      return json({ allowed: w.n <= b.limit, n: w.n });
    }
    let hits = (await this.ctx.storage.get('hits')) || [];
    const now = Date.now(); hits = hits.filter((t) => now - t < b.windowMs);
    if (b.ok) { await this.ctx.storage.delete('hits'); return json({ allowed: true, remaining: b.limit }); }
    if (hits.length >= b.limit) { await this.ctx.storage.put('hits', hits); return json({ allowed: false, retryMs: b.windowMs - (now - hits[0]) }); }
    hits.push(now); await this.ctx.storage.put('hits', hits); await this.ctx.storage.setAlarm(now + b.windowMs);
    return json({ allowed: true, remaining: b.limit - hits.length });
  }
  async alarm() { await this.ctx.storage.deleteAll(); }
}

export class Lobby {
  constructor(ctx, env) {
    useRpc(env); this.ctx = ctx; this.env = env;
    this.code = null; this.dev = null; this.policy = { waitMs: 8000 }; this.chain = 'sol';
    this.members = new Map(); // wallet -> { wallet, name, amount, ready, role, ws }
    this.ctx.blockConcurrencyWhile(async () => { const s = await this.ctx.storage.get('meta'); if (s) { this.code = s.code; this.dev = s.dev; this.policy = s.policy || this.policy; this.chain = s.chain || 'sol'; } });
  }
  async persist() { await this.ctx.storage.put('meta', { code: this.code, dev: this.dev, policy: this.policy, chain: this.chain }); }
  get evm() { return this.chain === 'rh'; }
  // rebuild the roster from socket attachments (survives hibernation)
  hydrate() {
    const live = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment(); if (!a?.wallet) continue;
      live.add(a.wallet);
      const m = this.members.get(a.wallet);
      if (m) { m.ws = ws; } else this.members.set(a.wallet, { wallet: a.wallet, name: a.name, amount: a.amount, extra: a.extra || null, ready: a.ready, role: a.role, ws });
    }
    for (const m of this.members.values()) if (!live.has(m.wallet)) m.ws = null;
  }
  attach(m) { try { m.ws?.serializeAttachment({ wallet: m.wallet, name: m.name, amount: m.amount, extra: m.extra || null, ready: m.ready, role: m.role }); } catch {} }

  async fetch(req) {
    if (new URL(req.url).pathname === '/lastbundle') { const b = await this.ctx.storage.get('lastBundle'); return new Response(JSON.stringify(b || null), { headers: { 'content-type': 'application/json' } }); }
    const u = new URL(req.url);
    if (u.pathname === '/init') { if (this.code) return json({ error: 'exists' }, 409); const b = await req.json(); this.code = b.code; this.chain = b.chain === 'rh' ? 'rh' : 'sol'; await this.persist(); await this.keepAlive(); return json({ ok: true }); }
    if (req.headers.get('upgrade') === 'websocket') {
      if (!this.code) return json({ error: 'no such lobby' }, 404); // only lobbies opened through /lobby/create exist
      const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ wallet: null });
      return new Response(null, { status: 101, webSocket: client });
    }
    return json({ error: 'not found' }, 404);
  }

  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  broadcast(obj) {
    for (const ws of this.ctx.getWebSockets()) this.send(ws, obj);
    if (obj?.t === 'result') { const landed = !!obj.ok && obj.createLanded !== false && !obj.dry; this.ctx.waitUntil(record(this.env, obj.dry ? 'rehearsal' : 'launch', { landed, mint: obj.mint || null, slot: obj.slot || null, buyers: (obj.members || []).filter((m) => m.ok !== false).length + (landed ? 1 : 0), members: (obj.members || []).length })); }
  }
  log(kind, msg) {
    this.broadcast({ t: 'log', kind, msg });
    // failures (and the warnings that explain a missed buy) also go to the owner's problems list
    const warn = kind === 'warn' && /rejected|refused|excluded|no signature in time|MISSED|dropped|unavailable/i.test(msg);
    if (kind === 'error' || warn) this.ctx.waitUntil(record(this.env, 'error', { src: 'relay', level: kind === 'error' ? 'error' : 'warn', where: 'lobby', msg, lobby: this.code, wallet: this.dev, role: 'dev' }));
  }
  memberOf(ws) { const a = ws.deserializeAttachment(); return a?.wallet ? this.members.get(a.wallet) : null; }
  async launchState() { return (await this.ctx.storage.get('launch')) || null; }
  async signedMap() { const m = await this.ctx.storage.list({ prefix: 'signed:' }); const out = new Map(); for (const [k, v] of m) out.set(k.slice(7), v); return out; }
  expected() { return [...this.members.values()].filter((x) => x.role === 'member' && x.ws && x.ready && x.amount > 0); }
  async rosterFor(ws, L, signed) {
    const you = this.memberOf(ws)?.wallet || null;
    return { t: 'roster', code: this.code, chain: this.chain, dev: this.dev, you, policy: this.policy, phase: L ? 'launching' : 'idle', fireAt: L?.fireAt || null, mint: L?.mint || null,
      members: [...this.members.values()].map((m) => ({ wallet: m.wallet, name: m.name, amount: m.amount, extra: m.extra || null, ready: !!m.ready, signed: signed.has(m.wallet), online: !!m.ws, role: m.wallet === this.dev ? 'dev' : 'member', balance: this.bal?.[m.wallet] ?? null })) };
  }
  async pushRoster() {
    const L = await this.launchState(); const signed = await this.signedMap();
    for (const ws of this.ctx.getWebSockets()) this.send(ws, await this.rosterFor(ws, L, signed));
    // live balances so the dev sees who's short BEFORE launching (throttled; re-pushes when fresh numbers arrive)
    if (!this.balAt || Date.now() - this.balAt > 12000) {
      this.balAt = Date.now();
      const ws = [...this.members.values()].filter((m) => m.ws).map((m) => m.wallet);
      (this.evm ? balancesEvm(ws) : balances(ws)).then(async (b) => { if (!b) return; this.bal = { ...(this.bal || {}), ...b }; const L2 = await this.launchState(); const s2 = await this.signedMap(); for (const w of this.ctx.getWebSockets()) this.send(w, await this.rosterFor(w, L2, s2)); }).catch(() => {});
    }
  }

  async webSocketMessage(ws, raw) {
    let b; try { b = JSON.parse(raw); } catch { return; }
    this.hydrate();
    const me = this.memberOf(ws);
    try {
      switch (b.t) {
        case 'hello': {
          // prove wallet ownership: ed25519 over "pumpcall-lobby:<code>:<ts>", ts within 2 min
          let wallet = String(b.wallet || ''); const ts = Number(b.ts || 0);
          if (Math.abs(Date.now() - ts) > 120000) return this.send(ws, { t: 'error', msg: 'bad hello' });
          const msg = 'pumpcall-lobby:' + this.code + ':' + ts; let ok = false;
          if (this.evm) { if (!isEvmAddr(wallet)) return this.send(ws, { t: 'error', msg: 'this is a Robinhood Chain lobby — join with an EVM (0x) wallet' }); wallet = getAddress(wallet); try { ok = lc(verifyMessage(msg, String(b.sig || ''))) === lc(wallet); } catch { ok = false; } }
          else { if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) return this.send(ws, { t: 'error', msg: 'this is a Solana lobby — join with a Solana wallet' }); try { ok = ed25519.verify(bs58.decode(String(b.sig || '')), new TextEncoder().encode(msg), bs58.decode(wallet)); } catch { ok = false; } }
          if (!ok) return this.send(ws, { t: 'error', msg: 'signature rejected' });
          if (await this.ctx.storage.get('ban:' + wallet)) return this.send(ws, { t: 'error', msg: 'the dev removed you from this lobby' });
          if (!this.members.has(wallet) && b.role !== 'dev' && this.members.size >= MAX_MEMBERS) return this.send(ws, { t: 'error', msg: 'this lobby is full (' + MAX_MEMBERS + ' people)' });
          // the first wallet to take the dev seat keeps it for good — connected or not, it never passes to anyone else
          if (b.role === 'dev') { if (this.dev && this.dev !== wallet) return this.send(ws, { t: 'error', msg: 'this lobby already has a dev' }); if (!this.dev) { this.dev = wallet; await this.persist(); } }
          const prev = this.members.get(wallet); if (!prev && b.role !== 'dev') await record(this.env, 'join');
          if (prev?.ws && prev.ws !== ws) { try { prev.ws.serializeAttachment({ wallet: null }); prev.ws.close(1000, 'replaced'); } catch {} }
          const m = { wallet, name: String(b.name || short(wallet)).slice(0, 24), amount: amountOf(b.amount), extra: extraOf(b.extra), ready: !!b.ready, ws, role: wallet === this.dev ? 'dev' : 'member' };
          this.members.set(wallet, m); this.attach(m); await this.keepAlive();
          this.log('info', (m.role === 'dev' ? 'dev ' : '') + m.name + ' joined' + (m.role === 'member' ? ' · ' + m.amount + (this.evm ? ' ETH' : ' SOL') : ''));
          await this.pushRoster();
          const L = await this.launchState();
          if (L && m.role === 'member' && m.ready && m.amount > 0) this.send(ws, L.chain === 'rh' ? { t: 'sign', chain: 'rh', curve: L.predicted.curve, token: L.predicted.token, deadline: L.startedAt + this.policy.waitMs, dry: L.dry } : { t: 'sign', template: L.template, tip: L.tip, deadline: L.startedAt + this.policy.waitMs, dry: L.dry });
          return;
        }
        case 'amount': if (!me) return; if (Number(b.amount) !== 0 && !amountOf(b.amount)) this.send(ws, { t: 'error', msg: 'a buy must be more than 0 and at most 100' }); me.amount = amountOf(b.amount); if ('extra' in b) me.extra = extraOf(b.extra); this.attach(me); await this.ctx.storage.delete('signed:' + me.wallet); return this.pushRoster();
        case 'ready': if (!me) return; me.ready = !!b.ready; this.attach(me); return this.pushRoster();
        case 'name': if (!me) return; me.name = String(b.name || '').slice(0, 24) || me.name; this.attach(me); return this.pushRoster();
        case 'policy': if (!me || me.wallet !== this.dev) return; this.policy.waitMs = Math.min(45000, Math.max(1000, Number(b.waitMs) || 8000)); await this.persist(); return this.pushRoster();
        case 'kick': if (!me || me.wallet !== this.dev) return; { const k = this.members.get(String(b.wallet)); if (k && k.wallet !== this.dev) { await this.ctx.storage.put('ban:' + k.wallet, Date.now()); try { k.ws?.serializeAttachment({ wallet: null }); k.ws?.close(1000, 'kicked'); } catch {} this.members.delete(k.wallet); this.log('info', k.name + ' was removed'); await this.pushRoster(); } } return;
        case 'abort': {
          if (!me || me.wallet !== this.dev) return; if (!(await this.launchState())) return;
          await this.clearLaunch(); this.log('warn', 'launch aborted by the dev'); return this.pushRoster();
        }
        case 'launch': {
          if (!me || me.wallet !== this.dev) return this.send(ws, { t: 'error', msg: 'only the dev can launch' });
          if (await this.launchState()) return this.send(ws, { t: 'error', msg: 'a launch is already in progress' });
          let L;
          // the official page launches pump.fun coins only (it refuses to sign anything else), so nothing else is accepted
          if (this.evm) return this.send(ws, { t: 'error', msg: 'Robinhood Chain launches are switched off' });
          if (this.evm && b.escrow) {
            // SAME-BLOCK escrow mode: the dev's single SquadLaunch tx creates the token AND buys for the squad from escrow.
            // Nothing to sign for members — the relay just tracks the receipt and tells everyone.
            if (!/^0x[0-9a-f]{64}$/i.test(String(b.launchHash || ''))) return this.send(ws, { t: 'error', msg: 'missing launch tx hash' });
            await this.clearLaunch();
            const L0 = { chain: 'rh', escrow: true, launchHash: String(b.launchHash), predicted: b.predicted || {}, buyers: Array.isArray(b.buyers) ? b.buyers : [], dry: false, startedAt: Date.now(), mint: b.predicted?.token || null };
            await this.ctx.storage.put('launch', L0);
            this.log('armed', 'SAME-BLOCK LAUNCH sent by ' + me.name + ' — ' + short(L0.launchHash) + ' · ' + L0.buyers.length + ' squad buys from escrow in the same tx · waiting for the receipt…');
            await this.pushRoster();
            return this.assembleSafe();
          }
          if (this.evm) {
            // Robinhood/Pons: dev sends the signed launch tx (or, with an extension wallet, the hash of one it already broadcast) + the predicted curve
            if (!b.predicted?.curve || !isEvmAddr(b.predicted.curve) || (!b.launchRaw && !b.launchHash)) return this.send(ws, { t: 'error', msg: 'missing launch tx / predicted curve' });
            L = { chain: 'rh', predicted: { token: b.predicted.token, curve: getAddress(b.predicted.curve) }, launchRaw: b.launchRaw ? String(b.launchRaw) : null, launchHash: b.launchHash ? String(b.launchHash) : null, localTxs: (Array.isArray(b.localTxs) ? b.localTxs.map(String) : []).filter((r) => { try { const t = EvmTx.from(r); return lc(t.to) === lc(b.predicted.curve) && Number(t.chainId) === RH.chainId; } catch { return false; } }), exemptions: Array.isArray(b.exemptions) ? b.exemptions.map(lc) : [], dry: !!b.dry, startedAt: Date.now(), mint: b.predicted.token || null };
            const notExempt = this.expected().filter((x) => !L.exemptions.includes(lc(x.wallet)));
            if (notExempt.length) this.log('warn', 'NOT in the snipe-tax exemptions (they will pay the launch tax): ' + notExempt.map((x) => x.name).join(', '));
          } else {
            if (!b.createTx || !b.template) return this.send(ws, { t: 'error', msg: 'missing create tx / template' });
            // preTxs: dev-signed txs that must run BEFORE the create in the same bundle (StonkFun's SOL→quote funding swap on a non-SOL quote)
            const preTxs = Array.isArray(b.preTxs) ? b.preTxs.slice(0, 2).map(String) : [];
            for (const p of preTxs) { let n = 0; try { n = bs58.decode(p).length; } catch {} if (!n || n > 1232) return this.send(ws, { t: 'error', msg: 'bad funding tx' }); }
            { let n = 0; try { n = bs58.decode(String(b.createTx)).length; } catch {} if (!n || n > 1232) return this.send(ws, { t: 'error', msg: 'bad launch transaction' }); }
            // pump.fun: members auto-sign against this template, so it must be THIS launch: create_v2 of the template's mint in
            // the dev's own transaction, and buy accounts derived from that mint (never another, already trading coin)
            if (b.template?.kind !== 'pump') return this.send(ws, { t: 'error', msg: 'launch refused: not a pump.fun launch — reload the arenalaunch page' });
            const chk = checkPumpLaunch(String(b.createTx), b.template, this.dev); if (chk.err) { this.log('warn', 'launch refused: ' + chk.err); return this.send(ws, { t: 'error', msg: 'launch refused: ' + chk.err }); }
            const lockUntil = Number(b.template.lockUntil) || 0, nowS = Date.now() / 1000;
            if (lockUntil && (lockUntil < nowS || lockUntil > nowS + MAX_LOCK_S)) return this.send(ws, { t: 'error', msg: 'launch refused: the lock must end within 7 days of go-live' });
            // the dev's other wallets: each a buy of this coin carrying its 3% launch tax, like a teammate's
            if (b.template?.kind === 'pump' && Array.isArray(b.localTxs)) for (const [i, raw] of b.localTxs.map(String).entries()) {
              let bytes; try { bytes = bs58.decode(raw); } catch { bytes = null; }
              const w = bytes && firstSigner(bytes), bad = !bytes ? 'unreadable' : validatePumpBuy(bytes, { wallet: w, amount: pumpBuyAmount(bytes) }, { template: b.template, dry: !!b.dry });
              if (bad) { this.log('warn', 'launch refused: dev wallet ' + (i + 1) + ' — ' + bad); return this.send(ws, { t: 'error', msg: 'launch refused: dev wallet ' + (i + 1) + ' — ' + bad }); }
            }
            // what teammates base their minimum tokens on: computed HERE from what was actually signed and what the roster
            // says, never taken from the dev (a huge number there would let them be sold into at any price)
            const devLocalLamports = (Array.isArray(b.localTxs) ? b.localTxs : []).reduce((a, raw) => { try { return a + Math.round(pumpBuyAmount(bs58.decode(String(raw))) * 1e9); } catch { return a; } }, 0);
            b.template.devLamports = chk.devLamports;
            b.template.plannedLamports = chk.devLamports + devLocalLamports + this.expected().reduce((a, x) => a + Math.round((x.amount + (x.extra?.sol || 0)) * 1e9), 0);
            delete b.template.feeSplit;
            this.log('info', 'the dev buys ' + (chk.devLamports / 1e9) + ' SOL in the create' + (devLocalLamports ? ' + ' + (devLocalLamports / 1e9) + ' SOL from their other wallets' : ''));
            // squad fee split: the dev pre-signs pump.fun's fee sharing for the dev + EVERY ready teammate; we send it after the buys
            let feeTx = null, feeSplit = null;
            if (b.feeTx) {
              const want = [this.dev, ...this.expected().map((x) => x.wallet)];
              const r = checkFeeSplit(String(b.feeTx), b.template?.mint, this.dev, want);
              if (r.err) { this.log('warn', 'launch refused: fee split — ' + r.err); return this.send(ws, { t: 'error', msg: 'launch refused: fee split — ' + r.err }); }
              feeTx = String(b.feeTx); feeSplit = r.holders; b.template.feeSplit = r.holders; // members are shown what is actually signed
            }
            let devLocks = [];
            if (Array.isArray(b.locks) && b.locks.length) {
              const own = new Set([this.dev, ...(Array.isArray(b.localTxs) ? b.localTxs.map((x) => { try { return firstSigner(bs58.decode(String(x))); } catch { return null; } }).filter(Boolean) : [])]);
              for (const raw of b.locks.slice(0, 11).map(String)) { const r = checkLock(raw, own, { template: b.template, dry: !!b.dry }); if (r.err) { this.log('warn', 'a dev lock was dropped — ' + r.err); continue; } if (!devLocks.some((k) => k.wallet === r.wallet)) devLocks.push({ wallet: r.wallet, tx: raw, until: r.until }); }
            }
            L = { chain: 'sol', single: !!b.single, fire: b.fire === 'block0' ? 'block0' : 'safe', template: b.template, createTx: String(b.createTx), preTxs, localTxs: Array.isArray(b.localTxs) ? b.localTxs.map(String) : [], tip: Number(b.tip) || 0, dry: !!b.dry, startedAt: Date.now(), mint: b.template?.mint || b.mint || null, feeTx, feeSplit, devLocks };
            if (preTxs.length) this.log('info', 'quote is not SOL — the dev\'s funding swap goes first in the bundle, leaving ' + (MAX_TX - 1 - preTxs.length) + ' buy slots in block zero');
            // scheduled go-live: the dev names the moment; the bundle is sent then (or once every signature is in, whichever is later).
            // Capped at 40 s because the create's blockhash was minted at prepare time and lives about a minute.
            const fireAt = Number(b.fireAt) || 0;
            if (fireAt > Date.now() + 1000) L.fireAt = Math.min(fireAt, Date.now() + 40000);
          }
          await this.clearLaunch();
          await this.ctx.storage.put('launch', L);
          const expected = this.expected();
          const goLive = L.fireAt ? ' · goes live in ' + Math.round((L.fireAt - Date.now()) / 1000) + 's' : '';
          this.log('armed', (L.dry ? 'REHEARSAL ' : '') + 'LAUNCH — ' + me.name + ' prepared ' + short(L.mint) + ' · waiting up to ' + (this.policy.waitMs / 1000) + 's for ' + expected.length + ' member signature' + (expected.length === 1 ? '' : 's') + goLive);
          for (const x of expected) this.send(x.ws, this.evm ? { t: 'sign', chain: 'rh', curve: L.predicted.curve, token: L.predicted.token, deadline: L.startedAt + this.policy.waitMs, dry: L.dry } : { t: 'sign', template: L.template, tip: L.tip, deadline: L.startedAt + this.policy.waitMs, dry: L.dry });
          await this.pushRoster();
          if (!expected.length) { if (L.fireAt) { await this.ctx.storage.setAlarm(L.fireAt); return; } return this.assembleSafe(); }
          await this.ctx.storage.setAlarm(Math.max(Date.now() + this.policy.waitMs, L.fireAt || 0));
          return;
        }
        case 'signed': {
          const L = await this.launchState();
          if (!me || me.role !== 'member' || !L) return;
          const tx = String(b.tx || '');
          if (this.evm) {
            if (!/^0x[0-9a-f]+$/i.test(tx) || tx.length > 4000) return this.send(ws, { t: 'error', msg: 'bad tx encoding' });
            const bad = validateEvmBuy(tx, me, L);
            if (bad) { this.log('warn', me.name + "'s buy was rejected: " + bad); return this.send(ws, { t: 'error', msg: 'your buy was rejected: ' + bad }); }
          } else {
            let bytes; try { bytes = bs58.decode(tx); } catch { return this.send(ws, { t: 'error', msg: 'bad tx encoding' }); }
            if (bytes.length > 1232) return this.send(ws, { t: 'error', msg: 'tx too large' });
            const bad = await validateBuy(bytes, me, L);
            if (bad) { this.log('warn', me.name + "'s buy was rejected: " + bad); return this.send(ws, { t: 'error', msg: 'your buy was rejected: ' + bad }); }
          }
          await this.ctx.storage.put('signed:' + me.wallet, tx);
          // the teammate's other wallets: one transaction each, signed and paid by that wallet, checked like any buy
          let extraN = 0;
          if (!this.evm && L.template?.kind === 'pump' && Array.isArray(b.extra) && b.extra.length) {
            const taken = new Set([this.dev, ...this.members.keys()]); const keep = [];
            for (const raw of b.extra.slice(0, 10).map(String)) {
              let bytes; try { bytes = bs58.decode(raw); } catch { continue; } if (bytes.length > 1232) continue;
              const w = firstSigner(bytes); const amount = pumpBuyAmount(bytes);
              if (!w || taken.has(w)) { this.log('warn', me.name + ': an extra buy was dropped (wallet already in this lobby)'); continue; }
              if (!(amount > 0 && amount <= 100)) { this.log('warn', me.name + ': an extra buy was dropped (amount)'); continue; }
              const bad = validatePumpBuy(bytes, { wallet: w, amount }, L); if (bad) { this.log('warn', me.name + "'s extra wallet " + short(w) + ' was rejected: ' + bad); continue; }
              taken.add(w); keep.push({ wallet: w, amount, tx: raw });
            }
            await this.ctx.storage.put('signedx:' + me.wallet, keep); extraN = keep.length;
          }
          let lockN = 0;
          if (!this.evm && Array.isArray(b.locks) && b.locks.length) {
            const own = new Set([me.wallet, ...((await this.ctx.storage.get('signedx:' + me.wallet)) || []).map((x) => x.wallet)]);
            const keep = []; for (const raw of b.locks.slice(0, 11).map(String)) { const r = checkLock(raw, own, L); if (r.err) { this.log('warn', me.name + ': a lock was dropped — ' + r.err); continue; } if (!keep.some((k) => k.wallet === r.wallet)) keep.push({ wallet: r.wallet, tx: raw, until: r.until }); }
            await this.ctx.storage.put('locks:' + me.wallet, keep); lockN = keep.length;
          }
          this.log('info', me.name + ' signed' + (extraN ? ' (+' + extraN + ' more wallet' + (extraN === 1 ? '' : 's') + ', each its own transaction)' : '') + (lockN ? ' · ' + lockN + ' wallet' + (lockN === 1 ? '' : 's') + ' will lock' : '')); await this.pushRoster();
          const signed = await this.signedMap();
          if (this.expected().every((x) => signed.has(x.wallet))) { await this.ctx.storage.deleteAlarm(); if (L.fireAt && L.fireAt > Date.now() + 200) { this.log('info', 'everyone signed — holding for the go-live moment'); await this.ctx.storage.setAlarm(L.fireAt); } else await this.assembleSafe(); }
          return;
        }
      }
    } catch (e) { this.send(ws, { t: 'error', msg: String(e.message || e) }); }
  }

  async assembleSafe() { try { await this.assemble(); } catch (e) { this.log('error', 'launch failed inside the relay: ' + String(e.message || e).slice(0, 200)); this.broadcast({ t: 'result', ok: false, ids: [], landed: 0, error: String(e.message || e).slice(0, 200) }); await this.pushRoster(); } }
  async alarm() {
    this.hydrate(); const L = await this.launchState();
    if (!L) return this.expire(); // no launch pending: the alarm is the idle clock
    if (L.fireAt && L.fireAt - Date.now() > 300) { await this.ctx.storage.setAlarm(L.fireAt); return; } await this.assembleSafe();
  }
  async clearLaunch() { await this.ctx.storage.delete('launch'); for (const p of ['signed:', 'signedx:', 'locks:']) { const m = await this.ctx.storage.list({ prefix: p }); for (const k of m.keys()) await this.ctx.storage.delete(k); } await this.keepAlive(); }
  // the idle clock: someone was here now. Never touches the alarm while a launch is pending (that alarm fires the launch).
  async keepAlive() { await this.ctx.storage.put('seen', Date.now()); if (!(await this.launchState())) await this.ctx.storage.setAlarm(Date.now() + LOBBY_IDLE_MS); }
  // a week with nobody connected and no launch pending: delete everything (bans, last bundle, dev seat); the code is free again
  async expire() {
    const seen = (await this.ctx.storage.get('seen')) || 0;
    if (this.ctx.getWebSockets().length || Date.now() - seen < LOBBY_IDLE_MS - 60000) { await this.ctx.storage.setAlarm(Math.max(seen + LOBBY_IDLE_MS, Date.now() + 3600000)); return; }
    await this.ctx.storage.deleteAll(); this.code = null; this.dev = null; this.members = new Map(); this.policy = { waitMs: 8000 }; this.chain = 'sol';
  }

  // Robinhood/Pons: broadcast the launch, wait for its receipt, THEN fan out the members' pre-signed buys.
  // (Never before: a buy sent to a curve address that doesn't exist yet would just donate the ETH to an empty address.)
  async assembleEvm(L, signed) {
    if (L.escrow) { // same-block mode: one tx did everything — just confirm it
      const rc = await waitReceipt(L.launchHash, 25000);
      if (!rc || rc.status !== '0x1') { this.log('error', rc ? 'SAME-BLOCK launch REVERTED (block ' + parseInt(rc.blockNumber, 16) + ') — nothing happened, every deposit is still in escrow' : 'launch not confirmed within 25s — check the tx'); this.broadcast({ t: 'result', ok: false, chain: 'rh', escrow: true, launchHash: L.launchHash, error: rc ? 'launch reverted' : 'not confirmed' }); return this.pushRoster(); }
      const blk = parseInt(rc.blockNumber, 16);
      this.log('success', 'SAME-BLOCK LAUNCH LANDED in block ' + blk + ' — token ' + (L.predicted.token || '?') + ' · ' + L.buyers.length + ' squad buys in the SAME transaction (' + (L.buyers.map((b) => b.name).join(', ') || 'none') + ')');
      this.broadcast({ t: 'result', ok: true, chain: 'rh', escrow: true, createLanded: true, launchHash: L.launchHash, launchBlock: blk, ids: [L.launchHash], landed: 1, members: L.buyers.map((b) => ({ name: b.name, ok: true, block: blk })), mint: L.predicted.token, curve: L.predicted.curve });
      return this.pushRoster();
    }
    let members = [...this.members.values()].filter((x) => x.role === 'member' && signed.has(x.wallet));
    const missing = this.expected().filter((x) => !signed.has(x.wallet));
    if (missing.length) this.log('warn', 'no signature in time from: ' + missing.map((x) => x.name).join(', ') + ' — launching without them');
    if (members.length) {
      const bal = await balancesEvm(members.map((x) => x.wallet));
      const short = members.filter((x) => (bal[x.wallet] ?? 0) < x.amount + 0.0005);
      if (short.length) { this.log('warn', 'excluded (not enough ETH for buy + gas): ' + short.map((x) => x.name + ' has ' + (bal[x.wallet] ?? 0).toFixed(5)).join(', ')); members = members.filter((x) => !short.includes(x)); }
    }
    const locals = (L.localTxs || []).map((raw, i) => ({ name: 'dev wallet ' + (i + 1), raw }));
    const summary = 'launch ' + (L.launchRaw ? 'tx' : 'hash ' + short(L.launchHash)) + ' + ' + members.length + ' squad buys (' + (members.map((m) => m.name).join(', ') || 'none') + ')' + (locals.length ? ' + ' + locals.length + ' dev-wallet buys' : '') + ' → curve ' + short(L.predicted.curve) + ' token ' + short(L.predicted.token);
    if (L.dry) { this.log('success', 'REHEARSAL — validated ' + summary + ' — NOT sent'); this.broadcast({ t: 'result', ok: true, dry: true, chain: 'rh', ids: [], landed: 0, members: members.map((m) => m.name), mint: L.predicted.token }); return this.pushRoster(); }
    const buyers = [...members.map((m) => ({ name: m.name, raw: signed.get(m.wallet) })), ...locals];
    this.log('info', 'sending ' + summary);
    let launchHash = L.launchHash;
    if (L.launchRaw) { try { launchHash = await rhRpc('eth_sendRawTransaction', [L.launchRaw]); } catch (e) { this.log('error', 'launch tx rejected by the RPC — ' + e.message + ' (nothing else was sent)'); this.broadcast({ t: 'result', ok: false, chain: 'rh', error: 'launch rejected: ' + e.message }); return this.pushRoster(); } }
    this.log('info', 'launch sent ' + short(launchHash) + ' — waiting for the receipt…');
    const rc = await waitReceipt(launchHash, 20000);
    if (!rc || rc.status !== '0x1') { this.log('error', rc ? 'launch tx REVERTED (block ' + parseInt(rc.blockNumber, 16) + ') — squad buys NOT sent, nothing lost' : 'launch not confirmed within 20s — squad buys NOT sent; check the tx before retrying'); this.broadcast({ t: 'result', ok: false, chain: 'rh', launchHash, error: rc ? 'launch reverted' : 'launch not confirmed' }); return this.pushRoster(); }
    const launchBlock = parseInt(rc.blockNumber, 16);
    this.log('success', 'LAUNCH LANDED in block ' + launchBlock + ' — firing ' + buyers.length + ' buys');
    const sent = await Promise.all(buyers.map(async (m) => { try { return { m, hash: await rhRpc('eth_sendRawTransaction', [m.raw]) }; } catch (e) { this.log('warn', m.name + ': buy rejected by the RPC — ' + e.message.slice(0, 100)); return { m, err: e.message }; } }));
    const results = await Promise.all(sent.map(async (s) => { if (!s.hash) return { name: s.m.name, ok: false, err: s.err }; const r = await waitReceipt(s.hash, 15000); return { name: s.m.name, hash: s.hash, ok: r?.status === '0x1', block: r ? parseInt(r.blockNumber, 16) : null }; }));
    for (const r of results) this.log(r.ok ? 'success' : 'error', r.name + ': ' + (r.ok ? 'IN at block ' + r.block + ' (+' + (r.block - launchBlock) + ')' : 'failed' + (r.err ? ' — ' + r.err.slice(0, 80) : ' (reverted)')));
    const landed = results.filter((r) => r.ok).length;
    this.log(landed === results.length ? 'success' : 'warn', 'SQUAD ' + landed + '/' + results.length + ' in · token ' + L.predicted.token);
    this.broadcast({ t: 'result', ok: true, chain: 'rh', createLanded: true, launchHash, launchBlock, ids: results.map((r) => r.hash).filter(Boolean), landed, members: results, mint: L.predicted.token, curve: L.predicted.curve });
    return this.pushRoster();
  }

  // Block 0 as bundles through Helius: [create + first 4 buys] is all-or-nothing, so those land in the same block or not at
  // all; the rest go in follow-up bundles of 5 sent right behind it. Returns null (→ the plain path) when bundles are not
  // available or the first one is refused; returns { st0 } with the create's status once it lands, or falls back after ~2.5 s.
  async sendBundles(createTx, buys) {
    if (!BUNDLE_URL) return null;
    if (!tipsHelius(createTx)) { this.log('info', 'block 0: the launch transaction carries no bundle tip (older page) — sending the plain way'); return null; }
    const groups = [[createTx, ...buys.slice(0, 4)]]; for (let i = 4; i < buys.length; i += 5) groups.push(buys.slice(i, i + 5));
    const id0 = await heliusBundle(groups[0]);
    if (!id0.ok) { this.log('warn', 'block 0: bundle refused by Helius (' + id0.err + ') — sending the plain way'); return null; }
    const rest = groups.slice(1).filter((g) => g.some(tipsHelius)); // a group with no tip is not a valid bundle: its buys go out after the create
    const ids = await Promise.all(rest.map(heliusBundle));
    this.log('info', 'block 0: sent as ' + (1 + ids.filter((x) => x.ok).length) + ' bundle(s) through Helius — the launch + ' + Math.min(4, buys.length) + ' buys together' + (buys.length > 4 ? ', ' + (buys.length - Math.min(4, buys.length)) + ' more right behind' : ''));
    const sig = sigOf(createTx); const end = Date.now() + 2500; let resent = 0;
    while (Date.now() < end) {
      await sleep(150);
      const st = (await statusesOf([sig]))?.[0]; if (st) return { st0: st };
      if (Date.now() > end - 2500 + 800 * (resent + 1) && resent < 2) { resent++; heliusBundle(groups[0]).catch(() => {}); }
    }
    this.log('warn', 'block 0: the bundle was not picked up within 2.5 s — sending the plain way (same transactions, nothing doubles)');
    const s0 = await sendRaw(createTx); if (!s0) return { st0: null };
    await Promise.all(buys.map((raw) => sendRaw(raw)));
    return { st0: await waitProcessed(sig, 20000, 100) };
  }

  async assemble() {
    const L = await this.launchState(); if (!L) return;
    const signed = await this.signedMap();
    L.extras = Object.fromEntries([...(await this.ctx.storage.list({ prefix: 'signedx:' }))].map(([k, v]) => [k.slice(8), v]));
    L.locks = [...(L.devLocks || []), ...[...(await this.ctx.storage.list({ prefix: 'locks:' }))].flatMap(([, v]) => v || [])];
    await this.clearLaunch(); // one shot
    if (L.chain === 'rh') return this.assembleEvm(L, signed);
    const signedMembers = [...this.members.values()].filter((x) => x.role === 'member' && signed.has(x.wallet));
    const missing = this.expected().filter((x) => !signed.has(x.wallet));
    if (missing.length) this.log('warn', 'no signature in time from: ' + missing.map((x) => x.name).join(', ') + ' — launching without them');
    // one entry per wallet: each teammate's ★ buy, then each of their extra wallets (their own transactions)
    let members = [];
    signedMembers.forEach((m, p) => { members.push({ name: m.name, wallet: m.wallet, amount: m.amount, raw: signed.get(m.wallet), person: p + 1, rank: 0 }); (L.extras?.[m.wallet] || []).forEach((x, i) => members.push({ name: m.name + ' · ' + short(x.wallet), wallet: x.wallet, amount: x.amount, raw: x.tx, person: p + 1, rank: i + 1 })); });
    // pre-flight: one underfunded buy fails the WHOLE bundle (create included) → drop anyone short.
    // The dev's own extra wallets get the same check: their buys are parsed for signer + amount.
    const quoteIsSol = !L.template?.mintB || L.template.mintB === WSOL_MINT; const dec = L.template?.quoteDecimals ?? 9;
    let locals = (L.localTxs || []).map((raw, i) => { let wallet = null, amount = 0; try { const t = parseLegacy(bs58.decode(raw)); wallet = t.keys[0]; const ix = t.ixs.find((x) => x.program === LAUNCHLAB || x.program === PUMP); if (ix) amount = Number(u64(ix.data, 8)) / 10 ** dec; } catch {} return { name: 'dev wallet ' + (i + 1) + (wallet ? ' ' + short(wallet) : ''), wallet, amount, raw, person: 0, rank: i + 1 }; });
    const bad = locals.filter((x) => !x.wallet || !(x.amount > 0)); if (bad.length) { this.log('warn', 'dropped unparseable dev-wallet buys: ' + bad.map((x) => x.name).join(', ')); locals = locals.filter((x) => !bad.includes(x)); }
    const all = [...members, ...locals];
    if (all.length) {
      const bal = await balances(all.map((x) => x.wallet));
      if (bal) {
        // SOL quote: the buy itself is SOL. Token quote: SOL only pays tip + fees, the buy is paid in the quote token (checked below)
        const short = all.filter((x) => (bal[x.wallet] ?? 0) < needSol(quoteIsSol ? x.amount : 0, L.tip));
        if (short.length && L.dry) this.log('warn', 'REHEARSAL — short of SOL (a real launch would leave them out until they are funded): ' + short.map((x) => x.name + ' has ' + (bal[x.wallet] ?? 0).toFixed(4)).join(', '));
        else if (short.length) { this.log('warn', 'excluded (not enough SOL for ' + (quoteIsSol ? 'buy + ' : '') + 'tip + fees): ' + short.map((x) => x.name + ' has ' + (bal[x.wallet] ?? 0).toFixed(4)).join(', ')); members = members.filter((x) => !short.includes(x)); locals = locals.filter((x) => !short.includes(x)); }
      } else this.log('warn', 'balance pre-check unavailable (RPC) — sending as-is');
      const rest = [...members, ...locals];
      if (!quoteIsSol && rest.length) {
        const tb = await tokenBalances(rest.map((x) => x.wallet), L.template.mintB);
        if (tb) {
          const short = rest.filter((x) => (tb[x.wallet] ?? 0) < x.amount);
          if (short.length) { this.log('warn', 'excluded (not enough of the quote token ' + short6(L.template.mintB) + ' for the buy): ' + short.map((x) => x.name + ' has ' + (tb[x.wallet] ?? 0)).join(', ')); members = members.filter((x) => !short.includes(x)); locals = locals.filter((x) => !short.includes(x)); }
        } else this.log('warn', 'quote-token balance pre-check unavailable (RPC) — sending as-is');
      }
    }
    // one wallet per person first: every teammate's ★ buy (the dev's ★ buy is inside the create), then everyone's 2nd wallet, then 3rd...
    const ordered = buyOrder(locals, members);
    const buys = ordered.map((x) => x.raw);
    const sizes = [L.createTx, ...buys].map((t) => { try { return bs58.decode(t).length; } catch { return 0; } });
    const summary = 'the launch transaction (create + dev buy) + ' + buys.length + ' wallet buys, each its own transaction (' + locals.length + ' dev wallets, ' + members.length + ' teammate wallets: ' + (members.map((m) => m.name).join(', ') || 'none') + ') · tx bytes ' + sizes.join('/') + (ordered.length ? ' · buy order: ' + ordered.map((x) => x.name).join(' → ') : '');
    if (L.dry && L.locks?.length) this.log('info', 'REHEARSAL — then ' + L.locks.length + ' wallet' + (L.locks.length === 1 ? '' : 's') + ' would lock their tokens on Streamflow until ' + new Date(Math.min(...L.locks.map((k) => k.until)) * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC: ' + L.locks.map((k) => short(k.wallet)).join(', '));
    if (L.dry && L.feeSplit) this.log('info', 'REHEARSAL — would then split creator fees between ' + L.feeSplit.length + ' wallets (' + L.feeSplit.map((h) => short(h.address) + ' ' + (h.bps / 100) + '%').join(', ') + '), permanently');
    if (L.dry) { this.log('success', 'REHEARSAL — assembled ' + summary + ' — NOT sent'); this.broadcast({ t: 'result', ok: true, dry: true, ids: [], landed: 0, sizes: [sizes], members: members.map((m) => m.name) }); return this.pushRoster(); }
    if (L.fireAt) { const late = Date.now() - L.fireAt; this.log('info', 'go-live moment' + (late > 1500 ? ' (' + (late / 1000).toFixed(1) + 's late — signatures held it)' : '')); }
    // last look before spending: the launch transaction with its REAL blockhash and signature checks on
    const sim0 = await simulateRaw(L.createTx, true);
    if (sim0 && sim0.err) { this.log('error', 'ABORT — the launch transaction fails a signature-checked simulation right now: ' + JSON.stringify(sim0.err) + ' ' + (sim0.logs || []).slice(-2).join(' | ') + '. Nothing sent.'); this.broadcast({ t: 'result', ok: false, ids: [], landed: 0, error: 'launch tx fails simulation: ' + JSON.stringify(sim0.err) }); return this.pushRoster(); }
    if (sim0 && sim0.bhValid === false) { this.log('error', 'ABORT — the launch transaction\'s blockhash has already expired. Press launch again. Nothing sent.'); this.broadcast({ t: 'result', ok: false, ids: [], landed: 0, error: 'blockhash expired before sending' }); return this.pushRoster(); }
    await this.ctx.storage.put('lastBundle', { at: Date.now(), mint: L.mint, txs: [L.createTx, ...buys], sizes });
    this.log('info', 'sending ' + summary);
    this.broadcast({ t: 'countdown', sent: true, mint: L.mint });
    // The launch transaction goes out through every RPC at once (same signature everywhere, so it lands once at most)
    const t0 = Date.now();
    const bundled = L.fire !== 'safe' ? await this.sendBundles(L.createTx, buys) : null;
    const createSig = bundled ? sigOf(L.createTx) : await sendRaw(L.createTx);
    if (!createSig) { this.log('error', 'every RPC refused the launch transaction — nothing sent'); this.broadcast({ t: 'result', ok: false, ids: [], landed: 0, error: 'rpc refused' }); return this.pushRoster(); }
    this.log('success', 'SENT the launch transaction ' + createSig + ' — waiting for it to be processed…');
    // Block 0: every wallet's buy goes out right behind the create (the create carries the higher priority, so the leader
    // runs it first); Safe: they wait until the create is seen on chain
    const names = ordered.map((x) => x.name);
    let sigs = null;
    if (bundled) sigs = buys.map(sigOf);
    else if (L.fire !== 'safe' && buys.length) { sigs = await Promise.all(buys.map((raw) => sendRaw(raw))); this.log('info', 'block 0: ' + sigs.filter(Boolean).length + '/' + buys.length + ' wallet buys fired with the create'); }
    const st0 = bundled?.st0 || await waitProcessed(createSig, 20000, 100);
    if (!st0 || st0.err) {
      this.log('error', st0?.err ? 'the launch transaction FAILED on chain: ' + JSON.stringify(st0.err) + ' (' + createSig + ')' : 'the launch transaction was not processed within 20s — not included (dropped by the network or the blockhash ran out). Nothing charged.');
      this.broadcast({ t: 'result', ok: false, ids: [createSig], landed: 0, createLanded: false, mint: L.mint, error: st0?.err ? 'failed on chain' : 'not processed' });
      return this.pushRoster();
    }
    const slot = st0.slot || null; const ms = Date.now() - t0;
    this.log('success', 'LIVE — the create landed in slot ' + slot + ' after ' + ms + ' ms (' + st0.confirmationStatus + ') · mint ' + (L.mint || '?'));
    const ids = [createSig]; let landedN = 1; const results = [];
    if (buys.length) {
      // Safe: the pool exists now — every wallet buy goes out at once (Block 0 already sent them with the create)
      if (!sigs) { sigs = await Promise.all(buys.map((raw) => sendRaw(raw))); this.log('info', 'wallet buys sent: ' + sigs.filter(Boolean).length + '/' + buys.length + ' accepted by the RPCs'); }
      else if (bundled) {
        // bundled buys normally land with the create; any not seen ~1 s after it go out the plain way (same signature: lands once at most)
        await sleep(1000); const seen = await statusesOf(sigs);
        const late = buys.map((raw, i) => (seen?.[i] ? null : raw)).filter(Boolean);
        if (late.length) { await Promise.all(late.map((raw) => sendRaw(raw))); this.log('info', late.length + ' buy(s) were not in the bundles — sent the plain way'); }
      }
      const sts = await Promise.all(sigs.map((sg) => (sg ? waitProcessed(sg, 25000) : null)));
      sts.forEach((st, i) => { const ok = !!(st && !st.err); if (ok) landedN++; results.push({ name: names[i], ok, slot: st?.slot || null, err: st?.err ? JSON.stringify(st.err).slice(0, 80) : (sigs[i] ? 'not processed' : 'rpc refused') }); ids.push(sigs[i] || null); this.log(ok ? 'success' : 'warn', names[i] + ': ' + (ok ? 'IN at slot ' + st.slot + (st.slot === slot ? ' (block 0)' : ' (+' + (st.slot - slot) + ')') : 'MISSED — ' + results[results.length - 1].err + (L.fire !== 'safe' && /Custom|InstructionError/.test(results[results.length - 1].err) ? ' (reached the leader before the coin existed)' : ''))); });
    }
    let lockRes = null;
    if (L.locks?.length) {
      const landed = new Set([this.dev]); ordered.forEach((x, i) => { if (results[i]?.ok) landed.add(x.wallet); });
      const go = L.locks.filter((k) => landed.has(k.wallet)), skip = L.locks.filter((k) => !landed.has(k.wallet));
      if (skip.length) this.log('info', 'not locking ' + skip.map((k) => short(k.wallet)).join(', ') + ' — their buy did not land');
      const sent = await Promise.all(go.map(async (k) => { const sg = await sendRaw(k.tx); const st = sg ? await waitProcessed(sg, 20000) : null; return { wallet: k.wallet, until: k.until, ok: !!(st && !st.err), sig: sg, err: st?.err ? JSON.stringify(st.err).slice(0, 80) : sg ? (st ? null : 'not processed') : 'rpc refused' }; }));
      lockRes = sent;
      const ok = sent.filter((x) => x.ok);
      if (ok.length) this.log('success', ok.length + ' wallet' + (ok.length === 1 ? '' : 's') + ' locked on Streamflow until ' + new Date(Math.min(...ok.map((x) => x.until)) * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC: ' + ok.map((x) => short(x.wallet)).join(', '));
      for (const x of sent.filter((y) => !y.ok)) this.log('warn', 'lock for ' + short(x.wallet) + ' did not go through (' + x.err + ') — those tokens are NOT locked');
    }
    // the fee split goes out only now: it moves the coin's creator to pump.fun's sharing account, and every buy above was
    // signed against the dev as creator, so it must never land before them
    let feeSplitOk = null;
    if (L.feeTx) {
      const fs0 = await sendRaw(L.feeTx); const fst = fs0 ? await waitProcessed(fs0, 20000) : null; feeSplitOk = !!(fst && !fst.err);
      this.log(feeSplitOk ? 'success' : 'warn', feeSplitOk ? 'creator fees now split between ' + L.feeSplit.length + ' wallets, permanently (' + fs0 + ')' : 'the creator-fee split did not go through (' + (fst?.err ? JSON.stringify(fst.err) : fs0 ? 'not processed' : 'rpc refused') + ') — the dev can set it from the coin page');
    }
    this.broadcast({ t: 'result', ok: true, ids, landed: landedN, createLanded: true, slot, mint: L.mint, members: results, feeSplit: L.feeSplit ? { ok: feeSplitOk, holders: L.feeSplit } : null, locks: lockRes });
    return this.pushRoster();
  }

  async webSocketClose(ws) {
    this.hydrate();
    const a = ws.deserializeAttachment(); const m = a?.wallet ? this.members.get(a.wallet) : null;
    if (m && (m.ws === ws || !m.ws)) { m.ws = null; this.log('info', m.name + ' left'); if (m.role === 'member' && !(await this.launchState())) this.members.delete(m.wallet); await this.pushRoster(); }
  }
  async webSocketError(ws) { return this.webSocketClose(ws); }
}

// ---- legacy tx parsing + validation of a member's buy (a bad tx in the bundle would fail the whole launch) ----
function parseLegacy(bytes) {
  let o = 0; const cu16 = () => { let v = 0, s = 0; for (;;) { const b = bytes[o++]; v |= (b & 0x7f) << s; if (!(b & 0x80)) return v; s += 7; } };
  const nsig = cu16(); o += nsig * 64;
  o += 3; // header
  const nkeys = cu16(); const keys = []; for (let i = 0; i < nkeys; i++) { keys.push(bs58.encode(bytes.subarray(o, o + 32))); o += 32; }
  const blockhash = bs58.encode(bytes.subarray(o, o + 32)); o += 32;
  const nix = cu16(); const ixs = [];
  for (let i = 0; i < nix; i++) { const pid = bytes[o++]; const na = cu16(); const accs = []; for (let j = 0; j < na; j++) accs.push(keys[bytes[o++]]); const nd = cu16(); const data = bytes.subarray(o, o + nd); o += nd; ixs.push({ program: keys[pid], accounts: accs, data }); }
  return { keys, blockhash, ixs };
}
// legacy OR v0: static keys, how many sign, and each instruction's accounts (null where an index points into a lookup table)
function parseTx(bytes) {
  let o = 0; const cu16 = () => { let v = 0, s = 0; for (;;) { const b = bytes[o++]; v |= (b & 0x7f) << s; if (!(b & 0x80)) return v; s += 7; } };
  const nsig = cu16(); o += nsig * 64;
  if (bytes[o] & 0x80) o++; // versioned message prefix
  const nreq = bytes[o]; o += 3;
  const nkeys = cu16(); const keys = []; for (let i = 0; i < nkeys; i++) { keys.push(bs58.encode(bytes.subarray(o, o + 32))); o += 32; }
  o += 32; // blockhash
  const nix = cu16(); const ixs = [];
  for (let i = 0; i < nix; i++) { const pid = bytes[o++]; const na = cu16(); const idx = []; for (let j = 0; j < na; j++) idx.push(bytes[o++]); const nd = cu16(); const data = bytes.subarray(o, o + nd); o += nd; ixs.push({ program: keys[pid] ?? null, idx, accounts: idx.map((x) => keys[x] ?? null), data }); }
  if (o > bytes.length) throw new Error('truncated');
  return { keys, nreq, ixs };
}
// SOL a pump.fun buy spends (buy_exact_quote_in_v2: lamports at byte 8 of its data); 0 when there is none
function pumpBuyAmount(bytes) { try { const ix = parseLegacy(bytes).ixs.find((x) => x.program === PUMP && x.data.length === 24); return ix ? Number(u64(ix.data, 8)) / 1e9 : 0; } catch { return 0; } }
const firstSigner = (bytes) => { try { return parseLegacy(bytes).keys[0]; } catch { return null; } };
const TIP_ACCOUNTS = new Set(['DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh', 'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49', '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT', 'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe', 'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt', 'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY', '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5', 'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL']);
const SYSTEM = '11111111111111111111111111111111', CB = 'ComputeBudget111111111111111111111111111111', ATA_PROG = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', LAUNCHLAB = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
// pump.fun buy_exact_quote_in_v2 (spend exactly N lamports) and the buyer-owned account positions in its 27 accounts
const PUMP_BUY_IN = [194, 171, 28, 70, 104, 77, 91, 47]; const PUMP_USER_IDX = new Set([13, 14, 15, 20, 21]);
// arenalaunch launch tax: every buy (dev, dev's wallets, teammates) pays 3% of its SOL to the treasury, in the buy's own transaction
export const TREASURY = '3kNft1YMHsX4WgFDAq7yri5fGNrzdsBX4SxLhFLLBKez', LAUNCH_TAX_BPS = 300n;
export const launchTax = (lamports) => (BigInt(lamports) * LAUNCH_TAX_BPS) / 10000n;
const isTransfer = (ix) => ix.program === SYSTEM && ix.data.length === 12 && ix.data[0] === 2 && !ix.data[1] && !ix.data[2] && !ix.data[3];
let BUY_DISC = null;
async function buyDisc() { if (!BUY_DISC) BUY_DISC = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('global:buy_exact_in'))).slice(0, 8); return BUY_DISC; }
const u64 = (d, off) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[off + i]); return v; };
// one wallet per person first (rank 0 = each teammate's ★, the dev's ★ is inside the create), then every person's 2nd wallet, ...
export const buyOrder = (locals, members) => [...locals, ...members].sort((a, b) => a.rank - b.rank || a.person - b.person);
// returns null when OK, else a reason string
export async function validateBuy(bytes, member, L) {
  if (L.template?.kind === 'pump') return validatePumpBuy(bytes, member, L);
  let tx; try { tx = parseLegacy(bytes); } catch { return 'unparseable tx'; }
  const t = L.template; if (!t) return 'no template';
  if (tx.keys[0] !== member.wallet) return 'not signed by your wallet';
  if (!L.dry && tx.blockhash !== t.blockhash) return 'wrong blockhash (stale template?)'; // a rehearsal is signed against a made-up blockhash on purpose: it can never land
  { const fee = prioBad(tx.ixs); if (fee) return fee; }
  const allow = new Set([SYSTEM, CB, ATA_PROG, LAUNCHLAB, t.progA, t.progB]);
  const disc = await buyDisc(); const want = BigInt(Math.round(member.amount * 10 ** (t.quoteDecimals ?? 9)));
  const tipMax = BigInt(Math.round((L.tip || 0) * 1e9 * 2)) + 1n;
  let buys = 0;
  for (const ix of tx.ixs) {
    if (!allow.has(ix.program)) return 'unexpected program ' + ix.program.slice(0, 6);
    if (ix.program === LAUNCHLAB) {
      if (ix.data.length < 32 || !disc.every((b, i) => ix.data[i] === b)) return 'not a buy instruction';
      if (ix.accounts[0] !== member.wallet) return 'buy owner mismatch';
      if (u64(ix.data, 8) !== want) return 'buy amount mismatch (' + u64(ix.data, 8) + ' vs ' + want + ')';
      if (u64(ix.data, 16) < 1n) return 'minAmountA < 1';
      buys++;
    } else if (ix.program === SYSTEM) {
      const kind = ix.data[0] | (ix.data[1] << 8) | (ix.data[2] << 16) | (ix.data[3] << 24);
      if (kind !== 2 || ix.data.length !== 12) return 'unexpected system instruction';
      const lamports = u64(ix.data, 4); const to = ix.accounts[1];
      if (TIP_ACCOUNTS.has(to)) { if (lamports > tipMax) return 'tip too large'; }
      else if (lamports !== want) return 'unexpected transfer';
    }
  }
  if (buys !== 1) return 'expected exactly one buy';
  return null;
}
// ---- pump.fun accounts every buy of a coin must use, re-derived from its mint (never trusted from the template) ----
const PFEE = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ', TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const CREATE_V2 = [214, 144, 76, 236, 95, 139, 49, 180];
const PUMP_CONST = {}; // the per-program accounts, derived once
function pumpConst() {
  if (!PUMP_CONST.global) Object.assign(PUMP_CONST, { global: pda([text('global')], PUMP), gva: pda([text('global_volume_accumulator')], PUMP), feeConfig: pda([text('fee_config'), PUMP], PFEE), events: pda([text('__event_authority')], PUMP) });
  return PUMP_CONST;
}
// buy_exact_quote_in_v2 accounts (27): returns null when every mint/creator/user-derived account is the right one
// (a holder-reward coin is created with holderRewardsPda(mint) as its creator, so its creator vault derives from that)
export function pumpBuyKeysBad(keys, mint, creator, user, holderReward) {
  if (!Array.isArray(keys) || keys.length !== 27) return 'buy account count mismatch';
  const c = pumpConst(); const curve = pda([text('bonding-curve'), mint], PUMP), vault = pda([text('creator-vault'), holderReward ? pda([text('holder-rewards'), mint], PUMP) : creator], PUMP), uva = pda([text('user_volume_accumulator'), user], PUMP);
  const want = { 0: c.global, 1: mint, 2: WSOL_MINT, 3: TOKEN22, 4: TOKEN, 5: ATA_PROG, 7: ata(keys[6], TOKEN, WSOL_MINT), 9: ata(keys[8], TOKEN, WSOL_MINT), 10: curve, 11: ata(curve, TOKEN22, mint), 12: ata(curve, TOKEN, WSOL_MINT),
    13: user, 14: ata(user, TOKEN22, mint), 15: ata(user, TOKEN, WSOL_MINT), 16: vault, 17: ata(vault, TOKEN, WSOL_MINT), 18: pda([text('sharing-config'), mint], PFEE), 19: c.gva, 20: uva, 21: ata(uva, TOKEN, WSOL_MINT), 22: c.feeConfig, 23: PFEE, 24: SYSTEM, 25: c.events, 26: PUMP };
  for (const [i, k] of Object.entries(want)) if (keys[i] !== k) return 'buy account #' + (Number(i) + 1) + ' is not the one derived from the mint';
  return null;
}
const STRM = 'strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m', STRM_CREATE_V2 = [214, 144, 76, 236, 95, 139, 49, 180];
export function checkLock(raw, allowed, L) {
  let bytes; try { bytes = bs58.decode(raw); } catch { return { err: 'bad encoding' }; }
  if (bytes.length > 1232) return { err: 'too large' };
  let tx; try { tx = parseLegacy(bytes); } catch { return { err: 'unreadable' }; }
  const wallet = tx.keys[0]; if (!allowed.has(wallet)) return { err: 'not signed by one of your wallets' };
  if (!L.dry && L.template?.blockhash && tx.blockhash !== L.template.blockhash) return { err: 'wrong blockhash' };
  let lock = null;
  for (const ix of tx.ixs) {
    if (ix.program === CB) continue;
    if (ix.program !== STRM || lock) return { err: 'not a single Streamflow lock' };
    lock = ix;
  }
  if (!lock) return { err: 'no lock' };
  const d = lock.data; if (d.length < 140 || !STRM_CREATE_V2.every((v, i) => d[i] === v)) return { err: 'not a Streamflow create' };
  if (lock.accounts[0] !== wallet || lock.accounts[2] !== wallet) return { err: 'the tokens must come back to the same wallet' };
  if (L.template?.mint && lock.accounts[11] !== L.template.mint) return { err: 'lock of another coin' };
  const start = Number(u64(d, 8)), amount = u64(d, 16), cliff = Number(u64(d, 40)), cliffAmount = u64(d, 48);
  if (cliff !== start || cliffAmount !== amount || amount < 1n) return { err: 'not a one-time token lock' };
  for (let i = 56; i <= 61; i++) if (d[i]) return { err: 'lock can be cancelled, transferred or topped up' };
  if (d[134] || d[135]) return { err: 'lock can be paused or changed' };
  const want = Number(L.template?.lockUntil) || 0; if (want && cliff < want - 120) return { err: 'unlocks earlier than the lobby\'s lock time' };
  if (cliff > (want || Date.now() / 1000) + 120 || cliff > Date.now() / 1000 + MAX_LOCK_S) return { err: 'locks for longer than the lobby\'s lock time' };
  return { wallet, until: cliff };
}
// pump.fun creator fee sharing (Pump Fees program): create_fee_sharing_config + update_fee_shares(_v2) — the dev pays, the
// coin is the template's, the shareholders are exactly the dev + the lobby's ready teammates, every share > 0, sum 100%
const PFEE_CREATE = [195, 78, 86, 76, 111, 52, 251, 213], PFEE_UPDATE = [189, 13, 136, 99, 187, 164, 237, 35], PFEE_UPDATE2 = [111, 251, 49, 6, 78, 78, 106, 18];
export function checkFeeSplit(b58, mint, dev, want) {
  let tx; try { tx = parseTx(bs58.decode(b58)); } catch { return { err: 'cannot read the fee-split transaction' }; }
  if (tx.keys[0] !== dev) return { err: 'not paid by the lobby dev' };
  let created = false, holders = null;
  for (const ix of tx.ixs) {
    if (ix.program === CB) continue;
    if (ix.program !== PFEE) return { err: 'unexpected program ' + String(ix.program).slice(0, 6) };
    const d = ix.data; const is = (x) => d.length >= 8 && x.every((v, i) => d[i] === v);
    if (ix.accounts[4] && mint && ix.accounts[4] !== mint) return { err: 'for another coin' };
    if (is(PFEE_CREATE)) { created = true; continue; }
    if (is(PFEE_UPDATE) || is(PFEE_UPDATE2)) {
      if (holders) return { err: 'two share updates' };
      const n = d[8] | (d[9] << 8) | (d[10] << 16) | (d[11] << 24); if (n < 1 || n > 10 || d.length < 12 + n * 34) return { err: 'bad shareholder list' };
      holders = []; for (let i = 0; i < n; i++) { const o = 12 + i * 34; holders.push({ address: bs58.encode(d.subarray(o, o + 32)), bps: d[o + 32] | (d[o + 33] << 8) }); }
      continue;
    }
    return { err: 'unexpected fee instruction' };
  }
  if (!created || !holders) return { err: 'incomplete fee split' };
  if (holders.reduce((a, h) => a + h.bps, 0) !== 10000 || holders.some((h) => !(h.bps > 0))) return { err: 'shares must be positive and add up to 100%' };
  const got = new Set(holders.map((h) => h.address));
  if (got.size !== holders.length) return { err: 'duplicate shareholder' };
  const need = [...new Set(want)].slice(0, 10);
  for (const w of need) if (!got.has(w)) return { err: 'a teammate is missing from the split (' + short(w) + ')' };
  for (const h of holders) if (!need.includes(h.address)) return { err: 'a wallet outside the lobby is in the split (' + short(h.address) + ')' };
  // equal shares (the page's equalShares: the dev takes the rounding remainder), so nobody is shown one split and signed into another
  const each = Math.floor(10000 / holders.length);
  for (const h of holders) if (h.address !== dev && h.bps !== each) return { err: 'shares are not equal' };
  return { holders };
}
// the dev's launch, instruction by instruction: the page builds exactly compute budget + create_v2 of the template's mint +
// the dev's token account + ONE dev buy (buy_exact_quote_in_v2, its accounts derived from the mint, paid by the dev) + its 3%
// launch fee + at most one bundle tip. Anything else (a second buy, another program, another signer's transfer) is refused,
// so the dev cannot slip extra buys ahead of the squad or skip the fee. Returns {devLamports} or {err}.
export function checkPumpLaunch(createB58, t, dev) {
  let tx; try { tx = parseTx(bs58.decode(createB58)); } catch { return { err: 'the launch transaction cannot be read' }; }
  if (!t?.mint || !t.creator || !Array.isArray(t.buyKeys)) return { err: 'incomplete template' };
  if (!dev || tx.keys[0] !== dev) return { err: 'the launch transaction is not paid by the lobby dev' };
  if (t.creator !== dev) return { err: 'the coin\'s creator is not the lobby dev' };
  if (tx.nreq > 2) return { err: 'the launch transaction has extra signers' };
  let create = null, buy = null, tax = null, tips = 0;
  for (const ix of tx.ixs) {
    if (ix.program === CB) { if (ix.data[0] !== 2 && ix.data[0] !== 3) return { err: 'unexpected compute-budget instruction' }; continue; } // the dev picks their own priority fee
    if (ix.program === PUMP && CREATE_V2.every((v, i) => ix.data[i] === v)) { if (create) return { err: 'two creates' }; create = ix; continue; }
    if (ix.program === PUMP && ix.data.length === 24 && PUMP_BUY_IN.every((v, i) => ix.data[i] === v)) { if (buy) return { err: 'more than one buy in the launch transaction' }; buy = ix; continue; }
    if (ix.program === ATA_PROG) { if (ix.accounts[0] !== dev || ix.accounts[2] !== dev) return { err: 'token account for someone else' }; continue; }
    if (isTransfer(ix) && ix.accounts[0] === dev) {
      if (ix.accounts[1] === TREASURY) { if (tax) return { err: 'two launch fees' }; tax = ix; continue; }
      if (HELIUS_TIPS.has(ix.accounts[1]) && u64(ix.data, 4) <= 100000n && ++tips <= 1) continue;
    }
    return { err: 'unexpected instruction in the launch transaction' };
  }
  if (!create) return { err: 'no pump.fun create_v2 in the launch transaction' };
  const mi = create.idx[0]; if (create.accounts[0] !== t.mint || !(mi < tx.nreq)) return { err: 'the create is for another mint than the template' };
  if (!buy) return { err: 'the launch has no dev buy' };
  const devLamports = u64(buy.data, 8);
  if (devLamports < 1n || devLamports > 100_000_000_000n) return { err: 'the dev buy must be between 0 and 100 SOL' };
  // most of the buy's accounts sit in the lookup table and cannot be read here, but its buyer is a signer, and signers are
  // always written out in full: it must be the dev (the only other signer is the new mint)
  if (buy.accounts[13] !== dev) return { err: 'the buy in the launch transaction is not the dev\'s' };
  if (!tax || u64(tax.data, 4) !== launchTax(devLamports)) return { err: 'missing the 3% launch fee on the dev buy — reload the arenalaunch page' };
  const tk = pumpBuyKeysBad(t.buyKeys.map((k) => k.pubkey), t.mint, t.creator, t.creator, !!t.holderReward); if (tk) return { err: tk };
  return { devLamports: Number(devLamports) };
}
// Compute budget: at most one limit + one price, and a priority fee of at most MAX_PRIO lamports (0.01 SOL) per transaction
const MAX_PRIO = 10_000_000n, MAX_CU = 1_400_000;
export function prioBad(ixs) {
  let limit = null, price = 0n; const others = ixs.filter((ix) => ix.program !== CB).length;
  for (const ix of ixs) {
    if (ix.program !== CB) continue;
    if (ix.data[0] === 2 && ix.data.length === 5) { if (limit != null) return 'two compute limits'; limit = ix.data[1] | (ix.data[2] << 8) | (ix.data[3] << 16) | (ix.data[4] * 2 ** 24); }
    else if (ix.data[0] === 3 && ix.data.length === 9) { if (price) return 'two compute prices'; price = u64(ix.data, 1); }
    else return 'unexpected compute-budget instruction';
  }
  const cu = limit ?? Math.min(MAX_CU, 200000 * Math.max(1, others));
  if (cu > MAX_CU) return 'compute limit too high';
  if ((BigInt(cu) * price + 999_999n) / 1_000_000n > MAX_PRIO) return 'priority fee above 0.01 SOL';
  return null;
}
// pump.fun: exactly one buy_exact_quote_in_v2 of THIS coin for the member's amount, every non-buyer account identical to
// the dev's buy (fee recipients, curve, creator vault...) AND derived from the template's mint, only the buyer's own
// token-account creations besides it, a capped priority fee, and no SOL transfers but one bundle tip and the 3% launch tax.
export function validatePumpBuy(bytes, member, L) {
  let tx; try { tx = parseLegacy(bytes); } catch { return 'unparseable tx'; }
  const t = L.template; if (!t?.buyKeys || !t.mint) return 'no template';
  if (tx.keys[0] !== member.wallet) return 'not signed by your wallet';
  if (!L.dry && tx.blockhash !== t.blockhash) return 'wrong blockhash (stale template?)'; // a rehearsal is signed against a made-up blockhash on purpose: it can never land
  const fee = prioBad(tx.ixs); if (fee) return fee;
  const want = BigInt(Math.round(member.amount * 1e9)); let buys = 0, tips = 0, taxed = 0;
  for (const ix of tx.ixs) {
    if (ix.program === CB) continue;
    if (ix.program === ATA_PROG) { if (ix.accounts[0] !== member.wallet || ix.accounts[2] !== member.wallet) return 'token account for someone else'; continue; }
    if (ix.program === SYSTEM) {
      if (!isTransfer(ix) || ix.accounts[0] !== member.wallet) return 'unexpected system instruction';
      if (ix.accounts[1] === TREASURY) { if (u64(ix.data, 4) !== launchTax(want) || ++taxed > 1) return 'the 3% launch fee is wrong'; continue; }
      if (!HELIUS_TIPS.has(ix.accounts[1]) || u64(ix.data, 4) > 100000n || ++tips > 1) return 'unexpected transfer (only one bundle tip of at most 0.0001 SOL is allowed)';
      continue;
    }
    if (ix.program !== PUMP) return 'unexpected program ' + ix.program.slice(0, 6);
    { const k = pumpBuyKeysBad(ix.accounts, t.mint, t.creator, member.wallet, !!t.holderReward); if (k) return k; }
    if (ix.data.length !== 24 || !PUMP_BUY_IN.every((b, i) => ix.data[i] === b)) return 'not a pump.fun buy';
    if (ix.accounts.length !== t.buyKeys.length) return 'buy account count mismatch';
    if (ix.accounts[13] !== member.wallet) return 'buy owner mismatch';
    for (let i = 0; i < ix.accounts.length; i++) if (!PUMP_USER_IDX.has(i) && ix.accounts[i] !== t.buyKeys[i].pubkey) return 'buy account #' + (i + 1) + ' differs from the launch';
    if (u64(ix.data, 8) !== want) return 'buy amount mismatch (' + u64(ix.data, 8) + ' vs ' + want + ')';
    if (u64(ix.data, 16) < 1n) return 'min tokens out < 1';
    buys++;
  }
  if (buys !== 1) return 'expected exactly one buy';
  if (!taxed) return 'missing the 3% launch fee — reload the arenalaunch page';
  return null;
}
// ---- balances (public RPC from the worker) ----
const RPCS = ['https://api.mainnet-beta.solana.com', 'https://public.rpc.solanavibestation.com', 'https://solana-rpc.publicnode.com']; // (the Alchemy demo endpoint answers with an empty body — dropped)
// a paid RPC (secret SOL_RPC_URL, Helius) goes first: sends, status polls, balances and simulations try it before the public ones
export function useRpc(env) { const u = env?.SOL_RPC_URL; if (u && !RPCS.includes(u)) RPCS.unshift(u); if (u && /helius/i.test(u)) BUNDLE_URL = u; }
// Helius forwards bundles to Jito for an authenticated key (Jito's public endpoint silently drops ours); each bundle must tip one of these
let BUNDLE_URL = null;
export const HELIUS_TIPS = new Set(['4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE', 'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ', '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta', '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn', '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD', '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ', 'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF', '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT', '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey', '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or']);
const MIN_BUNDLE_TIP = 5000n;
export function tipsHelius(b58tx) {
  try { const t = parseTx(bs58.decode(b58tx)); return t.ixs.some((ix) => ix.program === SYSTEM && ix.data.length === 12 && ix.data[0] === 2 && !ix.data[1] && !ix.data[2] && !ix.data[3] && HELIUS_TIPS.has(ix.accounts[1]) && u64(ix.data, 4) >= MIN_BUNDLE_TIP); } catch { return false; }
}
export function sigOf(b58tx) { try { return bs58.encode(bs58.decode(b58tx).subarray(1, 65)); } catch { return null; } }
async function heliusBundle(txs) {
  try {
    const r = await fetchT(BUNDLE_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendBundle', params: [txs.map((t) => b64(bs58.decode(t))), { encoding: 'base64' }] }) }, 5000);
    const j = await r.json().catch(() => ({})); if (j.result) return { ok: true, id: j.result };
    return { ok: false, err: String(j.error?.message || ('HTTP ' + r.status)).slice(0, 120) };
  } catch (e) { return { ok: false, err: String(e.message || e).slice(0, 120) }; }
}
async function statusesOf(sigs) {
  for (const url of RPCS) {
    try { const r = await fetchT(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses', params: [sigs, { searchTransactionHistory: false }] }) }, 3000); const j = await r.json(); if (j.error) continue; return (j.result?.value || []).map((x) => (x && !x.err ? x : null)); } catch {}
  }
  return null;
}
async function balances(wallets) {
  if (!wallets.length) return {};
  for (const url of [...RPCS, ...RPCS]) {
    try {
      const r = await fetchT(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [wallets, { encoding: 'base64', commitment: 'processed', dataSlice: { offset: 0, length: 0 } }] }) }, 5000);
      const j = await r.json(); if (j.error) continue;
      const out = {}; (j.result?.value || []).forEach((a, i) => { out[wallets[i]] = a ? a.lamports / 1e9 : 0; }); return out;
    } catch {}
  }
  return null;
}
const needSol = (amount, tip) => amount * (1 + Number(LAUNCH_TAX_BPS) / 10000) + tip + 0.0045; // buy + 3% launch tax + tip + ATA rents + fees
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const short6 = (s) => String(s || '').slice(0, 6);
// quote-token balances (ui amount, summed over the owner's accounts of that mint) for non-SOL quotes
async function tokenBalances(wallets, mint) {
  const out = {};
  const res = await Promise.all(wallets.map(async (w) => {
    for (const url of [...RPCS, ...RPCS]) {
      try {
        const r = await fetchT(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [w, { mint }, { encoding: 'jsonParsed', commitment: 'processed' }] }) }, 5000);
        const j = await r.json(); if (j.error) continue;
        return (j.result?.value || []).reduce((s, a) => s + (Number(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount) || 0), 0);
      } catch {}
    }
    return null;
  }));
  for (let i = 0; i < wallets.length; i++) { if (res[i] == null) return null; out[wallets[i]] = res[i]; }
  return out;
}
async function jito(i, method, params) {
  const url = JITO[i % JITO.length] + '/api/v1/bundles';
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (r.status === 429) { await sleep(600); continue; }
    const j = await r.json(); if (j.error) throw new Error((j.error.message || JSON.stringify(j.error)).slice(0, 160));
    return j.result;
  }
  throw new Error('jito rate limited');
}
async function simulateRaw(b58tx, sigVerify) {
  let raw; try { raw = b64(bs58.decode(b58tx)); } catch { return null; }
  for (const url of RPCS) {
    try {
      const r = await fetchT(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'simulateTransaction', params: [raw, { encoding: 'base64', sigVerify: !!sigVerify, replaceRecentBlockhash: false, commitment: 'processed' }] }) }, 6000);
      const j = await r.json();
      // 'invalid transaction' (e.g. a lookup table that does not exist) is the transaction's fault, not the RPC's: it would fail on chain too
      if (j.error?.code === -32602 && /invalid transaction/i.test(j.error.message || '')) return { err: j.error.message, logs: [], bhValid: true };
      if (j.error) continue;
      const v = j.result?.value || {}; const bhValid = !(v.err === 'BlockhashNotFound' || JSON.stringify(v.err || '').includes('BlockhashNotFound'));
      return { err: bhValid ? v.err : null, logs: v.logs, bhValid };
    } catch {}
  }
  return null;
}
// send one transaction (base58) to every RPC at once; returns its signature or null when nobody accepted it
const b64 = (u8) => { let t = ''; for (let i = 0; i < u8.length; i++) t += String.fromCharCode(u8[i]); return btoa(t); }; // Workers have no Buffer
const fetchT = (url, init, ms) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); return fetch(url, { ...init, signal: c.signal }).finally(() => clearTimeout(t)); };
async function sendRaw(b58tx) {
  let bytes; try { bytes = bs58.decode(b58tx); } catch { return null; }
  const nsig = bytes[0]; const sig = bs58.encode(bytes.subarray(1, 65)); if (!nsig) return null;
  const b64tx = b64(bytes);
  // first RPC that accepts it wins; the others keep trying in the background (same signature, lands once at most)
  const tries = RPCS.map(async (url) => { try { const r = await fetchT(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [b64tx, { encoding: 'base64', skipPreflight: true, maxRetries: 3 }] }) }, 6000); const j = await r.json(); if (j.error) throw new Error(j.error.message || 'rpc'); return j.result; } catch (e) { throw e; } });
  try { await Promise.any(tries); return sig; } catch { return null; }
}
async function waitProcessed(sig, ms, every = 300) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleep(every);
    for (const url of RPCS) {
      try { const r = await fetchT(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses', params: [[sig], { searchTransactionHistory: false }] }) }, 4000); const j = await r.json(); if (j.error) continue; const st = j.result?.value?.[0]; if (st) return st; break; } catch {}
    }
  }
  return null;
}
async function regionStatuses(id) {
  const out = [];
  await Promise.all(JITO.map(async (u, i) => { try { const r = await jito(i, 'getInflightBundleStatuses', [[id]]); const v = r?.value?.[0]; if (v?.status) out.push({ r: regionName(u), status: v.status, slot: v.landed_slot || null }); } catch {} }));
  return out;
}
async function waitLanded(ids, ms = 30000) {
  const deadline = Date.now() + ms; const done = new Map();
  while (Date.now() < deadline && done.size < ids.length) {
    await sleep(1500);
    try { const r = await jito(0, 'getBundleStatuses', [ids]); for (const s of r?.value || []) if (s && (s.confirmation_status === 'confirmed' || s.confirmation_status === 'finalized' || s.err?.Ok === null || s.err === null)) done.set(s.bundle_id, s); } catch {}
  }
  return done;
}
// Jito never says why a bundle was dropped, but its in-flight status narrows it: Failed = a transaction in it failed at the
// leader (a buy without funds, a stale swap, ...); Pending/Invalid = it was never picked up (tip too low or blockhash expired).
async function dropReason(ids) {
  if (!ids.length) return 'nothing to check';
  const st = [];
  await Promise.all(JITO.map(async (_, i) => { try { const r = await jito(i, 'getInflightBundleStatuses', [ids]); for (const s of r?.value || []) if (s?.status) st.push(s.status); } catch {} }));
  if (st.includes('Failed')) return 'a transaction in it FAILED at the leader (a wallet short of SOL for rent/tip, or a buy the pool rejected)';
  if (st.includes('Landed')) return 'Jito reports it landed after all — check the mint';
  if (st.includes('Pending')) return 'still pending in Jito after 30s — never scheduled by a leader (tip too low for the moment)';
  if (st.length && st.every((x) => x === 'Invalid')) return 'no Jito region has a record of it (' + st.length + ' asked) — dropped at intake or never scheduled; the usual cause is a tip too low for the moment';
  return 'no status from any Jito region';
}
