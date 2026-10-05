// Does a buy with the 3% treasury fee work on chain? With <mint>: a teammate-style buy + fee on that existing coin (the
// launch create itself needs a lookup table to fit, so it is covered by pump-sim). Otherwise: SIMULATES (never sends) on mainnet, sigVerify off, a fresh coin's
// create + dev buy + the dev's 3% fee — and, when it fits one transaction, a teammate's buy + their 3% fee right after —
// built with the app's own code. Prints the treasury's balance change and each wallet's SOL spend.
//   node tools/build-sim.mjs fee-sim && node tools/.fee-sim.bundle.mjs [devSol] [mateSol]
//   node tools/.fee-sim.bundle.mjs --coin <mint> [sol]
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js';
import { PUMP_SDK, bondingCurvePda } from '@pump-fun/pump-sdk';
import { pumpState, buildCreate, buyIxsFor, tokensFor, tokensAt, launchTaxIx, launchTax, TREASURY } from '../src/pump.js';

const RPC = process.env.SOL_RPC_URL || 'https://solana-rpc.publicnode.com';
const rpc = async (method, params) => { const j = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw new Error(JSON.stringify(j.error)); return j.result; };
const getAccounts = async (a) => (await rpc('getMultipleAccounts', [a, { encoding: 'base64' }])).value;
// rich mainnet wallets stand in as the dev and a teammate (signatures are not checked in a simulation)
const DEV = new PublicKey('5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9'), MATE = new PublicKey(process.env.SIM_MATE || 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS');
if (process.argv[2] === '--coin') {
  const st = await pumpState(getAccounts); const mint = new PublicKey(process.argv[3]); const lam = Math.round(Number(process.argv[4] || 0.25) * 1e9);
  const [bcA] = await getAccounts([bondingCurvePda(mint).toBase58()]); if (!bcA) { console.log('FAIL no bonding curve for that coin'); process.exit(1); }
  const bc = PUMP_SDK.decodeBondingCurve({ data: Buffer.from(bcA.data[0], 'base64'), owner: new PublicKey(bcA.owner), lamports: bcA.lamports, executable: false });
  if (bc.complete) { console.log('FAIL that coin has left the bonding curve'); process.exit(1); }
  const built = await buildCreate(st, { mint, creator: bc.creator, name: 'x', symbol: 'x', uri: 'https://x', holderReward: false, devLamports: 1e6, devMinOut: tokensFor(st, 1e6) });
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }), ...buyIxsFor(built.template, MATE, lam, tokensFor(st, 1e5)), launchTaxIx(MATE, lam)];
  const bh = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: MATE, recentBlockhash: bh, instructions: ixs }).compileToV0Message());
  const watch = [TREASURY, MATE.toBase58()]; const before = (await getAccounts(watch)).map((a) => a?.lamports ?? 0);
  const sim = (await rpc('simulateTransaction', [Buffer.from(tx.serialize()).toString('base64'), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: watch } }])).value;
  console.log('transaction: teammate buy of ' + lam / 1e9 + ' SOL + 3% fee on ' + mint.toBase58().slice(0, 6) + '… · ' + tx.serialize().length + ' bytes');
  if (sim.err) { console.log('FAIL simulation:', JSON.stringify(sim.err)); console.log((sim.logs || []).slice(-12).join('\n')); process.exit(1); }
  const after = sim.accounts.map((a) => a?.lamports ?? 0); const got = after[0] - before[0];
  console.log('ok   simulation succeeded on mainnet (' + sim.unitsConsumed + ' compute units)');
  console.log((got === launchTax(lam) ? 'ok  ' : 'FAIL') + ' treasury received ' + got / 1e9 + ' SOL (expected ' + launchTax(lam) / 1e9 + ')');
  console.log('     buyer spent ' + ((before[1] - after[1]) / 1e9).toFixed(6) + ' SOL for a ' + lam / 1e9 + ' SOL buy (buy + 3% + fees/rent)');
  process.exit(got === launchTax(lam) ? 0 : 1);
}
const devLam = Math.round(Number(process.argv[2] || 0.5) * 1e9), mateLam = Math.round(Number(process.argv[3] || 0.25) * 1e9);
const st = await pumpState(getAccounts); const mint = Keypair.generate();
const built = await buildCreate(st, { mint: mint.publicKey, creator: DEV, name: 'Fee Sim', symbol: 'FSIM', uri: 'https://x', holderReward: false, devLamports: devLam, devMinOut: tokensFor(st, devLam).muln(95).divn(100) });
const head = [ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }), ...built.ixs, launchTaxIx(DEV, devLam)];
const mate = [...buyIxsFor(built.template, MATE, mateLam, tokensAt(st, devLam, mateLam).muln(85).divn(100)), launchTaxIx(MATE, mateLam)];
const bh = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
const txOf = (ixs) => new VersionedTransaction(new TransactionMessage({ payerKey: DEV, recentBlockhash: bh, instructions: ixs }).compileToV0Message());
let tx = txOf([...head, ...mate]), both = true; let size = 0;
try { size = tx.serialize().length; } catch { size = 9999; }
if (size > 1232) { both = false; tx = txOf(head); size = tx.serialize().length; }
const watch = [TREASURY, DEV.toBase58(), MATE.toBase58()];
const before = (await getAccounts(watch)).map((a) => a?.lamports ?? 0);
const sim = (await rpc('simulateTransaction', [Buffer.from(tx.serialize()).toString('base64'), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: watch } }])).value;
console.log('transaction: ' + (both ? 'create + dev buy + dev fee + teammate buy + teammate fee' : 'create + dev buy + dev fee (teammate buy does not fit one tx without a lookup table)') + ' · ' + size + ' bytes');
if (sim.err) { console.log('FAIL simulation:', JSON.stringify(sim.err)); console.log((sim.logs || []).slice(-12).join('\n')); process.exit(1); }
const after = sim.accounts.map((a) => a?.lamports ?? 0); const d = (i) => (after[i] - before[i]) / 1e9;
const wantT = launchTax(devLam) + (both ? launchTax(mateLam) : 0);
console.log('ok   simulation succeeded on mainnet (' + sim.unitsConsumed + ' compute units)');
console.log((after[0] - before[0] === wantT ? 'ok  ' : 'FAIL') + ' treasury received ' + d(0) + ' SOL (expected ' + wantT / 1e9 + ')');
console.log('     dev spent ' + (-d(1)).toFixed(6) + ' SOL for a ' + devLam / 1e9 + ' SOL buy' + (both ? ' · teammate spent ' + (-d(2)).toFixed(6) + ' SOL for a ' + mateLam / 1e9 + ' SOL buy' : ''));
process.exit(after[0] - before[0] === wantT ? 0 : 1);
