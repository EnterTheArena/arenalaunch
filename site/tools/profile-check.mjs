// Profile fee history, offline: a made-up wallet history read by the relay's scanner (relay/src/profile.js) through a
// fake RPC.   node tools/profile-check.mjs   (from site/)
import { feeLamportsOf, scanStep, WSOL } from '../../relay/src/profile.js';
const W = 'Wa11et1111111111111111111111111111111111111', X = 'Other11111111111111111111111111111111111111';
const tx = (o) => ({ meta: { err: o.err || null, fee: 5000, logMessages: o.logs || [], preBalances: o.pre, postBalances: o.post, preTokenBalances: o.preT || [], postTokenBalances: o.postT || [], loadedAddresses: { writable: [], readonly: [] } }, transaction: { message: { accountKeys: o.keys || [W, X] } } });
const L = (n) => ['Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]', 'Program log: Instruction: ' + n];
let fails = 0; const ok = (c, w, got) => { console.log((c ? 'ok   ' : 'FAIL ') + w + (got != null ? '  → ' + got : '')); if (!c) fails++; };
ok(feeLamportsOf(tx({ logs: L('CollectCreatorFee'), pre: [1e9, 5e8], post: [1.2e9 - 5000, 3e8] }), W) === 2e8, 'a bonding-curve claim counts what arrived, network fee added back', feeLamportsOf(tx({ logs: L('CollectCreatorFee'), pre: [1e9, 5e8], post: [1.2e9 - 5000, 3e8] }), W));
ok(feeLamportsOf(tx({ logs: L('Buy'), pre: [1e9, 0], post: [2e9, 0] }), W) === 0, 'an ordinary transaction (a sell, a deposit) is not a fee');
ok(feeLamportsOf(tx({ logs: L('CollectCoinCreatorFee'), pre: [1e9, 0], post: [1e9 - 5000, 0], preT: [{ owner: W, mint: WSOL, uiTokenAmount: { amount: '0' } }], postT: [{ owner: W, mint: WSOL, uiTokenAmount: { amount: '30000000' } }] }), W) === 3e7, 'a PumpSwap claim paid in wrapped SOL counts');
ok(feeLamportsOf(tx({ logs: L('DistributeCreatorFees'), keys: [X, W], pre: [1e9, 1e8], post: [1e9 - 5000, 1.5e8] }), W) === 5e7, 'a squad split payout someone else triggered counts (no fee added back)');
ok(feeLamportsOf(tx({ logs: L('CollectCreatorFee'), err: { x: 1 }, pre: [1e9, 0], post: [1e9 - 5000, 0] }), W) === 0, 'a failed transaction counts nothing');
ok(feeLamportsOf(tx({ logs: L('DistributeCreatorFees'), keys: [X, X], pre: [1, 1], post: [2, 2] }), W) === 0, 'a payout to other wallets counts nothing');
// a history of 7 transactions (newest first), 3 of them fee payouts: 0.1 + 0.2 + 0.4 SOL
const hist = Array.from({ length: 7 }, (_, i) => ({ signature: 'sig' + (7 - i), err: null }));
const paid = { sig2: 1e8, sig4: 2e8, sig6: 4e8 };
const txOf = (sig) => (paid[sig] ? tx({ logs: L('CollectCreatorFee'), pre: [1e9, 0], post: [1e9 + paid[sig] - 5000, 0] }) : tx({ logs: L('Buy'), pre: [1e9, 0], post: [9e8, 0] }));
let calls = 0;
const mkRpc = (h) => async (m, p) => { calls++; if (m === 'getTransaction') return txOf(p[0]); const o = p[1]; let list = h; if (o.before) list = list.slice(list.findIndex((x) => x.signature === o.before) + 1); if (o.until) list = list.slice(0, list.findIndex((x) => x.signature === o.until)); return list.slice(0, o.limit); };
let st = null, r; let visits = 0; const rpc1 = mkRpc(hist);
do { r = await scanStep(rpc1, W, st, 3); st = r.state; visits++; } while (!st.done && visits < 10);
ok(st.done && st.earned === 7e8 && st.n === 7, 'the whole history is read across visits, 3 transactions at a time (' + visits + ' visits)', st.earned / 1e9 + ' SOL');
// new activity later: two more transactions, one a 0.05 SOL claim
const hist2 = [{ signature: 'sig9' }, { signature: 'sig8' }, ...hist]; paid.sig9 = 5e7;
r = await scanStep(mkRpc(hist2), W, st, 3); st = r.state;
ok(st.earned === 7.5e8 && st.n === 9 && st.newest === 'sig9', 'a later visit reads only the new transactions', st.earned / 1e9 + ' SOL');
r = await scanStep(mkRpc(hist2), W, st, 3);
ok(r.used === 0 && r.state.earned === 7.5e8, 'nothing new: nothing read, nothing counted twice');
// a burst of 12 new transactions between visits (more than a visit reads): read over two visits, none skipped
const burst = Array.from({ length: 12 }, (_, i) => ({ signature: 'b' + (12 - i) })); for (let i = 1; i <= 12; i++) paid['b' + i] = 1e7;
const hist3 = [...burst, ...hist2]; r = await scanStep(mkRpc(hist3), W, st, 5); r = await scanStep(mkRpc(hist3), W, r.state, 5); r = await scanStep(mkRpc(hist3), W, r.state, 5);
ok(r.state.earned === 7.5e8 + 12e7 && r.state.n === 21 && r.state.newest === 'b12', 'a burst bigger than one visit is read in order over several visits', r.state.earned / 1e9 + ' SOL');
const empty = await scanStep(mkRpc([]), W, null, 30); ok(empty.state.done && empty.state.earned === 0, 'a brand-new wallet: done, 0 earned');
console.log(fails ? fails + ' FAILED' : 'all profile checks passed'); process.exit(fails ? 1 : 0);
