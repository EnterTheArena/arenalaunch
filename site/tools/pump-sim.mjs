// Build a pump.fun squad launch exactly like the web app does and SIMULATE it on mainnet.
//   node tools/build-sim.mjs && node tools/.pump-sim.bundle.mjs <mode> [wallets] [--holders]
//   alt   create a lookup table (signed by .testwallet.json, ~0.009 SOL rent, reclaimable) holding every account of the sim launch
//   sim   simulate create + dev buy + N wallets in ONE transaction (sigVerify off: rich mainnet wallets stand in as dev/buyers)
//   close deactivate, then (after ~4 min) close the sim lookup table to get the rent back
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, AddressLookupTableProgram, AddressLookupTableAccount } from '@solana/web3.js';
import bs58 from 'bs58';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { pumpState, buildCreate, buyIxsFor, tokensFor, tokensAt, altKeysOf, signersOf } from '../src/pump.js';

Math.random = () => 0.1; // the SDK picks a random fee recipient per build — pin it so every run plans the same accounts
const RPC = process.env.SOL_RPC_URL || 'https://solana-rpc.publicnode.com';
async function rpc(method, params) {
  let e;
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json(); if (j.error) throw new Error('RPC ' + JSON.stringify(j.error)); return j.result;
    } catch (x) { e = x; if (/^RPC /.test(x.message)) throw x; await new Promise((r) => setTimeout(r, 900)); }
  }
  throw e;
}
const getAccounts = async (a) => (await rpc('getMultipleAccounts', [a, { encoding: 'base64' }])).value;
const here = (f) => new URL('../' + f, import.meta.url);
const tw = JSON.parse(readFileSync(here('.testwallet.json')));
const payer = Keypair.fromSecretKey(bs58.decode(tw.secret));
// stand-ins with plenty of SOL (simulation only — never signed): exchange hot wallets
const DEV = new PublicKey(process.env.SIM_DEV || '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9');
const BUYERS = (process.env.SIM_BUYERS || 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS,2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm,GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE,ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ').split(',').map((s) => new PublicKey(s));
const simFile = here('tools/.sim-state.json');
const S = existsSync(simFile) ? JSON.parse(readFileSync(simFile)) : {};
if (!S.mint) { S.mint = bs58.encode(Keypair.generate().secretKey); writeFileSync(simFile, JSON.stringify(S)); }
const mint = Keypair.fromSecretKey(bs58.decode(S.mint));
const mode = process.argv[2] || 'sim'; const N = Number(process.argv[3] || 2);
const holders = process.argv.includes('--holders');
const devLam = 20_000_000, buyLam = 10_000_000;

const st = await pumpState(getAccounts);
const built = await buildCreate(st, { mint: mint.publicKey, creator: DEV, name: 'Sim Test', symbol: 'SIMT', uri: 'https://ipfs.io/ipfs/bafkreibxsimtestsimtestsimtestsimtestsimtestsimtestsimt', holderReward: holders, devLamports: devLam, devMinOut: tokensFor(st, devLam).muln(95).divn(100) });
const wallets = BUYERS.slice(0, N);
let spent = devLam;
const buys = wallets.map((pk) => { const ixs = buyIxsFor(built.template, pk, buyLam, tokensAt(st, spent, buyLam).muln(90).divn(100)); spent += buyLam; return ixs; });
const head = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }), ...built.ixs];
const allIxs = [...head, ...buys.flat()];
const keys = altKeysOf(allIxs, signersOf(allIxs));
const MAXSLOT = BigInt('18446744073709551615');

async function sendConfirm(ixs) {
  for (let i = 0; ; i++) { try { return await sendOnce(ixs); } catch (e) { if (i < 4 && /BlockhashNotFound|Blockhash not found/.test(e.message)) { await new Promise((r) => setTimeout(r, 1500)); continue; } throw e; } }
}
async function sendOnce(ixs) {
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash, instructions: ixs }).compileToV0Message()); tx.sign([payer]);
  const sig = await rpc('sendTransaction', [Buffer.from(tx.serialize()).toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
  for (let t = 0; t < 40; t++) { await new Promise((r) => setTimeout(r, 1000)); const s = (await rpc('getSignatureStatuses', [[sig]])).value[0]; if (s?.err) throw new Error('tx failed ' + JSON.stringify(s.err)); if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return sig; }
  throw new Error('not confirmed ' + sig);
}

if (mode === 'alt') {
  // an existing table (from an earlier run) is only extended with what it lacks
  let alt = S.alt ? new PublicKey(S.alt) : null; let have = [];
  if (alt) { const a = (await getAccounts([S.alt]))[0]; if (a) have = AddressLookupTableAccount.deserialize(Buffer.from(a.data[0], 'base64')).addresses.map((x) => x.toBase58()); else alt = null; }
  let createIx = null;
  if (!alt) { const slot = await rpc('getSlot', [{ commitment: 'finalized' }]); [createIx, alt] = AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot }); }
  const todo = keys.filter((k) => !have.includes(k));
  for (let i = 0; i < todo.length; i += 28) {
    const ext = AddressLookupTableProgram.extendLookupTable({ payer: payer.publicKey, authority: payer.publicKey, lookupTable: alt, addresses: todo.slice(i, i + 28).map((k) => new PublicKey(k)) });
    console.log('alt tx', await sendConfirm([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20000 }), ...(createIx && i === 0 ? [createIx] : []), ext]));
    S.alt = alt.toBase58(); writeFileSync(simFile, JSON.stringify(S));
  }
  console.log('lookup table', alt.toBase58(), 'holds', keys.length);
  process.exit(0);
}
if (mode === 'close') {
  const a = (await getAccounts([S.alt]))[0]; if (!a) { console.log('no table'); process.exit(0); }
  const t = AddressLookupTableAccount.deserialize(Buffer.from(a.data[0], 'base64'));
  const active = t.deactivationSlot === MAXSLOT;
  const ix = active ? AddressLookupTableProgram.deactivateLookupTable({ lookupTable: new PublicKey(S.alt), authority: payer.publicKey }) : AddressLookupTableProgram.closeLookupTable({ lookupTable: new PublicKey(S.alt), authority: payer.publicKey, recipient: payer.publicKey });
  console.log(active ? 'deactivated' : 'closed', await sendConfirm([ix]));
  process.exit(0);
}

let alt = null;
if (S.alt) { const a = (await getAccounts([S.alt]))[0]; if (a) alt = new AddressLookupTableAccount({ key: new PublicKey(S.alt), state: AddressLookupTableAccount.deserialize(Buffer.from(a.data[0], 'base64')) }); }
const real = !!alt;
if (!alt) { alt = new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: { deactivationSlot: MAXSLOT, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: keys.map((k) => new PublicKey(k)) } }); console.log('(no lookup table on chain yet — sizes only; run "alt" to simulate)'); }
const missing = keys.filter((k) => !alt.state.addresses.some((x) => x.toBase58() === k)); if (missing.length) console.log('table is missing', missing.length, 'accounts of this plan');
console.log('table holds', keys.length, 'accounts');
const bh = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
for (let n = 0; n <= wallets.length; n++) {
  try { const v = new VersionedTransaction(new TransactionMessage({ payerKey: DEV, recentBlockhash: bh, instructions: [...head, ...buys.slice(0, n).flat()] }).compileToV0Message([alt])); console.log('create + dev buy +', n, 'wallets:', v.serialize().length, 'bytes'); }
  catch { console.log('create + dev buy +', n, 'wallets: over 1232'); }
}
if (!real) process.exit(0);
const v = new VersionedTransaction(new TransactionMessage({ payerKey: DEV, recentBlockhash: bh, instructions: allIxs }).compileToV0Message([alt]));
const sim = await rpc('simulateTransaction', [Buffer.from(v.serialize()).toString('base64'), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed', accounts: { encoding: 'base64', addresses: [DEV, ...wallets].map((w) => built.ata(w)) } }]);
console.log('SIM err', JSON.stringify(sim.value.err), '· CU', sim.value.unitsConsumed);
(sim.value.logs || []).filter((l) => /Error|failed|Instruction: (Create|Buy)|insufficient|exceed/i.test(l)).forEach((l) => console.log('  ', l));
(sim.value.accounts || []).forEach((a, i) => { const who = i ? 'wallet ' + i : 'dev'; if (!a) return console.log('  ', who, 'token account missing'); const d = Buffer.from(a.data[0], 'base64'); console.log('  ', who, 'holds', Number(d.readBigUInt64LE(64)) / 1e6, 'tokens'); });
