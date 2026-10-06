import { limited, ipOf } from './_limit.js';
import { signedIn } from './_session.js';
import { TREASURY, husherFeeOk } from '../src/fees.js';

// POST /api/husher — Husher private-transfer proxy (the API key never reaches the browser).
// Body: { action: 'estimate'|'create'|'status', ... }
// Our key may only call /api/v1/exchange/{currencies, validate-address, private/create, private/order/:id};
// there is no rate route, so 'estimate' returns Husher's minimum and the real fees come back with the order.
const API = 'https://api.husher.net/api/v1/exchange';
const KEY = () => process.env.HUSHER_KEY || '';
const hdr = () => ({ 'content-type': 'application/json', 'x-api-key': KEY() });
const SOL = { send: 'SOL', sendNetwork: 'SOL', receive: 'SOL', receiveNetwork: 'SOL' };
// Husher order status → the Send panel's steps
const STATUS = { pending: 'waiting', confirmed: 'confirming', exchanging: 'exchanging', withdraw: 'sending', completed: 'finished', refund: 'refunded', expired: 'expired', failed: 'failed' };
let minCache = { at: 0, min: null };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const who = await signedIn(req, res); if (!who) return; // signed-in users only: our Husher key is not a public mixer
  if (await limited(req, res, 'husher', 60)) return; // 60 req/min per IP
  if (await limited(req, res, 'husher-acct', 40, 60000, who)) return;
  if (req.body?.action === 'create' && await limited(req, res, 'husher-create', 10, 3600000, who)) return; // orders: 10 an hour per account
  if (!KEY()) return res.status(500).json({ error: 'husher not configured' });

  const { action } = req.body || {};
  // Husher's create wants the visitor's ip + client info (it answers "Please reload and try again" without them)
  const ip = ipOf(req);
  const client = { ipAddress: ip, clientMeta: { timezone: 'UTC', language: String(req.headers['accept-language'] || '').split(',')[0], userAgent: String(req.headers['user-agent'] || ''), ip } };

  try {
    if (action === 'estimate') {
      return res.status(200).json({ min: await minAmount(client) });
    }

    if (action === 'create') {
      const { amount, address, feeSig } = req.body;
      if (!(Number(amount) > 0)) return res.status(400).json({ error: 'amount required' });
      if (!address || address.length < 32) return res.status(400).json({ error: 'destination address required' });
      // the arenalaunch fee is paid FIRST, on chain, and checked here: a confirmed transfer of at least 2% to the treasury,
      // recent, and never used for another order (the relay keeps the used signatures)
      const fee = await feePaid(String(feeSig || ''), Math.round(Number(amount) * 1e9));
      if (fee.error) return res.status(fee.status || 402).json({ error: fee.error, retry: !!fee.retry });
      const claim = await claimFee('claim', feeSig, who); if (!claim.ok) return res.status(409).json({ error: claim.error || 'that fee payment cannot be used' });
      let id;
      try {
        id = await hfetch(`${API}/private/create`, { method: 'POST', body: JSON.stringify({ ...SOL, ...client, receiveAddress: address, amount: Number(amount) }) });
        if (typeof id !== 'string') throw new Error('Husher returned no order id');
      } catch (e) { await claimFee('release', feeSig, who); throw e; } // no order: the same payment can be used to try again
      await claimFee('done', feeSig, who, id);
      return res.status(200).json(order(await hfetch(`${API}/private/order/${encodeURIComponent(id)}`)));
    }

    if (action === 'status') {
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'order id required' });
      return res.status(200).json(order(await hfetch(`${API}/private/order/${encodeURIComponent(id)}`)));
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    return res.status(502).json({ error: e.message || 'Husher unreachable' });
  }
}

// the shape the Send panel reads
function order(o) {
  return {
    id: o.orderId, payinAddress: o.sendAddress, sendAmount: Number(o.sendAmount),
    toAmount: Number(o.receiveAmount), amountTo: Number(o.receiveAmount),
    fee: Number(o.feeAmount || 0) + Number(o.networkFee || 0),
    status: STATUS[o.status] || o.status, trackUrl: o.trackPageUrl || null, hashOutUrl: o.hashOutUrl || null
  };
}

// Husher answers a below-minimum create with "Minimum amount X SOL" before it looks at anything else; the address
// here is invalid on purpose so a probe can never become a real order.
async function minAmount(client) {
  if (Date.now() - minCache.at < 60000) return minCache.min;
  let min = null;
  try { await hfetch(`${API}/private/create`, { method: 'POST', body: JSON.stringify({ ...SOL, ...client, receiveAddress: 'x', amount: 1e-9 }) }); }
  catch (e) { const m = /minimum amount\s+([\d.]+)/i.exec(e.message); if (m) min = Number(m[1]); }
  minCache = { at: min == null ? 0 : Date.now(), min };
  return min;
}

// ---- the fee check ----
const RELAY = process.env.RELAY_URL || 'https://relay.arenalaunch.bond';
const RPCS = () => [process.env.SOL_RPC_URL, 'https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'].filter(Boolean);
const FEE_MAX_AGE_S = 30 * 60;
async function getTx(sig) {
  for (const url of RPCS()) {
    try {
      const c = new AbortController(); const t = setTimeout(() => c.abort(), 8000);
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: c.signal, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [sig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }] }) }).finally(() => clearTimeout(t));
      const j = await r.json(); if (j.error) continue; return { tx: j.result };
    } catch {}
  }
  return { down: true };
}
// {lamports, payer} or {error, status, retry}
export async function feePaid(sig, orderLamports, get = getTx) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) return { error: 'pay the arenalaunch fee first (this page is out of date — reload it)', status: 402 };
  const { tx, down } = await get(sig);
  if (down) return { error: 'could not check the fee payment right now — try again in a moment', status: 503, retry: true };
  if (!tx) return { error: 'fee payment not confirmed yet — trying again', status: 402, retry: true };
  if (tx.meta?.err) return { error: 'the fee payment failed on chain', status: 402 };
  if (tx.blockTime && Date.now() / 1000 - tx.blockTime > FEE_MAX_AGE_S) return { error: 'that fee payment is too old — pay the fee again', status: 402 };
  let lamports = 0, payer = null;
  for (const ix of tx.transaction?.message?.instructions || []) {
    if (ix.program !== 'system' || ix.parsed?.type !== 'transfer' || ix.parsed.info?.destination !== TREASURY) continue;
    lamports += Number(ix.parsed.info.lamports) || 0; payer = payer || ix.parsed.info.source;
  }
  if (!husherFeeOk(orderLamports, lamports)) return { error: 'the fee paid does not cover this amount — pay the fee for this amount', status: 402 };
  return { lamports, payer };
}
async function claimFee(op, sig, who, order) {
  if (!process.env.RL_KEY) return { ok: false, error: 'private transfers are not configured' }; // fail closed: never sell an order twice
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 5000);
    const r = await fetch(RELAY + '/fee/claim', { method: 'POST', headers: { 'content-type': 'application/json', 'x-rl-key': process.env.RL_KEY }, signal: c.signal, body: JSON.stringify({ op, sig, who, order }) }).finally(() => clearTimeout(t));
    return await r.json();
  } catch { return { ok: false, error: 'could not reserve the fee payment — try again' }; }
}

async function hfetch(url, opts = {}) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 15000);
  try {
    const r = await fetch(url, { headers: hdr(), signal: c.signal, ...opts });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw new Error(j.message || j.error || 'Husher ' + r.status);
    return j.data;
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Husher timed out' : e.message);
  } finally { clearTimeout(t); }
}
