// Drives the relay's REAL launch path (dry: false, a go-live countdown) with a launch transaction that cannot land
// (it points at a lookup table that does not exist), and prints every message the lobby sends back.
// The relay must answer with a result (here: "fails simulation"); silence means the launch path is stuck.
//   node tools/build-sim.mjs fire-probe && node tools/.fire-probe.bundle.mjs [countdownSeconds]
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, AddressLookupTableAccount } from '@solana/web3.js';
import { readFileSync } from 'fs';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519.js';
import { pumpState, buildCreate, tokensFor, altKeysOf, signersOf, launchTaxIx } from '../src/pump.js';
import { mintToken } from '../api/gate.js';

const RELAY = process.env.RELAY || 'https://relay.arenalaunch.bond';
const gate = mintToken(JSON.parse(readFileSync(new URL('../.secrets.json', import.meta.url))).GATE_SECRET);
const RPC = 'https://api.mainnet-beta.solana.com';
const getAccounts = async (a) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [a, { encoding: 'base64' }] }) })).json()).result.value;
const countdown = Number(process.argv[2] ?? 8);
const st = await pumpState(getAccounts);
const dev = Keypair.generate(), mint = Keypair.generate();
const built = await buildCreate(st, { mint: mint.publicKey, creator: dev.publicKey, name: 'Probe', symbol: 'PRB', uri: 'https://x', holderReward: false, devLamports: 1e7, devMinOut: tokensFor(st, 1e7) });
const bh = (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [] }) })).json()).result.value.blockhash;
const alt = new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: altKeysOf(built.ixs, signersOf(built.ixs)).map((k) => new PublicKey(k)) } });
const vtx = new VersionedTransaction(new TransactionMessage({ payerKey: dev.publicKey, recentBlockhash: bh, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), ...built.ixs, launchTaxIx(dev.publicKey, 1e7)] }).compileToV0Message([alt]));
vtx.sign([mint, dev]);

const { code } = await (await fetch(RELAY + '/lobby/create', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gate': gate, origin: process.env.ORIGIN || 'https://arenalaunch.bond' }, body: '{}' })).json();
const ws = new WebSocket(RELAY.replace(/^http/, 'ws') + '/lobby/' + code + '/ws?g=' + encodeURIComponent(gate));
const t0 = Date.now(); const at = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'roster') return; console.log(at(), m.t, m.msg || m.error || (m.t === 'result' ? JSON.stringify({ ok: m.ok, error: m.error }) : '')); if (m.t === 'result') { ws.close(); process.exit(0); } };
await new Promise((r) => (ws.onopen = r));
const ts = Date.now(); const devKey = dev.secretKey.slice(0, 32);
ws.send(JSON.stringify({ t: 'hello', wallet: dev.publicKey.toBase58(), name: 'probe-dev', sig: bs58.encode(ed25519.sign(new TextEncoder().encode('pumpcall-lobby:' + code + ':' + ts), devKey)), ts, role: 'dev', amount: 0 }));
await new Promise((r) => setTimeout(r, 1500));
const template = { ...built.template, blockhash: bh, plannedLamports: 1e7, cu: 200000, prio: 0.0005 };
ws.send(JSON.stringify({ t: 'launch', single: true, template, createTx: bs58.encode(vtx.serialize()), preTxs: [], localTxs: [], tip: 0, dry: false, mint: built.template.mint, fireAt: countdown ? Date.now() + countdown * 1000 : undefined }));
console.log(at(), 'launch sent to lobby', code, 'countdown', countdown + 's');
setTimeout(() => { console.log(at(), 'NO RESULT within', countdown + 40, 's — the launch path is stuck'); process.exit(1); }, (countdown + 40) * 1000);
