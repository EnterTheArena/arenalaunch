// Paired launches (a coin quoted in another pump.fun coin $X), offline: a made-up chain holding pump.fun's global account,
// $X's mint and its bonding curve (then its pool), read through pump.fun's own SDK. Builds the dev's create + every kind of
// buy and runs them through the relay's checks, plus tampered copies that must be refused.
//   node tools/build-sim.mjs pair-check && node tools/.pair-check.bundle.mjs   (from site/)
import { PublicKey, Keypair, Transaction, TransactionMessage, VersionedTransaction, AddressLookupTableAccount, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js';
import { MintLayout, MINT_SIZE } from '@solana/spl-token';
import BN from 'bn.js';
import bs58 from 'bs58';
import { PUMP_SDK, GLOBAL_PDA, QUOTE_CONTROL_PDA, bondingCurvePda, canonicalPumpPoolPdaWithQuote, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID } from '@pump-fun/pump-sdk';
import { resolvePair, buildPairedCreate, pairedBuyIxsFor, pairedTokensAt, pairedTemplateBad, launchTaxIx, altKeysOf, signersOf, TOKEN22, WSOL, TREASURY, buildCreate, templateBad } from '../src/pump.js';
import { checkPumpLaunch, validatePumpBuy, pairedSwapKeysBad, ammPoolOf } from '../../relay/src/index.js';

let fails = 0; const ok = (c, w, got) => { console.log((c ? 'ok   ' : 'FAIL ') + w + (got != null ? '  → ' + got : '')); if (!c) fails++; };
const rk = () => Keypair.generate().publicKey;
const coder = PUMP_SDK.offlinePumpProgram.coder.accounts;
// the coder's own encode allocates 1000 bytes, less than pump.fun's global account: lay it out by hand
const enc = async (name, obj, c = coder) => { const e = c.accountLayouts.get(name); const lay = e.layout, disc = e.discriminator; const b = Buffer.alloc(4096); const n = lay.encode(obj, b); return Buffer.concat([Buffer.from(disc), b.subarray(0, n)]); };
const global = { initialized: true, authority: rk(), feeRecipient: rk(), initialVirtualTokenReserves: new BN('1073000000000000'), initialVirtualSolReserves: new BN('30000000000'), initialRealTokenReserves: new BN('793100000000000'), tokenTotalSupply: new BN('1000000000000000'), feeBasisPoints: new BN(95), withdrawAuthority: rk(), enableMigrate: true, poolMigrationFee: new BN(0), creatorFeeBasisPoints: new BN(30), feeRecipients: Array.from({ length: 7 }, rk), setCreatorAuthority: rk(), adminSetCreatorAuthority: rk(), createV2Enabled: true, whitelistPda: rk(), reservedFeeRecipient: rk(), mayhemModeEnabled: false, reservedFeeRecipients: Array.from({ length: 7 }, rk), isCashbackEnabled: false, buybackFeeRecipients: Array.from({ length: 8 }, rk), buybackBasisPoints: new BN(0), initialVirtualQuoteReserves: new BN('30000000000'), whitelistedQuoteMints: [PublicKey.default], creatorFeeConfigurable: false, maxConfigurableCreatorFeeBps: new BN(0), holderRewardClaimAuthority: rk(), isHolderRewardEnabled: true, maxCurveDepth: 3 };
const X = rk();
const curveX = (o = {}) => ({ virtualTokenReserves: new BN('900000000000000'), virtualQuoteReserves: new BN('35766666666'), realTokenReserves: new BN('620100000000000'), realQuoteReserves: new BN('5766666666'), tokenTotalSupply: new BN('1000000000000000'), complete: false, creator: rk(), isMayhemMode: false, isCashbackCoin: false, quoteMint: PublicKey.default, creatorFeeBps: new BN(0), canEditCreatorFee: false, isHolderReward: false, creatorFee: new BN(0), protocolFees: new BN(0), depth: 0, initialVirtualQuoteReserves: new BN('30000000000'), postCompleteBaseOut: new BN(0), postCompleteQuoteIn: new BN(0), ...o });
const mintData = () => { const b = Buffer.alloc(MINT_SIZE); MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 1000000000000000n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, b); return b; };
const chain = new Map();
const put = (k, owner, data) => chain.set(k.toBase58(), { data: [Buffer.from(data).toString('base64'), 'base64'], owner: owner.toBase58(), lamports: 1e9, executable: false });
put(GLOBAL_PDA, PUMP_PROGRAM_ID, await enc('global', global));
put(X, new PublicKey(TOKEN22), mintData());
put(new PublicKey(WSOL), new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), (() => { const b = mintData(); b[44] = 9; return b; })());
put(bondingCurvePda(X), PUMP_PROGRAM_ID, await enc('bondingCurve', curveX()));
const getAccounts = async (a) => a.map((k) => chain.get(k) || null);
if (process.env.DUMP) { (await import('fs')).writeFileSync(process.env.DUMP, JSON.stringify({ X: X.toBase58(), chain: [...chain] })); console.log('chain written to ' + process.env.DUMP); process.exit(0); }
const st = { global: PUMP_SDK.decodeGlobal({ data: await enc('global', global) }), feeConfig: null };

// ---- the pair ----
const pair = await resolvePair(getAccounts, st, X.toBase58());
ok(pair.hop1.venue === 'curve' && pair.hop1.baseMint === X.toBase58() && pair.hop1.quoteMint === WSOL && pair.tokenProgram === TOKEN22 && pair.depth === 1, '$X on its curve: route SOL → $X on the curve, depth 1', pair.hop1.venue);
let e = null; try { await resolvePair(getAccounts, st, rk().toBase58()); } catch (x) { e = x.message; } ok(!!e, 'a random address is refused', e);
e = null; try { await resolvePair(getAccounts, st, WSOL); } catch (x) { e = x.message; } ok(!!e && /default/.test(e), 'SOL itself is refused (it is the default)', e);
// tokens: monotonic, positive, each later buyer gets fewer
const a1 = pairedTokensAt(st, pair, 0, 1e9), a2 = pairedTokensAt(st, pair, 1e9, 1e9);
ok(a1.gtn(0) && a2.gtn(0) && a2.lt(a1), 'pricing through both curves: 1 SOL buys ' + a1.toString() + ', the next 1 SOL ' + a2.toString());

// ---- the dev's create ----
const dev = Keypair.generate(), mintKp = Keypair.generate(), devL = 500_000_000;
const devMin = pairedTokensAt(st, pair, 0, devL).muln(95).divn(100);
const built = await buildPairedCreate(st, pair, { mint: mintKp.publicKey, creator: dev.publicKey, name: 'Paired', symbol: 'PAIR', uri: 'https://x/y.json', holderReward: false, devLamports: devL, devMinOut: devMin });
const t = { ...built.template, blockhash: rk().toBase58() };
const swapIx = built.ixs.find((ix) => ix.programId.equals(PUMP_AMM_PROGRAM_ID));
ok(swapIx && swapIx.keys.length === 26 && swapIx.keys[23].pubkey.equals(bondingCurvePda(mintKp.publicKey)) && swapIx.keys[18].pubkey.equals(bondingCurvePda(X)), 'the dev buy is one multi_hop_swap: SOL → $X curve → the new coin\'s curve');
ok(!pairedSwapKeysBad(swapIx.keys.map((k) => k.pubkey.toBase58()), t, dev.publicKey.toBase58()), 'the relay re-derives every account of the SDK\'s swap', pairedSwapKeysBad(swapIx.keys.map((k) => k.pubkey.toBase58()), t, dev.publicKey.toBase58()));
const create = built.ixs.find((ix) => ix.programId.equals(PUMP_PROGRAM_ID));
ok(create.keys.some((k) => k.pubkey.equals(X)) && create.keys.some((k) => k.pubkey.equals(bondingCurvePda(X))), 'create_v2 names $X and its curve (pump.fun seeds the new curve from it)');
const all = [...built.ixs]; const keys = altKeysOf(all, signersOf(all));
const alt = new AddressLookupTableAccount({ key: rk(), state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: keys.map((k) => new PublicKey(k)) } });
const devTx = (ixs) => { const v = new VersionedTransaction(new TransactionMessage({ payerKey: dev.publicKey, recentBlockhash: t.blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }), ...ixs] }).compileToV0Message([alt])); v.sign([dev, mintKp]); return bs58.encode(v.serialize()); };
const good = devTx([...built.ixs, launchTaxIx(dev.publicKey, devL)]);
ok(bs58.decode(good).length <= 1232, 'the create transaction fits (' + bs58.decode(good).length + ' bytes)');
let r = checkPumpLaunch(good, t, dev.publicKey.toBase58()); ok(r.devLamports === devL, 'the relay accepts the paired create and reads the dev buy', JSON.stringify(r));
r = checkPumpLaunch(devTx(built.ixs), t, dev.publicKey.toBase58()); ok(r.err && /3%/.test(r.err), 'no 3% fee: refused', r.err);
r = checkPumpLaunch(devTx([...built.ixs, launchTaxIx(dev.publicKey, devL), ...(await pairedBuyIxsFor(t, dev.publicKey, 1e8, 1)).filter((ix) => ix.programId.equals(PUMP_AMM_PROGRAM_ID))]), t, dev.publicKey.toBase58()); ok(r.err && /more than one buy/.test(r.err), 'a second buy in the create: refused', r.err);
r = checkPumpLaunch(devTx([...built.ixs, launchTaxIx(dev.publicKey, devL), SystemProgram.transfer({ fromPubkey: dev.publicKey, toPubkey: rk(), lamports: devL })]), t, dev.publicKey.toBase58()); ok(r.err, 'a stray SOL transfer (curve route, nothing to wrap): refused', r.err);
r = checkPumpLaunch(good, { ...t, quote: { ...t.quote, hop1: { ...t.quote.hop1, quoteMint: X.toBase58() } } }, dev.publicKey.toBase58()); ok(r.err, 'a template whose first hop is not SOL → $X: refused', r.err);
r = checkPumpLaunch(good, { ...t, mintB: WSOL }, dev.publicKey.toBase58()); ok(r.err, 'a template naming two pairs: refused', r.err);

// ---- holder rewards on a paired coin: pump.fun takes is_holder_reward with any quote (holders are paid in $X) ----
{
  const hb = await buildPairedCreate(st, pair, { mint: mintKp.publicKey, creator: dev.publicKey, name: 'Paired', symbol: 'PAIR', uri: 'https://x/y.json', holderReward: true, devLamports: devL, devMinOut: devMin });
  const hc = hb.ixs.find((ix) => ix.programId.equals(PUMP_PROGRAM_ID)); const ht = { ...hb.template, blockhash: t.blockhash };
  const hall = [...hb.ixs]; const halt = new AddressLookupTableAccount({ key: rk(), state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: altKeysOf(hall, signersOf(hall)).map((k) => new PublicKey(k)) } });
  const v = new VersionedTransaction(new TransactionMessage({ payerKey: dev.publicKey, recentBlockhash: t.blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 }), ...hb.ixs, launchTaxIx(dev.publicKey, devL)] }).compileToV0Message([halt])); v.sign([dev, mintKp]);
  const raw = bs58.encode(v.serialize());
  ok(ht.holderReward === true && hc.data.length > create.data.length - 1, 'a holder-rewards paired create builds (holderReward set on create_v2)');
  ok(checkPumpLaunch(raw, ht, dev.publicKey.toBase58()).devLamports === devL, 'the relay accepts a holder-rewards paired create (' + bs58.decode(raw).length + ' bytes)', JSON.stringify(checkPumpLaunch(raw, ht, dev.publicKey.toBase58())));
  ok((await pairedTemplateBad(getAccounts, st, ht, dev.publicKey.toBase58())) === null, 'a teammate\'s page accepts a holder-rewards paired template');
}
// ---- a teammate's buy (legacy transaction, as the page signs it) ----
const mate = Keypair.generate(); const L = { template: t, dry: false };
const mateTx = async (ixs, amt = 2e8) => { const tx = new Transaction({ feePayer: mate.publicKey, recentBlockhash: t.blockhash }); tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 450000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2000 }), ...ixs); tx.sign(mate); return tx.serialize(); };
const mateIxs = async (amt = 2e8, mint = t, bb = false) => [...(await pairedBuyIxsFor(mint, mate.publicKey, amt, pairedTokensAt(st, pair, devL, amt).muln(85).divn(100), bb)), launchTaxIx(mate.publicKey, amt), SystemProgram.transfer({ fromPubkey: mate.publicKey, toPubkey: new PublicKey('4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE'), lamports: 250000 })];
const mb = await mateTx(await mateIxs());
ok(mb.length <= 1232, 'a teammate\'s buy fits a legacy transaction (' + mb.length + ' bytes, creating pump.fun\'s buyback account too)');
const mbb = await mateTx(await mateIxs(2e8, t, true)); ok(mbb.length < mb.length && validatePumpBuy(mbb, { wallet: mate.publicKey.toBase58(), amount: 0.2 }, { template: t }) === null, '...and ' + mbb.length + ' bytes when that account already exists (accepted too)');
const W = mate.publicKey.toBase58();
ok(validatePumpBuy(mb, { wallet: W, amount: 0.2 }, L) === null, 'the relay accepts a teammate\'s paired buy', validatePumpBuy(mb, { wallet: W, amount: 0.2 }, L));
ok(/amount/.test(validatePumpBuy(mb, { wallet: W, amount: 0.3 }, L) || ''), 'another amount than the roster says: refused');
ok(/3%/.test(validatePumpBuy(await mateTx((await mateIxs()).filter((ix) => !(ix.programId.equals(SystemProgram.programId) && ix.keys[1].pubkey.toBase58() === TREASURY))), { wallet: W, amount: 0.2 }, L) || ''), 'no 3% fee: refused');
const otherCoin = { ...t, mint: rk().toBase58() };
ok(/derived/.test(validatePumpBuy(await mateTx(await mateIxs(2e8, otherCoin)), { wallet: W, amount: 0.2 }, L) || ''), 'a buy of another coin through the same pair: refused', validatePumpBuy(await mateTx(await mateIxs(2e8, otherCoin)), { wallet: W, amount: 0.2 }, L));
const viaY = { ...t, quote: { ...t.quote, mint: rk().toBase58(), hop1: { ...t.quote.hop1 } } }; viaY.quote.hop1.baseMint = viaY.quote.mint; viaY.mintB = viaY.quote.mint;
ok(!!validatePumpBuy(await mateTx(await mateIxs(2e8, viaY)), { wallet: W, amount: 0.2 }, L), 'a buy routed through a different pair: refused');
ok(!!validatePumpBuy(await mateTx([...(await mateIxs(2e8, t, true)), SystemProgram.transfer({ fromPubkey: mate.publicKey, toPubkey: rk(), lamports: 1e6 })]), { wallet: W, amount: 0.2 }, L), 'an extra SOL transfer: refused');
ok(/signed/.test(validatePumpBuy(mb, { wallet: dev.publicKey.toBase58(), amount: 0.2 }, L) || ''), 'signed by someone else than the member: refused');
// the teammate's own check of the template
ok((await pairedTemplateBad(getAccounts, st, t, dev.publicKey.toBase58())) === null, 'a teammate\'s page accepts the dev\'s paired template', await pairedTemplateBad(getAccounts, st, t, dev.publicKey.toBase58()));
ok(/creator/.test((await pairedTemplateBad(getAccounts, st, t, rk().toBase58())) || ''), '...and refuses it when the creator is not the lobby dev');
ok(/route/.test((await pairedTemplateBad(getAccounts, st, { ...t, quote: { ...t.quote, hop1: { ...t.quote.hop1, venue: 'pool' } } }, dev.publicKey.toBase58())) || ''), '...or when the dev claims another route than the chain shows');

// ---- $X migrated: the first hop is its canonical SOL pool (the buy wraps SOL first) ----
const pool = canonicalPumpPoolPdaWithQuote(X, new PublicKey(WSOL));
ok(pool.toBase58() === ammPoolOf(X.toBase58(), WSOL), 'the relay derives $X\'s canonical pool like the SDK');
{
  const ammCoder = PUMP_SDK.offlinePumpAmmProgram.coder.accounts;
  const baseVault = rk(), quoteVault = rk();
  const poolAcc = { poolBump: 255, index: 0, creator: rk(), baseMint: X, quoteMint: new PublicKey(WSOL), lpMint: rk(), poolBaseTokenAccount: baseVault, poolQuoteTokenAccount: quoteVault, lpSupply: new BN(1), coinCreator: rk(), isMayhemMode: false, isCashbackCoin: false };
  let pdata = null; try { pdata = await enc('pool', poolAcc, ammCoder); } catch (x) { console.log('(pool encode: ' + x.message + ')'); }
  if (pdata) {
    const tokAcc = (mint, amount, prog) => { const b = Buffer.alloc(165); mint.toBuffer().copy(b, 0); rk().toBuffer().copy(b, 32); b.writeBigUInt64LE(amount, 64); b[108] = 1; return b; };
    put(bondingCurvePda(X), PUMP_PROGRAM_ID, await enc('bondingCurve', curveX({ virtualTokenReserves: new BN(0), virtualQuoteReserves: new BN(0), realTokenReserves: new BN(0), realQuoteReserves: new BN(0), complete: true })));
    put(pool, PUMP_AMM_PROGRAM_ID, Buffer.concat([pdata, Buffer.alloc(Math.max(0, 300 - pdata.length))]));
    put(baseVault, new PublicKey(TOKEN22), tokAcc(X, 200000000000000n)); put(quoteVault, new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), tokAcc(new PublicKey(WSOL), 85000000000n));
    let p2 = null; try { p2 = await resolvePair(getAccounts, st, X.toBase58()); } catch (x) { e = x.message; }
    ok(p2 && p2.hop1.venue === 'pool', '$X migrated: the route goes through its pool', p2 ? p2.hop1.venue : e);
    if (p2) {
      const t2 = { ...(await buildPairedCreate(st, p2, { mint: mintKp.publicKey, creator: dev.publicKey, name: 'P', symbol: 'P', uri: 'https://x', devLamports: devL, devMinOut: new BN(1) })).template, blockhash: t.blockhash };
      const ixs = [...(await pairedBuyIxsFor(t2, mate.publicKey, 2e8, 1, true)), launchTaxIx(mate.publicKey, 2e8), SystemProgram.transfer({ fromPubkey: mate.publicKey, toPubkey: new PublicKey('4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE'), lamports: 250000 })];
      ok(ixs.some((ix) => ix.programId.equals(SystemProgram.programId) && ix.keys[1].pubkey.equals(PublicKey.findProgramAddressSync([mate.publicKey.toBuffer(), new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer(), new PublicKey(WSOL).toBuffer()], new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'))[0])), 'the pool route wraps the SOL first');
      const raw = await mateTx(ixs); ok(raw.length <= 1232, 'a buy through the pool fits (' + raw.length + ' bytes, buyback account already there)'); ok(validatePumpBuy(raw, { wallet: W, amount: 0.2 }, { template: t2 }) === null, 'the relay accepts a buy through $X\'s pool', validatePumpBuy(raw, { wallet: W, amount: 0.2 }, { template: t2 }));
      ok(pairedTokensAt(st, p2, 0, 1e9).gtn(0), 'pricing through the pool works');
    }
  }
}
// SOL launches are untouched by any of this
{
  const b = await buildCreate(st, { mint: mintKp.publicKey, creator: dev.publicKey, name: 'S', symbol: 'S', uri: 'https://x', devLamports: devL, devMinOut: new BN(1) });
  ok(!b.template.quote && (await templateBad(st, b.template, dev.publicKey.toBase58())) === null, 'a SOL launch still builds and checks as before');
}
console.log(fails ? fails + ' FAILED' : 'all paired-launch checks passed'); process.exit(fails ? 1 : 0);
