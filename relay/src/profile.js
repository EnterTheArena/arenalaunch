// ============================================================================
// arenalaunch PROFILE — per-wallet history for the signed-in user's profile page.
//
//   launches: every landed launch a wallet took part in (as the dev or a teammate), recorded by the Stats DO when the
//             launch landed (relay data, the same wallets anyone can see on chain)
//   fees earned: pump.fun creator fees that reached the wallet: claims of the bonding-curve creator vault
//             (collect_creator_fee), of the PumpSwap creator vault (collect_coin_creator_fee) and squad fee-split
//             payouts (distribute_creator_fees). Read from the wallet's own transaction history, a page at a time, and
//             kept per wallet so each visit only reads what is new. Unclaimed fees are read live by the page.
// ============================================================================
export const WSOL = 'So11111111111111111111111111111111111111112';
// the pump.fun instructions that pay creator fees out (Anchor logs "Program log: Instruction: <Name>")
const FEE_IX = /Program log: Instruction: (CollectCreatorFee|CollectCreatorFeeV2|CollectCoinCreatorFee|DistributeCreatorFees|DistributeCreatorFeesV2)\b/;

// what one confirmed transaction paid this wallet in creator fees, in lamports (0 when it is not a fee payout).
// The wallet's SOL change plus its wrapped-SOL change; the network fee is added back when the wallet paid it, so a claim
// counts the fees claimed, not the fees minus the cost of claiming.
export function feeLamportsOf(tx, wallet) {
  if (!tx?.meta || tx.meta.err) return 0;
  if (!(tx.meta.logMessages || []).some((l) => FEE_IX.test(l))) return 0;
  const keys = [...(tx.transaction?.message?.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey)), ...(tx.meta.loadedAddresses?.writable || []), ...(tx.meta.loadedAddresses?.readonly || [])];
  const i = keys.indexOf(wallet); if (i < 0) return 0;
  let d = (tx.meta.postBalances[i] || 0) - (tx.meta.preBalances[i] || 0) + (i === 0 ? tx.meta.fee || 0 : 0);
  const wsol = (list) => (list || []).filter((b) => b.owner === wallet && b.mint === WSOL).reduce((a, b) => a + Number(b.uiTokenAmount?.amount || 0), 0);
  d += wsol(tx.meta.postTokenBalances) - wsol(tx.meta.preTokenBalances);
  return d > 0 ? d : 0;
}

// one step of a wallet's scan. state = {newest, cursor, done, earned, n}. Reads at most `budget` transactions:
// first the history backwards from the newest signature seen on the first visit (`cursor`), then, once that is done,
// anything newer than `newest`. Returns the updated state and how many transactions it read.
export async function scanStep(rpc, wallet, state, budget) {
  const st = { newest: null, cursor: null, done: false, earned: 0, n: 0, ...(state || {}) }; let used = 0;
  const lim = Math.max(1, Math.min(budget, 100));
  const count = async (sig) => { used++; const tx = await rpc('getTransaction', [sig, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]); st.earned += feeLamportsOf(tx, wallet); st.n++; };
  if (!st.done) {
    // backwards through the history, from the newest signature on the first visit
    const sigs = (await rpc('getSignaturesForAddress', [wallet, { limit: lim, commitment: 'confirmed', ...(st.cursor ? { before: st.cursor } : {}) }])) || [];
    if (!st.cursor && !st.newest && sigs.length) st.newest = sigs[0].signature;
    for (const s of sigs) { if (used >= budget) break; if (!s.err) await count(s.signature); else used++; st.cursor = s.signature; }
    if (sigs.length < lim && st.cursor === (sigs[sigs.length - 1]?.signature ?? st.cursor)) st.done = true; // the oldest page, read to the end
    return { state: st, used };
  }
  // caught up with the past: whatever came after the newest signature already counted, oldest first
  // (paged back to `newest`, up to 500, so a busy wallet leaves no gap; anything beyond that waits for the next visit)
  let sigs = []; let before;
  for (let p = 0; p < 5; p++) { const pg = (await rpc('getSignaturesForAddress', [wallet, { limit: 100, commitment: 'confirmed', ...(st.newest ? { until: st.newest } : {}), ...(before ? { before } : {}) }])) || []; sigs.push(...pg); if (pg.length < 100) break; before = pg[pg.length - 1].signature; }
  sigs.reverse();
  for (const s of sigs) { if (used >= budget) break; if (!s.err) await count(s.signature); else used++; st.newest = s.signature; }
  return { state: st, used };
}
