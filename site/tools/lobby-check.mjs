// Check of the relay's lobby rules (live or local): dev seat is permanent, buy amounts are bounded, unknown lobbies refuse
// sockets, the dashboard is admin-wallet only.
//   node tools/lobby-check.mjs                  (live relay)
//   RELAY=http://127.0.0.1:8788 node tools/lobby-check.mjs --burst   (local wrangler dev; --burst also trips the lobby rate limit)
import { readFileSync } from 'fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import { mintToken } from '../api/gate.js';
const RELAY = process.env.RELAY || 'https://relay.arenalaunch.bond';
const sec = JSON.parse(readFileSync(new URL('../.secrets.json', import.meta.url)));
const gate = mintToken(sec.GATE_SECRET); const H = { 'content-type': 'application/json', 'x-gate': gate, origin: 'http://localhost:5182' };
let bad = 0; const check = (name, ok, got) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : JSON.stringify(got)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wallet = () => { const k = ed25519.utils.randomSecretKey(); return { k, pub: bs58.encode(ed25519.getPublicKey(k)) }; };
async function connect(code) {
  const ws = new WebSocket(RELAY.replace(/^http/, 'ws') + '/lobby/' + code + '/ws?g=' + encodeURIComponent(gate));
  const msgs = []; ws.onmessage = (e) => msgs.push(JSON.parse(e.data));
  const opened = await new Promise((r) => { ws.onopen = () => r(true); ws.onerror = () => r(false); ws.onclose = () => r(false); setTimeout(() => r(false), 8000); });
  return { ws, msgs, opened, send: (o) => ws.send(JSON.stringify(o)) };
}
const hello = (c, code, w, role, amount) => { const ts = Date.now(); c.send({ t: 'hello', wallet: w.pub, name: role + w.pub.slice(0, 4), sig: bs58.encode(ed25519.sign(new TextEncoder().encode('pumpcall-lobby:' + code + ':' + ts), w.k)), ts, role, amount, ready: true }); };
const lastRoster = (c) => [...c.msgs].reverse().find((m) => m.t === 'roster');

const r = await fetch(RELAY + '/lobby/create', { method: 'POST', headers: H, body: '{"chain":"sol"}' }); const { code } = await r.json();
check('lobby created', /^[A-Z2-9]{6}$/.test(code || ''), code);
const A = wallet(), B = wallet(), M = wallet();
const a = await connect(code); hello(a, code, A, 'dev', 0); await sleep(1200);
check('creator holds the dev seat', lastRoster(a)?.dev === A.pub, lastRoster(a));
a.ws.close(); await sleep(1200);
const b = await connect(code); hello(b, code, B, 'dev', 0); await sleep(1200);
check('another wallet cannot take the seat while the dev is away', b.msgs.some((m) => m.t === 'error' && /already has a dev/.test(m.msg)), b.msgs);
const a2 = await connect(code); hello(a2, code, A, 'dev', 0); await sleep(1200);
check('the dev gets the seat back', lastRoster(a2)?.dev === A.pub && lastRoster(a2)?.you === A.pub, lastRoster(a2));
const m = await connect(code); hello(m, code, M, 'member', 'Infinity'); await sleep(1200);
check('an infinite buy counts as 0', lastRoster(m)?.members.find((x) => x.wallet === M.pub)?.amount === 0, lastRoster(m));
m.send({ t: 'amount', amount: 150 }); await sleep(900);
check('a 150 SOL buy is refused', m.msgs.some((x) => x.t === 'error' && /at most 100/.test(x.msg)) && lastRoster(m)?.members.find((x) => x.wallet === M.pub)?.amount === 0, m.msgs.slice(-3));
m.send({ t: 'amount', amount: 0.25 }); await sleep(900);
check('a 0.25 SOL buy is kept', lastRoster(m)?.members.find((x) => x.wallet === M.pub)?.amount === 0.25, lastRoster(m));
for (const c of [a2, b, m]) c.ws.close();
// a code nobody created
let free = ''; for (const x of crypto.getRandomValues(new Uint8Array(6))) free += 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[x % 32];
const ghost = await connect(free); check('a socket to a lobby that was never opened is refused', !ghost.opened, ghost.opened);
// stats key: header works, nothing without it
// the dashboard answers only a signed-in session of the admin wallet: no session, a junk one, or the old key are refused
const s1 = await fetch(RELAY + '/stats/summary', { headers: { 'x-stats-key': sec.STATS_KEY } }); check('old dashboard key refused', s1.status === 403, s1.status);
const s2 = await fetch(RELAY + '/stats/summary', { headers: { 'x-session': 'junk.junk' } }); check('a junk session refused', s2.status === 403, s2.status);
const s3 = await fetch(RELAY + '/launches'); check('public launches list stays public', s3.status === 200, s3.status);
if (process.argv.includes('--burst')) {
  let st = []; for (let i = 0; i < 32; i++) st.push((await fetch(RELAY + '/lobby/create', { method: 'POST', headers: H, body: '{}' })).status);
  check('lobby creation is rate limited after a few dozen a minute', st.includes(429) && st.slice(0, 25).every((x) => x === 200), st.join(','));
}
process.exit(bad ? 1 : 0);
