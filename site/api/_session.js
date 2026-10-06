// Who is calling: the account session from Sign In With Solana / email sign-in (minted by the relay), sent by the page as
// the x-session header. The site's paid proxies (/api/sol on our Helius key, /api/husher on our Husher key, and /api/ipfs,
// /api/pump) answer signed-in users only, so nobody can use them from a script without an account.
// Checked here with ACCOUNT_SECRET (the relay's, shared with this deployment) when set, else by asking the relay (cached
// for a minute). Never with GATE_SECRET: sessions are not signed with it any more.
// Fails CLOSED: no valid session, no answer. (Files starting with _ are not served by Vercel.)
import { createHmac, timingSafeEqual } from 'crypto';
const RELAY = process.env.RELAY_URL || 'https://relay.arenalaunch.bond';
const cache = new Map(); // token → {id, until}

function local(token) {
  const secret = process.env.ACCOUNT_SECRET; if (!secret) return null;
  const [body, mac] = String(token).split('.'); if (!body || !mac) return null;
  const want = Buffer.from(createHmac('sha256', secret + ':account-session').update(body).digest('base64url'));
  const got = Buffer.from(mac); if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const s = Buffer.from(body, 'base64url').toString(); const i = s.lastIndexOf('|');
  const exp = Number(s.slice(i + 1)); return exp > Date.now() ? { id: s.slice(0, i), until: Math.min(exp, Date.now() + 60000) } : null;
}
async function viaRelay(token) {
  if (!process.env.RL_KEY) return null;
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 3000);
    const r = await fetch(RELAY + '/session/check', { method: 'POST', headers: { 'content-type': 'application/json', 'x-rl-key': process.env.RL_KEY }, body: JSON.stringify({ session: token }), signal: c.signal }).finally(() => clearTimeout(t));
    const j = await r.json(); return j.id ? { id: j.id, until: Date.now() + 60000 } : null;
  } catch { return null; }
}
// the account id ('w:<wallet>' / 'e:<email>'), or null after sending the 401
export async function signedIn(req, res) {
  const token = String(req.headers['x-session'] || '').slice(0, 512);
  if (token) {
    const hit = cache.get(token); if (hit && hit.until > Date.now()) return hit.id;
    const v = local(token) || (await viaRelay(token));
    if (v) { if (cache.size > 5000) cache.clear(); cache.set(token, v); return v.id; }
  }
  res.status(401).json({ error: 'sign in first' }); return null;
}
