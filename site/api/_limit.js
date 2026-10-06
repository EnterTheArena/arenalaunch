import { createHash } from 'crypto';
// Per-IP request limits for the API functions, counted by the relay's RateLimit Durable Object (shared RL_KEY).
// Aimed at scripts, not people: the limits are a multiple of what the page itself sends. Fails OPEN — if the relay is
// slow or down, requests go through rather than breaking a launch. (Files starting with _ are not served by Vercel.)
const RELAY = process.env.RELAY_URL || 'https://relay.arenalaunch.bond';
export const ipOf = (req) => String(req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket?.remoteAddress || 'unknown').trim().slice(0, 64);

// true when this caller is over `limit` requests per `windowMs` in `bucket` (and the 429 has been sent)
export async function limited(req, res, bucket, limit, windowMs = 60000, who = null) {
  if (!process.env.RL_KEY) return false;
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 1500);
    const r = await fetch(RELAY + '/ratelimit', { method: 'POST', headers: { 'content-type': 'application/json', 'x-rl-key': process.env.RL_KEY }, body: JSON.stringify({ ip: who ? 'acct:' + createHash('sha256').update(String(who)).digest('hex').slice(0, 40) : ipOf(req), bucket, limit, windowMs }), signal: c.signal }).finally(() => clearTimeout(t));
    const j = await r.json();
    if (j.allowed === false) { res.status(429).json({ error: 'too many requests — wait a minute and try again' }); return true; }
  } catch {}
  return false;
}
