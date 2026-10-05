// Local dev server: public/ + the /api functions, gate skipped (a valid gate cookie is minted from .secrets.json so the
// page can open lobbies on the live relay, which allows localhost origins).
//   node site/tools/dev.mjs   → http://localhost:5182
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { extname, join } from 'path';
import { fileURLToPath } from 'url';
import { mintToken } from '../api/gate.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const secrets = JSON.parse(readFileSync(join(root, '.secrets.json'), 'utf8'));
const PORT = Number(process.env.PORT || 5182);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp' };
// the same security headers Vercel sends (vercel.json), so a CSP problem shows up here first
const HEADERS = Object.fromEntries(JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8')).headers[0].headers.map((h) => [h.key, h.value]));
// RELAY_URL=http://127.0.0.1:8788 (a local `wrangler dev`): let the page talk to it
if (/^http:\/\/(127\.0\.0\.1|localhost)/.test(process.env.RELAY_URL || '')) HEADERS['Content-Security-Policy'] = HEADERS['Content-Security-Policy'].replace("connect-src 'self'", "connect-src 'self' " + process.env.RELAY_URL + ' ' + process.env.RELAY_URL.replace(/^http/, 'ws'));
const cookie = 'sq_gate=' + mintToken(secrets.GATE_SECRET) + '; Path=/; SameSite=Lax';

createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) {
    const file = join(root, 'api', u.pathname.slice(5).replace(/[^a-z]/g, '') + '.js');
    if (!existsSync(file)) { res.writeHead(404); return res.end('{}'); }
    let raw = ''; for await (const c of req) raw += c;
    req.body = raw ? JSON.parse(raw) : {}; req.query = Object.fromEntries(u.searchParams);
    if (!/(?:^|;\s*)sq_gate=/.test(req.headers.cookie || '')) req.headers.cookie = cookie.split(';')[0];
    const out = { code: 200, h: { 'content-type': 'application/json' } };
    const r = { status(c) { out.code = c; return r; }, setHeader(k, v) { out.h[k] = v; }, json(o) { res.writeHead(out.code, out.h); res.end(JSON.stringify(o)); } };
    try { const mod = await import('file:///' + file.replace(/\\/g, '/')); await mod.default(req, r); } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }
  const p = join(root, 'public', u.pathname === '/' ? 'index.html' : u.pathname);
  if (!p.startsWith(join(root, 'public')) || !existsSync(p)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { ...HEADERS, 'content-type': TYPES[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store', 'set-cookie': cookie });
  res.end(readFileSync(p));
}).listen(PORT, () => console.log('arenalaunch dev on http://localhost:' + PORT));
