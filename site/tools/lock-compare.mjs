// lock.js builds Streamflow's create_v2 by hand; this checks it is byte-identical to Streamflow's own SDK (devDependency).
//   node tools/build-sim.mjs lock-compare && node tools/.lock-compare.bundle.mjs
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import BN from 'bn.js';
import { createStreamV2Instruction, deriveStreamMetadataPDA, STREAMFLOW_TREASURY_PUBLIC_KEY, WITHDRAWOR_PUBLIC_KEY } from '@streamflow/stream';
import { lockIx, lockAccountOf, STREAMFLOW, STREAMFLOW_ORACLE } from '../src/lock.js';
const T22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'), ATAP = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const ata = (o, m) => PublicKey.findProgramAddressSync([o.toBuffer(), T22.toBuffer(), m.toBuffer()], ATAP)[0];
let bad = 0;
for (let i = 0; i < 5; i++) {
  const o = Keypair.generate().publicKey, m = Keypair.generate().publicKey, amount = String(BigInt(Math.floor(Math.random() * 1e15))), t = 1790000000 + i * 99991;
  const mine = await lockIx({ owner: o, mint: m, amount, unlockAt: t });
  const md = deriveStreamMetadataPDA(STREAMFLOW, m, o, 0); const [esc] = PublicKey.findProgramAddressSync([Buffer.from('strm'), md.toBuffer()], STREAMFLOW);
  const ref = await createStreamV2Instruction({ start: new BN(t), depositedAmount: new BN(amount), period: new BN(1), amountPerPeriod: new BN(1), cliff: new BN(t), cliffAmount: new BN(amount), cancelableBySender: false, cancelableByRecipient: false, automaticWithdrawal: false, transferableBySender: false, transferableByRecipient: false, canTopup: false, canUpdateRate: false, canPause: false, name: 'arenalaunch squad lock', withdrawFrequency: new BN(1), nonce: 0 }, STREAMFLOW,
    { sender: o, senderTokens: ata(o, m), recipient: o, metadata: md, escrowTokens: esc, recipientTokens: ata(o, m), streamflowTreasury: STREAMFLOW_TREASURY_PUBLIC_KEY, streamflowTreasuryTokens: ata(STREAMFLOW_TREASURY_PUBLIC_KEY, m), withdrawor: WITHDRAWOR_PUBLIC_KEY, partner: o, partnerTokens: ata(o, m), mint: m, feeOracle: STREAMFLOW_ORACLE, rent: SYSVAR_RENT_PUBKEY, timelockProgram: STREAMFLOW, tokenProgram: T22, associatedTokenProgram: ATAP, systemProgram: SystemProgram.programId });
  const sameData = Buffer.from(mine.data).equals(Buffer.from(ref.data));
  const sameKeys = mine.keys.length === ref.keys.length && mine.keys.every((k, j) => k.pubkey.equals(ref.keys[j].pubkey) && k.isSigner === ref.keys[j].isSigner && k.isWritable === ref.keys[j].isWritable);
  const samePda = lockAccountOf(m, o).equals(md);
  if (!(sameData && sameKeys && samePda)) bad++;
  console.log(sameData && sameKeys && samePda ? 'ok  ' : 'FAIL', 'lock', i, 'data', sameData, 'keys', sameKeys, 'pda', samePda, mine.data.length, ref.data.length);
}
process.exit(bad ? 1 : 0);
