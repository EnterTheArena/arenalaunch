// pump.fun launch builder — shared by the browser app and tools/pump-sim.mjs.
// The create (create_v2) and every squad buy go into transactions WE build: the mint is ours, so the dev buy and
// the first few wallets ride inside the create transaction itself, and teammates' buys are ready the instant it lands.
// Every buy is buy_exact_quote_in_v2: spend exactly N SOL, receive at least M tokens. Its accounts are identical to
// buy_v2, so the SDK builds buy_v2 and we swap the instruction data.
import { PublicKey, TransactionInstruction, SystemProgram, Keypair } from '@solana/web3.js';
import BN from 'bn.js';
import { PUMP_SDK, GLOBAL_PDA, PUMP_FEE_CONFIG_PDA, PUMP_PROGRAM_ID, getBuyTokenAmountFromSolAmount, userVolumeAccumulatorPda } from '@pump-fun/pump-sdk';

export const PUMP = PUMP_PROGRAM_ID.toBase58();
export const WSOL = 'So11111111111111111111111111111111111111112';
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const BUY_V2 = [184, 23, 238, 97, 103, 197, 211, 61];
export const BUY_EXACT_IN = [194, 171, 28, 70, 104, 77, 91, 47];
export const CREATE_V2 = [214, 144, 76, 236, 95, 139, 49, 180];
// buy_v2 / buy_exact_quote_in_v2 account positions that belong to the BUYER (everything else is per-coin or global)
export const BUY_USER = { user: 13, baseAta: 14, quoteAta: 15, uva: 20, uvaAta: 21 };

// arenalaunch fees, paid to the treasury: 3% on top of every launch buy (inside that buy's own transaction, so a buy that
// fails pays nothing — the relay refuses buys without it) and 2% of every private (Husher) transfer
import { TREASURY, LAUNCH_TAX_BPS } from '../api/_fees.js';
export { TREASURY, LAUNCH_TAX_BPS, HUSHER_TAX_BPS } from '../api/_fees.js';
export const launchTax = (lamports) => Number((BigInt(Math.round(lamports)) * BigInt(LAUNCH_TAX_BPS)) / 10000n);
export const launchTaxIx = (from, buyLamports) => SystemProgram.transfer({ fromPubkey: new PublicKey(from), toPubkey: new PublicKey(TREASURY), lamports: launchTax(buyLamports) });

const ata = (mint, owner, prog) => PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), new PublicKey(prog).toBuffer(), new PublicKey(mint).toBuffer()], new PublicKey(ATA_PROGRAM))[0];
const isDisc = (data, d) => data.length >= 8 && d.every((b, i) => data[i] === b);

// global + fee config, decoded by the SDK. getAccounts(addresses) → [{data: base64 string}|null]
export async function pumpState(getAccounts) {
  const [g, f] = await getAccounts([GLOBAL_PDA.toBase58(), PUMP_FEE_CONFIG_PDA.toBase58()]);
  if (!g) throw new Error('pump.fun global account not found');
  const info = (a) => ({ data: Buffer.from(a.data[0], 'base64'), owner: new PublicKey(a.owner), lamports: a.lamports, executable: false });
  return { global: PUMP_SDK.decodeGlobal(info(g)), feeConfig: f ? PUMP_SDK.decodeFeeConfig(info(f)) : null };
}

// tokens (raw, 6 dp) a buy of `lamports` gets from a FRESH curve
export function tokensFor(st, lamports) {
  if (!(lamports > 0)) return new BN(0);
  return getBuyTokenAmountFromSolAmount({ global: st.global, feeConfig: st.feeConfig, mintSupply: null, bondingCurve: null, amount: new BN(String(lamports)), quoteMint: new PublicKey(WSOL) });
}
// tokens the k-th buyer gets when `before` lamports were spent ahead of it on the fresh curve
export const tokensAt = (st, before, lamports) => tokensFor(st, before + lamports).sub(tokensFor(st, before));

export function exactIn(buyIx, lamports, minOut) {
  const data = Buffer.alloc(24); Buffer.from(BUY_EXACT_IN).copy(data, 0);
  data.writeBigUInt64LE(BigInt(lamports), 8); data.writeBigUInt64LE(BigInt(minOut.toString()), 16);
  return new TransactionInstruction({ programId: buyIx.programId, keys: buyIx.keys.map((k) => ({ ...k })), data });
}

// The create + the dev's token account + the dev buy. Returns the instructions and a TEMPLATE (plain JSON) that
// anyone can turn into their own buy of this coin with buyIxsFor().
export async function buildCreate(st, { mint, creator, name, symbol, uri, holderReward, devLamports, devMinOut }) {
  const ixs = await PUMP_SDK.createV2AndBuyV2Instructions({ global: st.global, mint, name, symbol, uri, creator, user: creator, amount: devMinOut, quoteAmount: new BN(String(devLamports)), mayhemMode: false, holderReward: !!holderReward });
  const bi = ixs.findIndex((ix) => ix.programId.equals(PUMP_PROGRAM_ID) && isDisc(ix.data, BUY_V2));
  const ci = ixs.findIndex((ix) => ix.programId.equals(PUMP_PROGRAM_ID) && isDisc(ix.data, CREATE_V2));
  if (bi < 0 || ci < 0) throw new Error('pump.fun SDK returned an unexpected create layout');
  const buy = ixs[bi];
  if (!buy.keys[BUY_USER.user].pubkey.equals(creator)) throw new Error('pump.fun SDK buy layout changed (user account not at #14)');
  ixs[bi] = exactIn(buy, devLamports, devMinOut);
  // which accounts follow the mint: build the same create for a throwaway mint and diff
  const other = await PUMP_SDK.createV2AndBuyV2Instructions({ global: st.global, mint: Keypair.generate().publicKey, name, symbol, uri, creator, user: creator, amount: devMinOut, quoteAmount: new BN(String(devLamports)), mayhemMode: false, holderReward: !!holderReward });
  const otherKeys = new Set(other.flatMap((ix) => ix.keys.map((k) => k.pubkey.toBase58())));
  const perMintKeys = [...new Set(ixs.flatMap((ix) => ix.keys.map((k) => k.pubkey.toBase58())))].filter((k) => !otherKeys.has(k));
  const template = { v: 2, perMintKeys, kind: 'pump', mint: mint.toBase58(), mintB: WSOL, quoteDecimals: 9, creator: creator.toBase58(), holderReward: !!holderReward, buyKeys: buy.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isWritable: k.isWritable })) };
  return { ixs, template, ata: (owner) => ata(mint, owner, TOKEN22).toBase58() };
}

// A buyer's own instructions for this coin: their Token-2022 token account (idempotent) + buy_exact_quote_in_v2.
export function buyIxsFor(template, owner, lamports, minOut) {
  owner = new PublicKey(owner); const mint = new PublicKey(template.mint);
  const uva = userVolumeAccumulatorPda(owner);
  const mine = { [BUY_USER.user]: owner, [BUY_USER.baseAta]: ata(mint, owner, TOKEN22), [BUY_USER.quoteAta]: ata(WSOL, owner, TOKEN), [BUY_USER.uva]: uva, [BUY_USER.uvaAta]: ata(WSOL, uva, TOKEN) };
  const keys = template.buyKeys.map((k, i) => { const pk = mine[i] || new PublicKey(k.pubkey); return { pubkey: pk, isSigner: i === BUY_USER.user, isWritable: k.isWritable }; });
  const ataIx = new TransactionInstruction({ programId: new PublicKey(ATA_PROGRAM), keys: [{ pubkey: owner, isSigner: true, isWritable: true }, { pubkey: mine[BUY_USER.baseAta], isSigner: false, isWritable: true }, { pubkey: owner, isSigner: false, isWritable: false }, { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: new PublicKey(TOKEN22), isSigner: false, isWritable: false }], data: Buffer.from([1]) });
  const buy = exactIn(new TransactionInstruction({ programId: PUMP_PROGRAM_ID, keys, data: Buffer.alloc(24) }), lamports, minOut);
  return [ataIx, buy];
}

// A teammate's check before auto-signing a buy against a template the dev sent: the coin is a fresh pump.fun coin created
// by the lobby dev, and every account of the buy is the one pump.fun derives from that mint (rebuilt here, not trusted).
// Fee recipients (#7-#10) are picked at random by the SDK from pump.fun's own list, so only their token accounts are checked.
// Returns null when the template is sound, else the reason.
export async function templateBad(st, t, dev) {
  if (t?.kind !== 'pump' || !t.mint || !t.creator || !Array.isArray(t.buyKeys)) return 'not a pump.fun launch template';
  if (t.creator !== dev) return 'the coin\'s creator is not the lobby dev';
  if (t.mintB !== WSOL) return 'not a SOL-quoted coin';
  let ref; try { ref = await buildCreate(st, { mint: new PublicKey(t.mint), creator: new PublicKey(t.creator), name: 'x', symbol: 'x', uri: 'https://x', holderReward: !!t.holderReward, devLamports: 1000000, devMinOut: new BN(1) }); } catch (e) { return 'cannot rebuild the launch (' + e.message + ')'; }
  const want = ref.template.buyKeys.map((k) => k.pubkey), got = t.buyKeys.map((k) => k.pubkey);
  if (got.length !== want.length) return 'buy account count mismatch';
  const skip = new Set([6, 7, 8, 9, ...Object.values(BUY_USER)]);
  for (let i = 0; i < want.length; i++) if (!skip.has(i) && got[i] !== want[i]) return 'buy account #' + (i + 1) + ' is not the one pump.fun derives from the mint';
  for (const [r, a] of [[6, 7], [8, 9]]) if (got[a] !== ata(WSOL, got[r], TOKEN).toBase58()) return 'buy account #' + (a + 1) + ' is not the fee recipient\'s account';
  return null;
}

// Accounts that are the same for every launch (globals, programs, fee recipients) — what a lookup table may hold.
// Everything derived from the new mint, or belonging to a buyer, is excluded: it does not exist before the launch.
export function staticKeysOf(ixs, mints, owners, template) {
  const own = new Set(owners.map((o) => new PublicKey(o).toBase58()));
  for (const o of owners) { const b = buyIxsFor(template, o, 1, 1)[1]; for (const i of Object.values(BUY_USER)) own.add(b.keys[i].pubkey.toBase58()); }
  const mintSet = new Set(mints.map((m) => new PublicKey(m).toBase58()));
  // per-mint accounts: every key of the create that is not also in a create for a DIFFERENT mint
  const perMint = new Set(); const t = template.perMintKeys || []; t.forEach((k) => perMint.add(k));
  return [...new Set(ixs.flatMap((ix) => ix.keys.map((k) => k.pubkey.toBase58())))].filter((k) => !own.has(k) && !mintSet.has(k) && !perMint.has(k));
}
// every account of a launch except its signers and programs — what the per-launch lookup table holds
export function signersOf(ixs) { return [...new Set(ixs.flatMap((ix) => ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())))]; }
export function altKeysOf(ixs, signers) { const s = new Set(signers); const progs = new Set(ixs.map((ix) => ix.programId.toBase58())); return [...new Set(ixs.flatMap((ix) => ix.keys.map((k) => k.pubkey.toBase58())))].filter((k) => !s.has(k) && !progs.has(k)); }
export const tokenAccountOf = (mint, owner) => ata(mint, owner, TOKEN22);
// pump.fun creator fee sharing: hand the coin's creator fees to up to 10 wallets, set once and locked (the admin is revoked).
// Moves the coin's creator to pump.fun's sharing account, so it must land AFTER every buy that names the dev as creator.
export async function feeSplitIxs(mint, creator, holders) {
  return [await PUMP_SDK.createFeeSharingConfig({ creator, mint, pool: null }), await PUMP_SDK.updateFeeShares({ authority: creator, mint, currentShareholders: [creator], newShareholders: holders.map((h) => ({ address: new PublicKey(h.address), shareBps: h.bps })) })];
}
// equal shares in basis points; the remainder goes to the first (the dev)
export const equalShares = (addrs) => { const b = Math.floor(10000 / addrs.length); return addrs.map((a, i) => ({ address: a, bps: i ? b : 10000 - b * (addrs.length - 1) })); };
