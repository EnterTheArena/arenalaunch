// The relay's storage stays bounded: account summary + pruning, visitor counting, idle lobbies. In-memory, no network.
//   node tools/relay-store-check.mjs   (from site/)
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import { Stats, Accounts, Lobby } from '../../relay/src/index.js';
import { hllAdd, hllCount } from '../../relay/src/stats.js';

let fails = 0; const ok = (c, what) => { console.log((c ? 'ok   ' : 'FAIL ') + what); if (!c) fails++; };
globalThis.fetch = async (url) => { throw new Error('unexpected network call ' + url); };
const clock = { now: Date.now() }; Date.now = () => clock.now; const DAY = 86400000;
function memStorage() {
  const mem = new Map(); let alarm = null;
  const pick = ({ prefix = '', start, end, limit } = {}) => { let ks = [...mem.keys()].filter((k) => k.startsWith(prefix) && (start == null || k >= start) && (end == null || k < end)).sort(); if (limit) ks = ks.slice(0, limit); return new Map(ks.map((k) => [k, structuredClone(mem.get(k))])); };
  return {
    mem, get alarmAt() { return alarm; },
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => mem.has(x)).map((x) => [x, structuredClone(mem.get(x))])) : structuredClone(mem.get(k))),
    put: async (k, v) => { mem.set(k, structuredClone(v)); },
    delete: async (k) => (Array.isArray(k) ? k.filter((x) => mem.delete(x)).length : mem.delete(k)),
    deleteAll: async () => { mem.clear(); alarm = null; }, list: async (o) => pick(o),
    setAlarm: async (t) => { alarm = t; }, getAlarm: async () => alarm, deleteAlarm: async () => { alarm = null; },
  };
}
const ctx = (storage = memStorage()) => ({ storage, waitUntil: () => {}, blockConcurrencyWhile: (f) => f(), getWebSockets: () => [] });
const env = { ACCOUNT_SECRET: 'acct', ALLOWED_ORIGINS: 'https://arenalaunch.bond', STATS: { idFromName: () => 0, get: () => ({ fetch: async () => new Response('{}') }) } };

// ---- accounts: running summary, abandoned accounts pruned, saved ones never ----
const AS = memStorage(); const A = new Accounts(ctx(AS), env);
const call = async (op, b) => { const r = await A.fetch(new Request('https://acct/' + op, { method: 'POST', body: JSON.stringify(b) })); return { status: r.status, ...(await r.json()) }; };
async function signIn() {
  const kp = ed25519.utils.randomSecretKey(), pub = bs58.encode(ed25519.getPublicKey(kp)); const { nonce } = await call('nonce', {});
  const m = new TextEncoder().encode('arenalaunch.bond wants you to sign in with your Solana account:\n' + pub + '\n\nSign in.\n\nURI: https://arenalaunch.bond\nVersion: 1\nChain ID: mainnet\nNonce: ' + nonce + '\nIssued At: ' + new Date(clock.now).toISOString());
  return call('wallet', { address: pub, message: bs58.encode(m), sig: bs58.encode(ed25519.sign(m, kp)) });
}
const a1 = await signIn(); ok(a1.status === 200, 'sign-in works');
let c = await call('count', {}); ok(c.total === 1 && c.withWallets === 0 && AS.mem.has('sum'), 'first dashboard read seeds the summary from a scan');
const a2 = await signIn(); await call('save', { session: a2.session, vault: 'v1.real', ver: 0 });
const a3 = await signIn(); await call('save', { session: a3.session, vault: 'blob1', ver: 0 }); // a test account
c = await call('count', {}); ok(c.total === 2 && c.withWallets === 1 && c.latest.length === 2, 'sign-ins and saves keep the summary current (test vaults left out)');
const scan = [...AS.mem.keys()].filter((k) => /^[we]:/.test(k)).length; ok(scan === 3, 'three records exist (the test one is stored, just not counted)');
clock.now += 31 * DAY; await signIn(); // someone signs in a month later: a few records are pruned on the way
ok(!AS.mem.has(a1.id) && AS.mem.has(a2.id), 'a wallet account that never saved anything is pruned after 30 days; a saved one is kept');
c = await call('count', {}); ok(c.total === 2 && c.withWallets === 1, 'the summary follows the prune');

// ---- visitors: exact per day, HLL all-time, old keys folded in and removed ----
const SS = memStorage(); const S = new Stats(ctx(SS), env);
const hit = (b) => S.fetch(new Request('https://stats/hit', { method: 'POST', body: JSON.stringify(b) }));
const tot = async () => (await (await S.fetch(new Request('https://stats/summary'))).json()).totals;
for (let i = 0; i < 300; i++) await SS.put('v:legacy' + String(i).padStart(4, '0'), 1); await SS.put('tot', { uniques: 300, visits: 400 });
await SS.put('uv:2020-01-01:legacyday', 1);
// a big backlog folds in over several visits; meanwhile the count stays exact
const BS = memStorage(); const B = new Stats(ctx(BS), env); const bhit = (b) => B.fetch(new Request('https://stats/hit', { method: 'POST', body: JSON.stringify(b) }));
for (let i = 0; i < 1500; i++) await BS.put('v:old' + String(i).padStart(5, '0'), 1); await BS.put('tot', { uniques: 1500 });
await bhit({ type: 'visit', v: 'old01400' }); await bhit({ type: 'visit', v: 'newcomer000' });
ok((await BS.get('tot')).uniques === 1501 && [...BS.mem.keys()].some((k) => k.startsWith('v:')), 'mid fold-in: returning visitor not recounted, newcomer counted exactly (1501)');
await bhit({ type: 'visit', v: 'newcomer000' }); await bhit({ type: 'visit', v: 'newcomer000' });
const bt = (await BS.get('tot')).uniques; ok(![...BS.mem.keys()].some((k) => k.startsWith('v:')) && Math.abs(bt - 1501) / 1501 < 0.05, 'fold-in done: the estimate takes over (' + bt + ' ≈ 1501)');
await hit({ type: 'visit', v: 'legacy0001' }); ok(Math.abs((await tot()).uniques - 300) <= 6, 'a small backlog folds in at once; returning visitor not counted twice');
await hit({ type: 'visit', v: 'brandnewvisitor1' });
const t1 = (await tot()).uniques; ok(Math.abs(t1 - 301) <= 6, 'a new visitor is counted (' + t1 + ' ≈ 301)');
ok(![...SS.mem.keys()].some((k) => k.startsWith('v:')) && !SS.mem.has('uv:2020-01-01:legacyday'), 'old per-visitor keys and earlier days are gone');
for (let i = 0; i < 5; i++) await hit({ type: 'visit', v: 'brandnewvisitor1' }); ok((await tot()).uniques === t1, 'the same visitor again does not move all-time uniques');
const h = new Uint8Array(4096); for (let i = 0; i < 20000; i++) await hllAdd(h, 'id' + i + 'x' + (i * 7919));
const est = hllCount(h); ok(Math.abs(est - 20000) / 20000 < 0.05, 'HLL estimate within 5% at 20k visitors (' + est + ')');
ok([...SS.mem.keys()].length < 20, 'stats storage holds a handful of keys, not one per visitor (' + SS.mem.size + ')');

// ---- lobbies: an idle lobby deletes itself; a pending launch is never touched ----
const LS = memStorage(); const L = new Lobby(ctx(LS), env);
await L.fetch(new Request('https://lobby/init', { method: 'POST', body: JSON.stringify({ code: 'ABCDEF', chain: 'sol' }) }));
ok(LS.alarmAt && Math.abs(LS.alarmAt - (clock.now + 7 * DAY)) < 1000, 'a new lobby sets its idle clock to 7 days');
await LS.put('ban:x', 1); clock.now += 3 * DAY; await L.alarm(); ok(LS.mem.has('meta'), 'an alarm before the week is up keeps the lobby');
clock.now += 5 * DAY; await LS.put('launch', { fireAt: clock.now + 5000 }); await L.alarm(); ok(LS.mem.has('meta') && LS.alarmAt === clock.now + 5000, 'with a launch pending the alarm is the launch, not the idle clock');
await LS.delete('launch'); await L.alarm(); ok(!LS.mem.size && L.code === null, 'idle a week with nobody connected: everything deleted, the code is free');
const r = await L.fetch(new Request('https://lobby/init', { method: 'POST', body: JSON.stringify({ code: 'ABCDEF', chain: 'sol' }) })); ok(r.status === 200, 'the code can be opened again');

console.log(fails ? fails + ' FAILED' : 'all relay storage checks passed'); process.exit(fails ? 1 : 0);
