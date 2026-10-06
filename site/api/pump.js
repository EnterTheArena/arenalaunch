import { limited } from './_limit.js';
import { signedIn } from './_session.js';
// POST /api/pump — pump.fun proxy (their API blocks cross-origin browser calls).
//   {action:'login', address, signature, timestamp} → {jwt, expiresAt, profile}   (signature = base58 ed25519 over "Sign in to pump.fun: <timestamp>")
//   {action:'callout', jwt, mint, thesis}          → {ok, status, body, retryable}
//   {action:'profile', address}                    → {username, pfp, followers}
// The JWT lives in the caller's browser only; this function never stores it. Gate enforced by middleware.
const PUMP = 'https://frontend-api-v3.pump.fun';
const H = { 'Origin': 'https://pump.fun', 'Referer': 'https://pump.fun/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 'Accept': 'application/json', 'Content-Type': 'application/json' };
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const retryable = (status, text) => status >= 500 || /PRICE_UNAVAILABLE|INSUFFICIENT_BALANCE|codex|not (yet )?(set ?up|supported|found|indexed|available)|isn.?t set ?up|no (pair|pool|market)/i.test(text);

async function profile(address) { try { const r = await fetch(PUMP + '/users/' + address, { headers: H }); if (!r.ok) return null; const p = await r.json(); return { username: p.username || null, pfp: p.profile_image || null, followers: p.followers ?? null }; } catch { return null; } }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const who = await signedIn(req, res); if (!who) return;
  if (await limited(req, res, 'pump', 120)) return; // a callout retries every 4 s while pump.fun indexes the coin
  const b = req.body || {};
  try {
    if (b.action === 'login') {
      if (!B58.test(b.address || '') || !b.signature || !b.timestamp) return res.status(400).json({ error: 'address, signature, timestamp' });
      const r = await fetch(PUMP + '/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ address: b.address, signature: String(b.signature), timestamp: Number(b.timestamp) }) });
      const text = await r.text(); let j = {}; try { j = JSON.parse(text); } catch {}
      const jwt = j.access_token || j.token || (r.headers.getSetCookie?.() || []).map((c) => /auth_token=([^;]+)/.exec(c)?.[1]).find(Boolean);
      if (!r.ok || !jwt) return res.status(401).json({ error: 'pump.fun rejected the sign-in: ' + text.slice(0, 160) });
      let exp = Date.now() + 30 * 86400000; try { exp = (JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).exp || 0) * 1000 || exp; } catch {}
      return res.status(200).json({ jwt, expiresAt: exp, profile: await profile(b.address) });
    }
    if (b.action === 'profile') { if (!B58.test(b.address || '')) return res.status(400).json({ error: 'address' }); return res.status(200).json(await profile(b.address) || {}); }
    if (b.action === 'callout') {
      const mint = String(b.mint || '').trim(); const thesis = String(b.thesis || '').slice(0, 2000);
      if (!B58.test(mint) && !/^0x[0-9a-fA-F]{40}$/.test(mint)) return res.status(400).json({ error: 'mint' });
      if (!b.jwt || !thesis) return res.status(400).json({ error: 'jwt, thesis' });
      const r = await fetch(PUMP + '/callout/create', { method: 'POST', headers: { ...H, 'Authorization': 'Bearer ' + b.jwt, 'Cookie': 'auth_token=' + b.jwt }, body: JSON.stringify({ coinMint: mint.startsWith('0x') ? mint.toLowerCase() : mint, thesis }) });
      const text = await r.text();
      return res.status(200).json({ ok: r.ok, status: r.status, body: text.slice(0, 300), retryable: !r.ok && retryable(r.status, text), expired: r.status === 401 && !/INSUFFICIENT/.test(text) });
    }
    return res.status(400).json({ error: 'action' });
  } catch (e) { return res.status(502).json({ error: 'pump.fun unreachable: ' + e.message }); }
}
