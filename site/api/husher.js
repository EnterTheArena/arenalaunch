import { limited, ipOf } from './_limit.js';
import { signedIn } from './_session.js';

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
      const { amount, address } = req.body;
      if (!(Number(amount) > 0)) return res.status(400).json({ error: 'amount required' });
      if (!address || address.length < 32) return res.status(400).json({ error: 'destination address required' });
      const id = await hfetch(`${API}/private/create`, {
        method: 'POST', body: JSON.stringify({ ...SOL, ...client, receiveAddress: address, amount: Number(amount) })
      });
      if (typeof id !== 'string') throw new Error('Husher returned no order id');
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
