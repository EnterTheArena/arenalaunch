// The private-transfer fee is enforced by the server: api/husher.js 'create' needs a confirmed, recent, big-enough,
// never-used fee payment to the treasury. Runs the real handler + the relay's real Claims store; chain, relay and
// Husher are stand-ins. No network.   node tools/husher-fee-check.mjs   (from site/)
import { Accounts, readSession } from '../../relay/src/accounts.js';
import worker, { Claims } from '../../relay/src/index.js';
import { TREASURY, husherFee } from '../src/fees.js';

let fails = 0; const ok = (c, w) => { console.log((c ? 'ok   ' : 'FAIL ') + w); if (!c) fails++; };
process.env.ACCOUNT_SECRET = 'acct'; process.env.HUSHER_KEY = 'hk'; process.env.RL_KEY = 'rl'; process.env.SOL_RPC_URL = 'https://rpc.test/';
const relayEnv = { ACCOUNT_SECRET: 'acct', GATE_SECRET: 'g', RL_KEY: 'rl', ALLOWED_ORIGINS: 'https://arenalaunch.bond' };
// one real Claims object behind the real worker route
const mem = new Map(); let alarm = null;
const storage = { get: async (k) => structuredClone(mem.get(k)), put: async (k, v) => mem.set(k, structuredClone(v)), delete: async (k) => mem.delete(k), list: async ({ prefix = '', start, limit } = {}) => { let ks = [...mem.keys()].filter((k) => k.startsWith(prefix) && (start == null || k >= start)).sort(); if (limit) ks = ks.slice(0, limit); return new Map(ks.map((k) => [k, mem.get(k)])); }, getAlarm: async () => alarm, setAlarm: async (t) => { alarm = t; } };
const claims = new Claims({ storage }); relayEnv.CLAIMS = { idFromName: () => 0, get: () => ({ fetch: (u, i) => claims.fetch(new Request(u, i)) }) };

// the chain: signature → transaction (jsonParsed shape)
const chain = new Map(); let rpcDown = false; let husherFails = false; const created = [];
const SIG = (n) => n.repeat(88).slice(0, 88);
const tx = ({ to = TREASURY, lamports, err = null, age = 10, from = 'Payer1111111111111111111111111111111111111' }) => ({ blockTime: Math.floor(Date.now() / 1000) - age, meta: { err }, transaction: { message: { instructions: [{ program: 'system', parsed: { type: 'transfer', info: { source: from, destination: to, lamports } } }] } } });
globalThis.fetch = async (url, init) => {
  url = String(url);
  if (url.endsWith('/ratelimit')) return new Response(JSON.stringify({ allowed: true }));
  if (url.endsWith('/session/check')) return new Response(JSON.stringify({ id: await readSession(relayEnv, JSON.parse(init.body).session) }));
  if (url.endsWith('/fee/claim')) return worker.fetch(new Request('https://relay.arenalaunch.bond/fee/claim', { method: 'POST', headers: init.headers, body: init.body }), relayEnv);
  if (url.startsWith('https://rpc.test') || url.includes('solana')) { if (rpcDown) throw new Error('down'); const b = JSON.parse(init.body); return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: chain.get(b.params[0]) || null })); }
  if (url.endsWith('/private/create')) { if (husherFails) return new Response(JSON.stringify({ success: false, message: 'Husher is busy' }), { status: 500 }); const id = 'ord' + (created.length + 1); created.push({ id, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ success: true, data: id })); }
  if (url.includes('/private/order/')) return new Response(JSON.stringify({ success: true, data: { orderId: url.split('/').pop(), sendAddress: 'dep', sendAmount: 1, receiveAmount: 0.99, status: 'pending' } }));
  throw new Error('unexpected ' + url);
};
// two real sessions, the way the relay mints them
const memA = new Map(); const st = { get: async (k) => memA.get(k), put: async (k, v) => memA.set(k, v), delete: async (k) => memA.delete(k), list: async ({ prefix }) => new Map([...memA].filter(([k]) => k.startsWith(prefix))) };
async function session(email) {
  const A = new Accounts({ storage: st }, { ...relayEnv, RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.io', STATS: { idFromName: () => 0, get: () => ({ fetch: async () => new Response('{}') }) } });
  const f = globalThis.fetch; let code; globalThis.fetch = async (u, i) => { if (String(u).includes('resend')) { code = /code is (\d{6})/.exec(JSON.parse(i.body).text)[1]; return new Response('{}'); } return f(u, i); };
  const call = async (op, b) => (await A.fetch(new Request('https://a/' + op, { method: 'POST', body: JSON.stringify(b) }))).json();
  const { ticket } = await call('email-start', { email }); const r = await call('email-login', { email, ticket, code, auth: 'a'.repeat(43) }); globalThis.fetch = f; return r.session;
}
const me = await session('me@x.io'), other = await session('other@x.io');
const handler = (await import('../api/husher.js')).default;
const create = async (body, sess = me) => { let status = 200, out; const res = { status(s) { status = s; return this; }, json(o) { out = o; return this; }, setHeader() {} }; await handler({ method: 'POST', headers: { 'x-session': sess, 'x-forwarded-for': '1.2.3.4' }, body: { action: 'create', address: 'D'.repeat(44), ...body } }, res); return { ...out, status }; };

const total = 1_000_000_000, fee = husherFee(total), order = (total - fee) / 1e9; // 1 SOL leaves the wallet: 0.02 fee, 0.98 order
ok(fee === 20_000_000, 'the fee is 2% of what leaves the wallet');
let r = await create({ amount: order });
ok(r.status === 402 && !created.length, 'no fee payment: refused, no Husher order');
chain.set(SIG('a'), tx({ lamports: fee - 2 })); r = await create({ amount: order, feeSig: SIG('a') });
ok(r.status === 402 && /does not cover/.test(r.error) && !created.length, 'two lamports short of 2% (one is allowed for rounding): refused');
chain.set(SIG('b'), tx({ lamports: fee, to: 'Somebody111111111111111111111111111111111' })); r = await create({ amount: order, feeSig: SIG('b') });
ok(r.status === 402 && !created.length, 'paid to the wrong address: refused');
chain.set(SIG('c'), tx({ lamports: fee, err: { InstructionError: [0, 'x'] } })); r = await create({ amount: order, feeSig: SIG('c') });
ok(r.status === 402 && /failed/.test(r.error), 'a failed transaction: refused');
chain.set(SIG('d'), tx({ lamports: fee, age: 3600 })); r = await create({ amount: order, feeSig: SIG('d') });
ok(r.status === 402 && /too old/.test(r.error), 'a payment from an hour ago: refused');
r = await create({ amount: order, feeSig: SIG('e') });
ok(r.status === 402 && r.retry && /not confirmed yet/.test(r.error), 'not on chain yet: refused with retry (the page tries again)');
rpcDown = true; r = await create({ amount: order, feeSig: SIG('e') }); rpcDown = false;
ok(r.status === 503 && r.retry, 'RPC unreachable: 503, never a free order');
chain.set(SIG('f'), tx({ lamports: fee })); husherFails = true; r = await create({ amount: order, feeSig: SIG('f') }); husherFails = false;
ok(r.status === 502 && !created.length, 'Husher fails: no order …');
r = await create({ amount: order, feeSig: SIG('f') });
ok(r.status === 200 && r.id === 'ord1' && created.length === 1 && created[0].body.amount === order, '… and the same payment works on retry (not charged twice)');
r = await create({ amount: order, feeSig: SIG('f') });
ok(r.status === 409 && created.length === 1, 'the same payment twice: refused (one order per fee)');
chain.set(SIG('g'), tx({ lamports: fee })); r = await create({ amount: order, feeSig: SIG('g') }, other);
ok(r.status === 200 && created.length === 2, 'another account with its own payment: works');
r = await create({ amount: order, feeSig: SIG('g') }, me);
ok(r.status === 409 && created.length === 2, "someone else's payment: refused");
chain.set(SIG('h'), tx({ lamports: fee })); r = await create({ amount: order * 2, feeSig: SIG('h') });
ok(r.status === 402 && created.length === 2, 'a fee for 1 SOL does not cover a 2 SOL order');
delete process.env.RL_KEY; chain.set(SIG('i'), tx({ lamports: fee })); r = await create({ amount: order, feeSig: SIG('i') }, me); process.env.RL_KEY = 'rl';
ok(r.status !== 200 && created.length === 2, 'no RL_KEY: fails closed (no order)');
r = await worker.fetch(new Request('https://relay.arenalaunch.bond/fee/claim', { method: 'POST', headers: { 'x-rl-key': 'wrong' }, body: JSON.stringify({ op: 'release', sig: SIG('f'), who: 'e:me@x.io' }) }), relayEnv);
ok(r.status === 403, 'the relay claim store refuses callers without the site key');

console.log(fails ? fails + ' FAILED' : 'all husher fee checks passed'); process.exit(fails ? 1 : 0);
