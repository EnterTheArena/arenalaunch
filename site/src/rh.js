// arenalaunch on Robinhood Chain: squad launches on Pons v2. Kept apart from the pump.fun code; app.js calls in through
// a small context object (ctx) for the shared pieces (log, lobby socket, vault saving, the coin form, the image).
//
// How it works (relay/src/pons.js has the full story): the dev pre-signs launchAndBuy with the squad in the snipe-tax
// exemptions; the coin and curve addresses are known before the launch, so each teammate pre-signs a buy on the curve plus
// a 3% fee transfer as their next transaction; the relay sends the launch, waits for it, checks nobody bought in between,
// then fires every buy at once, and each fee only once its buy has landed. Every key here stays in the browser.
import { Wallet as EvmWallet, getAddress, hexlify, randomBytes, formatEther, ZeroAddress } from 'ethers';
import { PONS, RH_TREASURY, ROUTER_ABI, FACTORY_ABI, CURVE_ABI, ethWei, feeWei } from '../../relay/src/pons.js';

export const RH = { list: [], keys: new Map(), active: null, bal: {} };
const lc = (a) => String(a || '').toLowerCase();
const fe = (wei) => (Math.round(Number(formatEther(wei)) * 1e6) / 1e6).toString();
const BUY_GAS = 250000n, FEE_GAS = 21000n, LAUNCH_GAS = 4500000n;
const MAX_GAS_COST = 5n * 10n ** 15n; // the relay refuses any transaction that could burn more than 0.005 ETH in gas
// a rehearsal signs with a nonce far in the future, so none of its transactions could ever be mined, whoever holds them
const DRY_NONCE = 1_000_000_000;

// ---------------- the chain (through the site's signed-in proxy) ----------------
let H = null; // apiHeaders from app.js
async function rpc(method, params) {
  const r = await fetch('/api/rh', { method: 'POST', headers: H(), body: JSON.stringify({ method, params }) });
  const j = await r.json(); if (j.error) throw new Error(typeof j.error === 'string' ? j.error : j.error.message || 'Robinhood Chain error'); return j.result;
}
const call = async (to, iface, fn, args, opts = {}, override = null) => iface.decodeFunctionResult(fn, await rpc('eth_call', [{ to, data: iface.encodeFunctionData(fn, args), ...opts }, 'latest', ...(override ? [override] : [])]));
const hex = (n) => '0x' + BigInt(n).toString(16);
async function gasFees(limit) {
  const gp = BigInt(await rpc('eth_gasPrice', []));
  let max = gp * 4n; const cap = MAX_GAS_COST / limit; if (max > cap) max = cap;
  return { maxFeePerGas: max, maxPriorityFeePerGas: gp < max ? gp : max, type: 2 };
}
const nonceOf = async (a) => Number(await rpc('eth_getTransactionCount', [a, 'pending']));
// the launch call, simulated as the dev with plenty of ETH: returns the coin, its curve and the dev buy's tokens
async function simulate(from, data, value) {
  const res = await rpc('eth_call', [{ from, to: PONS.router, data, value: hex(value) }, 'latest', { [from]: { balance: hex(10n ** 21n) } }]);
  const d = ROUTER_ABI.decodeFunctionResult('launchAndBuy', res); return { token: getAddress(d[0]), curve: getAddress(d[1]), tokensOut: d[2] };
}

// ---------------- wallets (inside the account vault, next to the Solana ones) ----------------
export const isKey = (s) => /^(0x)?[0-9a-fA-F]{64}$/.test(String(s || '').trim());
export function load(w) { // a saved vault entry with chain 'rh'
  try { const k = new EvmWallet(w.secret); RH.list.push({ id: w.id, name: w.name, address: k.address, amount: w.amount || 0, on: !!w.on }); RH.keys.set(w.id, k); return true; } catch { return false; }
}
export const dump = () => RH.list.map((w) => ({ id: w.id, chain: 'rh', name: w.name, secret: RH.keys.get(w.id).privateKey, amount: w.amount || 0, on: !!w.on }));
export const clear = () => { RH.list = []; RH.keys.clear(); RH.active = null; RH.bal = {}; };
export const setActive = (id) => { RH.active = RH.list.some((w) => w.id === id) ? id : (RH.list[0] || {}).id || null; };
export const activeW = () => RH.list.find((w) => w.id === RH.active) || null;
export const addr = () => activeW()?.address || null;
export const unlocked = () => !!(activeW() && RH.keys.get(activeW().id));
export const mainAmt = () => Number(activeW()?.amount) || 0;
export const extras = () => RH.list.filter((w) => w.on && w.amount > 0 && w.id !== RH.active && RH.keys.has(w.id));
export function add(name, secret) {
  const k = secret ? new EvmWallet((String(secret).trim().startsWith('0x') ? '' : '0x') + String(secret).trim()) : EvmWallet.createRandom();
  if (RH.list.some((w) => lc(w.address) === lc(k.address))) throw new Error('that wallet is already in your account');
  const id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  RH.list.push({ id, name: (name || '').trim().slice(0, 24) || 'robinhood-' + (RH.list.length + 1), address: k.address, amount: 0, on: false }); RH.keys.set(id, k.privateKey ? new EvmWallet(k.privateKey) : k);
  if (!RH.active) RH.active = id; return k.address;
}
export const remove = (w) => { RH.list = RH.list.filter((x) => x.id !== w.id); RH.keys.delete(w.id); if (RH.active === w.id) RH.active = (RH.list[0] || {}).id || null; };
// the lobby hello: EIP-191 over the same text the Solana wallets sign
export async function signText(text) { const k = RH.keys.get(RH.active); if (!k) throw new Error('make a Robinhood wallet first'); return k.signMessage(text); }
export async function refresh() { for (const w of RH.list) { try { RH.bal[w.address] = Number(formatEther(BigInt(await rpc('eth_getBalance', [w.address, 'latest'])))); } catch {} } }

// ---------------- a teammate's buy (auto-signed when the dev launches) ----------------
// Before signing: the launch call is really a Pons launch by the lobby dev, I am in its snipe-tax exemptions, and the curve
// the relay names is the one that call creates (simulated here, not taken on trust).
export async function onSign(b, ctx) {
  const k = RH.keys.get(RH.active); const me = addr();
  if (!k || !me) throw new Error('make a Robinhood wallet and put the ★ on it');
  const amt = mainAmt(); if (!(amt > 0 && amt <= 100)) throw new Error('set a buy between 0 and 100 ETH on your ★ Robinhood wallet');
  const l = b.launch || {}; const dev = ctx.Y.roster?.dev;
  if (lc(l.to) !== lc(PONS.router) || lc(l.from) !== lc(dev)) throw new Error('that is not a Pons launch by this lobby\'s dev');
  let d; try { d = ROUTER_ABI.parseTransaction({ data: l.data, value: BigInt(l.value || 0) }); } catch { d = null; }
  if (!d || d.name !== 'launchAndBuy') throw new Error('that is not a Pons launch');
  if (lc(d.args[2]) !== lc(ZeroAddress)) throw new Error('that coin is not priced in ETH');
  if (!d.args[6].some((a) => lc(a) === lc(me))) throw new Error('the dev left my wallet out of the snipe-tax exemptions — not buying');
  const sim = await simulate(l.from, l.data, BigInt(l.value || 0));
  if (lc(sim.curve) !== lc(b.curve) || lc(sim.token) !== lc(b.token)) throw new Error('the curve the relay named is not the one this launch creates — not buying');
  const wei = ethWei(amt); const n = b.dry ? DRY_NONCE : await nonceOf(me);
  const [g1, g2] = await Promise.all([gasFees(BUY_GAS), gasFees(FEE_GAS)]);
  const buy = await k.signTransaction({ chainId: PONS.chainId, to: sim.curve, value: wei, data: CURVE_ABI.encodeFunctionData('buy', [wei, 0n, me]), nonce: n, gasLimit: BUY_GAS, ...g1 });
  const fee = await k.signTransaction({ chainId: PONS.chainId, to: RH_TREASURY, value: feeWei(wei), data: '0x', nonce: n + 1, gasLimit: FEE_GAS, ...g2 });
  ctx.ysend({ t: 'signed', tx: buy, fee });
  ctx.log('success', 'lobby: signed my buy of ' + amt + ' ETH (+ 3% launch fee, sent only if the buy lands) of ' + ctx.short(sim.token) + (b.dry ? ' (rehearsal)' : ''));
}

// ---------------- the dev's launch ----------------
let busy = false;
export const launching = () => busy;
export async function launch(dry, ctx) {
  const { Y, L, log } = ctx; const LOGO = ctx.logo();
  if (busy) throw new Error('already launching');
  const k = RH.keys.get(RH.active); const me = addr();
  if (!k) throw new Error('make a Robinhood wallet and put the ★ on it');
  if (!(Y.connected && Y.role === 'dev' && Y.roster?.chain === 'rh')) throw new Error('host a Robinhood lobby first (switch to Pons, then Host a lobby)');
  if (!L.name.trim() || !L.symbol.trim()) throw new Error('name and ticker are required');
  if (!LOGO?.dataUrl) throw new Error('choose an image');
  const dev = mainAmt(); if (!(dev > 0)) throw new Error('set a dev buy on your ★ Robinhood wallet');
  busy = true; ctx.render();
  try {
    const [[enabled], [can]] = await Promise.all([call(PONS.factory, FACTORY_ABI, 'launchEnabled', []), call(PONS.factory, FACTORY_ABI, 'canLaunch', [me])]);
    if (!enabled) throw new Error('Pons launches are switched off right now'); if (!can) throw new Error('Pons does not let this wallet launch right now');
    if (!LOGO.rhUrl) { log('info', 'launch: uploading the image…'); const r = await fetch('/api/ipfs', { method: 'POST', headers: H(), body: JSON.stringify({ name: L.name.trim(), symbol: L.symbol.trim(), description: L.description, dataUrl: LOGO.dataUrl }) }); const j = await r.json(); if (!j.imageUrl) throw new Error(j.error || 'image upload failed'); LOGO.rhUrl = j.imageUrl; ctx.saveLogo(); }
    const [[fee], [econ]] = await Promise.all([call(PONS.factory, FACTORY_ABI, 'launchFee', []), call(PONS.factory, FACTORY_ABI, 'previewLaunchEconomics', [PONS.configId, ZeroAddress])]);
    const team = (Y.roster?.members || []).filter((m) => m.role === 'member' && m.online && m.ready && m.amount > 0).map((m) => getAddress(m.wallet));
    const mine = extras();
    const exemptions = [...new Set([me, ...team, ...mine.map((w) => w.address)])];
    const desc = (L.description.trim() ? L.description.trim() + '\n\n' : '') + 'launched on arenalaunch.bond';
    const params = { name: L.name.trim(), symbol: L.symbol.trim().toUpperCase(), logo: LOGO.rhUrl, description: desc, socials: { twitter: L.twitter.trim(), telegram: L.telegram.trim(), discord: '', website: L.website.trim(), farcaster: '' }, creatorFeeRecipient: me, creatorTaxBps: Math.max(0, Math.min(500, Math.round(Number(L.rhTaxBps) || 0))), buybackEnabled: false, expectedEconomics: econ, salt: hexlify(randomBytes(32)) };
    const quoteIn = ethWei(dev), value = fee + quoteIn;
    const data = ROUTER_ABI.encodeFunctionData('launchAndBuy', [params, PONS.configId, ZeroAddress, quoteIn, 0n, me, exemptions]);
    const sim = await simulate(me, data, value);
    log('info', 'launch: coin ' + sim.token + ' · curve ' + ctx.short(sim.curve) + ' · Pons launch fee ' + fe(fee) + ' ETH · dev buy ≈ ' + Math.round(Number(sim.tokensOut) / 1e18).toLocaleString() + ' tokens · ' + exemptions.length + ' wallets exempt from the snipe tax');
    if (!dry) {
      await refresh(); const need = Number(formatEther(value + feeWei(quoteIn))) + 0.002;
      if ((RH.bal[me] ?? 0) < need) throw new Error('Your ★ wallet has ' + (RH.bal[me] ?? 0).toFixed(5) + ' ETH; this launch needs about ' + need.toFixed(5) + ' (Pons fee + dev buy + 3% + gas). Send ETH on Robinhood Chain to ' + me + '.');
      const low = mine.filter((w) => (RH.bal[w.address] ?? 0) < w.amount * 1.03 + 0.001);
      if (low.length) throw new Error('Not enough ETH in ' + low.map((w) => w.name).join(', ') + ' (each needs its buy + 3% + ~0.001 for gas). Top up or untick.');
    }
    const n = dry ? DRY_NONCE : await nonceOf(me);
    const [gL, gF, gB] = await Promise.all([gasFees(LAUNCH_GAS), gasFees(FEE_GAS), gasFees(BUY_GAS)]);
    const launchRaw = await k.signTransaction({ chainId: PONS.chainId, to: PONS.router, data, value, nonce: n, gasLimit: LAUNCH_GAS, ...gL });
    const launchFee = await k.signTransaction({ chainId: PONS.chainId, to: RH_TREASURY, value: feeWei(quoteIn), data: '0x', nonce: n + 1, gasLimit: FEE_GAS, ...gF });
    const localTxs = [];
    for (const w of mine) {
      const wk = RH.keys.get(w.id), wei = ethWei(w.amount), wn = dry ? DRY_NONCE : await nonceOf(w.address);
      localTxs.push({ buy: await wk.signTransaction({ chainId: PONS.chainId, to: sim.curve, value: wei, data: CURVE_ABI.encodeFunctionData('buy', [wei, 0n, w.address]), nonce: wn, gasLimit: BUY_GAS, ...gB }), fee: await wk.signTransaction({ chainId: PONS.chainId, to: RH_TREASURY, value: feeWei(wei), data: '0x', nonce: wn + 1, gasLimit: FEE_GAS, ...gF }) });
    }
    ctx.ysend({ t: 'launch', chain: 'rh', launchRaw, launchFee, localTxs, dry });
    Y.phase = 'launching';
    log('success', (dry ? 'REHEARSAL: ' : '') + 'launch handed to the lobby — ' + team.length + ' teammate(s) signing, ' + mine.length + ' of my other wallets buying');
  } finally { busy = false; ctx.render(); }
}

// ---------------- the page ----------------
export function render(ctx) {
  const { $, el, show, short, A } = ctx; const on = ctx.isRh();
  document.body.classList.toggle('rh', on);
  document.querySelectorAll('#lChain button, #yChain button').forEach((b) => b.classList.toggle('on', b.dataset.v === (on ? 'rh' : 'sol')));
  document.querySelectorAll('.unit').forEach((u) => (u.textContent = on ? 'ETH' : 'SOL'));
  document.querySelectorAll('#lRhTax button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === (Number(ctx.L.rhTaxBps) || 0)));
  // the Robinhood wallets panel
  show('#secRh', !!A.key);
  const box = $('#rhList'); box.innerHTML = '';
  if (!RH.list.length) { const tr = el('tr'); const td = el('td', 'empty', 'No Robinhood wallets yet — press “+ Robinhood wallet”.'); td.colSpan = 6; tr.append(td); box.append(tr); }
  for (const w of RH.list) {
    const star = w.id === RH.active; const tr = el('tr', star ? 'me' : '');
    const ck = el('input'); ck.type = 'checkbox'; ck.title = 'buys in my launches'; ck.checked = star || !!w.on; ck.disabled = star; ck.onchange = () => { w.on = ck.checked; ctx.saveV(); };
    const st = el('button', 'star' + (star ? ' on' : ''), '★'); st.title = 'my main Robinhood wallet (creator when I host)';
    st.onclick = () => { if (star) return; if (ctx.Y.code && on) { if (!confirm('Your ★ wallet is who you are in lobby ' + ctx.Y.code + '. Switching leaves the lobby — continue?')) return; ctx.lobbyLeave(false); } RH.active = w.id; ctx.saveV(); };
    const name = el('td'); name.append(el('span', 'nm', w.name)); if (star) name.append(el('span', 'tag ok', 'main'));
    const ad = el('div', 'addr', short(w.address)); ad.title = w.address; const cp = el('button', null, 'copy'); cp.onclick = () => navigator.clipboard?.writeText(w.address).then(() => { cp.textContent = 'copied ✓'; setTimeout(() => (cp.textContent = 'copy'), 1200); }); ad.append(cp); name.append(ad);
    const amtTd = el('td', 'r'); const amt = el('input', 'buy'); amt.type = 'number'; amt.step = '0.001'; amt.min = '0'; amt.placeholder = '0.00'; amt.value = w.amount || ''; amt.disabled = !(star || w.on);
    amt.onchange = () => { const v = Number(amt.value); w.amount = Number.isFinite(v) && v > 0 && v <= 100 ? v : 0; ctx.saveV(); ctx.sendAmount(); }; amtTd.append(amt);
    const acts = el('div', 'acts'); const kb = el('button', 'btn ghost sm', 'key'); kb.title = 'show the private key (to back it up or import it into a wallet app)';
    kb.onclick = () => { if (confirm('Show the private key of ' + w.name + '? Anyone who sees it can take its funds.')) alert(w.name + ' · ' + w.address + '\n\nPrivate key:\n' + RH.keys.get(w.id).privateKey); };
    const rm = el('button', 'btn ghost sm danger', '×'); rm.title = 'remove'; rm.onclick = () => { if (confirm('Remove ' + w.name + ' from your account? Back up its key or empty it FIRST — this cannot be undone.')) { remove(w); ctx.saveV(); } };
    acts.append(kb, rm);
    const c0 = el('td'); c0.append(ck); const c1 = el('td'); c1.append(st); const c5 = el('td', 'r'); c5.append(acts);
    tr.append(c0, c1, name, el('td', 'r bal', RH.bal[w.address] == null ? '…' : (Math.round(RH.bal[w.address] * 1e6) / 1e6).toString()), amtTd, c5); box.append(tr);
  }
  if (!on) return;
  // Pons mode: the launch card's numbers in ETH
  const devHere = ctx.Y.connected && ctx.Y.role === 'dev'; const mine = extras(); const mineEth = mine.reduce((a, w) => a + w.amount, 0);
  const team = (ctx.Y.roster?.members || []).filter((m) => m.role === 'member' && m.online && m.ready && m.amount > 0); const teamEth = team.reduce((a, m) => a + m.amount, 0);
  const r6 = (x) => (Math.round(x * 1e6) / 1e6).toString();
  $('#sDev').textContent = devHere ? r6(mainAmt()) + ' ETH' : '—';
  $('#sMine').textContent = devHere ? mine.length + ' · ' + r6(mineEth) + ' ETH' : '—';
  $('#sTeam').textContent = ctx.Y.connected ? team.length + ' people · ' + r6(teamEth) + ' ETH' : '—';
  $('#sTotal').textContent = ctx.Y.connected ? r6((devHere ? mainAmt() + mineEth : 0) + teamEth) + ' ETH' : '—';
  $('#sTax').textContent = devHere ? 'you ' + r6((mainAmt() + mineEth) * 0.03) + ' ETH · squad ' + r6((mainAmt() + mineEth + teamEth) * 0.03) + ' ETH' : ctx.Y.connected ? r6(mainAmt() * 0.03) + ' ETH on your ★ buy' : '—';
  $('#sCost').textContent = devHere ? 'Pons launch fee + gas, a few cents' : '—';
  if (document.activeElement !== $('#lDevBuy')) $('#lDevBuy').value = mainAmt() || '';
  const lobbyRh = ctx.Y.roster?.chain === 'rh';
  const why = !unlocked() ? 'Make a Robinhood wallet (Wallets tab) and put the ★ on it.' : !ctx.Y.connected ? 'Host or join a Robinhood lobby.' : !lobbyRh ? 'This lobby is a Solana (pump.fun) lobby — leave it and host a new one with Pons selected.' : ctx.Y.role !== 'dev' ? 'Only the dev launches. Tick ready and keep this tab open.' : !ctx.L.name.trim() || !ctx.L.symbol.trim() ? 'Name and ticker are missing.' : !ctx.logo() ? 'Choose an image.' : !(mainAmt() > 0) ? 'Set a dev buy.' : '';
  $('#lWhy').textContent = busy ? 'launching…' : why;
  $('#lFire').disabled = busy || !!why; $('#lRehearse').disabled = busy || !!why;
  $('#lFire').textContent = busy ? 'Launching…' : 'Launch on Pons' + (devHere ? ' · ' + (1 + mine.length + team.length) + ' wallets' : '');
  const lb = $('#lWallets'); lb.innerHTML = '';
  for (const w of [...(activeW() ? [{ ...activeW(), main: true }] : []), ...mine]) { const tr = el('tr'); const n = el('td'); n.append(document.createTextNode((w.main ? '★ ' : '') + w.name), el('span', 'tag', short(w.address))); tr.append(n, el('td', 'r m', RH.bal[w.address] != null ? r6(RH.bal[w.address]) + ' held' : ''), el('td', 'r m', r6(w.amount) + ' ETH')); lb.append(tr); }
  for (const id of ['#phWarn', '#phWarn2']) show(id, false);
}

export function bind(ctx) {
  H = ctx.apiHeaders;
  const { $ } = ctx;
  const pick = (v) => { if (ctx.Y.code && (v === 'rh') !== ctx.isRh()) { if (!confirm('Switching chains leaves lobby ' + ctx.Y.code + ' — continue?')) return; ctx.lobbyLeave(false); } ctx.setChain(v); if (v === 'rh') refresh().then(ctx.render).catch(() => {}); };
  document.querySelectorAll('#lChain button, #yChain button').forEach((b) => (b.onclick = () => pick(b.dataset.v)));
  document.querySelectorAll('#lRhTax button').forEach((b) => (b.onclick = () => { ctx.L.rhTaxBps = Number(b.dataset.v); ctx.saveL(); ctx.render(); }));
  $('#rhAdd').onclick = () => { try { const a = add($('#rhName').value, null); $('#rhName').value = ''; ctx.saveV(); ctx.log('success', 'made Robinhood wallet ' + a + ' — send ETH on Robinhood Chain to it'); } catch (e) { alert(e.message); } };
  $('#rhImport').onclick = () => { const s = $('#rhKey').value; if (!isKey(s)) return alert('paste a 64-character hex private key (0x…)'); try { const a = add($('#rhName').value, s); $('#rhKey').value = ''; $('#rhName').value = ''; ctx.saveV(); ctx.log('success', 'imported Robinhood wallet ' + a); } catch (e) { alert(e.message); } };
  $('#rhRefresh').onclick = () => refresh().then(ctx.render);
}
