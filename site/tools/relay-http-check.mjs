// The relay's HTTP rules, run against the real worker with in-memory Durable Objects. No network.
//   node tools/relay-http-check.mjs   (from site/)
import worker, { Stats, Accounts, extraOf, MAX_EXTRA_N, MAX_EXTRA_SOL } from '../../relay/src/index.js';
import { readSiws, mintSession } from '../../relay/src/accounts.js';
import { mintToken } from '../api/gate.js';

let fails = 0; const ok = (c, what) => { console.log((c ? 'ok   ' : 'FAIL ') + what); if (!c) fails++; };
globalThis.fetch = async (url) => { throw new Error('unexpected network call ' + url); };
globalThis.caches = { default: { match: async () => null, put: async () => {}, delete: async () => {} } };

// in-memory Durable Object storage (the parts the relay uses)
export function memStorage() {
  const mem = new Map(); let alarm = null;
  const pick = ({ prefix = '', start, end, limit } = {}) => { let ks = [...mem.keys()].filter((k) => k.startsWith(prefix) && (start == null || k >= start) && (end == null || k < end)).sort(); if (limit) ks = ks.slice(0, limit); return new Map(ks.map((k) => [k, structuredClone(mem.get(k))])); };
  return {
    mem, get alarmAt() { return alarm; },
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => mem.has(x)).map((x) => [x, structuredClone(mem.get(x))])) : structuredClone(mem.get(k))),
    put: async (k, v) => { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) mem.set(a, structuredClone(b)); else mem.set(k, structuredClone(v)); },
    delete: async (k) => (Array.isArray(k) ? k.filter((x) => mem.delete(x)).length : mem.delete(k)),
    deleteAll: async () => mem.clear(), list: async (o) => pick(o),
    setAlarm: async (t) => { alarm = t; }, getAlarm: async () => alarm, deleteAlarm: async () => { alarm = null; },
  };
}
const ns = (Cls, envRef) => { const objs = new Map(); return { idFromName: (n) => n, get: (id) => { if (!objs.has(id)) { const inst = new Cls({ storage: memStorage(), waitUntil: () => {}, blockConcurrencyWhile: (f) => f() }, envRef.env); objs.set(id, { inst, fetch: (u, init) => inst.fetch(u instanceof Request ? u : new Request(u, init)) }); } return objs.get(id); } }; };
class FakeRL { constructor() { this.n = 0; } async fetch(req) { const b = await req.json(); if (new URL(req.url).pathname !== '/count') return Response.json({ allowed: true }); this.n++; return Response.json({ allowed: this.n <= b.limit, n: this.n }); } }
export function makeEnv(extra = {}) {
  const ref = {}; const env = { GATE_SECRET: 'gate-secret', ACCOUNT_SECRET: 'acct-secret', RL_KEY: 'rl-key', ALLOWED_ORIGINS: 'https://arenalaunch.bond,https://www.arenalaunch.bond', ...extra };
  ref.env = env; env.STATS = ns(Stats, ref); env.ACCOUNTS = ns(Accounts, ref); env.RATELIMIT = ns(FakeRL, ref); return env;
}
const SITE = 'https://arenalaunch.bond';
const req = (path, { method = 'POST', origin = SITE, headers = {}, body } = {}) => new Request('https://relay.arenalaunch.bond' + path, { method, headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...headers }, body: body == null ? undefined : JSON.stringify(body) });
const env = makeEnv(); const gate = mintToken(env.GATE_SECRET);

// ---- the gate fails closed ----
let r = await worker.fetch(req('/lobby/create', { headers: { 'x-gate': gate }, body: {} }), makeEnv({ GATE_SECRET: undefined }));
ok(r.status === 401, 'no GATE_SECRET: the relay refuses (fails closed), it does not open');
r = await worker.fetch(req('/account/nonce', { headers: { 'x-gate': 'nope.nope' }, body: {} }), env);
ok(r.status === 401, 'a forged gate token is refused');
r = await worker.fetch(req('/account/nonce', { headers: { 'x-gate': gate }, body: {} }), env);
ok(r.status === 200 && (await r.json()).nonce, 'a real gate token gets through');

// ---- origins: only ours; localhost only with DEV ----
r = await worker.fetch(req('/account/nonce', { origin: 'http://localhost:5182', headers: { 'x-gate': gate }, body: {} }), env);
ok(r.status === 403, 'production refuses a localhost origin');
r = await worker.fetch(req('/account/nonce', { origin: 'https://evil.example', headers: { 'x-gate': gate }, body: {} }), env);
ok(r.status === 403, 'a foreign origin is refused');
r = await worker.fetch(req('/account/nonce', { origin: 'http://localhost:5182', headers: { 'x-gate': gate }, body: {} }), makeEnv({ DEV: '1' }));
ok(r.status === 200, 'with DEV set, localhost works (wrangler dev)');
r = await worker.fetch(req('/account/nonce', { method: 'OPTIONS', origin: 'https://evil.example' }), env);
ok(!r.headers.get('access-control-allow-origin'), 'CORS never reflects a foreign origin');
r = await worker.fetch(req('/account/nonce', { method: 'OPTIONS', origin: SITE }), env);
ok(r.headers.get('access-control-allow-origin') === SITE, 'CORS reflects our own origin');
const siws = (d) => d + ' wants you to sign in with your Solana account:\n11111111111111111111111111111111\n\nx\n\nNonce: n\nIssued At: ' + new Date().toISOString();
ok(readSiws(env, siws('localhost:5182'), '11111111111111111111111111111111').error && !readSiws(env, siws('arenalaunch.bond'), '11111111111111111111111111111111').error, 'a sign-in message for localhost is refused in production');

// ---- the owner's problems list: signed-in accounts only, short, limited ----
const errors = async (e) => (await (await e.STATS.get('all').fetch('https://stats/summary')).json()).errors;
const sess = await mintSession(env, 'w:11111111111111111111111111111112');
r = await worker.fetch(req('/stats/error', { headers: { 'x-gate': gate }, body: { msg: 'spam' } }), env);
ok(r.status === 401 && !(await errors(env)).length, '/stats/error with no session: 401, nothing recorded');
r = await worker.fetch(req('/stats/error', { headers: { 'x-gate': gate, 'x-session': sess.slice(0, -3) + 'abc' }, body: { msg: 'spam' } }), env);
ok(r.status === 401, '/stats/error with a forged session: 401');
r = await worker.fetch(req('/stats/error', { headers: { 'x-gate': gate, 'x-session': sess }, body: { msg: 'x'.repeat(3000) } }), env);
ok(r.status === 413 && !(await errors(env)).length, '/stats/error refuses an oversized body');
r = await worker.fetch(req('/stats/error', { headers: { 'x-gate': gate, 'x-session': sess }, body: { msg: 'launch: it broke', where: 'launch' } }), env);
const got = await errors(env);
ok(r.status === 200 && got.length === 1 && got[0].account === 'w:11111111111111111111111111111112', 'a signed-in report is recorded with its account');
let codes = []; for (let i = 0; i < 20; i++) codes.push((await worker.fetch(req('/stats/error', { headers: { 'x-gate': gate, 'x-session': sess }, body: { msg: 'n' + i } }), env)).status);
ok(codes.filter((c) => c === 200).length === 18 && codes.slice(18).every((c) => c === 429), 'one account gets 20 reports per 10 minutes (2 used above), then 429');

// ---- a teammate's claimed extra wallets stay small (they loosen everyone's slippage floors) ----
const big = extraOf({ n: 10, sol: 1000 });
ok(MAX_EXTRA_N === 3 && MAX_EXTRA_SOL === 10 && big.n === 3 && big.sol === 30, 'a claim of 10 wallets / 1000 SOL counts as 3 wallets / 30 SOL');
ok(extraOf({ n: 2, sol: 5 }).sol === 5 && extraOf({ n: 0, sol: 5 }) === null && extraOf({ n: 2, sol: Infinity }).sol === 20, 'small claims kept; junk bounded');

export const done = () => { console.log(fails ? fails + ' FAILED' : 'all relay http checks passed'); process.exit(fails ? 1 : 0); };
export { ok, req, gate, env, SITE };
if (process.argv[1]?.endsWith('relay-http-check.mjs')) done();
