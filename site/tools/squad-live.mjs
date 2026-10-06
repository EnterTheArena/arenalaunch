// A REAL squad launch through the live relay, with throwaway wallets, to prove block 0: the create + up to 4 teammate buys
// land in the SAME slot (Helius Sender bundle). Spends real SOL (a few cents of fees + the buys). Keys live in a file you
// name with KEYS= (keep it OUT of this repo, which is public).
//   node tools/build-sim.mjs squad-live
//   KEYS=/path/keys.json node tools/.squad-live.bundle.mjs addr          → makes the wallets, prints the one to fund
//   KEYS=... node tools/.squad-live.bundle.mjs fund                      → dev pays each teammate FUND_MATE SOL
//   KEYS=... node tools/.squad-live.bundle.mjs launch                    → lookup table, lobby, launch, then reads the slots
//   KEYS=... node tools/.squad-live.bundle.mjs sweep <address>           → sends what SOL is left back to <address>
import { Keypair, PublicKey, Transaction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, SystemProgram, AddressLookupTableProgram, AddressLookupTableAccount } from '@solana/web3.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import bs58 from 'bs58';
import BN from 'bn.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { pumpState, buildCreate, buyIxsFor, tokensFor, altKeysOf, signersOf, launchTaxIx } from '../src/pump.js';
import { mintToken } from '../api/gate.js';

const KEYS = process.env.KEYS; if (!KEYS) { console.log('set KEYS=<path outside the repo>'); process.exit(1); }
const RELAY = process.env.RELAY || 'https://relay.arenalaunch.bond', ORIGIN = 'https://arenalaunch.bond';
const RPC = process.env.SOL_RPC_URL || JSON.parse(readFileSync(new URL('../.secrets.json', import.meta.url))).SOL_RPC_URL || 'https://api.mainnet-beta.solana.com';
const gate = mintToken(JSON.parse(readFileSync(new URL('../.secrets.json', import.meta.url))).GATE_SECRET);
const MATES = 4, BUY = 0.01, DEV_BUY = 0.01, FUND_MATE = 0.02, TIP_CREATE = 1_000_000, TIP_BUY = 250_000, PRIO = 0.0002;
const HT = ['4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE', 'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ', '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta', '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn'];
const tipIx = (from, l) => SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(HT[Math.floor(Math.random() * HT.length)]), lamports: l });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = async (method, params) => { const j = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw new Error(method + ': ' + JSON.stringify(j.error)); return j.result; };
const getAccounts = async (a) => (await rpc('getMultipleAccounts', [a, { encoding: 'base64', commitment: 'confirmed' }])).value;
const bal = async (pk) => (await rpc('getBalance', [pk.toBase58(), { commitment: 'confirmed' }])).value / 1e9;
const bh = async () => (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
const prio = (cu, sol) => [ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.max(1, Math.floor(sol * 1e15 / cu)) })];
async function sendConfirm(tx) {
  const raw = Buffer.from(tx.serialize()).toString('base64'); const sig = await rpc('sendTransaction', [raw, { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 5 }]);
  for (let i = 0; i < 60; i++) { await sleep(1000); const st = (await rpc('getSignatureStatuses', [[sig]])).value[0]; if (st?.err) throw new Error('failed ' + JSON.stringify(st.err) + ' ' + sig); if (st && st.confirmationStatus !== 'processed') return sig; }
  throw new Error('not confirmed ' + sig);
}

// ---- wallets ----
let K = existsSync(KEYS) ? JSON.parse(readFileSync(KEYS, 'utf8')) : null;
if (!K) { K = { dev: bs58.encode(Keypair.generate().secretKey), mates: Array.from({ length: MATES }, () => bs58.encode(Keypair.generate().secretKey)) }; writeFileSync(KEYS, JSON.stringify(K, null, 2)); }
const dev = Keypair.fromSecretKey(bs58.decode(K.dev)), mates = K.mates.map((s) => Keypair.fromSecretKey(bs58.decode(s)));
const cmd = process.argv[2];

if (cmd === 'addr') {
  console.log('FUND THIS (dev):', dev.publicKey.toBase58());
  console.log('teammates (funded by the dev in step "fund"):'); for (const m of mates) console.log('  ', m.publicKey.toBase58());
  console.log('dev balance now:', await bal(dev.publicKey), 'SOL');
  process.exit(0);
}
if (cmd === 'fund') {
  const tx = new Transaction({ feePayer: dev.publicKey, recentBlockhash: await bh() });
  for (const m of mates) tx.add(SystemProgram.transfer({ fromPubkey: dev.publicKey, toPubkey: m.publicKey, lamports: Math.round(FUND_MATE * 1e9) }));
  tx.sign(dev); console.log('funded teammates:', await sendConfirm(tx));
  for (const k of [dev, ...mates]) console.log('  ', k.publicKey.toBase58(), await bal(k.publicKey), 'SOL');
  process.exit(0);
}
if (cmd === 'sweep') {
  const to = new PublicKey(process.argv[3]);
  for (const k of [...mates, dev]) {
    const b = Math.round((await bal(k.publicKey)) * 1e9) - 5000; if (b <= 0) continue;
    const tx = new Transaction({ feePayer: k.publicKey, recentBlockhash: await bh() }); tx.add(SystemProgram.transfer({ fromPubkey: k.publicKey, toPubkey: to, lamports: b })); tx.sign(k);
    try { console.log('swept', b / 1e9, 'from', k.publicKey.toBase58().slice(0, 6), await sendConfirm(tx)); } catch (e) { console.log('sweep', k.publicKey.toBase58().slice(0, 6), e.message.slice(0, 120)); }
  }
  process.exit(0);
}
// sell every pump.fun token the test wallets hold, close the emptied token accounts (rent back), collect the dev's creator
// fees, and deactivate/close the lookup tables the launches made — so a test wastes nothing but network fees
if (cmd === 'cleanup') {
  const { OnlinePumpSdk, PUMP_SDK } = await import('@pump-fun/pump-sdk');
  const { Connection } = await import('@solana/web3.js');
  const { createCloseAccountInstruction } = await import('@solana/spl-token');
  const TOKEN22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  const sdk = new OnlinePumpSdk(new Connection(RPC, 'confirmed')); const global = await sdk.fetchGlobal();
  const v0 = async (kp, ixs, cu = 300000) => { const v = new VersionedTransaction(new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: await bh(), instructions: [...prio(cu, 0.00002), ...ixs] }).compileToV0Message()); v.sign([kp]); return sendConfirm(v); };
  for (const kp of [dev, ...mates]) {
    const accs = (await rpc('getTokenAccountsByOwner', [kp.publicKey.toBase58(), { programId: TOKEN22.toBase58() }, { encoding: 'jsonParsed', commitment: 'confirmed' }])).value;
    for (const a of accs) {
      const info = a.account.data.parsed.info; const mint = new PublicKey(info.mint); const amount = new BN(info.tokenAmount.amount); const ata = new PublicKey(a.pubkey);
      try {
        const ixs = [];
        if (amount.gtn(0)) { const s = await sdk.fetchSellState(mint, kp.publicKey, TOKEN22); ixs.push(...(await PUMP_SDK.sellV2Instructions({ global, bondingCurveAccountInfo: s.bondingCurveAccountInfo, bondingCurve: s.bondingCurve, mint, user: kp.publicKey, amount, quoteAmount: new BN(0), slippage: 0, tokenProgram: TOKEN22, quoteTokenProgram: s.quoteTokenProgram }))); }
        ixs.push(createCloseAccountInstruction(ata, kp.publicKey, kp.publicKey, [], TOKEN22));
        const before = await bal(kp.publicKey); const sig = await v0(kp, ixs);
        console.log(kp.publicKey.toBase58().slice(0, 6), 'sold', info.tokenAmount.uiAmountString, mint.toBase58().slice(0, 4) + ' + closed its account: +' + ((await bal(kp.publicKey)) - before).toFixed(6), 'SOL', sig.slice(0, 12));
      } catch (e) { console.log(kp.publicKey.toBase58().slice(0, 6), mint.toBase58().slice(0, 4), 'FAILED', String(e.message || e).slice(0, 200)); }
    }
  }
  // creator fees are NOT collected here: on a test coin they are smaller than the rent pump.fun's collect makes the caller pay
  // for its own fee-vault account (live 2026-10-06: +0.000826 fees, -0.001488 rent)
  // lookup tables owned by the dev: deactivate now; close (rent back) once ~513 slots have passed — run cleanup again later
  const alts = (await rpc('getProgramAccounts', ['AddressLookupTab1e1111111111111111111111111', { encoding: 'base64', filters: [{ memcmp: { offset: 22, bytes: dev.publicKey.toBase58() } }] }])) || [];
  const slotNow = await rpc('getSlot', [{ commitment: 'finalized' }]);
  for (const a of alts) {
    const key = new PublicKey(a.pubkey); const t = AddressLookupTableAccount.deserialize(Buffer.from(a.account.data[0], 'base64'));
    try {
      if (t.deactivationSlot === BigInt('18446744073709551615')) { await v0(dev, [AddressLookupTableProgram.deactivateLookupTable({ lookupTable: key, authority: dev.publicKey })], 50000); console.log('lookup table', a.pubkey.slice(0, 6), 'deactivated — close it with cleanup again in ~4 minutes'); }
      else if (BigInt(slotNow) > t.deactivationSlot + 513n) { await v0(dev, [AddressLookupTableProgram.closeLookupTable({ lookupTable: key, authority: dev.publicKey, recipient: dev.publicKey })], 50000); console.log('lookup table', a.pubkey.slice(0, 6), 'closed: +' + (a.account.lamports / 1e9).toFixed(6), 'SOL'); }
      else console.log('lookup table', a.pubkey.slice(0, 6), 'still cooling down (' + (Number(t.deactivationSlot + 513n) - slotNow) + ' slots left)');
    } catch (e) { console.log('lookup table', a.pubkey.slice(0, 6), String(e.message || e).slice(0, 160)); }
  }
  for (const k of [dev, ...mates]) console.log('  ', k.publicKey.toBase58(), await bal(k.publicKey), 'SOL');
  process.exit(0);
}
if (cmd !== 'launch') { console.log('addr | fund | launch | cleanup | sweep <address>'); process.exit(1); }

// ---- launch ----
const st = await pumpState(getAccounts);
const mintKp = Keypair.generate(); const devL = Math.round(DEV_BUY * 1e9);
// metadata: the image/JSON of an earlier arenalaunch coin (this is a test coin)
const uri = process.env.URI || 'https://pump.mypinata.cloud/ipfs/bafkreictxg6knhycfciz6huomvsbdcwfvgsi3mqowct6525lgvpm6fi5ta';
const built = await buildCreate(st, { mint: mintKp.publicKey, creator: dev.publicKey, name: 'Squad Test', symbol: 'SQTEST', uri, holderReward: false, devLamports: devL, devMinOut: tokensFor(st, devL).muln(50).divn(100) });
// lookup table with every non-signer account (as the page does), extended in chunks, then wait until it reads back
const keys = altKeysOf(built.ixs, signersOf(built.ixs));
const slot = await rpc('getSlot', [{ commitment: 'finalized' }]);
const [createAlt, altAddr] = AddressLookupTableProgram.createLookupTable({ authority: dev.publicKey, payer: dev.publicKey, recentSlot: slot });
const chunks = []; for (let i = 0; i < keys.length; i += 26) chunks.push(keys.slice(i, i + 26));
for (let i = 0; i < chunks.length; i++) {
  const v = new VersionedTransaction(new TransactionMessage({ payerKey: dev.publicKey, recentBlockhash: await bh(), instructions: [...prio(60000, 0.00002), ...(i === 0 ? [createAlt] : []), AddressLookupTableProgram.extendLookupTable({ payer: dev.publicKey, authority: dev.publicKey, lookupTable: altAddr, addresses: chunks[i].map((k) => new PublicKey(k)) })] }).compileToV0Message());
  v.sign([dev]); console.log('lookup table tx', i + 1, '/', chunks.length, await sendConfirm(v));
}
let alt = null;
for (let i = 0; i < 30 && !alt; i++) { await sleep(800); const a = (await getAccounts([altAddr.toBase58()]))[0]; if (a) { const t = new AddressLookupTableAccount({ key: altAddr, state: AddressLookupTableAccount.deserialize(Buffer.from(a.data[0], 'base64')) }); if (keys.every((k) => t.state.addresses.some((x) => x.toBase58() === k))) alt = t; } }
if (!alt) throw new Error('lookup table not readable'); await sleep(1200);
console.log('lookup table ready', altAddr.toBase58());

const blockhash = await bh();
const createV = new VersionedTransaction(new TransactionMessage({ payerKey: dev.publicKey, recentBlockhash: blockhash, instructions: [...prio(260000, PRIO * 3), ...built.ixs, launchTaxIx(dev.publicKey, devL), tipIx(dev.publicKey, TIP_CREATE)] }).compileToV0Message([alt]));
createV.sign([mintKp, dev]); console.log('launch tx bytes', createV.serialize().length);
const template = { ...built.template, blockhash, plannedLamports: devL + MATES * Math.round(BUY * 1e9), cu: 200000, prio: PRIO, bundleTip: TIP_BUY, lockUntil: Math.floor(Date.now() / 1000) + 3600 };
// a teammate's buy, as the page builds it (priority fee, buy, 3% launch fee, Sender tip)
function mateBuy(kp, t) {
  const tx = new Transaction({ feePayer: kp.publicKey, recentBlockhash: t.blockhash }); const l = Math.round(BUY * 1e9);
  tx.add(...prio(200000, Math.min(0.01, t.prio)), ...buyIxsFor(t, kp.publicKey, l, new BN(1)), launchTaxIx(kp.publicKey, l), tipIx(kp.publicKey, TIP_BUY)); tx.sign(kp);
  return bs58.encode(tx.serialize({ requireAllSignatures: true, verifySignatures: true }));
}

const H = { 'content-type': 'application/json', 'x-gate': gate, origin: ORIGIN };
const { code } = await (await fetch(RELAY + '/lobby/create', { method: 'POST', headers: H, body: '{"chain":"sol"}' })).json();
console.log('lobby', code);
const t0 = Date.now(); const at = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
let result = null;
function conn(kp, role) {
  const ws = new WebSocket(RELAY.replace(/^http/, 'ws') + '/lobby/' + code + '/ws?g=' + encodeURIComponent(gate), { headers: { origin: ORIGIN } });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (role === 'dev' && m.t === 'log') console.log(at(), '[relay]', m.msg);
    if (role === 'dev' && m.t === 'result') result = m;
    if (m.t === 'error') console.log(at(), role, 'error:', m.msg);
    if (role === 'member' && m.t === 'sign') ws.send(JSON.stringify({ t: 'signed', tx: mateBuy(kp, m.template), extra: [], locks: [] }));
  };
  return new Promise((r) => (ws.onopen = () => { const ts = Date.now(); ws.send(JSON.stringify({ t: 'hello', wallet: kp.publicKey.toBase58(), name: role + '-' + kp.publicKey.toBase58().slice(0, 4), sig: bs58.encode(ed25519.sign(new TextEncoder().encode('pumpcall-lobby:' + code + ':' + ts), kp.secretKey.slice(0, 32))), ts, role, amount: role === 'member' ? BUY : 0, ready: role === 'member' })); r(ws); }));
}
const dws = await conn(dev, 'dev'); await sleep(1200);
const mws = []; for (const m of mates) { mws.push(await conn(m, 'member')); await sleep(400); }
await sleep(2500);
dws.send(JSON.stringify({ t: 'launch', single: true, fire: 'block0', template, createTx: bs58.encode(createV.serialize()), preTxs: [], localTxs: [], tip: 0, dry: false, mint: mintKp.publicKey.toBase58(), fireAt: Date.now() + 6000, locks: [] }));
console.log(at(), 'launch sent · mint', mintKp.publicKey.toBase58());
for (let i = 0; i < 120 && !result; i++) await sleep(500);
await sleep(3000); for (const w of [dws, ...mws]) try { w.close(); } catch {}
console.log('\nRESULT', JSON.stringify(result ? { ok: result.ok, landed: result.landed, error: result.error } : 'none'));

// ---- the proof: which slot did each transaction land in? ----
let sigs = [];
for (let i = 0; i < 10; i++) { await sleep(3000); sigs = (await rpc('getSignaturesForAddress', [mintKp.publicKey.toBase58(), { limit: 40 }])).reverse(); if (sigs.length >= 1 + MATES) break; } // the index lags a few seconds
const ours = new Set([dev, ...mates].map((k) => k.publicKey.toBase58())); let createSlot = null;
for (const s of sigs) {
  const tx = await rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]); if (!tx) continue;
  const signer = tx.transaction.message.accountKeys.find((k) => k.signer).pubkey; const isCreate = (tx.meta.logMessages || []).some((l) => /CreateV2/.test(l));
  if (isCreate) createSlot = s.slot;
  console.log('slot', s.slot, createSlot != null ? '(+' + (s.slot - createSlot) + ')' : '', s.err ? 'FAILED' : 'ok', ours.has(signer) ? (signer === dev.publicKey.toBase58() ? 'DEV' : 'SQUAD') : 'outsider', signer.slice(0, 6), isCreate ? 'create' : 'buy', 'index', tx.transaction.message ? '' : '');
}
process.exit(0);
