// Solana program-derived addresses without web3.js (Workers): sha256(seeds | bump | program | "ProgramDerivedAddress"),
// first bump from 255 down whose hash is NOT a valid ed25519 point.
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';

const te = new TextEncoder();
const onCurve = (b) => { try { ed25519.Point.fromBytes(b); return true; } catch { return false; } };
const bytesOf = (s) => (typeof s === 'string' ? bs58.decode(s) : s);
export const text = (s) => te.encode(s);

// seeds: strings are base58 public keys; text seeds go in as text('bonding-curve'); Uint8Arrays are taken as-is
export function pda(seeds, program) {
  const parts = seeds.map(bytesOf); const prog = bs58.decode(program); const tag = te.encode('ProgramDerivedAddress');
  for (let bump = 255; bump >= 0; bump--) {
    const all = [...parts, Uint8Array.of(bump), prog, tag]; const buf = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
    let o = 0; for (const p of all) { buf.set(p, o); o += p.length; }
    const h = sha256(buf); if (!onCurve(h)) return bs58.encode(h);
  }
  throw new Error('no PDA');
}
export const ATA_PROG = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const ata = (owner, tokenProgram, mint) => pda([owner, tokenProgram, mint], ATA_PROG);
