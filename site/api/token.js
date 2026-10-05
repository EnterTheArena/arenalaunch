// GET /api/token → a token the page passes to the relay (WebSocket ?g= / x-gate header).
// Locked site: the (HttpOnly) password cookie, which middleware already verified.
// Public site (no GATE_PASSWORD): a fresh short-lived token signed with GATE_SECRET, so the relay still only talks
// to pages served from here.
import { mintToken } from './gate.js';

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const relay = process.env.RELAY_URL || 'https://relay.arenalaunch.bond';
  const cookie = (/(?:^|;\s*)sq_gate=([^;]+)/.exec(req.headers.cookie || '') || [])[1];
  if (cookie) return res.status(200).json({ token: cookie, relay });
  if (!process.env.GATE_PASSWORD && process.env.GATE_SECRET) return res.status(200).json({ token: mintToken(process.env.GATE_SECRET, 86400000), relay });
  return res.status(401).json({ error: 'gate' });
}
