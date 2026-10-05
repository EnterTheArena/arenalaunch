// Does a squad fee split work on a real pump.fun coin? SIMULATES (never sends) the creator setting up pump.fun creator fee
// sharing for an existing coin: create_fee_sharing_config + update_fee_shares (which also revokes the admin), signed as the
// coin's creator (sigVerify off). Then checks the size of that transaction and of a buy built the old way after it.
//   node tools/build-sim.mjs feeshare-sim && node tools/.feeshare-sim.bundle.mjs <mint> [shareholders]
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js';
import { PUMP_SDK, OnlinePumpSdk, feeSharingConfigPda, bondingCurvePda } from '@pump-fun/pump-sdk';

const RPC = process.env.SOL_RPC_URL || 'https://solana-rpc.publicnode.com';
const conn = new Connection(RPC, 'confirmed');
const mint = new PublicKey(process.argv[2]);
const n = Math.max(1, Math.min(10, Number(process.argv[3] || 4)));
const online = new OnlinePumpSdk(conn);
const bc = await online.fetchBondingCurve(mint);
const creator = bc.creator;
console.log('coin', mint.toBase58(), 'creator', creator.toBase58(), 'complete', bc.complete);
const sc = feeSharingConfigPda(mint);
console.log('sharing config', sc.toBase58(), 'exists already:', !!(await conn.getAccountInfo(sc)));
const others = Array.from({ length: n - 1 }, () => Keypair.generate().publicKey);
const holders = [creator, ...others];
const base = Math.floor(10000 / holders.length);
const newShareholders = holders.map((a, i) => ({ address: a, shareBps: i === 0 ? 10000 - base * (holders.length - 1) : base }));
const ix1 = await PUMP_SDK.createFeeSharingConfig({ creator, mint, pool: null });
const ix2 = await PUMP_SDK.updateFeeShares({ authority: creator, mint, currentShareholders: [creator], newShareholders });
const { blockhash } = await conn.getLatestBlockhash();
const tx = new VersionedTransaction(new TransactionMessage({ payerKey: creator, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }), ix1, ix2] }).compileToV0Message());
console.log('fee-split tx:', tx.serialize().length, 'bytes (no lookup table), accounts', tx.message.staticAccountKeys.length, '·', holders.length, 'shareholders');
const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' });
console.log('SIM err', JSON.stringify(sim.value.err), '· CU', sim.value.unitsConsumed);
(sim.value.logs || []).filter((l) => /Error|failed|Instruction:|insufficient|revok/i.test(l)).slice(0, 14).forEach((l) => console.log('  ', l));
