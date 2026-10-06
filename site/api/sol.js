import { limited } from './_limit.js';
import { signedIn } from './_session.js';
// POST /api/sol — Solana JSON-RPC pass-through (public RPCs block/CORS-limit browser calls; some blockers kill them).
// Body: {method, params}. Signed-in users only (x-session), and only the methods the page uses. Rotates RPCs on failure.
const RPCS = [process.env.SOL_RPC_URL, 'https://api.mainnet-beta.solana.com', 'https://public.rpc.solanavibestation.com', 'https://solana-mainnet.g.alchemy.com/v2/demo'].filter(Boolean);
const ALLOW = new Set(['getLatestBlockhash', 'getMultipleAccounts', 'getSignatureStatuses', 'sendTransaction', 'simulateTransaction', 'getSlot']);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const who = await signedIn(req, res); if (!who) return;
  // the page polls balances every 20 s and a launch makes a few dozen calls; these are several times that
  if (await limited(req, res, 'sol', 300)) return;
  if (await limited(req, res, 'sol-acct', 240, 60000, who)) return;
  const { method, params } = req.body || {};
  if (!ALLOW.has(method)) return res.status(400).json({ error: 'method not allowed' });
  if (!Array.isArray(params) || JSON.stringify(params).length > 20000) return res.status(400).json({ error: 'params' });
  if ((method === 'getMultipleAccounts' && !(Array.isArray(params[0]) && params[0].length <= 100)) || (method === 'getSignatureStatuses' && !(Array.isArray(params[0]) && params[0].length <= 50))) return res.status(400).json({ error: 'params' });
  let last = 'no rpc';
  for (const url of RPCS) {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ctrl.signal }).finally(() => clearTimeout(t));
      const j = await r.json();
      if (j.error && /429|rate|limit/i.test(JSON.stringify(j.error))) { last = j.error.message; continue; }
      return res.status(200).json(j);
    } catch (e) { last = e.message; }
  }
  return res.status(502).json({ error: 'rpc unreachable: ' + last });
}
