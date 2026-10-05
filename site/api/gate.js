// POST /api/gate {password} → sets the signed sq_gate cookie (7 days).
// Constant-time compare, per-IP attempt limit enforced by the relay's RateLimit DO.
import { createHmac, timingSafeEqual } from 'crypto';

const RELAY = process.env.RELAY_URL || 'https://relay.arenalaunch.bond';
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function mintToken(secret, ttlMs = 7 * 86400000) {
  const exp = String(Date.now() + ttlMs);
  return b64u(exp) + '.' + b64u(createHmac('sha256', secret).update(exp).digest());
}
async function limit(ip, ok) {
  if (!process.env.RL_KEY) return { allowed: true };
  try { const r = await fetch(RELAY + '/ratelimit', { method: 'POST', headers: { 'content-type': 'application/json', 'x-rl-key': process.env.RL_KEY }, body: JSON.stringify({ ip, ok }) }); return await r.json(); } catch { return { allowed: true }; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const secret = process.env.GATE_SECRET, want = process.env.GATE_PASSWORD;
  if (!secret || !want) return res.status(500).json({ error: 'gate not configured' });
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  const pre = await limit(ip, false);
  if (!pre.allowed) return res.status(429).json({ error: 'too many attempts — try again in ' + Math.ceil((pre.retryMs || 900000) / 60000) + ' min' });
  const got = String((req.body && req.body.password) || '');
  const a = Buffer.from(got), b = Buffer.from(want);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (!ok) { await new Promise((r) => setTimeout(r, 400)); return res.status(401).json({ error: 'wrong password', remaining: pre.remaining }); }
  await limit(ip, true);
  const token = mintToken(secret);
  res.setHeader('Set-Cookie', 'sq_gate=' + token + '; Path=/; Max-Age=' + 7 * 86400 + '; HttpOnly; Secure; SameSite=Strict');
  return res.status(200).json({ ok: true, token }); // token also returned for non-browser clients (the exe)
}
