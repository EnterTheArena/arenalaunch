// Streamflow token lock for a squad wallet's block-0 bag, built WITHOUT looking the coin up (it does not exist yet when the
// buy is signed) and without Streamflow's SDK (228 KB we don't need): the create_v2 instruction is encoded here, byte for
// byte as the SDK does (tools/lock-sim.mjs compares the two). Same settings as Streamflow's own "token lock": everything
// unlocks at one moment, nobody can cancel it, change it, top it up, pause it or transfer it. The lock account is derived
// from (coin, wallet, nonce 0), so the launch needs no extra signer. Streamflow charges its own fee for each lock
// (0.16 SOL + 0.5% of the tokens, read live from its fee oracle on 2026-10-02; ~0.009 SOL of rent on top).
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';

export const STREAMFLOW = new PublicKey('strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m');
export const STREAMFLOW_ORACLE = new PublicKey('B743wFVk2pCYhV91cn287e1xY7f1vt4gdY48hhNiuQmT');
const TREASURY = new PublicKey('5SEpbdjFK5FxwTvfsGMXVQTD2v4M2c5tyRTxhdsPkgDw');
const WITHDRAWOR = new PublicKey('wdrwhnCv4pzW8beKsbPa4S2UDZrXenjg16KJdKSpb5u');
const TOKEN22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const CREATE_V2 = [214, 144, 76, 236, 95, 139, 49, 180]; // sha256("global:create_v2")[0..8]
export const LOCK_FEE_SOL = 0.16, LOCK_FEE_PCT = 0.5; // shown to people before they tick "lock"
const enc = new TextEncoder();
const ata = (owner, mint, prog = TOKEN22) => PublicKey.findProgramAddressSync([owner.toBuffer(), prog.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
export const lockAccountOf = (mint, owner) => PublicKey.findProgramAddressSync([enc.encode('strm-met'), new PublicKey(mint).toBuffer(), new PublicKey(owner).toBuffer(), new Uint8Array(4)], STREAMFLOW)[0];

// owner locks `amount` (base units) of `mint` until `unlockAt` (unix seconds); the tokens come back to owner
export async function lockIx({ owner, mint, amount, unlockAt, name = 'arenalaunch squad lock' }) {
  const o = new PublicKey(owner), m = new PublicKey(mint);
  const metadata = lockAccountOf(m, o);
  const [escrowTokens] = PublicKey.findProgramAddressSync([enc.encode('strm'), metadata.toBuffer()], STREAMFLOW);
  const mine = ata(o, m);
  const d = new Uint8Array(8 + 132 + 10); let p = 0;
  const put = (bytes) => { d.set(bytes, p); p += bytes.length; };
  const u64 = (v) => put(new BN(String(v)).toArrayLike(Uint8Array, 'le', 8));
  const t = Math.floor(unlockAt);
  put(CREATE_V2);
  u64(t); u64(amount); u64(1); u64(1); u64(t); u64(amount); // start, deposit, period, amount per period, cliff, cliff amount
  put([0, 0, 0, 0, 0, 0]); // cancelable by sender / recipient, automatic withdrawal, transferable by sender / recipient, top-up
  const nm = new Uint8Array(64); nm.set(enc.encode(name).slice(0, 64)); put(nm);
  u64(1); // withdraw frequency (= period)
  put([0, 0]); // pausable, can update rate
  put([0, 0, 0, 0]); // nonce 0
  const keys = [
    [o, true, true], [mine, false, true], [o, false, true], [metadata, false, true], [escrowTokens, false, true], [mine, false, true],
    [TREASURY, false, true], [ata(TREASURY, m), false, true], [WITHDRAWOR, false, true], [o, false, true], [mine, false, true],
    [m, false, false], [STREAMFLOW_ORACLE, false, false], [SYSVAR_RENT_PUBKEY, false, false], [STREAMFLOW, false, false],
    [TOKEN22, false, false], [ATA_PROGRAM, false, false], [SystemProgram.programId, false, false],
  ].map(([pubkey, isSigner, isWritable]) => ({ pubkey, isSigner, isWritable }));
  return new TransactionInstruction({ programId: STREAMFLOW, keys, data: Buffer.from(d) });
}
