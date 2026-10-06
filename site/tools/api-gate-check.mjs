// The site's paid proxies answer signed-in users only. Offline: upstream calls are intercepted, sessions are minted
// with the relay's own code.   node tools/api-gate-check.mjs   (from site/)
import { Accounts, readSession } from '../../relay/src/accounts.js';
const env = { ACCOUNT_SECRET: 'acct-secret' };
process.env.ACCOUNT_SECRET = 'acct-secret'; process.env.HUSHER_KEY = 'hk'; process.env.RL_KEY = 'rl'; process.env.SOL_RPC_URL = 'https://helius.test/?api-key=x';
const calls = [];
globalThis.fetch = async (url, init) => {
  url = String(url); calls.push(url);
  if (url.endsWith('/ratelimit')) return new Response(JSON.stringify({ allowed: true }));
  if (url.endsWith('/session/check')) { const b = JSON.parse(init.body); return new Response(JSON.stringify({ id: await readSession(relayEnv, b.session) })); }
  if (url.startsWith('https://helius.test')) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }));
  if (url.includes('husher.net')) return new Response(JSON.stringify({ success: false, message: 'Minimum amount 0.1 SOL' }), { status: 400 });
  throw new Error('unexpected ' + url);
};
let relayEnv = env;
// a real session, the way the relay mints one (email account sign-in path is the simplest to drive)
const mem = new Map(); const storage = { get: async (k) => mem.get(k), put: async (k, v) => mem.set(k, v), delete: async (k) => mem.delete(k), list: async ({ prefix }) => new Map([...mem].filter(([k]) => k.startsWith(prefix))) };
const mint = async (e) => { const A = new Accounts({ storage }, { ...e, STATS: { idFromName: () => 0, get: () => ({ fetch: async () => new Response('{}') }) } }); const f = globalThis.fetch; let code; globalThis.fetch = async (u, i) => { if (String(u).includes('resend')) { code = /is (\d{6})/.exec(JSON.parse(i.body).text)[1]; return new Response('{}'); } return f(u, i); };
  const call = async (op, b) => (await A.fetch(new Request('https://a/' + op, { method: 'POST', body: JSON.stringify(b) }))).json();
  const em = 'u' + Math.random().toString(36).slice(2) + '@x.io'; const { ticket } = await call('email-start', { email: em }); const r = await call('email-login', { email: em, ticket, code, auth: 'a'.repeat(43) }); globalThis.fetch = f; return r.session; };
const sess = await mint({ ...env, RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.io' });
const run = async (mod, body, session) => { const h = (await import('../api/' + mod + '.js')).default; let status = 200, out; const res = { status(s) { status = s; return this; }, json(o) { out = o; return this; }, setHeader() {} }; await h({ method: 'POST', body, headers: session ? { 'x-session': session } : {}, socket: {} }, res); return { status, out }; };
let fails = 0; const ok = (c, w) => { console.log((c ? 'ok   ' : 'FAIL ') + w); if (!c) fails++; };
const before = () => calls.filter((u) => u.includes('helius') || u.includes('husher')).length;

let n = before(); let r = await run('sol', { method: 'getSlot', params: [] });
ok(r.status === 401 && before() === n, '/api/sol without a session: 401, Helius never called');
r = await run('sol', { method: 'getSlot', params: [] }, sess.slice(0, -2) + 'xx'); ok(r.status === 401, '/api/sol with a forged session: 401');
r = await run('sol', { method: 'getSlot', params: [] }, sess); ok(r.status === 200 && r.out.result === 'ok', '/api/sol signed in: answered');
for (const m of ['getTransaction', 'getTokenAccountsByOwner', 'getProgramAccounts', 'getBalance']) { r = await run('sol', { method: m, params: [] }, sess); ok(r.status === 400, '/api/sol refuses ' + m); }
r = await run('sol', { method: 'getMultipleAccounts', params: [Array(101).fill('11111111111111111111111111111111')] }, sess); ok(r.status === 400, '/api/sol refuses 101 accounts in one call');
n = before(); r = await run('husher', { action: 'create', amount: 1, address: 'x'.repeat(40) }); ok(r.status === 401 && before() === n, '/api/husher without a session: 401, Husher never called');
r = await run('husher', { action: 'estimate' }, sess); ok(r.status === 200, '/api/husher signed in: answered');
for (const m of ['ipfs', 'pump']) { r = await run(m, { action: 'profile', address: '11111111111111111111111111111111' }); ok(r.status === 401, '/api/' + m + ' without a session: 401'); }
// the site deployment does not have the relay's secret: falls back to asking the relay
delete process.env.ACCOUNT_SECRET; process.env.GATE_SECRET = 'something-else';
const sess2 = await mint({ ...env, RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.io' });
n = calls.filter((u) => u.endsWith('/session/check')).length; r = await run('sol', { method: 'getSlot', params: [] }, sess2);
ok(r.status === 200 && calls.filter((u) => u.endsWith('/session/check')).length === n + 1, 'no shared secret here: the relay vouches for the session');
r = await run('sol', { method: 'getSlot', params: [] }, 'garbage.token'); ok(r.status === 401, '...and refuses a made-up one');
console.log(fails ? fails + ' FAILED' : 'all proxy gate checks passed'); process.exit(fails ? 1 : 0);
