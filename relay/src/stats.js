// ============================================================================
// arenalaunch STATS — one Durable Object counting usage per UTC day. No IPs, no wallets in the counters:
// visitors are a random id the page keeps in localStorage. Launch rows keep the mint (it is public on chain).
//
//   record(env, type, extra)       — from the worker / other DOs: visit | signin | lobby | join | rehearsal | launch
//   GET /stats/summary            — the dashboard (signed-in session of the ADMIN_WALLET only)
// ============================================================================
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const FIELDS = ['visits', 'uniques', 'signins', 'newAccounts', 'lobbies', 'joins', 'rehearsals', 'launches', 'landed', 'buyers', 'errors'];

export async function record(env, type, extra = {}) {
  try { await env.STATS.get(env.STATS.idFromName('all')).fetch('https://stats/hit', { method: 'POST', body: JSON.stringify({ type, ...extra }) }); } catch {}
}

export class Stats {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; if (env.SOL_RPC_URL && !RPCS.includes(env.SOL_RPC_URL)) RPCS.unshift(env.SOL_RPC_URL); } // paid RPC first
  async fetch(req) {
    const S = this.ctx.storage; const op = new URL(req.url).pathname.slice(1);
    if (op === 'hit') {
      const b = await req.json().catch(() => ({})); const d = day(); const key = 'day:' + d;
      const c = (await S.get(key)) || {}; const tot = (await S.get('tot')) || {};
      const inc = (f, n = 1) => { c[f] = (c[f] || 0) + n; tot[f] = (tot[f] || 0) + n; };
      switch (b.type) {
        case 'visit': {
          const v = String(b.v || '').slice(0, 40); if (!/^[a-z0-9]{8,40}$/.test(v)) return new Response('bad', { status: 400 });
          inc('visits');
          if (!(await S.get('uv:' + d + ':' + v))) { await S.put('uv:' + d + ':' + v, 1); c.uniques = (c.uniques || 0) + 1; }
          if (!(await S.get('v:' + v))) { await S.put('v:' + v, Date.now()); tot.uniques = (tot.uniques || 0) + 1; }
          break;
        }
        case 'signin': inc('signins'); if (b.isNew) inc('newAccounts'); break;
        case 'lobby': inc('lobbies'); break;
        case 'join': inc('joins'); break;
        case 'rehearsal': inc('rehearsals'); break;
        case 'error': {
          // the owner's problems list: what went wrong, where, for which wallet / lobby. The same message from the same
          // lobby (every member's page reports a relay error it was shown) within 2 minutes is counted, not repeated.
          const e = { src: b.src === 'relay' ? 'relay' : 'site', level: b.level === 'warn' ? 'warn' : 'error', where: String(b.where || '').slice(0, 40), msg: String(b.msg || '').slice(0, 400), wallet: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(b.wallet || '') ? b.wallet : null, lobby: /^[A-Z2-9]{6}$/.test(b.lobby || '') ? b.lobby : null, ua: String(b.ua || '').slice(0, 60) || null, role: ['dev', 'member'].includes(b.role) ? b.role : null, account: typeof b.account === 'string' ? b.account.replace(/^e:(.).*@/, 'e:$1…@').slice(0, 60) : null };
          if (!e.msg) return new Response('bad', { status: 400 });
          const list = (await S.get('errors')) || []; const now = Date.now();
          const same = list.find((x) => x.msg === e.msg && x.lobby === e.lobby && now - x.last < 120000);
          if (same) { same.n++; same.last = now; if (!same.wallet && e.wallet) same.wallet = e.wallet; }
          else { list.unshift({ t: now, last: now, n: 1, ...e }); inc('errors'); }
          await S.put('errors', list.slice(0, 300));
          break;
        }
        case 'launch': {
          inc('launches'); if (b.landed) inc('landed'); inc('buyers', Math.max(0, Number(b.buyers) || 0));
          const recent = (await S.get('recent')) || [];
          recent.unshift({ t: Date.now(), mint: b.mint || null, landed: !!b.landed, buyers: Number(b.buyers) || 0, members: Number(b.members) || 0, slot: b.slot || null });
          await S.put('recent', recent.slice(0, 50));
          // the public showcase keeps every landed coin (mint + time only)
          if (b.landed && b.mint) { const shown = await landedList(S); if (!shown.some((x) => x.mint === b.mint)) { shown.unshift({ t: Date.now(), mint: String(b.mint) }); await S.put('landed', shown.slice(0, 500)); } }
          break;
        }
        default: return new Response('bad', { status: 400 });
      }
      await S.put(key, c); await S.put('tot', tot);
      return new Response('ok');
    }
    if (op === 'summary') {
      const tot = (await S.get('tot')) || {}; const days = [];
      for (let i = 29; i >= 0; i--) { const d = day(Date.now() - i * 86400000); const c = (await S.get('day:' + d)) || {}; const row = { day: d }; for (const f of FIELDS) row[f] = c[f] || 0; days.push(row); }
      const since = ((await S.list({ prefix: 'day:', limit: 1 })).keys().next().value || '').slice(4) || null;
      return Response.json({ totals: tot, days, recent: (await S.get('recent')) || [], errors: (await S.get('errors')) || [], countingSince: since });
    }
    if (op === 'public') {
      // landed launches with what anyone can read on chain: name, ticker, image. Metadata is fetched once per coin and kept.
      // left out: coins the owner hid, and names with slurs (they still count in the stats)
      const hidden = new Set((await S.get('hidden')) || []);
      const list = (await landedList(S)).filter((x) => !hidden.has(x.mint)).slice(0, 60); let fetched = 0; const out = [];
      for (const x of list) {
        let m = await S.get('meta2:' + x.mint);
        if ((!m || (!m.image && Date.now() - (m.at || 0) > 3600000)) && fetched < 8) { fetched++; const f = await coinMeta(x.mint); if (f) { m = { ...f, at: Date.now() }; await S.put('meta2:' + x.mint, m); } } // no image yet (slow IPFS): try again in an hour
        out.push({ mint: x.mint, t: x.t, name: starred(m?.name), symbol: starred(m?.symbol), image: m?.image || null });
      }
      return Response.json({ launches: out });
    }
    if (op === 'errclear') { await S.put('errors', []); return Response.json({ ok: true }); } // owner: problems list handled
    if (op === 'hide') { // owner: take a coin off (or back onto) the public list — {mint, hide}
      const b = await req.json().catch(() => ({})); const mint = String(b.mint || ''); if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return new Response('bad', { status: 400 });
      const h = new Set((await S.get('hidden')) || []); if (b.hide === false) h.delete(mint); else h.add(mint); await S.put('hidden', [...h]);
      return Response.json({ hidden: [...h] });
    }
    return new Response('not found', { status: 404 });
  }
}

// every landed launch, newest first ({t, mint}); started from the dashboard's recent list the first time it is read
async function landedList(S) {
  let l = await S.get('landed');
  if (!l) { l = ((await S.get('recent')) || []).filter((x) => x.landed && x.mint).map((x) => ({ t: x.t, mint: x.mint })); await S.put('landed', l); }
  return l;
}
const RPCS = ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com', 'https://public.rpc.solanavibestation.com'];
const fetchT = (url, init, ms) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); return fetch(url, { ...init, signal: c.signal }).finally(() => clearTimeout(t)); };
// IPFS links go through pump.fun's own gateway (ipfs.io now answers gateway requests with 429)
const IPFS = 'https://pump.mypinata.cloud/ipfs/';
const httpsUrl = (u) => {
  u = String(u || '').trim(); if (u.startsWith('ipfs://')) u = IPFS + u.slice(7).replace(/^ipfs\//, '');
  try { const x = new URL(u); if (x.protocol !== 'https:') return null; const cid = /^\/ipfs\/([A-Za-z0-9]{20,100}(?:\/[^?#]*)?)/.exec(x.pathname); return (cid ? IPFS + cid[1] : x.toString()).slice(0, 300); } catch { return null; }
};
// slurs never go on the public page (letters only, common look-alike digits folded)
const SLURS = /n[i!]gg|n[i]gg?[ae]r|f[a]gg?[o]?t|k[i]ke|ch[i]nk|sp[i]c(k|s|$)|wetback|tr[a]nn(y|ie)|beaner|g[o]{2}k|sandn[i]g/;
// a name with a slur is shown with that word starred: "REAL N***** DAO" (first letter kept); if the slur hides across
// words, everything after the first letter is starred
export const starred = (s) => {
  if (s == null) return null; s = String(s);
  const star = (w) => w.slice(0, 1) + w.slice(1).replace(/[^\s]/g, '*');
  const out = s.split(/(\s+)/).map((w) => (offensive(w) ? star(w) : w)).join('');
  return offensive(out) ? star(out) : out;
};
export const offensive = (s) => SLURS.test(String(s || '').toLowerCase().replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/[4@]/g, 'a').replace(/0/g, 'o').replace(/[5$]/g, 's').replace(/[^a-z]/g, ''));
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n) || null;
// a pump.fun coin is a Token-2022 mint with the metadata extension (name, symbol, uri); the uri's JSON holds the image
async function coinMeta(mint) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return null;
  let md = null;
  for (const url of RPCS) {
    try { const r = await fetchT(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [mint, { encoding: 'jsonParsed' }] }) }, 5000); const j = await r.json(); if (j.error) continue; md = (j.result?.value?.data?.parsed?.info?.extensions || []).find((e) => e.extension === 'tokenMetadata')?.state || null; break; } catch {}
  }
  if (!md) return null;
  let image = null; const uri = httpsUrl(md.uri);
  if (uri) { try { const r = await fetchT(uri, {}, 6000); if (r.ok) image = httpsUrl((await r.json()).image); } catch {} }
  return { name: clean(md.name, 32), symbol: clean(md.symbol, 13), image };
}
