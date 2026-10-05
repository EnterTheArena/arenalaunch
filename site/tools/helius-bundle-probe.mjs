// Does a bundle land through Helius? Sends ONE tiny bundle (count self-transfers, the last carries a Helius tip) from
// .testwallet.json through the RPC in $SOL_RPC_URL (Helius) and reports the slot of each tx. Costs the tip + fees.
//   SOL_RPC_URL=... node tools/.helius-bundle-probe.bundle.mjs [tipLamports] [txCount]
import { Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import { readFileSync } from 'fs';
import bs58 from 'bs58';

const URL_ = process.env.SOL_RPC_URL; if (!URL_) throw new Error('SOL_RPC_URL not set');
const TIPS = ['4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE', 'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ', '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta', '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn', '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD', '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ', 'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF', '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT', '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey', '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or'];
const tip = Number(process.argv[2] || 10000), count = Math.max(1, Math.min(5, Number(process.argv[3] || 2)));
const kp = Keypair.fromSecretKey(bs58.decode(JSON.parse(readFileSync(new URL('../.testwallet.json', import.meta.url))).secret));
const rpc = async (m, p, h = {}) => { const r = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) }); const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch { return { status: r.status, raw: t.slice(0, 200) }; } };
const tipTo = new PublicKey(TIPS[Math.floor(Math.random() * TIPS.length)]);
const bh = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).result.value.blockhash;
console.log('balance', (await rpc('getBalance', [kp.publicKey.toBase58()])).result.value / 1e9, 'SOL');
const txs = [];
for (let i = 0; i < count; i++) {
  const t = new Transaction({ feePayer: kp.publicKey, recentBlockhash: bh });
  t.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 + i }), SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 1 + i }));
  if (i === count - 1) t.add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: tipTo, lamports: tip }));
  t.sign(kp); txs.push(t);
}
const sigs = txs.map((t) => bs58.encode(t.signature));
const b64 = txs.map((t) => Buffer.from(t.serialize()).toString('base64'));
if (process.env.SIM) { const s = await rpc('simulateBundle', [{ encodedTransactions: b64 }, { encoding: 'base64' }]); console.log('simulateBundle', s.status, JSON.stringify(s.result || s.error || s.raw).slice(0, 300)); }
const r = await rpc('sendBundle', [b64, { encoding: 'base64' }]);
console.log('sendBundle', r.status, r.result ? 'id ' + r.result : JSON.stringify(r.error || r.raw).slice(0, 300));
const id = r.result; if (!id) process.exit(1);
for (let i = 0; i < 20; i++) {
  await new Promise((res) => setTimeout(res, 1500));
  const st = (await rpc('getSignatureStatuses', [sigs])).result.value;
  const bs = await rpc('getBundleStatuses', [[id]]);
  const b = bs.result?.value?.[0];
  console.log(((i + 1) * 1.5).toFixed(1) + 's', 'chain:', st.map((x) => (x ? (x.err ? 'ERR' : x.confirmationStatus + '@' + x.slot) : 'none')).join(' '), '| bundle:', b ? (b.confirmation_status || b.confirmationStatus) + '@' + b.slot : JSON.stringify(bs.error || null).slice(0, 80));
  if (st.every((x) => x && !x.err)) { console.log('LANDED — same slot:', new Set(st.map((x) => x.slot)).size === 1); break; }
}
