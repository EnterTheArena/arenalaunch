// Does a Streamflow lock work on a pump.fun (Token-2022) coin, built the way the launch builds it? SIMULATES (never sends)
// a real holder of <mint> locking 10% of their tokens for 1 h (sigVerify off). Prints SOL and token movements.
//   node tools/build-sim.mjs lock-sim && node tools/.lock-sim.bundle.mjs <mint>
import { Connection, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js';
import { lockIx, lockAccountOf } from '../src/lock.js';

const conn = new Connection(process.env.SOL_RPC_URL || 'https://solana-rpc.publicnode.com', 'confirmed');
const mint = new PublicKey(process.argv[2]);
const big = (await conn.getTokenLargestAccounts(mint)).value;
const acct = big[Number(process.env.RANK || 1)]; const info = await conn.getParsedAccountInfo(acct.address);
const owner = new PublicKey(info.value.data.parsed.info.owner);
const amount = BigInt(acct.amount) / 10n;
const bal0 = await conn.getBalance(owner);
console.log('holder', owner.toBase58(), 'SOL', bal0 / 1e9, 'tokens', acct.uiAmountString, '· locking', Number(amount) / 1e6);
const ix = await lockIx({ owner, mint, amount, unlockAt: Date.now() / 1000 + 3600 });
const { blockhash } = await conn.getLatestBlockhash();
const tx = new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }), ix] }).compileToV0Message());
console.log('lock alone:', tx.serialize().length, 'bytes,', tx.message.staticAccountKeys.length, 'accounts');
const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed', accounts: { encoding: 'base64', addresses: [owner.toBase58()] } });
console.log('SIM err', JSON.stringify(sim.value.err), '· CU', sim.value.unitsConsumed);
if (sim.value.accounts?.[0]) console.log('SOL spent by the holder:', (bal0 - sim.value.accounts[0].lamports) / 1e9);
(sim.value.logs || []).filter((l) => /Error|failed|Instruction:|insufficient|fee/i.test(l)).slice(0, 12).forEach((l) => console.log('  ', l));
console.log('lock account', lockAccountOf(mint, owner).toBase58());
