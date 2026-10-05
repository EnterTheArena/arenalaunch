// Vercel Edge Middleware — the password gate. Runs BEFORE every request (pages,
// assets, api). No valid signed cookie → the gate page, nothing else is served.
// Token = base64url(exp) + '.' + base64url(HMAC-SHA256(GATE_SECRET, exp)).
export const config = { matcher: ['/((?!api/gate|gate\\.html|gate\\.js|favicon\\.svg).*)'] }; // the gate page, its script and the favicon are the only ungated assets

const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function valid(token, secret) {
  if (!secret) return false;
  const [expB, sigB] = String(token || '').split('.'); if (!expB || !sigB) return false;
  let exp; try { exp = Number(atob(expB.replace(/-/g, '+').replace(/_/g, '/'))); } catch { return false; }
  if (!(exp > Date.now())) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const want = b64u(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(exp)))));
  if (want.length !== sigB.length) return false;
  let d = 0; for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ sigB.charCodeAt(i);
  return d === 0;
}

export default async function middleware(req) {
  // public mode: no GATE_PASSWORD set on Vercel → everything is served (re-lock = set GATE_PASSWORD + redeploy)
  if (!process.env.GATE_PASSWORD) return;
  const cookie = req.headers.get('cookie') || '';
  const token = (/(?:^|;\s*)sq_gate=([^;]+)/.exec(cookie) || [])[1];
  if (await valid(token, process.env.GATE_SECRET)) return; // pass through
  const u = new URL(req.url);
  if (u.pathname.startsWith('/api/')) return new Response(JSON.stringify({ error: 'gate' }), { status: 401, headers: { 'content-type': 'application/json' } });
  // serve the gate page in place of whatever was asked for (URL unchanged)
  return new Response(null, { status: 200, headers: { 'x-middleware-rewrite': new URL('/gate.html', req.url).toString() } });
}
