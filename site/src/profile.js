// arenalaunch — the Profile tab: the signed-in user's launches, the pump.fun creator fees they have earned and can claim.
// app.js calls in through a small context object (ctx), like rh.js.
//
//   launches + fees earned: from the relay (POST /profile), which lists every landed launch a wallet bought in and adds
//     up the creator fees paid out to it, read from its on-chain history (relay/src/profile.js)
//   unclaimed + Claim: read live here with pump.fun's own SDK (the same code pump.fun uses), through the site's RPC proxy:
//     one claim per wallet empties both its bonding-curve vault and its PumpSwap vault (all its coins at once)
//   squad-split coins: the fees sit in the coin's sharing account until someone distributes them to every shareholder;
//     anyone may do that, so the page offers it to every shareholder
import { PublicKey, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import { OnlinePumpSdk, PUMP_SDK, feeSharingConfigPda, bondingCurvePda } from '@pump-fun/pump-sdk';

const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const PR = { busy: false, at: 0, launches: [], fees: {}, unclaimed: {}, amm: {}, buckets: {}, splits: [], err: null, claiming: null };
const sol = (lamports) => Number(lamports) / 1e9;
const f4 = (x) => (Math.round(x * 1e4) / 1e4).toString();

// the few reads pump.fun's SDK makes, answered through /api/sol (getMultipleAccounts is the only method it needs)
function connection(ctx) {
  const toInfo = (a) => (a ? { data: Buffer.from(a.data[0], 'base64'), owner: new PublicKey(a.owner), lamports: a.lamports, executable: !!a.executable, rentEpoch: 0 } : null);
  const c = {
    rpcEndpoint: location.origin + '/api/sol', commitment: 'confirmed',
    getMultipleAccountsInfo: async (keys) => (await ctx.getAccounts(keys.map((k) => new PublicKey(k).toBase58()))).map(toInfo),
    getAccountInfo: async (k) => (await c.getMultipleAccountsInfo([k]))[0],
    getMinimumBalanceForRentExemption: async (n) => (n + 128) * 6960, // Solana's rent-exempt minimum (2 years at 3480 lamports/byte-year)
  };
  return c;
}
let SDK = null; const sdk = (ctx) => (SDK ||= new OnlinePumpSdk(connection(ctx)));

const myWallets = (ctx) => [...ctx.sols().map((w) => ({ id: w.id, name: w.name, address: w.address })), ...(ctx.phantomPk() ? [{ id: 'phantom', name: 'Phantom', address: ctx.phantomPk() }] : [])];

// creator fees sitting on coins' curves (BondingCurve.creatorFee), by the curve's current creator: {creator: [{mint, fee}]}
async function curveBuckets(ctx, launches) {
  const mints = [...new Set(launches.map((x) => x.mint))].slice(0, 60); const out = {}; if (!mints.length) return out;
  const infos = await connection(ctx).getMultipleAccountsInfo(mints.map((m) => bondingCurvePda(new PublicKey(m))));
  infos.forEach((info, i) => {
    let bc; try { bc = info && PUMP_SDK.decodeBondingCurveNullable(info); } catch { return; } if (!bc) return;
    const fee = Number(bc.creatorFee?.toString() || 0); const q = bc.quoteMint?.toBase58?.();
    if (!(fee > 0) || (q && q !== PublicKey.default.toBase58() && q !== NATIVE_MINT.toBase58())) return;
    (out[bc.creator.toBase58()] ||= []).push({ mint: mints[i], fee });
  });
  return out;
}
const sweepIxs = (payer, creator, list) => Promise.all(list.slice(0, 6).map((b) => PUMP_SDK.sweepCreatorFeeInstruction({ payer: new PublicKey(payer), mint: new PublicKey(b.mint), creator: new PublicKey(creator), quoteMint: NATIVE_MINT, quoteTokenProgram: TOKEN_PROGRAM })));

export async function load(ctx) {
  if (PR.busy || !ctx.A.session) return; PR.busy = true; PR.err = null; ctx.render();
  try {
    const ws = myWallets(ctx);
    await ctx.gateToken();
    const r = await fetch(ctx.Y.relay + '/profile', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gate': ctx.Y.token, 'x-session': ctx.A.session }, body: JSON.stringify({ wallets: ws.map((w) => w.address) }) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'profile unavailable (' + r.status + ')');
    PR.launches = j.launches || []; PR.fees = j.fees || {};
    // unclaimed, per wallet: bonding-curve vault + PumpSwap vault
    const s = sdk(ctx); PR.unclaimed = {};
    PR.amm = {};
    // fees newer pump.fun trades (v3) leave on each coin's curve until someone sweeps them to the creator's vault:
    // counted as unclaimed, and swept by the claim. Only SOL-quoted coins (a paired coin earns in its pair token)
    PR.buckets = await curveBuckets(ctx, PR.launches.filter((x) => !x.mint.startsWith('0x')));
    for (const w of ws) { try { const pk = new PublicKey(w.address); const bc = Number((await s.getCreatorVaultBalance(pk)).toString()), amm = Number((await s.pumpAmmSdk.getCoinCreatorVaultBalance(pk)).toString()); PR.unclaimed[w.address] = bc + amm + (PR.buckets[w.address] || []).reduce((a, b) => a + b.fee, 0); PR.amm[w.address] = amm; } catch { PR.unclaimed[w.address] = null; } }
    // squad-split coins I hold a share of: what is waiting to be distributed
    PR.splits = []; const mine = new Set(ws.map((w) => w.address));
    const sol_ = PR.launches.filter((x) => !x.mint.startsWith('0x')).slice(0, 40);
    const cfgAddrs = sol_.map((x) => feeSharingConfigPda(new PublicKey(x.mint)));
    const infos = cfgAddrs.length ? await connection(ctx).getMultipleAccountsInfo(cfgAddrs) : [];
    for (const [i, info] of infos.entries()) {
      if (!info) continue; let cfg; try { cfg = PUMP_SDK.decodeSharingConfig(info); } catch { continue; }
      const me = (cfg.shareholders || []).find((h) => mine.has(h.address.toBase58())); if (!me) continue;
      let pending = null; try { pending = Number((await s.getCreatorVaultBalanceBothPrograms(cfgAddrs[i])).toString()) + ((PR.buckets[cfgAddrs[i].toBase58()] || [])[0]?.fee || 0); } catch {}
      PR.splits.push({ mint: sol_[i].mint, name: sol_[i].name, symbol: sol_[i].symbol, cfg, cfgAddr: cfgAddrs[i], pending, myBps: me.shareBps, n: cfg.shareholders.length });
    }
    PR.at = Date.now();
  } catch (e) { PR.err = e.message; }
  finally { PR.busy = false; ctx.render(); }
}

async function send(ctx, w, ixs, what) {
  const tx = new Transaction({ feePayer: new PublicKey(w.address), recentBlockhash: await ctx.blockhash() });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }), ...ixs);
  if (w.id === 'phantom') ctx.log('warn', what + ': approve it in Phantom');
  const signed = await ctx.signAs(w, tx);
  return ctx.sendAndConfirm(signed);
}
// one claim per wallet: everything its coins have earned so far, in both vaults
export async function claim(ctx, w) {
  if (PR.claiming) return; PR.claiming = w.address; ctx.render();
  try {
    const amt = PR.unclaimed[w.address];
    let ixs = await sdk(ctx).collectCoinCreatorFeeInstructions(new PublicKey(w.address), new PublicKey(w.address));
    // the SDK always adds the PumpSwap leg, which first creates an empty vault account (~0.002 SOL) when there is none:
    // only worth it once a coin has graduated and earned fees there; otherwise just the bonding-curve claim
    if (!(PR.amm?.[w.address] > 0)) ixs = ixs.filter((ix) => ix.programId.toBase58() === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
    // first move the fees still on the coins' curves into the vault this claim empties
    ixs = [...(await sweepIxs(w.address, w.address, PR.buckets[w.address] || [])), ...ixs];
    if (!ixs.length) throw new Error('nothing to claim');
    const sig = await send(ctx, w, ixs, 'claim');
    ctx.log('success', 'claimed ' + (amt != null ? f4(sol(amt)) + ' SOL of ' : '') + 'creator fees to ' + w.name + ' (' + sig + ')');
  } catch (e) { ctx.log('error', 'claim: ' + e.message); alert('Claim failed: ' + e.message); }
  finally { PR.claiming = null; await load(ctx); }
}
// a squad-split coin: pay its waiting fees out to every shareholder (anyone may; the payer only pays the network fee)
export async function distribute(ctx, sp, payer) {
  if (PR.claiming) return; PR.claiming = sp.mint; ctx.render();
  try {
    const mint = new PublicKey(sp.mint); const ixs = [];
    const amm = await new OnlinePumpSdk(connection(ctx)).pumpAmmSdk.getCoinCreatorVaultBalance(sp.cfgAddr).catch(() => null);
    if (amm && Number(amm.toString()) > 0) ixs.push(await PUMP_SDK.transferCreatorFeesToPumpV2({ payer: new PublicKey(payer.address), mint, quoteMint: NATIVE_MINT, quoteTokenProgram: TOKEN_PROGRAM }));
    ixs.unshift(...(await sweepIxs(payer.address, sp.cfgAddr.toBase58(), PR.buckets[sp.cfgAddr.toBase58()] || [])));
    ixs.push(await PUMP_SDK.distributeCreatorFees({ mint, sharingConfig: sp.cfg, sharingConfigAddress: sp.cfgAddr }));
    const sig = await send(ctx, payer, ixs, 'distribute');
    ctx.log('success', 'distributed the creator fees of ' + (sp.symbol ? '$' + sp.symbol : sp.mint) + ' to its ' + sp.n + ' shareholders (' + sig + ')');
  } catch (e) { ctx.log('error', 'distribute: ' + e.message); alert('Distribute failed: ' + e.message); }
  finally { PR.claiming = null; await load(ctx); }
}

export function render(ctx) {
  const { $, el, show, short } = ctx; if (!$('#tabProfile')) return;
  const ws = myWallets(ctx);
  $('#pName').textContent = ctx.A.key ? (ctx.A.kind === 'wallet' ? short(ctx.A.name) : ctx.A.name) : '—';
  const devN = PR.launches.filter((x) => x.role === 'dev').length;
  $('#pSub').textContent = PR.busy && !PR.at ? 'loading…' : PR.launches.length + ' launch' + (PR.launches.length === 1 ? '' : 'es') + ' · ' + devN + ' as the dev · ' + (PR.launches.length - devN) + ' as a buyer';
  const earned = ws.reduce((a, w) => a + (PR.fees[w.address]?.earned || 0), 0), unclaimed = ws.reduce((a, w) => a + (PR.unclaimed[w.address] || 0), 0);
  const counting = ws.some((w) => PR.fees[w.address] && !PR.fees[w.address].done);
  $('#pEarned').textContent = PR.at ? f4(sol(earned)) : '—'; $('#pEarnedNote').textContent = counting ? 'still reading your history — refresh in a minute for the full total' : 'claimed and paid out to you so far';
  $('#pUnclaimed').textContent = PR.at ? f4(sol(unclaimed)) : '—';
  $('#pErr').textContent = PR.err ? 'Could not load your profile: ' + PR.err : ''; $('#pRefresh').disabled = PR.busy; $('#pRefresh').textContent = PR.busy ? 'loading…' : '↻ refresh';
  // wallets
  const tb = $('#pWallets'); tb.innerHTML = '';
  for (const w of ws) {
    const tr = el('tr'); const n = el('td'); n.append(document.createTextNode(w.name), el('div', 'm', short(w.address))); n.lastChild.style.color = 'var(--mute)';
    const u = PR.unclaimed[w.address], e = PR.fees[w.address];
    const act = el('td', 'r'); const b = el('button', 'btn sm' + (u > 0 ? ' pri' : ''), PR.claiming === w.address ? 'claiming…' : 'Claim'); b.disabled = !(u > 5000) || !!PR.claiming; b.title = u > 5000 ? 'collect ' + f4(sol(u)) + ' SOL of creator fees into ' + w.name : 'nothing to claim yet'; b.onclick = () => claim(ctx, w); act.append(b);
    tr.append(n, el('td', 'r m', u == null ? (PR.at ? '?' : '…') : f4(sol(u)) + ' SOL'), el('td', 'r m', e ? f4(sol(e.earned)) + ' SOL' + (e.done ? '' : ' …') : '…'), act); tb.append(tr);
  }
  // squad splits
  show('#pSplitBox', PR.splits.length > 0); const sb = $('#pSplits'); sb.innerHTML = '';
  const payer = ws.find((w) => w.id !== 'phantom') || ws[0];
  for (const sp of PR.splits) {
    const tr = el('tr'); const n = el('td'); n.append(document.createTextNode((sp.symbol ? '$' + sp.symbol : short(sp.mint)) + ' '), el('span', 'tag', (sp.myBps / 100) + '% of ' + sp.n + ' shares'));
    const act = el('td', 'r'); const b = el('button', 'btn sm' + (sp.pending > 0 ? ' pri' : ''), PR.claiming === sp.mint ? 'sending…' : 'Distribute'); b.disabled = !(sp.pending > 5000) || !!PR.claiming || !payer; b.title = 'pays the waiting fees out to all ' + sp.n + ' shareholders (you pay only the network fee)'; b.onclick = () => distribute(ctx, sp, payer); act.append(b);
    tr.append(n, el('td', 'r m', sp.pending == null ? '?' : f4(sol(sp.pending)) + ' SOL waiting'), el('td', 'r m', sp.pending == null ? '' : '≈ ' + f4(sol(sp.pending) * sp.myBps / 10000) + ' SOL yours'), act); sb.append(tr);
  }
  // launches
  const lb = $('#pLaunches'); lb.innerHTML = '';
  if (!PR.launches.length) { const d = el('div', 'note', PR.at ? 'No launches yet. Coins you launch or buy into with arenalaunch show up here once they land.' : ''); lb.append(d); }
  for (const x of PR.launches) {
    const evm = x.mint.startsWith('0x'); const a = el('a', 'coin'); a.href = evm ? 'https://explorer.chain.robinhood.com/token/' + x.mint : 'https://pump.fun/coin/' + x.mint; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = x.mint;
    if (x.image && String(x.image).startsWith('https://')) { const im = el('img'); im.src = x.image; im.alt = ''; im.loading = 'lazy'; im.referrerPolicy = 'no-referrer'; im.onerror = () => im.replaceWith(el('span', 'ph')); a.append(im); } else a.append(el('span', 'ph'));
    const t = el('div', 't'); t.append(el('div', 'nm', x.name || short(x.mint)), el('div', 'tk', (x.symbol ? '$' + x.symbol + ' · ' : '') + (x.role === 'dev' ? 'you launched it' : 'you bought in') + ' · ' + new Date(x.t).toLocaleDateString())); a.append(t); lb.append(a);
  }
}

export function bind(ctx) { ctx.$('#pRefresh').onclick = () => load(ctx); }
export const loaded = () => PR.at > 0;
export const reset = () => Object.assign(PR, { busy: false, at: 0, launches: [], fees: {}, unclaimed: {}, buckets: {}, splits: [], err: null, claiming: null });
