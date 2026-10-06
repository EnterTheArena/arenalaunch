// Proves a GROUP launch includes everyone: a dev + 3 teammates, each teammate with a ★ wallet AND an extra wallet, all sign
// a REHEARSAL (dry: nothing sent). The relay must assemble every wallet into the launch and name them in the result.
//   node tools/build-sim.mjs group-check && node tools/.group-check.bundle.mjs
// Runs against the live relay by default; RELAY=http://127.0.0.1:8788 for a local wrangler dev.
import { Keypair, PublicKey, Transaction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, AddressLookupTableAccount } from '@solana/web3.js';
import { readFileSync } from 'fs';
import bs58 from 'bs58';
import BN from 'bn.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { pumpState, buildCreate, buyIxsFor, tokensFor, altKeysOf, signersOf, launchTaxIx } from '../src/pump.js';
import { mintToken } from '../api/gate.js';

const RELAY = process.env.RELAY || 'https://relay.arenalaunch.bond';
const gate = mintToken(JSON.parse(readFileSync(new URL('../.secrets.json', import.meta.url))).GATE_SECRET);
const H = { 'content-type': 'application/json', 'x-gate': gate, origin: process.env.ORIGIN || 'https://arenalaunch.bond' };
const RPC = process.env.SOL_RPC_URL || 'https://solana-rpc.publicnode.com';
const getAccounts = async (a) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [a, { encoding: 'base64' }] }) })).json()).result.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bh = Keypair.generate().publicKey.toBase58(); // a rehearsal signs against a made-up blockhash on purpose

const st = await pumpState(getAccounts);
const dev = Keypair.generate(), mint = Keypair.generate();
const built = await buildCreate(st, { mint: mint.publicKey, creator: dev.publicKey, name: 'Group', symbol: 'GRP', uri: 'https://x', holderReward: false, devLamports: 1e7, devMinOut: tokensFor(st, 1e7) });
const alt = new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: altKeysOf(built.ixs, signersOf(built.ixs)).map((k) => new PublicKey(k)) } });
const createTx = new VersionedTransaction(new TransactionMessage({ payerKey: dev.publicKey, recentBlockhash: bh, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), ...built.ixs, launchTaxIx(dev.publicKey, 1e7)] }).compileToV0Message([alt]));
createTx.sign([mint, dev]);
const template = { ...built.template, blockhash: bh, plannedLamports: 1e7, cu: 200000, prio: 0.0005 };

// a member's buy of `sol` from `kp`, built like the client's memberBuyTx
const prio = (cu, p) => [ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.max(1, Math.floor(p * 1e15 / cu)) })];
function buy(kp, sol) {
  const t = new Transaction({ feePayer: kp.publicKey, recentBlockhash: bh });
  t.add(...prio(200000, 0.0005), ...buyIxsFor(template, kp.publicKey, Math.round(sol * 1e9), new BN(1)), launchTaxIx(kp.publicKey, Math.round(sol * 1e9)));
  t.sign(kp);
  return bs58.encode(t.serialize({ requireAllSignatures: true, verifySignatures: true }));
}

const { code } = await (await fetch(RELAY + '/lobby/create', { method: 'POST', headers: H, body: '{"chain":"sol"}' })).json();
function conn(role, kp) {
  const ws = new WebSocket(RELAY.replace(/^http/, 'ws') + '/lobby/' + code + '/ws?g=' + encodeURIComponent(gate));
  const c = { ws, msgs: [], kp, star: Keypair.generate() };
  ws.onmessage = (e) => { const m = JSON.parse(e.data); c.msgs.push(m); if (m.t === 'sign' && role === 'member') { const starSol = 0.05, extra = [buy(c.star, 0.03)]; ws.send(JSON.stringify({ t: 'signed', tx: buy(kp, starSol), extra, locks: [] })); } };
  return c;
}
// NOTE for the member buys: the member's own ★ is `kp`; their extra wallet is `c.star`. Both must appear in the launch.
const dc = conn('dev', dev);
await new Promise((r) => (dc.ws.onopen = r));
const hello = (c, role, amount) => { const ts = Date.now(); c.ws.send(JSON.stringify({ t: 'hello', wallet: c.kp.publicKey.toBase58(), name: role + '-' + c.kp.publicKey.toBase58().slice(0, 4), sig: bs58.encode(ed25519.sign(new TextEncoder().encode('pumpcall-lobby:' + code + ':' + ts), c.kp.secretKey.slice(0, 32))), ts, role, amount, ready: role === 'member' })); };
hello(dc, 'dev', 0);
await sleep(1200);

const members = [];
for (let i = 0; i < 3; i++) { const kp = Keypair.generate(); const c = conn('member', kp); await new Promise((r) => (c.ws.onopen = r)); hello(c, 'member', 0.05); members.push(c); await sleep(500); }
await sleep(1500);

let result = null;
dc.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'result') result = m; };
dc.ws.send(JSON.stringify({ t: 'launch', single: true, fire: 'block0', template, createTx: bs58.encode(createTx.serialize()), preTxs: [], localTxs: [], tip: 0, dry: true, mint: built.template.mint }));

for (let i = 0; i < 40 && !result; i++) await sleep(500);
for (const c of [dc, ...members]) c.ws.close();

let bad = 0; const check = (name, ok, got) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : JSON.stringify(got)); };
check('the launch assembled (result came back, dry)', !!result && result.ok && result.dry, result);
// 3 teammates × 2 wallets each = 6 wallet buys, plus the dev's ★ buy inside the create
const names = result?.members || [];
check('every teammate wallet is in the launch (6 buys)', names.length === 6, names);
const stars = members.filter((c) => names.some((n) => n.includes(c.kp.publicKey.toBase58().slice(0, 4))));
check('all 3 teammates\' ★ wallets are in', stars.length === 3, members.map((c) => c.kp.publicKey.toBase58().slice(0, 4)));
const extras = members.filter((c) => names.some((n) => n.includes(c.star.publicKey.toBase58().slice(0, 4))));
check('all 3 teammates\' extra wallets are in', extras.length === 3, members.map((c) => c.star.publicKey.toBase58().slice(0, 4)));
console.log(bad ? '\nFAILED' : '\nall in — nobody was dropped');
process.exit(bad ? 1 : 0);
