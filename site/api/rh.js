import { limited } from './_limit.js';
import { signedIn } from './_session.js';
// POST /api/rh — Robinhood Chain JSON-RPC pass-through for Pons launches. Body: {method, params}. Signed-in users only
// (x-session), only the methods the page uses, and eth_call only against Pons (with a balance override, which is how the
// page learns a launch's coin and curve addresses before the wallet is funded). RH_RPC_URL (optional) goes first.
const RPCS = [process.env.RH_RPC_URL, 'https://rpc.mainnet.chain.robinhood.com'].filter(Boolean);
const PONS = new Set(['0xe33e9e479df8802cb0866d5d05258bec4cf62948', '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e']); // router, factory
const ALLOW = new Set(['eth_chainId', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_getBalance', 'eth_getTransactionCount', 'eth_call', 'eth_getTransactionReceipt', 'eth_sendRawTransaction']);
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const who = await signedIn(req, res); if (!who) return;
  if (await limited(req, res, 'rh', 300)) return;
  if (await limited(req, res, 'rh-acct', 240, 60000, who)) return;
  const { method, params } = req.body || {};
  if (!ALLOW.has(method)) return res.status(400).json({ error: 'method not allowed' });
  if (!Array.isArray(params) || JSON.stringify(params).length > 20000) return res.status(400).json({ error: 'params' });
  if (method === 'eth_getBalance' || method === 'eth_getTransactionCount') { if (!isAddr(params[0])) return res.status(400).json({ error: 'params' }); }
  if (method === 'eth_call') {
    const [call, , override] = params;
    if (!call || !PONS.has(String(call.to || '').toLowerCase())) return res.status(400).json({ error: 'eth_call is for Pons only' });
    if (override != null && (typeof override !== 'object' || Object.values(override).some((o) => !o || Object.keys(o).some((k) => k !== 'balance')))) return res.status(400).json({ error: 'only a balance override is allowed' });
  }
  let last = 'no rpc';
  for (const url of RPCS) {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ctrl.signal }).finally(() => clearTimeout(t));
      return res.status(200).json(await r.json());
    } catch (e) { last = e.message; }
  }
  return res.status(502).json({ error: 'rpc unreachable: ' + last });
}
