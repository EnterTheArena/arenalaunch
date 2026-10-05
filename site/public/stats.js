// owner usage dashboard — kept out of the HTML so the Content-Security-Policy can forbid inline scripts
const $ = (s) => document.querySelector(s);
const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
const fmt = (n) => (n || 0).toLocaleString('en-US');
try { const th = localStorage.getItem('stats_theme'); if (th) document.documentElement.dataset.theme = th; } catch {}
$('#theme').onclick = () => { const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; const t = dark ? 'light' : 'dark'; document.documentElement.dataset.theme = t; try { localStorage.setItem('stats_theme', t); } catch {} if (DATA) draw(DATA); };

// Only the admin wallet gets in: Sign In With Solana through Phantom (domain + a one-time relay nonce, the same sign-in as
// the site), and the relay answers the dashboard only to a session of the ADMIN_WALLET. The session lives in this tab.
try { localStorage.removeItem('stats_key'); } catch {} // the old dashboard key is gone
let RELAY = null, GATE = null, SESSION = null, DATA = null; try { SESSION = sessionStorage.getItem('stats_session'); } catch {}
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (u8) => { let n = 0n; for (const b of u8) n = n * 256n + BigInt(b); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const b of u8) { if (b) break; s = '1' + s; } return s; };
async function relay() { if (!RELAY) { const j = await (await fetch('/api/token')).json(); RELAY = j.relay; GATE = j.token; } return RELAY; }
async function signIn() {
  const p = window.phantom?.solana || (window.solana?.isPhantom ? window.solana : null); if (!p) throw new Error('Phantom was not found in this browser');
  await relay();
  const acct = async (op, body) => { const r = await fetch(RELAY + '/account/' + op, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gate': GATE }, body: JSON.stringify(body) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'sign-in failed (' + r.status + ')'); return j; };
  const { nonce } = await acct('nonce', {});
  const input = { domain: location.host, statement: 'Sign in to the arenalaunch dashboard. This does not move funds.', uri: location.origin, version: '1', chainId: 'mainnet', nonce, issuedAt: new Date().toISOString() };
  let addr, message, sig;
  if (typeof p.signIn === 'function') { const o = await p.signIn(input); const a = o.account?.address ?? o.address ?? p.publicKey; addr = typeof a === 'string' ? a : a?.toBase58?.(); message = o.signedMessage; sig = o.signature; }
  else { await p.connect(); addr = p.publicKey?.toBase58?.(); message = new TextEncoder().encode([input.domain + ' wants you to sign in with your Solana account:', addr, '', input.statement, '', 'URI: ' + input.uri, 'Version: ' + input.version, 'Chain ID: ' + input.chainId, 'Nonce: ' + input.nonce, 'Issued At: ' + input.issuedAt].join('\n')); sig = (await p.signMessage(message, 'utf8')).signature; }
  const r = await acct('wallet', { address: addr, message: b58(message), sig: b58(sig) });
  SESSION = r.session; try { sessionStorage.setItem('stats_session', SESSION); } catch {}
}
async function load() {
  await relay(); if (!SESSION) throw new Error('');
  const r = await fetch(RELAY + '/stats/summary', { headers: { 'x-session': SESSION } });
  if (r.status === 403 || r.status === 401) { SESSION = null; try { sessionStorage.removeItem('stats_session'); } catch {} throw new Error('That wallet is not the admin wallet.'); }
  DATA = await r.json(); $('#keyBox').style.display = 'none'; $('#dash').style.display = ''; draw(DATA);
}
function start() { load().catch((e) => { $('#dash').style.display = 'none'; $('#keyBox').style.display = ''; $('#keyErr').textContent = e.message; }); }
$('#keyGo').onclick = async () => { $('#keyGo').disabled = true; $('#keyErr').textContent = ''; try { await signIn(); start(); } catch (e) { $('#keyErr').textContent = e.message; } finally { $('#keyGo').disabled = false; } };
$('#probClear').onclick = async () => { if (!confirm('Clear the problems list? Do this once you have dealt with them.')) return; await fetch(RELAY + '/stats/errors/clear', { method: 'POST', headers: { 'x-session': SESSION || '' } }); load().catch(() => {}); };
$('#signOut').onclick = () => { SESSION = null; DATA = null; try { sessionStorage.removeItem('stats_session'); } catch {} start(); };
start(); setInterval(() => { if (SESSION && DATA) load().catch(() => {}); }, 30000);

function draw(d) {
  const today = d.days[d.days.length - 1]; const t = d.totals || {}; const acc = d.accounts || { total: 0, byDay: {} };
  // new accounts per day come from the accounts themselves (they carry a created date), so they reach back before counting began
  for (const row of d.days) row.accounts = acc.byDay?.[row.day] || 0;
  const tiles = [
    ['Visitors', fmt(t.uniques), fmt(today.uniques) + ' today · ' + fmt(t.visits) + ' page loads'],
    ['Accounts', fmt(acc.total), fmt(today.accounts) + ' new today · ' + fmt(acc.withWallets) + ' saved wallets'],
    ['Lobbies opened', fmt(t.lobbies), fmt(today.lobbies) + ' today · ' + fmt(t.joins) + ' teammates joined'],
    ['Launches', fmt(t.launches), fmt(t.landed) + ' landed · ' + fmt(t.rehearsals) + ' rehearsals'],
    ['Sign-ins', fmt(t.signins), fmt(today.signins) + ' today'],
    // from the list itself (so clearing it resets the tile), errors only — warnings and cancels are listed but not counted
    ['Problems', fmt((d.errors || []).filter((e) => e.level === 'error' && Date.now() - e.last < 86400000).length), 'errors in the last 24 h · ' + fmt((d.errors || []).filter((e) => e.level === 'error').length) + ' in the list'],
  ];
  const tb = $('#tiles'); tb.innerHTML = '';
  for (const [l, b, s] of tiles) { const x = el('div', 'tile'); x.append(el('div', 'lbl', l), el('div', 'big', b), el('div', 'sub', s)); tb.append(x); }
  // one measure per chart — no shared axis, no legend needed (the title names the series)
  const charts = [['Visitors per day', 'uniques', 'visitor'], ['New accounts per day', 'accounts', 'new account'], ['Lobbies opened per day', 'lobbies', 'lobby'], ['Launches per day', 'launches', 'launch']];
  const cb = $('#charts'); cb.innerHTML = '';
  for (const [title, key, unit] of charts) {
    const box = el('div', 'chart'); const h = el('h3', null, title); h.append(el('span', null, '30 days · ' + fmt(d.days.reduce((s, r) => s + r[key], 0)))); box.append(h);
    const plot = el('div', 'plot'); box.append(plot); cb.append(box); bars(plot, d.days, key, unit);
  }
  // table view of the same numbers
  const tt = $('#dayTable'); tt.innerHTML = '<thead><tr><th>Day</th><th class="r">Visitors</th><th class="r">Page loads</th><th class="r">New accounts</th><th class="r">Sign-ins</th><th class="r">Lobbies</th><th class="r">Joins</th><th class="r">Rehearsals</th><th class="r">Launches</th><th class="r">Landed</th></tr></thead>';
  const body = el('tbody'); for (const r of [...d.days].reverse()) { const tr = el('tr'); tr.append(el('td', 'm', r.day)); for (const k of ['uniques', 'visits', 'accounts', 'signins', 'lobbies', 'joins', 'rehearsals', 'launches', 'landed']) tr.append(el('td', 'r m', fmt(r[k]))); body.append(tr); } tt.append(body);
  // recent launches
  const rb = $('#recent'); rb.innerHTML = '';
  if (!d.recent.length) { const tr = el('tr'); const td = el('td', 'm', 'No real launches yet.'); td.colSpan = 4; td.style.color = 'var(--mute)'; tr.append(td); rb.append(tr); }
  for (const x of d.recent) {
    const tr = el('tr'); tr.append(el('td', 'm', new Date(x.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })));
    // click copies the full contract address
    const c = el('td', 'm'); if (x.mint) { const label = x.mint.slice(0, 6) + '…' + x.mint.slice(-4); const b = el('button', 'ca', label); b.title = 'copy ' + x.mint; b.onclick = () => navigator.clipboard.writeText(x.mint).then(() => { b.textContent = 'copied ✓'; setTimeout(() => (b.textContent = label), 1200); }); c.append(b); } else c.textContent = '—'; tr.append(c);
    tr.append(el('td', x.landed ? 'm ok' : 'm bad', x.landed ? '✓ landed' : '✕ did not land'));
    tr.append(el('td', 'r m', fmt(x.buyers))); rb.append(tr);
  }
  // problems: newest first; the wallet copies on click, like the coins above
  const pb = $('#probs'); pb.innerHTML = ''; const errs = d.errors || [];
  $('#probCount').textContent = errs.length ? errs.length + ' listed' : '';
  if (!errs.length) { const tr = el('tr'); const td = el('td', 'empty', 'Nothing has gone wrong yet.'); td.colSpan = 5; tr.append(td); pb.append(tr); }
  const copyBtn = (full, label) => { const b = el('button', 'ca', label); b.title = 'copy ' + full; b.onclick = () => navigator.clipboard.writeText(full).then(() => { b.textContent = 'copied ✓'; setTimeout(() => (b.textContent = label), 1200); }); return b; };
  for (const e of errs) {
    const tr = el('tr');
    tr.append(el('td', 'm', new Date(e.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) + (e.n > 1 ? ' ×' + e.n : '')));
    const w = el('td'); const msg = el('div', 'msg'); msg.append(el('span', 'lv ' + (e.level === 'warn' ? 'warn' : 'error'), e.level === 'warn' ? 'warn' : 'error'), document.createTextNode(e.msg)); w.append(msg, el('div', 'src', (e.src === 'relay' ? 'relay · ' : 'site · ') + (e.where || '') + (e.role ? ' · ' + e.role : ''))); tr.append(w);
    const wl = el('td', 'm'); if (e.wallet) wl.append(copyBtn(e.wallet, e.wallet.slice(0, 4) + '…' + e.wallet.slice(-4))); else wl.textContent = '—'; tr.append(wl);
    const lb = el('td', 'm'); if (e.lobby) lb.append(copyBtn(e.lobby, e.lobby)); else lb.textContent = '—'; tr.append(lb);
    tr.append(el('td', 'm', e.ua || '—')); pb.append(tr);
  }
  const su = $('#signups'); su.innerHTML = '';
  if (!(acc.latest || []).length) { const tr = el('tr'); const td = el('td', 'm', 'No sign-ups yet.'); td.colSpan = 3; td.style.color = 'var(--mute)'; tr.append(td); su.append(tr); }
  for (const a of acc.latest || []) { const tr = el('tr'); tr.append(el('td', 'm', new Date(a.created).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })), el('td', 'm', a.wallet), el('td', 'r m', a.saved ? 'yes' : 'not yet')); su.append(tr); }
  $('#upd').textContent = 'updated ' + new Date().toLocaleTimeString([], { hour12: false }) + ' · refreshes every 30 s';
  $('#since').textContent = 'Visits, sign-ins, lobbies and launches are counted from ' + (d.countingSince || 'today') + ' on. Accounts include everyone who signed in before that.';
}

// bars: thin, 4px rounded tops anchored to the baseline, 2px gaps, recessive grid, hover tooltip per bar
const PLURAL = { visitor: 'visitors', 'new account': 'new accounts', lobby: 'lobbies', launch: 'launches' };
function bars(plot, days, key, unit) {
  const W = plot.clientWidth || 520, H = 150, pad = { l: 28, b: 20, t: 6 };
  const max = Math.max(1, ...days.map((r) => r[key])); const nice = max <= 4 ? max : Math.ceil(max / 4) * 4;
  const ns = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const iw = W - pad.l, ih = H - pad.b - pad.t, step = iw / days.length, bw = Math.max(3, step - 2);
  const y = (v) => pad.t + ih - (v / nice) * ih;
  for (const v of [0, nice / 2, nice]) { const ln = document.createElementNS(ns, 'line'); ln.setAttribute('x1', pad.l); ln.setAttribute('x2', W); ln.setAttribute('y1', y(v)); ln.setAttribute('y2', y(v)); ln.setAttribute('class', 'gridl'); svg.append(ln); const tx = document.createElementNS(ns, 'text'); tx.setAttribute('x', pad.l - 6); tx.setAttribute('y', y(v) + 3.5); tx.setAttribute('text-anchor', 'end'); tx.setAttribute('class', 'axis'); tx.textContent = Number.isInteger(v) ? v : v.toFixed(1); svg.append(tx); }
  const tip = el('div', 'tip'); plot.append(tip);
  days.forEach((r, i) => {
    const v = r[key], x = pad.l + i * step + 1, h = Math.max(0, y(0) - y(v));
    if (v > 0) { const p = document.createElementNS(ns, 'path'); const rr = Math.min(4, bw / 2, h); p.setAttribute('d', `M${x},${y(0)} V${y(0) - h + rr} Q${x},${y(0) - h} ${x + rr},${y(0) - h} H${x + bw - rr} Q${x + bw},${y(0) - h} ${x + bw},${y(0) - h + rr} V${y(0)} Z`); p.setAttribute('fill', getComputedStyle(document.documentElement).getPropertyValue('--bar')); svg.append(p); }
    // hit target: the whole column, taller than the bar
    const hit = document.createElementNS(ns, 'rect'); hit.setAttribute('x', pad.l + i * step); hit.setAttribute('y', pad.t); hit.setAttribute('width', step); hit.setAttribute('height', ih); hit.setAttribute('fill', 'transparent');
    hit.addEventListener('mouseenter', () => { tip.style.display = 'block'; tip.style.left = ((pad.l + i * step + step / 2) / W * 100) + '%'; tip.style.top = (y(v) / H * 150) + 'px'; tip.textContent = new Date(r.day + 'T12:00:00Z').toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' · ' + fmt(v) + ' ' + (v === 1 ? unit : PLURAL[unit]); });
    hit.addEventListener('mouseleave', () => (tip.style.display = 'none'));
    svg.append(hit);
  });
  for (const i of [0, Math.floor(days.length / 2), days.length - 1]) { const tx = document.createElementNS(ns, 'text'); tx.setAttribute('x', pad.l + i * step + step / 2); tx.setAttribute('y', H - 4); tx.setAttribute('text-anchor', i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'); tx.setAttribute('class', 'axis'); tx.textContent = new Date(days[i].day + 'T12:00:00Z').toLocaleDateString([], { month: 'short', day: 'numeric' }); svg.append(tx); }
  plot.prepend(svg);
}
addEventListener('resize', () => { if (DATA) draw(DATA); });
