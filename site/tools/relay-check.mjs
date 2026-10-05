// Offline check of the relay's pump.fun buy validation against transactions built by the real client code.
//   node tools/build-sim.mjs relay-check && node tools/.relay-check.bundle.mjs
import { Keypair, Transaction, ComputeBudgetProgram, SystemProgram, PublicKey, TransactionMessage, VersionedTransaction, AddressLookupTableAccount } from '@solana/web3.js';
import bs58 from 'bs58';
import { lockIx } from '../src/lock.js';
import { pumpState, buildCreate, buyIxsFor, tokensFor, altKeysOf, signersOf, templateBad, feeSplitIxs, equalShares, launchTaxIx, TREASURY } from '../src/pump.js';
import { validatePumpBuy, checkPumpLaunch, amountOf, tipsHelius, buyOrder, checkFeeSplit, checkLock } from '../../relay/src/index.js';
const HT = new PublicKey('4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE');

const RPC = 'https://api.mainnet-beta.solana.com';
const getAccounts = async (a) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [a, { encoding: 'base64' }] }) })).json()).result.value;
const st = await pumpState(getAccounts);
const dev = Keypair.generate(), mint = Keypair.generate(), member = Keypair.generate(), other = Keypair.generate();
const built = await buildCreate(st, { mint: mint.publicKey, creator: dev.publicKey, name: 'T', symbol: 'T', uri: 'https://x', holderReward: false, devLamports: 1e7, devMinOut: tokensFor(st, 1e7) });
const bh = Keypair.generate().publicKey.toBase58();
const L = { template: { ...built.template, blockhash: bh } };
const m = { wallet: member.publicKey.toBase58(), amount: 0.05 };
const mk = (f = (x) => x, signer = member, amount = 5e7, extra = [], tax = [launchTaxIx(signer.publicKey, amount)]) => { const t = new Transaction({ feePayer: signer.publicKey, recentBlockhash: bh }); t.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }), ...f(buyIxsFor(L.template, signer.publicKey, amount, 1)), ...tax, ...extra); t.sign(signer); return t.serialize(); };
const cases = {
  legit: [mk(), null],
  'wrong amount': [mk(undefined, member, 6e7), 'amount'],
  'other signer': [mk(undefined, other), 'not signed'],
  'stale blockhash': [(() => { const t = new Transaction({ feePayer: member.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() }); t.add(...buyIxsFor(L.template, member.publicKey, 5e7, 1)); t.sign(member); return t.serialize(); })(), 'blockhash'],
  'sol transfer added': [mk(undefined, member, 5e7, [SystemProgram.transfer({ fromPubkey: member.publicKey, toPubkey: other.publicKey, lamports: 1 })]), 'unexpected'],
  'bundle tip 0.00001 SOL': [mk(undefined, member, 5e7, [SystemProgram.transfer({ fromPubkey: member.publicKey, toPubkey: HT, lamports: 10000 })]), null],
  'bundle tip too big': [mk(undefined, member, 5e7, [SystemProgram.transfer({ fromPubkey: member.publicKey, toPubkey: HT, lamports: 200000 })]), 'unexpected transfer'],
  'two bundle tips': [mk(undefined, member, 5e7, [SystemProgram.transfer({ fromPubkey: member.publicKey, toPubkey: HT, lamports: 10000 }), SystemProgram.transfer({ fromPubkey: member.publicKey, toPubkey: HT, lamports: 10000 })]), 'unexpected transfer'],
  'fee recipient swapped': [mk((ixs) => { ixs[1].keys[6] = { ...ixs[1].keys[6], pubkey: other.publicKey }; return ixs; }), /differs|derived/],
  'fee recipient + its account swapped': [mk((ixs) => { ixs[1].keys[6] = { ...ixs[1].keys[6], pubkey: other.publicKey }; ixs[1].keys[7] = { ...ixs[1].keys[7], pubkey: PublicKey.findProgramAddressSync([other.publicKey.toBuffer(), new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer(), new PublicKey('So11111111111111111111111111111111111111112').toBuffer()], new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'))[0] }; return ixs; }), 'differs'],
  'priority fee 0.005 SOL': [(() => { const t = new Transaction({ feePayer: member.publicKey, recentBlockhash: bh }); t.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 25000000 }), ...buyIxsFor(L.template, member.publicKey, 5e7, 1), launchTaxIx(member.publicKey, 5e7)); t.sign(member); return t.serialize(); })(), null],
  'priority fee 0.02 SOL': [(() => { const t = new Transaction({ feePayer: member.publicKey, recentBlockhash: bh }); t.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000000 }), ...buyIxsFor(L.template, member.publicKey, 5e7, 1)); t.sign(member); return t.serialize(); })(), 'priority fee'],
  'no limit, huge price': [(() => { const t = new Transaction({ feePayer: member.publicKey, recentBlockhash: bh }); t.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 40000000 }), ...buyIxsFor(L.template, member.publicKey, 5e7, 1)); t.sign(member); return t.serialize(); })(), 'priority fee'],
  'two limits': [mk(undefined, member, 5e7, [ComputeBudgetProgram.setComputeUnitLimit({ units: 1000 })]), 'two compute'],
  'token account for another owner': [mk((ixs) => { ixs[0].keys[2] = { ...ixs[0].keys[2], pubkey: other.publicKey }; return ixs; }), 'someone else'],
  'other coin': [mk((ixs) => { ixs[1].keys[1] = { ...ixs[1].keys[1], pubkey: Keypair.generate().publicKey }; return ixs; }), /differs|derived/],
  'two buys': [mk((ixs) => [...ixs, ixs[1]]), 'exactly one'],
  'no launch fee': [mk(undefined, member, 5e7, [], []), 'missing the 3%'],
  'launch fee 1 lamport short': [mk(undefined, member, 5e7, [], [SystemProgram.transfer({ fromPubkey: member.publicKey, toPubkey: new PublicKey(TREASURY), lamports: 1.5e6 - 1 })]), 'launch fee is wrong'],
  'launch fee paid twice': [mk(undefined, member, 5e7, [launchTaxIx(member.publicKey, 5e7)]), 'launch fee is wrong'],
  'launch fee sent elsewhere': [mk(undefined, member, 5e7, [], [SystemProgram.transfer({ fromPubkey: member.publicKey, toPubkey: other.publicKey, lamports: 1.5e6 })]), 'unexpected transfer'],
  'launch fee + bundle tip': [mk(undefined, member, 5e7, [SystemProgram.transfer({ fromPubkey: member.publicKey, toPubkey: HT, lamports: 10000 })]), null],
};
let bad = 0;
for (const [name, [bytes, want]] of Object.entries(cases)) { const got = validatePumpBuy(bytes, m, L); const ok = want === null ? got === null : got && (want instanceof RegExp ? want.test(got) : got.includes(want)); if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', name, '→', got); }
// the dev's launch transaction (v0 with a lookup table, like the app) against the template
const tbl = new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: altKeysOf(built.ixs, signersOf(built.ixs)).map((k) => new PublicKey(k)) } });
const v0 = (ixs, tax = [launchTaxIx(dev.publicKey, 1e7)]) => { const t = new VersionedTransaction(new TransactionMessage({ payerKey: dev.publicKey, recentBlockhash: bh, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), ...ixs, ...tax] }).compileToV0Message([tbl])); return bs58.encode(t.serialize()); };
const other2 = await buildCreate(st, { mint: Keypair.generate().publicKey, creator: dev.publicKey, name: 'T', symbol: 'T', uri: 'https://x', holderReward: false, devLamports: 1e7, devMinOut: tokensFor(st, 1e7) });
const dev2 = Keypair.generate(); const D = dev.publicKey.toBase58();
const CREATE = Buffer.from([214, 144, 76, 236, 95, 139, 49, 180]);
const lcases = {
  'launch legit': [v0(built.ixs), L.template, D, null],
  'launch of another mint': [v0(other2.ixs), L.template, D, 'another mint'],
  'launch without create': [v0(built.ixs.filter((ix) => !Buffer.from(ix.data.subarray(0, 8)).equals(CREATE))), L.template, D, 'create_v2'],
  'template points at another coin': [v0(built.ixs), { ...L.template, buyKeys: other2.template.buyKeys }, D, 'derived'],
  'someone else is the dev': [v0(built.ixs), L.template, dev2.publicKey.toBase58(), 'lobby dev'],
  'launch without the 3% fee': [v0(built.ixs, []), L.template, D, '3% launch fee'],
  'launch with a 1% fee': [v0(built.ixs, [SystemProgram.transfer({ fromPubkey: dev.publicKey, toPubkey: new PublicKey(TREASURY), lamports: 1e5 })]), L.template, D, '3% launch fee'],
};
for (const [name, [tx, t, d, want]] of Object.entries(lcases)) { const got = checkPumpLaunch(tx, t, d); const ok = want === null ? got === null : got && got.includes(want); if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', name, '→', got); }
// the browser's own check before a teammate auto-signs
for (const [name, t, d, want] of [['template legit', L.template, D, null], ['template for another coin', { ...L.template, buyKeys: other2.template.buyKeys }, D, 'derives'], ['template made by someone else', L.template, dev2.publicKey.toBase58(), 'creator'], ['template curve swapped', { ...L.template, buyKeys: L.template.buyKeys.map((k, i) => (i === 10 ? { ...k, pubkey: other.publicKey.toBase58() } : k)) }, D, '#11']]) { const got = await templateBad(st, t, d); const ok = want === null ? got === null : got && got.includes(want); if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', name, '→', got); }
for (const [v, want] of [[0.05, 0.05], [100, 100], [100.01, 0], [-1, 0], ['Infinity', 0], [NaN, 0], ['1e400', 0], ['abc', 0], [0, 0]]) { const ok = amountOf(v) === want; if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', 'amount', String(v), '→', amountOf(v)); }
for (const [name, tx, want] of [['create with a Helius tip', v0([...built.ixs, SystemProgram.transfer({ fromPubkey: dev.publicKey, toPubkey: HT, lamports: 100000 })]), true], ['create without tip', v0(built.ixs), false], ['tip below 5000 lamports', v0([...built.ixs, SystemProgram.transfer({ fromPubkey: dev.publicKey, toPubkey: HT, lamports: 4000 })]), false], ['buy with tip', bs58.encode(mk(undefined, member, 5e7, [SystemProgram.transfer({ fromPubkey: member.publicKey, toPubkey: HT, lamports: 10000 })])), true]]) { const got = tipsHelius(tx); const ok = got === want; if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', name, '→ tips', got); }
{ // 4 people: the dev (2 extra wallets) + 3 teammates (2, 1, 0 extra) → the first 3 bundled buys are one per teammate, then round robin
  const L2 = [{ name: 'dev-2', person: 0, rank: 1 }, { name: 'dev-3', person: 0, rank: 2 }];
  const M2 = [{ name: 'A', person: 1, rank: 0 }, { name: 'A-2', person: 1, rank: 1 }, { name: 'A-3', person: 1, rank: 2 }, { name: 'B', person: 2, rank: 0 }, { name: 'B-2', person: 2, rank: 1 }, { name: 'C', person: 3, rank: 0 }];
  const got = buyOrder(L2, M2).map((x) => x.name).join(' '); const want = 'A B C dev-2 A-2 B-2 dev-3 A-3'; const ok = got === want; if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', 'buy order', '→', got); }
{ // squad fee split: dev + every ready teammate, equal shares, paid by the dev
  const M = built.template.mint, mates = [member.publicKey.toBase58(), other.publicKey.toBase58()];
  const ftx = async (payer, holders, mint = M) => { const t = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: bh, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }), ...(await feeSplitIxs(new PublicKey(mint), payer, holders))] }).compileToV0Message()); return bs58.encode(t.serialize()); };
  const all3 = equalShares([D, ...mates]);
  for (const [name, tx, want] of [
    ['fee split legit (3 people, ' + all3.map((h) => h.bps).join('/') + ')', await ftx(dev.publicKey, all3), null],
    ['fee split leaves a teammate out', await ftx(dev.publicKey, equalShares([D, mates[0]])), 'missing'],
    ['fee split adds an outsider', await ftx(dev.publicKey, equalShares([D, ...mates, Keypair.generate().publicKey.toBase58()])), 'outside'],
    ['fee split paid by someone else', await ftx(dev2.publicKey, equalShares([dev2.publicKey.toBase58(), ...mates])), 'not paid'],
    ['fee split for another coin', await ftx(dev.publicKey, all3, other2.template.mint), 'another coin'],
  ]) { const got = checkFeeSplit(tx, M, D, [D, ...mates]).err || null; const ok = want === null ? got === null : got && got.includes(want); if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', name, '→', got); }
}
{ // Squad Lock: one Streamflow token lock of THIS coin by the wallet itself, no earlier than the lobby's lock time
  const M = built.template.mint, until = 1800000000, LL = { template: { mint: M, blockhash: bh, lockUntil: until }, dry: false };
  const mk = async (signer, o = {}) => { const ix = await lockIx({ owner: signer.publicKey, mint: o.mint || M, amount: '1000000', unlockAt: o.until || until }); if (o.cancel) ix.data[56] = 1; const t = new Transaction({ feePayer: signer.publicKey, recentBlockhash: o.bh || bh }); t.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 150000 }), ix, ...(o.extra || [])); t.sign(signer); return bs58.encode(t.serialize()); };
  const own = new Set([member.publicKey.toBase58()]);
  for (const [name, raw, want] of [
    ['lock legit', await mk(member), null],
    ['lock by a wallet that is not yours', await mk(other), 'not signed'],
    ['lock of another coin', await mk(member, { mint: other2.template.mint }), 'another coin'],
    ['lock shorter than the lobby time', await mk(member, { until: until - 3600 }), 'earlier'],
    ['lock that can be cancelled', await mk(member, { cancel: true }), 'cancelled'],
    ['lock with a SOL transfer added', await mk(member, { extra: [SystemProgram.transfer({ fromPubkey: member.publicKey, toPubkey: other.publicKey, lamports: 1 })] }), 'single Streamflow'],
    ['lock with a stale blockhash', await mk(member, { bh: Keypair.generate().publicKey.toBase58() }), 'blockhash'],
  ]) { const got = checkLock(raw, own, LL).err || null; const ok = want === null ? got === null : got && got.includes(want); if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', name, '→', got); }
}
process.exit(bad ? 1 : 0);
