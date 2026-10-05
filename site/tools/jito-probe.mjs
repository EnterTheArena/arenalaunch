// Does Jito land our bundles? Sends ONE tiny bundle (a 1-lamport self-transfer + a Jito tip) from .testwallet.json to
// every block-engine region and reports where it landed. Costs the tip + a fee (~0.0001 SOL by default).
//   node tools/build-sim.mjs jito-probe && node tools/.jito-probe.bundle.mjs [tipLamports] [txCount]
import { Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import { readFileSync } from 'fs';
import bs58 from 'bs58';

const RPC = 'https://api.mainnet-beta.solana.com';
const REGIONS = ['mainnet', 'ny.mainnet', 'amsterdam.mainnet', 'frankfurt.mainnet', 'tokyo.mainnet', 'slc.mainnet', 'london.mainnet', 'dublin.mainnet', 'singapore.mainnet'].map((r) => 'https://' + r + '.block-engine.jito.wtf');
const tip = Number(process.argv[2] || 100000), count = Math.max(1, Math.min(5, Number(process.argv[3] || 1)));
const kp = Keypair.fromSecretKey(bs58.decode(JSON.parse(readFileSync(new URL('../.testwallet.json', import.meta.url))).secret));
const rpc = async (m, p) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) })).json()).result;
const jito = async (base, m, p, path = '/api/v1/bundles') => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) }); const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch { return { status: r.status, raw: t.slice(0, 160) }; } };

const tipAccounts = (await jito(REGIONS[0], 'getTipAccounts', [])).result;
console.log('tip accounts from Jito:', tipAccounts?.length || 0);
const tipTo = new PublicKey(tipAccounts[Math.floor(Math.random() * tipAccounts.length)]);
const bh = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
// count transactions, each a distinct self-transfer; the LAST one carries the tip (Jito's rule)
const txs = [];
for (let i = 0; i < count; i++) {
  const t = new Transaction({ feePayer: kp.publicKey, recentBlockhash: bh });
  t.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 + i }), SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 1 + i }));
  if (i === count - 1) t.add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: tipTo, lamports: tip }));
  t.sign(kp); txs.push(t);
}
const b64 = txs.map((t) => Buffer.from(t.serialize()).toString('base64'));
const sigs = txs.map((t) => bs58.encode(t.signature));
console.log('bundle of', count, 'tx · tip', tip, 'lamports · sigs', sigs.map((s) => s.slice(0, 8)).join(','));
// ONLY=<region index> sends to one region; B58=1 sends base58 (the original encoding)
const targets = process.env.ONLY ? [REGIONS[Number(process.env.ONLY)]] : REGIONS;
const payload = process.env.B58 ? [txs.map((t) => bs58.encode(t.serialize()))] : [b64, { encoding: 'base64' }];
const sent = await Promise.all(targets.map(async (u) => ({ u, r: await jito(u, 'sendBundle', payload) })));
let id = null; for (const { u, r } of sent) { console.log(' send', u.replace('https://', '').split('.')[0].padEnd(10), r.status, r.result ? 'id ' + r.result.slice(0, 12) : JSON.stringify(r.error || r.raw).slice(0, 120)); id = id || r.result; }
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  const st = (await rpc('getSignatureStatuses', [sigs])).value;
  const inflight = id ? await Promise.all(REGIONS.slice(0, 4).map((u) => jito(u, 'getInflightBundleStatuses', [[id]]))) : [];
  const states = inflight.map((r) => r.result?.value?.[0]?.status || '-').join('/');
  console.log(((i + 1) * 1.5).toFixed(1) + 's', 'chain:', st.map((x) => (x ? (x.err ? 'ERR' : x.confirmationStatus + '@' + x.slot) : 'none')).join(' '), '| jito inflight:', states);
  if (st.every((x) => x && !x.err)) { console.log('LANDED — same slot:', new Set(st.map((x) => x.slot)).size === 1); break; }
}
