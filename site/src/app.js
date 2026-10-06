// arenalaunch — web client. Squad launches on pump.fun: the dev builds the create, the dev buy and the first few of
// their own wallets' buys as ONE transaction; every teammate's buy is signed IN THEIR OWN BROWSER (vault wallet or
// Phantom) and the relay fires it the instant the create lands. No server ever holds a key.
import { Keypair, PublicKey, Transaction, VersionedTransaction, TransactionMessage, SystemProgram, ComputeBudgetProgram, AddressLookupTableProgram, AddressLookupTableAccount, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import BN from 'bn.js';
import { lockIx, LOCK_FEE_SOL, LOCK_FEE_PCT } from './lock.js';
import { pumpState, buildCreate, buyIxsFor, tokensFor, tokensAt, altKeysOf, signersOf, templateBad, feeSplitIxs, equalShares, TREASURY, LAUNCH_TAX_BPS, HUSHER_TAX_BPS, launchTaxIx } from './pump.js';

const $ = (s) => document.querySelector(s);
const short = (a) => (a && a.length > 12 ? a.slice(0, 4) + '…' + a.slice(-4) : a || '');
const fsol = (n) => (n == null ? '—' : (Math.round(n * 1e6) / 1e6).toString());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ls = { get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }, del: (k) => { try { localStorage.removeItem(k); } catch {} } };
const enc = new TextEncoder();
const MAX_TX = 1232;
const NEVER = BigInt('18446744073709551615');

// ---------------- activity log ----------------
function log(kind, msg, relayed) {
  if (kind === 'error' && !relayed) report(msg);
  const box = $('#log'); const div = document.createElement('div'); div.className = 'logline k-' + kind;
  const ts = document.createElement('span'); ts.className = 'ts'; ts.textContent = new Date().toLocaleTimeString([], { hour12: false });
  const m = document.createElement('span'); m.className = 'm'; m.textContent = msg; div.append(ts, m); box.appendChild(div);
  while (box.children.length > 300) box.removeChild(box.firstChild); box.scrollTop = box.scrollHeight;
}

// ---------------- problems → the owner's dashboard ----------------
// Every error a user sees is sent (once a minute per message, at most 25 per page load) with what the owner needs to
// help: the message, the wallet's public address, the lobby, and the browser. A user cancelling in Phantom is a warning.
const REP = { n: 0, last: new Map() };
function report(msg) {
  try {
    msg = String(msg || '').slice(0, 400); const now = Date.now();
    if (!msg || REP.n >= 25 || now - (REP.last.get(msg) || 0) < 60000) return; REP.last.set(msg, now); REP.n++;
    const ua = navigator.userAgent; const browser = (/Mobile|Android|iPhone/.test(ua) ? 'mobile ' : '') + (/Edg\//.test(ua) ? 'Edge' : /Brave/.test(ua) ? 'Brave' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'other');
    let wallet = null, lobby = null, role = null, mode = ''; try { wallet = address(); lobby = Y.code; role = Y.role; mode = W.mode === 'phantom' ? ' · Phantom signs' : ' · saved wallet signs'; } catch {}
    const level = /reject|cancel|denied|declined/i.test(msg) ? 'warn' : 'error';
    gateToken().then(() => fetch(Y.relay + '/stats/error', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gate': Y.token }, body: JSON.stringify({ level, where: (/^([a-z][a-z .]{1,20}):/i.exec(msg) || [])[1] || 'page', msg, wallet, lobby, role, ua: browser + mode }) })).catch(() => {});
  } catch {}
}
// only crashes from our own bundle: wallet extensions inject scripts that throw on their own (e.g. two EVM wallets
// fighting over window.ethereum) and they are not ours to fix
addEventListener('error', (e) => { if (!/\/app\.js(\?|$)/.test(String(e.filename || ''))) return; report('page crash: ' + (e.message || 'script error') + (e.filename ? ' @' + String(e.filename).split('/').pop() + ':' + e.lineno : '')); });
addEventListener('unhandledrejection', (e) => report('page crash: ' + (e.reason?.message || String(e.reason || 'unhandled rejection'))));

// ---------------- RPC (through the site's proxy: public RPCs CORS-block browsers and ad-blockers kill them) ----------------
const tailLogs = (logs) => (logs || []).filter((l) => /failed|Error|error|insufficient/i.test(l)).slice(-3).join(' | ') || (logs || []).slice(-2).join(' | ') || '(no program logs — usually the fee payer has no SOL)';
async function rpc(method, params) {
  const r = await fetch('/api/sol', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) });
  const j = await r.json(); if (j.error) { const e = j.error; const logs = e?.data?.logs; throw new Error((typeof e === 'string' ? e : (e.message || 'rpc error')) + (logs?.length ? ' · ' + tailLogs(logs) : '')); } return j.result;
}
const getAccounts = async (addrs) => (await rpc('getMultipleAccounts', [addrs, { encoding: 'base64', commitment: 'confirmed' }]))?.value || [];
const blockhash = async () => (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
async function sendAndConfirm(tx, ms = 60000) {
  const raw = Buffer.from(tx.serialize()).toString('base64');
  const sig = await rpc('sendTransaction', [raw, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 5 }]);
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await sleep(1200);
    const st = (await rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: false }]))?.value?.[0];
    if (st?.err) throw new Error('transaction failed on chain: ' + JSON.stringify(st.err) + ' (' + sig + ')');
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return sig;
  }
  throw new Error('not confirmed within ' + ms / 1000 + 's — check ' + sig);
}

// ---------------- account = the user's Phantom wallet; the saved wallets are encrypted HERE before upload ----------------
// A fresh signed message logs in; a signature over a FIXED message, hashed, is the vault key (ed25519 signatures are
// deterministic, so the same wallet always unlocks the same vault). The key never leaves this browser.
const b64 = (u8) => btoa(String.fromCharCode(...u8)), unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (u8) => b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const A = { session: null, id: null, kind: null, name: null, key: null, keyRaw: null, ver: 0, saving: null, dirty: false };
const VAULT_MSG = (addr) => 'arenalaunch: unlock my saved wallets\n' + addr + '\n\nSigning this does not move funds. Only sign it on arenalaunch.';
// accounts made before the rename were sealed with this message; they are re-sealed under the new one on first sign-in
const OLD_VAULT_MSG = (addr) => 'squadlaunch: unlock my saved wallets\n' + addr + '\n\nSigning this does not move funds. Only sign it on squadlaunch.';
const canOpen = async (blob, raw) => { try { const [, iv, ct] = blob.split('.'); await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await importKey(raw), unb64(ct)); return true; } catch { return false; } };
async function acct(op, body) {
  await gateToken();
  const r = await fetch(Y.relay + '/account/' + op, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gate': Y.token }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(j.error || 'account server error ' + r.status); e.status = r.status; e.body = j; throw e; } return j;
}
const importKey = (raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
async function sealVault(obj) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, A.key, enc.encode(JSON.stringify(obj)))); return 'v1.' + b64(iv) + '.' + b64(ct); }
async function openVault(blob) { const [, iv, ct] = blob.split('.'); return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, A.key, unb64(ct)))); }
async function startSession(r, raw) {
  A.session = r.session; A.id = r.id; A.kind = r.kind; A.name = r.id.slice(2); A.keyRaw = raw; A.key = await importKey(raw); A.ver = r.ver || 0;
  let data = { wallets: [], active: null };
  if (r.vault) { try { data = await openVault(r.vault); } catch { signOut(true); throw new Error(A.kind === 'wallet' ? 'this wallet could not unlock its saved wallets' : 'wrong password'); } }
  V.all = []; V.keys.clear(); V.raw = [];
  for (const w of data.wallets || []) { try { const kp = Keypair.fromSecretKey(bs58.decode(w.secret)); V.all.push({ id: w.id, name: w.name, address: kp.publicKey.toBase58(), amount: w.amount || 0, on: !!w.on, lock: !!w.lock }); V.keys.set(w.id, kp); } catch { V.raw.push(w); } }
  if (V.raw.length) log('warn', V.raw.length + ' saved wallet entr' + (V.raw.length === 1 ? 'y' : 'ies') + ' could not be read here — kept in your account untouched');
  V.active.sol = data.active === 'phantom' || V.all.some((w) => w.id === data.active) ? data.active : (V.all[0] || {}).id || null;
  if (!V.all.length && !V.raw.length) { addWallet('launch wallet', Keypair.generate()); A.dirty = true; setTimeout(flushVault, 0); log('success', 'made your launch wallet ' + V.all[0].address + ' — fund it with “Deposit from Phantom” in 01'); }
  try { sessionStorage.setItem('sq_acct', JSON.stringify({ session: A.session, id: A.id, kind: A.kind, ver: A.ver, raw: b64(raw), vault: r.vault || null })); } catch {}
  document.body.classList.remove('out');
  log('success', 'signed in as ' + (A.kind === 'wallet' ? short(A.name) : A.name) + ' · ' + V.all.length + ' saved wallet' + (V.all.length === 1 ? '' : 's'));
  render(); refreshBalances();
}
// save after any change (debounced); a save from a tab that is behind is refused by the server, never silently merged
let saveTimer = null;
function saveV() { if (!A.key) return; A.dirty = true; clearTimeout(saveTimer); saveTimer = setTimeout(flushVault, 600); render(); }
async function flushVault() {
  if (!A.key || !A.dirty) return; if (A.saving) { await A.saving; return flushVault(); }
  A.dirty = false;
  A.saving = (async () => {
    const data = { wallets: [...V.all.map((w) => ({ id: w.id, name: w.name, secret: bs58.encode(V.keys.get(w.id).secretKey), amount: w.amount || 0, on: !!w.on, lock: !!w.lock })), ...V.raw], active: V.active.sol };
    const vault = await sealVault(data);
    try { const r = await acct('save', { session: A.session, vault, ver: A.ver }); A.ver = r.ver; try { const s = JSON.parse(sessionStorage.getItem('sq_acct')); s.ver = A.ver; s.vault = vault; sessionStorage.setItem('sq_acct', JSON.stringify(s)); } catch {} }
    catch (e) { A.dirty = true; log('error', 'saving wallets: ' + e.message); if (e.status === 401) { alert('Your session ended — sign in again. Your last change was not saved.'); signOut(true); } else if (e.body?.conflict) alert(e.message); }
  })();
  try { await A.saving; } finally { A.saving = null; render(); }
}
// the Sign In With Solana message (same layout Phantom's signIn produces)
const siwsText = (i, addr) => [i.domain + ' wants you to sign in with your Solana account:', addr, '', i.statement, '', 'URI: ' + i.uri, 'Version: ' + i.version, 'Chain ID: ' + i.chainId, 'Nonce: ' + i.nonce, 'Issued At: ' + i.issuedAt].join('\n');
const injected = () => window.phantom?.solana || (window.solana?.isPhantom ? window.solana : null);
async function walletLogin() {
  const p = injected(); if (!p) throw new Error('Phantom was not found in this browser — install it from phantom.com, then reload this page');
  // Sign In With Solana: Phantom shows "<this domain> wants you to sign in", bound to this domain and a one-time nonce from the relay
  const { nonce } = await acct('nonce', {});
  const input = { domain: location.host, statement: 'Sign in to arenalaunch. This does not move funds.', uri: location.origin, version: '1', chainId: 'mainnet', nonce, issuedAt: new Date().toISOString() };
  let addr, message, sig;
  let viaSignIn = false;
  if (typeof p.signIn === 'function') {
    try {
      const out = await p.signIn(input);
      const a = out.account?.address ?? out.address ?? p.publicKey; addr = typeof a === 'string' ? a : a?.toBase58?.();
      message = out.signedMessage; sig = out.signature; viaSignIn = !!(addr && message && sig);
    } catch (e) { if (e?.code === 4001 || /reject|cancel|denied/i.test(e?.message || '')) throw e; log('warn', 'Phantom sign-in prompt failed (' + (e?.message || e) + ') — asking for a plain signature instead'); }
  }
  if (!viaSignIn) {
    // a wallet without signIn: sign the same standard message ourselves
    await p.connect(); addr = (p.publicKey || {}).toBase58?.();
    message = enc.encode(siwsText(input, addr)); sig = (await p.signMessage(message, 'utf8')).signature;
  }
  if (!addr) throw new Error('the wallet did not share its address');
  if (!p.publicKey) await p.connect();
  let r;
  try { r = await acct('wallet', { address: addr, message: bs58.encode(message), sig: bs58.encode(sig) }); }
  catch (e) {
    if (!viaSignIn || e.status !== 400) throw e;
    // the relay could not read the wallet's own sign-in message: sign our standard text once instead (fresh nonce)
    log('warn', 'sign-in not accepted (' + e.message + ') — approve one more signature');
    const again = { ...input, nonce: (await acct('nonce', {})).nonce, issuedAt: new Date().toISOString() };
    message = enc.encode(siwsText(again, addr)); sig = (await p.signMessage(message, 'utf8')).signature;
    r = await acct('wallet', { address: addr, message: bs58.encode(message), sig: bs58.encode(sig) });
  }
  const keyFrom = async (msg) => { const s = (await p.signMessage(enc.encode(msg), 'utf8')).signature; if (!ed25519.verify(s, enc.encode(msg), bs58.decode(addr))) throw new Error('the wallet returned an invalid signature'); return new Uint8Array(await crypto.subtle.digest('SHA-256', s)); };
  const raw = await keyFrom(VAULT_MSG(addr));
  W.phantom = p; W.phantomPk = addr;
  if (r.vault && !(await canOpen(r.vault, raw))) {
    // saved before the rename: unlock with the old message once, then re-seal under the new key
    log('warn', 'your saved wallets are from before the rename — approve one more signature in Phantom to move them over');
    const old = await keyFrom(OLD_VAULT_MSG(addr));
    if (!(await canOpen(r.vault, old))) throw new Error('this wallet could not unlock its saved wallets');
    await startSession(r, old);
    A.keyRaw = raw; A.key = await importKey(raw); A.dirty = true; await flushVault();
    try { const s = JSON.parse(sessionStorage.getItem('sq_acct')); s.raw = b64(raw); sessionStorage.setItem('sq_acct', JSON.stringify(s)); } catch {}
    log('success', 'saved wallets moved to your arenalaunch sign-in');
  } else await startSession(r, raw);
}
// ---------------- email sign-in: emailed code + password ----------------
// The password is stretched HERE (PBKDF2-SHA256, 600k rounds, salted with the email) and split with HKDF into two keys:
// AUTH goes to the relay (stored only as an HMAC there) and VAULT encrypts the saved wallets and never leaves this
// browser. Nobody, the relay included, can reset a forgotten password: the saved wallets go with it.
const E = { email: null, ticket: null, exists: null };
async function emailKeys(email, password) {
  const km = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const master = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode('arenalaunch email v1:' + email), iterations: 600000, hash: 'SHA-256' }, km, 256));
  const hk = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits']);
  const part = async (info) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(info) }, hk, 256));
  return { auth: b64url(await part('arenalaunch auth')), vault: await part('arenalaunch vault') };
}
const cleanEmail = (v) => String(v || '').trim().toLowerCase();
async function emailSend(email) { email = cleanEmail(email); if (!/^[^\s@|]+@[^\s@|]+\.[a-z]{2,}$/.test(email)) throw new Error('enter a valid email address'); const r = await acct('email-start', { email }); E.email = email; E.ticket = r.ticket; E.exists = null; }
async function emailCheck(code) { const r = await acct('email-check', { email: E.email, ticket: E.ticket, code: String(code).trim() }); E.exists = r.exists; return r.exists; }
async function emailLogin(code, password, confirm) {
  if (!E.email) throw new Error('send yourself a code first');
  if (!E.exists) { if (password.length < 10) throw new Error('use a password of at least 10 characters'); if (password !== confirm) throw new Error('the two passwords do not match'); }
  const k = await emailKeys(E.email, password);
  const r = await acct('email-login', { email: E.email, ticket: E.ticket, code: String(code).trim(), auth: k.auth });
  await startSession(r, k.vault); E.email = null; E.ticket = null; E.exists = null;
}
// after a reload: reconnect Phantom silently (it remembers this site) so the sign-in wallet can still sign
// after a refresh: the signed-in wallet is known (it is the account), so show it at once; attach Phantom silently when it
// appears (extensions inject a moment after the page). Anything that needs a signature connects on demand (ensurePhantom).
async function reconnect(addr) { W.phantomPk = W.phantomPk || addr; render(); let p = null; for (let i = 0; i < 15 && !(p = injected()); i++) await new Promise((res) => setTimeout(res, 200)); if (!p) return; try { await p.connect({ onlyIfTrusted: true }); } catch { return; } if (p.publicKey?.toBase58() === addr) { W.phantom = p; W.phantomPk = addr; render(); } }
function signOut(quiet) {
  clearTimeout(saveTimer); Object.assign(A, { session: null, id: null, kind: null, name: null, key: null, keyRaw: null, ver: 0, dirty: false });
  V.all = []; V.keys.clear(); V.raw = []; V.sel = null; V.active.sol = null; try { sessionStorage.removeItem('sq_acct'); } catch {} W.phantomPk = null; W.phantom = null;
  if (Y.code) lobbyLeave(true);
  document.body.classList.add('out'); if (!quiet) log('info', 'signed out'); render();
}
// survive a reload of this tab (sessionStorage dies with the tab)
async function resume() {
  let s; try { s = JSON.parse(sessionStorage.getItem('sq_acct') || 'null'); } catch {} if (!s?.session) return;
  try { const r = await acct('vault', { session: s.session }); await startSession({ session: s.session, id: s.id, kind: s.kind, ver: r.ver, vault: r.vault }, unb64(s.raw)); if (A.kind === 'wallet') reconnect(A.name); }
  catch (e) { if (e.status === 401) { try { sessionStorage.removeItem('sq_acct'); } catch {} log('info', 'session expired — sign in again'); } else log('warn', 'could not restore your session: ' + e.message); }
}

// ---------------- wallets (held in memory while signed in) ----------------
// saved wallets sign everything after sign-in (instantly, no pop-ups); Phantom is only the account + deposits
// saved wallets sign instantly; Phantom (the sign-in wallet) is a wallet row too and signs through its pop-up
const W = { get mode() { return V.active.sol === 'phantom' ? 'phantom' : 'launch'; }, balance: null, phantom: null, phantomPk: null };
const PH = Object.assign({ on: false, amount: 0, lock: false }, ls.get('sq_ph', {})); const savePH = () => ls.set('sq_ph', { on: PH.on, amount: PH.amount, lock: PH.lock });
const phW = () => ({ id: 'phantom', name: 'Phantom', address: W.phantomPk, amount: PH.amount, on: PH.on, lock: PH.lock, phantom: true });
// Squad Lock: does this wallet lock its tokens after its buy lands? (each person decides per wallet)
const LOCK_COST = LOCK_FEE_SOL + 0.009; // Streamflow fee + its account rent, measured on mainnet
const lockedW = (w) => !!w && (w.id === 'phantom' ? !!PH.lock : !!w.lock);
const V = { all: [], active: { sol: null }, keys: new Map(), bal: {}, sel: null, raw: [] }; // raw: saved entries this version cannot read, kept as-is so a save never drops them
const sols = () => V.all;
const activeW = () => (V.active.sol === 'phantom' ? phW() : sols().find((w) => w.id === V.active.sol) || null);
// my first buy: the ★ wallet's amount (the dev buy when I host)
const mainAmt = () => Number(activeW()?.amount) || 0;
const keyOf = (w) => (w ? V.keys.get(w.id) || null : null);
const address = () => (W.mode === 'phantom' ? W.phantomPk : (activeW() || {}).address) || null;
const unlocked = () => (W.mode === 'phantom' ? !!W.phantomPk : !!keyOf(activeW()));
const phantom = () => W.phantom || injected();
function parseSecret(s) { s = s.trim(); if (s.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s))); const r = bs58.decode(s); return r.length === 64 ? Keypair.fromSecretKey(r) : Keypair.fromSeed(r); }
function addWallet(name, kp) {
  const addr = kp.publicKey.toBase58(); if (V.all.some((w) => w.address === addr)) throw new Error('that wallet is already in your account');
  const id = 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  V.all.push({ id, name: (name || '').trim().slice(0, 24) || 'wallet-' + (V.all.length + 1), address: addr, amount: 0, on: false }); V.keys.set(id, kp);
  if (!V.active.sol) V.active.sol = id; return id;
}
function vaultAdd(name, secret) { if (!A.key) throw new Error('sign in first'); const kp = secret ? parseSecret(secret) : Keypair.generate(); addWallet(name, kp); saveV(); log('success', (secret ? 'imported ' : 'generated ') + kp.publicKey.toBase58()); }
function vaultRemove(w) { V.all = V.all.filter((x) => x.id !== w.id); V.keys.delete(w.id); if (V.active.sol === w.id) V.active.sol = (V.all[0] || {}).id || null; if (V.sel === w.id) V.sel = null; saveV(); log('warn', 'removed ' + w.name + ' from your account'); }
// wallets the older version kept in THIS browser only (each encrypted with its own vault password) — offered for import once signed in
const legacy = () => (ls.get('sq_wallets', []) || []).filter((w) => (w.chain || 'sol') === 'sol' && w.enc?.ct && !V.all.some((x) => x.address === w.address));
async function legacyDecrypt(rec, password) {
  const km = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: bs58.decode(rec.salt), iterations: 250000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bs58.decode(rec.iv) }, key, bs58.decode(rec.ct)));
}
async function importLegacy(password) {
  let n = 0; const left = [];
  for (const w of legacy()) { try { addWallet(w.name, Keypair.fromSecretKey(await legacyDecrypt(w.enc, password))); n++; } catch { left.push(w.name); } }
  if (!n) throw new Error('wrong password — nothing moved');
  saveV(); await flushVault();
  if (!left.length) { ls.del('sq_wallets'); ls.del('sq_active'); }
  log('success', 'moved ' + n + ' wallet(s) from this browser into your account' + (left.length ? ' — ' + left.length + ' need a different password: ' + left.join(', ') : ''));
}
// my other wallets that ride along in a launch I run as dev
const extraWallets = () => [...sols().filter((w) => w.on && w.amount > 0 && V.keys.has(w.id) && w.id !== V.active.sol), ...(W.phantomPk && PH.on && PH.amount > 0 && V.active.sol !== 'phantom' ? [phW()] : [])];
// sign a transaction as one of my wallets (Phantom asks in its pop-up; saved wallets sign here)
// connect Phantom only when it must sign, and make sure it is on the wallet the page expects
async function ensurePhantom(expect = W.phantomPk) {
  if (!W.phantom) { const p = phantom(); if (!p) throw new Error('Phantom not found — install it or use a saved wallet'); await p.connect(); W.phantom = p; }
  const got = W.phantom.publicKey?.toBase58();
  if (expect && got && got !== expect) throw new Error('Phantom is on ' + short(got) + ' — switch Phantom to ' + short(expect) + ' (the wallet you signed in with) and try again');
  if (!W.phantomPk && got) W.phantomPk = got;
  return W.phantom;
}
async function signAs(w, tx) { if (w.id === 'phantom') return (await ensurePhantom()).signTransaction(tx); tx.partialSign(keyOf(w)); return tx; }
// `also`: more transfers [{to, lamports}] in the same transaction (the private-transfer fee rides with its deposit)
async function sendSol(fromKp, to, sol, also = []) {
  const tx = new Transaction({ feePayer: fromKp.publicKey, recentBlockhash: await blockhash() }); tx.add(SystemProgram.transfer({ fromPubkey: fromKp.publicKey, toPubkey: new PublicKey(to), lamports: Math.round(sol * LAMPORTS_PER_SOL) }), ...also.map((a) => SystemProgram.transfer({ fromPubkey: fromKp.publicKey, toPubkey: new PublicKey(a.to), lamports: a.lamports }))); tx.sign(fromKp);
  return rpc('sendTransaction', [bs58.encode(tx.serialize()), { encoding: 'base58', preflightCommitment: 'confirmed' }]);
}
async function phantomConnect() { const p = phantom(); if (!p) throw new Error('Phantom not found — install it or use a saved wallet'); const { publicKey } = await p.connect(); W.phantom = p; W.phantomPk = publicKey.toBase58(); log('success', 'Phantom connected: ' + W.phantomPk); }
async function phantomDeposit(toAddr, sol, also = []) {
  const p = phantom(); if (!p) throw new Error('Phantom not found'); if (!W.phantomPk) await phantomConnect(); else await ensurePhantom();
  const from = new PublicKey(W.phantomPk);
  const tx = new Transaction({ feePayer: from, recentBlockhash: await blockhash() }); tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(toAddr), lamports: Math.round(sol * LAMPORTS_PER_SOL) }), ...also.map((a) => SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(a.to), lamports: a.lamports })));
  const { signature } = await p.signAndSendTransaction(tx); return signature;
}
// sign a message (lobby hello / pump.fun login) or a transaction with whichever identity is active
async function signMessage(bytes) {
  if (W.mode === 'phantom') { const r = await (await ensurePhantom()).signMessage(bytes, 'utf8'); return bs58.encode(r.signature); }
  const k = keyOf(activeW()); if (!k) throw new Error('sign in first');
  return bs58.encode(ed25519.sign(bytes, k.secretKey.slice(0, 32)));
}
async function signTx(tx) { if (W.mode === 'phantom') return (await ensurePhantom()).signTransaction(tx); if (tx instanceof VersionedTransaction) tx.sign([keyOf(activeW())]); else tx.partialSign(keyOf(activeW())); return tx; }

// ---------------- pump.fun state (global + fee config), cached briefly ----------------
let PS = null, PSat = 0;
async function pump() { if (PS && Date.now() - PSat < 30000) return PS; PS = await pumpState(getAccounts); PSat = Date.now(); return PS; }
const lam = (sol) => Math.round(Number(sol) * 1e9);
const prioIxs = (cu, prioSol) => [ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.max(1, Math.floor((Number(prioSol) || 0) * 1e15 / cu)) })];

// ---------------- Send SOL: one place to move SOL between your wallets, Phantom, or any address ----------------
// Every choice is a NAME with its balance and short address; the button spells out the exact move before you press it.
const T = { open: true, from: null, to: null, busy: false, mode: 'send', est: null, order: null, polling: null, sent: false };
const optW = (w) => ({ v: 'w:' + w.id, name: (w.id === V.active.sol ? '★ ' : '') + w.name, addr: w.address });
const optP = () => ({ v: 'phantom', name: 'Phantom', addr: W.phantomPk });
const srcOpts = () => [...sols().filter((w) => V.keys.has(w.id)).map(optW), optP()];
const dstOpts = () => [...sols().map(optW), optP(), { v: 'other', name: 'Another address…', addr: null }];
const optLabel = (o) => (o.v === 'other' ? o.name : o.name + '  —  ' + (o.addr ? (V.bal[o.addr] == null ? '…' : fsol(V.bal[o.addr])) + ' SOL  ·  ' + short(o.addr) : 'connect in the next step'));
const tAddr = (v) => (v === 'other' ? $('#tToAddr').value.trim() : v === 'phantom' ? W.phantomPk : (sols().find((w) => 'w:' + w.id === v) || {}).address);
const tName = (v) => (v === 'other' ? short(tAddr(v)) || 'that address' : v === 'phantom' ? 'Phantom' : (sols().find((w) => 'w:' + w.id === v) || {}).name || '?');
const isAddr = (a) => { try { new PublicKey(a); return true; } catch { return false; } };
const RENT_MIN = 0.00089; // a wallet left with less than this (and more than 0) is refused by the network
// Max leaves exactly the network fee in a saved wallet (it closes to 0), and a little more in Phantom (it may add a priority fee)
const tMax = () => { const b = V.bal[tAddr(T.from)] || 0; return T.from === 'phantom' ? Math.max(0, b - 0.001) : Math.max(0, (Math.round(b * 1e9) - 5000) / 1e9); };
function xferOpen(from, to) {
  const star = V.active.sol ? 'w:' + V.active.sol : null; const src = from || star; const others = sols().filter((w) => 'w:' + w.id !== src);
  T.open = true; T.picked = true; T.from = src; T.to = to || (others[0] ? 'w:' + others[0].id : 'phantom'); $('#tAmt').value = ''; $('#tMsg').textContent = '';
  renderXfer(); try { document.querySelector('#tabs button[data-tab=wallets]').click(); } catch {} $('#xfer').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); $('#tAmt').focus(); refreshBalances();
}
function fillSel(sel, opts, val) {
  if (document.activeElement !== sel) { sel.innerHTML = ''; for (const o of opts) { const op = el('option', null, optLabel(o)); op.value = o.v; sel.append(op); } }
  sel.value = opts.some((o) => o.v === val) ? val : (opts[0] || {}).v; return sel.value;
}
function renderXfer() {
  show('#xfer', T.open); if (!T.open) return;
  const priv = T.mode === 'private';
  document.querySelectorAll('#tMode button').forEach((b) => b.classList.toggle('on', b.dataset.m === T.mode));
  $('#tSub').textContent = priv ? 'via Husher · unlinkable on chain · ' + HUSHER_TAX_BPS / 100 + '% fee' : 'wallets · Phantom · any address';
  // until someone picks, From = my ★ wallet and To = my next wallet (Phantom only once it is connected)
  if (!T.picked) { const star = V.active.sol && V.active.sol !== 'phantom' ? 'w:' + V.active.sol : null; const other = sols().find((w) => 'w:' + w.id !== star); T.from = star || (W.phantomPk ? 'phantom' : null); T.to = other ? 'w:' + other.id : W.phantomPk ? 'phantom' : 'other'; }
  T.from = fillSel($('#tFrom'), srcOpts(), T.from); T.to = fillSel($('#tTo'), dstOpts(), T.to); show('#tToAddr', T.to === 'other');
  const amt = Number($('#tAmt').value), from = tAddr(T.from), to = tAddr(T.to), bal = from ? V.bal[from] : null, left = bal == null ? null : bal - amt - (T.from === 'phantom' ? 0.0001 : 0.000005);
  $('#tAvail').textContent = bal == null ? '' : 'can send ' + fsol(tMax()) + ' SOL';
  // private mode: Husher has no quote route — show its minimum before the order, the exact amounts once it exists
  // the amount box is what leaves the wallet: 2% of it is the arenalaunch fee, the rest is the Husher order
  const minP = priv && T.est && T.est.min ? Math.ceil(T.est.min / (1 - HUSHER_TAX_BPS / 10000) * 1e6) / 1e6 : 0;
  if (priv && T.order) {
    $('#pvtEst').innerHTML = 'They receive <b>' + fsol(T.order.toAmount) + ' SOL</b> · ' + HUSHER_TAX_BPS / 100 + '% fee ' + fsol(T.tax / 1e9) + ' SOL · Husher fees ' + fsol(T.order.fee) + ' SOL';
    show('#pvtEst', true);
  } else if (priv && amt > 0) {
    $('#pvtEst').innerHTML = HUSHER_TAX_BPS / 100 + '% fee ' + fsol(pvtTax(amt) / 1e9) + ' SOL' + (minP ? ' · minimum <b>' + fsol(minP) + ' SOL</b>' : '') + ' · Husher fees show once the order is made';
    show('#pvtEst', true);
  } else { show('#pvtEst', false); }
  let why = '';
  if (!from) why = T.from === 'phantom' ? 'Connect Phantom' : 'Pick a wallet to send from';
  else if (!to) why = T.to === 'other' ? 'Paste the address to send to' : T.to === 'phantom' ? 'Connect Phantom' : 'Pick where to send';
  else if (from === to) why = 'From and To are the same wallet';
  else if (T.to === 'other' && !isAddr(to)) why = 'That is not a Solana address';
  else if (!(amt > 0)) why = 'Choose an amount';
  else if (bal != null && amt > tMax() + 1e-9) why = 'More than ' + tName(T.from) + ' can send';
  else if (minP && amt < minP) why = 'Private minimum is ' + fsol(minP) + ' SOL';
  else if (!priv && left != null && left > 1e-9 && left < RENT_MIN) why = 'Leave at least ' + RENT_MIN + ' SOL in ' + tName(T.from) + ', or press Max';
  else if (!priv && V.bal[to] === 0 && amt < RENT_MIN) why = 'An empty wallet needs at least ' + RENT_MIN + ' SOL';
  // order section (private mode)
  const hasOrder = priv && !!T.order;
  show('#pvtOrder', hasOrder);
  if (hasOrder) {
    $('#pvtOid').textContent = T.order.id;
    $('#pvtDep').textContent = T.order.payinAddress;
    const st = T.order.status || 'waiting';
    const STEPS = ['waiting', 'confirming', 'exchanging', 'sending', 'finished'];
    const idx = Math.max(0, STEPS.indexOf(st));
    document.querySelectorAll('#pvtDots .dot').forEach((d, i) => { d.className = 'dot' + (i < idx ? ' ok' : i === idx ? ' on' : ''); });
    const labels = { waiting: 'waiting for deposit…', confirming: 'deposit detected — confirming…', exchanging: 'processing transfer…', sending: 'sending SOL to destination…', finished: '✓ Transfer complete!', failed: '✗ Transfer failed', refunded: '↩ Refunded', expired: '✗ Order expired' };
    $('#pvtSt').textContent = labels[st] || st;
    show('#pvtSend', st === 'waiting' && !T.sent);
    if (T.order.trackUrl) { $('#pvtTrack').href = T.order.trackUrl; show('#pvtTrack', true); } else show('#pvtTrack', false);
  }
  $('#tGo').disabled = !!why || T.busy || hasOrder;
  show('#tGo', !hasOrder);
  if (priv) {
    $('#tGo').textContent = T.busy ? 'Creating order…' : why || 'Privately send ' + fsol(amt) + ' SOL via Husher';
  } else {
    $('#tGo').textContent = T.busy ? 'Sending…' : why || 'Send ' + fsol(amt) + ' SOL  ·  ' + tName(T.from) + '  →  ' + tName(T.to);
  }
}
async function xferSend() {
  if (T.from === 'phantom' && !W.phantomPk) { await phantomConnect(); refreshBalances(); return renderXfer(); }
  const amt = Number($('#tAmt').value), from = tAddr(T.from), to = tAddr(T.to);
  if (!confirm('Send ' + fsol(amt) + ' SOL?\n\nFROM  ' + tName(T.from) + '\n' + from + '\n\nTO  ' + tName(T.to) + '\n' + to + '\n\nThis cannot be undone.')) return;
  T.busy = true; renderXfer(); $('#tMsg').textContent = '';
  try {
    const sig = T.from === 'phantom' ? await phantomDeposit(to, amt) : await sendSol(keyOf(sols().find((w) => 'w:' + w.id === T.from)), to, amt);
    $('#tMsg').textContent = 'Sent ✓ — balances update in a few seconds.'; log('success', 'sent ' + fsol(amt) + ' SOL from ' + tName(T.from) + ' to ' + tName(T.to) + ' — ' + sig);
    $('#tAmt').value = ''; setTimeout(refreshBalances, 2500); setTimeout(refreshBalances, 8000);
  } catch (e) { $('#tMsg').textContent = 'Not sent — ' + e.message; log('error', 'send SOL: ' + e.message); }
  finally { T.busy = false; renderXfer(); }
}

// ---------------- Private Transfer (Husher) — integrated into the Send panel ----------------
async function husher(action, body = {}) {
  const r = await fetch('/api/husher', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...body }) });
  const j = await r.json(); if (!r.ok || j.error) throw new Error(j.error || 'Husher error ' + r.status); return j;
}

async function pvtEstimate() {
  const amt = Number($('#tAmt').value);
  if (!(amt > 0)) { T.est = null; renderXfer(); return; }
  try { T.est = await husher('estimate', { amount: amt }); } catch { T.est = null; }
  renderXfer();
}

function pvtTax(sol) { return Math.floor(lam(sol) * HUSHER_TAX_BPS / 10000); } // lamports
async function pvtCreate() {
  const amt = Number($('#tAmt').value), to = tAddr(T.to);
  if (!(amt > 0) || !to) return;
  T.busy = true; renderXfer(); $('#tMsg').textContent = '';
  try {
    const tax = pvtTax(amt);
    T.order = await husher('create', { amount: (lam(amt) - tax) / 1e9, address: to }); T.tax = tax;
    T.sent = false;
    log('success', 'private transfer order ' + T.order.id + ' created — send ' + fsol(amt) + ' SOL to the deposit address');
    pvtPoll();
  } catch (e) { $('#tMsg').textContent = e.message; log('error', 'private transfer: ' + e.message); }
  finally { T.busy = false; renderXfer(); }
}

async function pvtDeposit() {
  if (!T.order || T.sent) return;
  const amt = T.order.sendAmount, dep = T.order.payinAddress; // the order's amount, even if the box was edited since
  if (!dep || !(amt > 0)) return;
  const fee = [{ to: TREASURY, lamports: T.tax }];
  if (!confirm('Send ' + fsol(amt) + ' SOL to the Husher deposit address?\n\n' + dep + '\n\n+ ' + fsol(T.tax / 1e9) + ' SOL arenalaunch fee (' + HUSHER_TAX_BPS / 100 + '%), in the same transaction.\n\nOnce sent, Husher privately delivers ' + fsol(T.order.toAmount) + ' SOL to ' + tName(T.to) + '.')) return;
  T.busy = true; renderXfer();
  try {
    if (T.from === 'phantom') { await phantomDeposit(dep, amt, fee); }
    else { const w = sols().find((w) => 'w:' + w.id === T.from); if (!w) throw new Error('wallet not found'); await sendSol(keyOf(w), dep, amt, fee); }
    T.sent = true;
    log('success', 'deposit sent to Husher — waiting for confirmation…');
    setTimeout(refreshBalances, 3000);
  } catch (e) { $('#tMsg').textContent = 'Deposit not sent — ' + e.message; log('error', 'husher deposit: ' + e.message); }
  finally { T.busy = false; renderXfer(); }
}

function pvtPoll() {
  if (T.polling) clearInterval(T.polling);
  T.polling = setInterval(async () => {
    if (!T.order) { clearInterval(T.polling); T.polling = null; return; }
    try {
      const st = await husher('status', { id: T.order.id });
      T.order = st;
      renderXfer();
      if (st.status === 'finished' || st.status === 'failed' || st.status === 'refunded' || st.status === 'expired') {
        clearInterval(T.polling); T.polling = null;
        if (st.status === 'finished') { log('success', 'private transfer complete — ' + fsol(st.amountTo) + ' SOL delivered to ' + tName(T.to)); setTimeout(refreshBalances, 3000); }
        else log('warn', 'private transfer ' + st.status);
      }
    } catch { /* keep polling */ }
  }, 5000);
}

function pvtReset() { T.order = null; T.est = null; T.sent = false; T.tax = 0; if (T.polling) { clearInterval(T.polling); T.polling = null; } renderXfer(); }

// ---------------- go-live clock ----------------
// One clock for the whole lobby: the dev picks "go live in N s", the relay fires the create exactly then (or as soon as the
// last signature is in, if that is later). The big numerals count down, then show SENT, then LIVE.
const CD = { at: 0, sent: false, live: null, slot: null, mint: null, dry: false, stage: '', handed: false, cancel: false };
const fmtCd = (s) => (s >= 60 ? Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0') : s.toFixed(1));
function tick() {
  const el = $('#goLive'), sub = $('#goLiveSub'); if (!el) return;
  let big = '--:--', small = '', cls = '';
  if (CD.live) { big = 'LIVE'; cls = 'live'; small = 'since ' + new Date(CD.live).toLocaleTimeString([], { hour12: false }) + (CD.slot ? ' · slot ' + CD.slot : '') + (CD.mint ? ' · ' + short(CD.mint) : ''); }
  else if (CD.live === false) { big = 'MISSED'; cls = 'dead'; small = 'the create did not land — nothing was charged'; }
  else if (CD.sent) { big = 'SENT'; cls = 'hot'; small = 'landing…'; }
  else if (CD.at) { const sec = (CD.at - Date.now()) / 1000; big = sec > 0 ? fmtCd(sec) : '0.0'; cls = sec < 10 ? 'hot' : ''; small = (CD.dry ? 'rehearsal · ' : '') + (sec > 0 ? (CD.stage || 'counting down') : 'waiting for the last signature…') + (launching && !CD.handed ? ' · click to cancel' : ''); }
  else small = Y.connected && Y.role === 'dev' ? 'ready when you are' : Y.connected ? 'waiting for the dev' : 'open a lobby to launch';
  el.textContent = big; el.className = 'clock ' + cls; sub.textContent = small;
}
setInterval(tick, 100);
async function holdUntil(t) { while (Date.now() < t) { if (CD.cancel) throw new Error('launch cancelled'); await sleep(150); } }
function cdReset(dry) { Object.assign(CD, { at: 0, sent: false, live: null, slot: null, mint: null, dry: !!dry, stage: '', handed: false, cancel: false }); tick(); }

// ---------------- lobby ----------------
const Y = { get amount() { return mainAmt(); }, ws: null, code: null, role: null, connected: false, roster: null, phase: 'idle', token: null, relay: null, name: ls.get('sq_name', ''), last: null };
async function gateToken() { if (Y.token) return Y.token; const j = await (await fetch('/api/token')).json(); if (!j.token) throw new Error('not signed in'); Y.token = j.token; Y.relay = j.relay; return j.token; }
const ysend = (o) => { try { Y.ws?.send(JSON.stringify(o)); } catch {} };
// my ticked extra wallets as the lobby sees them (count + SOL), sent with my buy amount
const extraInfo = () => { const ex = extraWallets(); return { n: ex.length, sol: Math.round(ex.reduce((a, w) => a + w.amount, 0) * 1e6) / 1e6 }; };
// set the ★ wallet's buy (the dev buy, or your first buy as a member) from the launch card — same rule as the wallets table
function setMainAmt(v){ const n=Number(v); const a=Number.isFinite(n)&&n>0&&n<=100?n:0; if(V.active.sol==='phantom'){ PH.amount=a; savePH(); } else { const w=activeW(); if(w){ w.amount=a; saveV(); } } sendAmount(); render(); }
const sendAmount = () => { if (Y.connected && Y.role === 'member') ysend({ t: 'amount', amount: Number(Y.amount) || 0, extra: extraInfo() }); };
async function lobbyConnect(code, role) {
  if (!unlocked()) throw new Error(W.mode === 'phantom' ? 'connect Phantom first' : 'add a wallet first');
  await gateToken(); lobbyLeave(true);
  Y.code = code; Y.role = role; render();
  const ws = new WebSocket(Y.relay.replace(/^http/, 'ws') + '/lobby/' + code + '/ws?g=' + encodeURIComponent(Y.token)); Y.ws = ws;
  ws.onopen = async () => { const ts = Date.now(); const sig = await signMessage(enc.encode('pumpcall-lobby:' + code + ':' + ts)); ysend({ t: 'hello', wallet: address(), name: Y.name || short(address()), sig, ts, role, amount: role === 'member' ? Number(Y.amount) || 0 : 0, extra: role === 'member' ? extraInfo() : null, ready: role === 'member' }); };
  ws.onmessage = (e) => { let b; try { b = JSON.parse(e.data); } catch { return; } onLobby(b).catch((err) => log('error', 'lobby: ' + err.message)); };
  ws.onclose = (e) => {
    if (Y.ws !== ws) return; const joined = Y.connected; Y.ws = null; Y.connected = false;
    // never got in: almost always a mistyped code or a lobby that no longer exists (the relay refuses unknown codes)
    if (!joined && e.code === 1006) { log('error', 'lobby: could not join ' + code + ' — check the code (it may be mistyped, or the lobby no longer exists)'); Y.code = null; Y.role = null; render(); return; }
    log('warn', 'lobby: disconnected (' + e.code + (e.reason ? ' ' + e.reason : '') + ')'); if (e.reason === 'kicked') { Y.code = null; Y.role = null; } render();
  };
  ws.onerror = () => { if (Y.ws === ws && Y.connected) log('error', 'lobby: relay connection failed'); };
}
function lobbyLeave(silent) { if (Y.ws) { const w = Y.ws; Y.ws = null; try { w.close(1000, 'leave'); } catch {} } Object.assign(Y, { connected: false, code: null, role: null, roster: null, phase: 'idle' }); if (!silent) { log('info', 'lobby: left'); render(); } }
// a teammate's buy: spend exactly my amount; accept anything down to half of what I'd get if I were the last squad buy
async function memberBuyTx(t, owner, sol, lock = false) {
  const st = await pump(); const mine = lam(sol);
  // how much is bought ahead of me: never more than the lobby itself adds up to (the dev's buy, as the relay read it from the
  // signed create, plus every roster buy), so nobody can widen my floor by sending a made-up number
  const roster = (Y.roster?.members || []).reduce((a, m) => a + lam(Math.min(100, Number(m.amount) || 0) + Math.min(1000, Number(m.extra?.sol) || 0)), 0);
  const bound = (Number(t.devLamports) || 0) + roster;
  const before = Math.max(0, Math.min(Number(t.plannedLamports) || 0, bound) - mine);
  const minOut = tokensAt(st, before, mine).muln(lock ? 85 : 50).divn(100);
  const tx = new Transaction({ feePayer: owner, recentBlockhash: t.blockhash });
  // the dev picks the priority fee, but a teammate never pays more than 0.01 SOL of it, nor asks for more than 400k CU
  const cu = Math.min(400000, Math.max(100000, Math.round(Number(t.cu) || 200000))), prio = Math.min(MEMBER_PRIO_MAX, Math.max(0, Number(t.prio) || 0));
  tx.add(...prioIxs(cu, prio), ...buyIxsFor(t, owner, mine, minOut.gtn(0) ? minOut : new BN(1)), launchTaxIx(owner, mine), ...buyTipIxs(t, owner));
  tx.minOut = minOut;
  return tx;
}
// the wallet's lock: exactly the tokens its buy is guaranteed to get (less Streamflow's 0.5%, which it takes on top), until the
// lobby's lock time; sent by the relay right after that wallet's buy lands
async function lockTxFor(t, owner, minOut) {
  const amount = new BN(minOut.toString()).muln(1000).divn(1005);
  if (!amount.gtn(0) || !t.lockUntil) throw new Error('nothing to lock');
  const tx = new Transaction({ feePayer: owner, recentBlockhash: t.blockhash });
  tx.add(...prioIxs(150000, Math.min(0.001, Number(t.prio) || 0)), await lockIx({ owner, mint: t.mint, amount: amount.toString(), unlockAt: t.lockUntil }));
  return tx;
}
const rawOf = (tx) => bs58.encode(tx.serialize({ requireAllSignatures: true, verifySignatures: true }));
const MEMBER_PRIO_MAX = 0.01;
// Block 0 goes out as bundles (all-or-nothing groups the leader runs back to back), sent through Helius. Every bundle must
// tip a Helius tip account: the launch transaction tips more so its bundle runs first, each buy tips a little so any group
// of buys is a valid bundle. A teammate never tips more than BUNDLE_TIP_MAX.
const HELIUS_TIPS = ['4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE', 'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ', '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta', '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn', '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD', '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ', 'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF', '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT', '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey', '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or'];
const BUNDLE_TIP_CREATE = 100000, BUNDLE_TIP_BUY = 10000, BUNDLE_TIP_MAX = 100000; // lamports: 0.0001 / 0.00001 / 0.0001 SOL
const tipIx = (from, lamports) => SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(HELIUS_TIPS[Math.floor(Math.random() * HELIUS_TIPS.length)]), lamports });
const buyTipIxs = (t, owner) => { const l = Math.min(BUNDLE_TIP_MAX, Math.max(0, Math.round(Number(t.bundleTip) || 0))); return l >= 1000 ? [tipIx(owner, l)] : []; };
// before signing anything the dev sent: a fresh coin (its mint not on chain yet) made by this lobby's dev, every buy account
// re-derived from the mint (so the buy can only ever be of THIS launch)
async function checkSignRequest(t) {
  const bad = await templateBad(await pump(), t, Y.roster?.dev || null); if (bad) throw new Error(bad);
  if (!(Number(t.devLamports) > 0)) throw new Error('the relay did not confirm the dev buy — reload the page');
  if (Number(t.devLamports) > 100e9) throw new Error('the dev buy is over 100 SOL');
  if (t.lockUntil && Number(t.lockUntil) > Date.now() / 1000 + 7 * 86400 + 2 * 3600) throw new Error('the dev asked for a lock longer than 7 days');
  const acc = (await getAccounts([t.mint]))[0];
  if (acc) throw new Error('that mint already exists on chain — this is not a new launch');
}
async function onLobby(b) {
  switch (b.t) {
    case 'roster': if (!Y.connected) { if (b.you !== address()) return; Y.connected = true; log('success', 'lobby ' + b.code + ' — joined as ' + Y.role); } Y.roster = b; Y.phase = b.phase || 'idle'; if (b.phase === 'launching' && b.fireAt && !CD.at) { CD.at = b.fireAt; CD.mint = b.mint || null; CD.live = null; CD.sent = false; tick(); } render(); return;
    case 'log': log(b.kind === 'armed' ? 'armed' : b.kind || 'info', 'lobby: ' + b.msg, true); return; // the relay already reported its own errors
    case 'countdown': if (b.sent) { CD.sent = true; if (!CD.at) CD.at = Date.now(); CD.mint = b.mint || CD.mint; tick(); } return;
    case 'error': log('error', 'lobby: ' + b.msg); if (!Y.connected) lobbyLeave(true); else if (Y.role === 'dev' && (CD.handed || Y.phase === 'launching')) { cdReset(false); Y.phase = 'idle'; alert('Launch stopped — ' + b.msg); } render(); return;
    case 'sign': {
      if (Y.role !== 'member') return;
      try {
        if (b.chain === 'rh' || b.template?.kind !== 'pump') throw new Error('this lobby is not a pump.fun launch — update the dev\'s page');
        const amt = Number(Y.amount); if (!(amt > 0 && amt <= 100)) throw new Error('set a buy between 0 and 100 SOL');
        await checkSignRequest(b.template);
        log('info', 'lobby: the dev buys ' + fsol(Number(b.template.devLamports) / 1e9) + ' SOL ahead of the squad');
        const owner = new PublicKey(address());
        // rehearsal: sign against a made-up blockhash so this signature can never be used for a real buy, even if the relay wanted to
        const canLock = !!b.template.lockUntil; const locks = [];
        const t0 = b.dry ? { ...b.template, blockhash: Keypair.generate().publicKey.toBase58() } : b.template;
        const tx = await memberBuyTx(t0, owner, amt, canLock && lockedW(activeW()));
        if (W.mode === 'phantom') log('warn', 'lobby: approve the buy in Phantom NOW — about a minute');
        const signed = await signTx(tx);
        if (canLock && lockedW(activeW())) locks.push(rawOf(await signTx(await lockTxFor(t0, owner, tx.minOut))));
        // my other ticked wallets: one transaction each, signed and paid by that wallet
        const tmpl = b.dry ? { ...b.template, blockhash: Keypair.generate().publicKey.toBase58() } : b.template; const extra = [];
        for (const w of extraWallets()) { const lk = canLock && lockedW(w); const t = await memberBuyTx(tmpl, new PublicKey(w.address), w.amount, lk); t.feePayer = new PublicKey(w.address); if (w.id === 'phantom') log('warn', 'lobby: approve the Phantom wallet\'s buy in Phantom NOW'); const st2 = await signAs(w, t); extra.push(bs58.encode(st2.serialize({ requireAllSignatures: true, verifySignatures: true }))); if (lk) locks.push(rawOf(await signAs(w, await lockTxFor(tmpl, new PublicKey(w.address), t.minOut)))); }
        ysend({ t: 'signed', tx: bs58.encode(signed.serialize({ requireAllSignatures: true, verifySignatures: true })), extra, locks });
        if (locks.length) log('info', 'lobby: ' + locks.length + ' of my wallets will lock their tokens on Streamflow until ' + new Date(b.template.lockUntil * 1000).toLocaleString() + ' (right after each buy lands)');
        else if (!canLock && (lockedW(activeW()) || extraWallets().some(lockedW))) log('warn', 'lobby: the dev\'s page is older and does not offer locks — my wallets buy without locking');
        if (b.template.feeSplit) { const mine = b.template.feeSplit.find((h) => h.address === address()); log('info', 'lobby: this coin splits creator fees between ' + b.template.feeSplit.length + ' wallets' + (mine ? ' — your ★ wallet gets ' + mine.bps / 100 + '%, paid by pump.fun' : '')); }
        log('success', 'lobby: signed my buy of ' + Y.amount + ' SOL (+ ' + LAUNCH_TAX_BPS / 100 + '% launch fee)' + (extra.length ? ' + ' + extra.length + ' more wallet' + (extra.length === 1 ? '' : 's') + ' (each its own transaction)' : '') + ' of ' + short(b.template.mint) + (b.dry ? ' (rehearsal)' : ''));
      } catch (e) { log('error', 'lobby: could not sign my buy — ' + e.message); }
      return;
    }
    case 'result': {
      Y.last = { at: Date.now(), ...b }; Y.phase = 'idle';
      if (!b.dry && b.ok && Array.isArray(b.members) && b.members.length && b.slot) { const ms = b.members.filter((m) => m && typeof m === 'object'); log('success', 'result: ' + ms.filter((m) => m.ok && m.slot === b.slot).length + ' of ' + ms.length + ' wallet buys landed in block 0, ' + ms.filter((m) => m.ok && m.slot !== b.slot).length + ' just after, ' + ms.filter((m) => !m.ok).length + ' missed'); }
      if (b.dry) { cdReset(false); log('info', 'rehearsal: the launch would have fired here'); } else { CD.sent = false; CD.live = b.ok && b.createLanded !== false ? Date.now() : false; CD.slot = b.slot || null; CD.mint = b.mint || CD.mint; tick(); }
      render();
      const mine = Y.role === 'dev' || (Y.roster?.members || []).some((m) => m.wallet === address() && m.signed);
      if (b.ok && !b.dry && b.createLanded !== false && b.mint && P.armed && mine) { setArmed(false); if (!pumpOk()) log('warn', 'pre-call: sign in to pump.fun to post your callout for ' + short(b.mint)); else callout(b.mint, 'pre-call').catch((e) => log('error', e.message)); render(); }
      return;
    }
  }
}

// ---------------- launch (dev) ----------------
const L = Object.assign({ name: '', symbol: '', description: '', website: '', twitter: '', telegram: '', fees: 'me', fire: 'block0', countdown: 30, prio: 0.0005 }, ls.get('sq_pump_launch', {}));
delete L.devBuySol; Object.defineProperty(L, 'devBuySol', { get: mainAmt, enumerable: false }); // the dev buy is the ★ wallet's buy
const saveL = () => ls.set('sq_pump_launch', L);
let LOGO = ls.get('sq_logo', null); // {name,type,size,dataUrl, uri?, key?}
let launching = false;
const ALTS = { list: ls.get('sq_alts', []) }; // lookup tables this browser made: [{addr, authority, at}]
const saveAlts = () => ls.set('sq_alts', ALTS.list);
const metaKey = () => [L.name, L.symbol, L.description, L.website, L.twitter, L.telegram, LOGO?.size, LOGO?.name].join('|');
async function metadataUri() {
  if (LOGO?.uri && LOGO.key === metaKey()) return LOGO.uri;
  log('info', 'launch: uploading the image and metadata to IPFS…');
  const r = await fetch('/api/ipfs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: L.name.trim(), symbol: L.symbol.trim(), description: L.description, website: L.website, twitter: L.twitter, telegram: L.telegram, dataUrl: LOGO.dataUrl }) });
  const j = await r.json(); if (!r.ok || !j.metadataUri) throw new Error(j.error || 'metadata upload failed');
  LOGO.uri = j.metadataUri; LOGO.key = metaKey(); ls.set('sq_logo', LOGO); log('info', 'launch: metadata ' + j.metadataUri); return j.metadataUri;
}
// a lookup table holding every non-signer account of this launch, made by the dev right before it (rent comes back on reclaim)
async function makeAlt(keys) {
  const me = new PublicKey(address()); const slot = await rpc('getSlot', [{ commitment: 'finalized' }]);
  const [createIx, altAddr] = AddressLookupTableProgram.createLookupTable({ authority: me, payer: me, recentSlot: slot });
  ALTS.list.push({ addr: altAddr.toBase58(), authority: me.toBase58(), at: Date.now() }); saveAlts(); render();
  const chunks = []; for (let i = 0; i < keys.length; i += 26) chunks.push(keys.slice(i, i + 26));
  // all chunks in parallel after the first (the table must exist before it can be extended)
  const txFor = async (i) => { const ixs = [...prioIxs(60000, 0.00002), ...(i === 0 ? [createIx] : []), AddressLookupTableProgram.extendLookupTable({ payer: me, authority: me, lookupTable: altAddr, addresses: chunks[i].map((k) => new PublicKey(k)) })]; return signTx(new VersionedTransaction(new TransactionMessage({ payerKey: me, recentBlockhash: await blockhash(), instructions: ixs }).compileToV0Message())); };
  if (W.mode === 'phantom') log('warn', 'launch: approve ' + chunks.length + ' lookup-table transaction(s) in Phantom NOW');
  await sendAndConfirm(await txFor(0));
  await Promise.all(chunks.slice(1).map(async (_, j) => sendAndConfirm(await txFor(j + 1))));
  // usable once a slot has passed since the last extend — poll until every address reads back
  for (let i = 0; i < 20; i++) {
    await sleep(700);
    const a = (await getAccounts([altAddr.toBase58()]))[0];
    if (a) { const t = new AddressLookupTableAccount({ key: altAddr, state: AddressLookupTableAccount.deserialize(Buffer.from(a.data[0], 'base64')) }); if (keys.every((k) => t.state.addresses.some((x) => x.toBase58() === k))) { await sleep(800); return t; } }
  }
  throw new Error('the lookup table is not readable yet — press launch again');
}
// teammates the launch counts on: online, ready, a buy of (0, 100] SOL, and a balance that covers it with fees
const TAXED = 1 + LAUNCH_TAX_BPS / 10000; // a buy of N SOL costs N × 1.03 with the launch fee
const memberNeed = (m) => m.amount * TAXED + Math.min(MEMBER_PRIO_MAX, Number(L.prio) || 0) + 0.0045;
const teamSolOf = (m) => m.amount + (m.extra?.sol || 0); const teamNOf = (m) => 1 + (m.extra?.n || 0);
const teamReady = () => (Y.roster?.members || []).filter((m) => m.role === 'member' && m.online && m.ready && m.amount > 0 && m.amount <= 100);
const teamFunded = () => teamReady().filter((m) => m.balance != null && m.balance >= memberNeed(m));
// plan the buys: who rides inside the create, who follows, and each buy's minimum tokens out
function plan(st, wallets, team) {
  const dev = lam(L.devBuySol); let spent = dev;
  const ws = wallets.map((w) => { const l = lam(w.amount); const minOut = tokensAt(st, spent, l).muln(85).divn(100); spent += l; return { w, pk: new PublicKey(w.address), lamports: l, minOut }; });
  const planned = spent + team.reduce((s, m) => s + lam(teamSolOf(m)), 0);
  return { dev, devMinOut: tokensFor(st, dev).muln(95).divn(100), ws, planned };
}
async function launch(dry) {
  if (launching) throw new Error('already launching');
  if (!unlocked()) throw new Error('unlock your wallet first');
  if (!(Y.connected && Y.role === 'dev')) throw new Error('open a lobby first — you launch as its dev');
  if (!L.name.trim() || !L.symbol.trim()) throw new Error('name and ticker are required');
  if (!LOGO?.dataUrl) throw new Error('choose an image');
  if (!(Number(L.devBuySol) > 0)) throw new Error('set a buy on your ★ wallet (Wallets tab) — that is the dev buy');
  const devAddr = address();
  if (Y.roster?.dev && Y.roster.dev !== devAddr) throw new Error('This lobby was opened with ' + short(Y.roster.dev) + ', but your ★ wallet is now ' + short(devAddr) + '. Open a new lobby (Leave, then Open a lobby) so it uses this wallet.');
  if (!dry) {
    const ex = extraWallets(); const accs = await getAccounts([devAddr, ...ex.map((w) => w.address)]); const sol = (i) => (accs[i]?.lamports || 0) / 1e9;
    const needDev = Number(L.devBuySol) * TAXED + 0.012 + 2 * Math.min(0.05, Number(L.prio) || 0) + (L.fees === 'squad' ? 0.007 : 0) + (lockedW(activeW()) ? LOCK_COST : 0); // dev buy + lookup table (~0.008, refundable) + token account + fees
    if (sol(0) < needDev) throw new Error('Your ★ wallet ' + short(devAddr) + ' has ' + fsol(sol(0)) + ' SOL. This launch needs about ' + fsol(needDev) + ' SOL there (dev buy ' + fsol(L.devBuySol) + ' + ' + LAUNCH_TAX_BPS / 100 + '% launch fee + ~0.012 for the lookup table, token account and fees). Deposit more or lower the dev buy.');
    const low = ex.filter((w, i) => sol(i + 1) < w.amount * TAXED + 0.004 + Math.min(0.05, Number(L.prio) || 0) + (lockedW(w) ? LOCK_COST : 0));
    if (low.length) throw new Error('Not enough SOL in ' + low.map((w) => w.name + ' (has ' + fsol(sol(ex.indexOf(w) + 1)) + ', buying ' + fsol(w.amount) + ')').join(', ') + '. Each wallet needs its buy + ' + LAUNCH_TAX_BPS / 100 + '% launch fee + about 0.004 SOL. Top it up or untick it in 03.');
  }
  launching = true; cdReset(dry); render();
  try {
    const me = new PublicKey(address());
    const goLive = Math.max(0, Number(L.countdown) || 0);
    CD.at = Date.now() + goLive * 1000; CD.stage = 'uploading metadata'; tick();
    const [uri, st] = await Promise.all([metadataUri(), pump()]);
    if (L.fees === 'holders' && !st.global.isHolderRewardEnabled) throw new Error('pump.fun has holder-reward coins switched off right now — pick "me"');
    const team = teamFunded();
    const p = plan(st, extraWallets(), team);
    const mintKp = Keypair.generate();
    const built = await buildCreate(st, { mint: mintKp.publicKey, creator: me, name: L.name.trim(), symbol: L.symbol.trim().toUpperCase(), uri, holderReward: L.fees === 'holders', devLamports: p.dev, devMinOut: p.devMinOut });
    // how many of my wallets fit inside the create transaction (sized against a table holding every account)
    const buyIx = p.ws.map((x) => buyIxsFor(built.template, x.pk, x.lamports, x.minOut));
    const cuFor = (n) => Math.min(1400000, 260000 + 130000 * n);
    const msgFor = (n, alt, bh) => new TransactionMessage({ payerKey: me, recentBlockhash: bh, instructions: [...prioIxs(cuFor(n), (Number(L.prio) || 0) * (L.fire === 'safe' ? 1 : 3)), ...built.ixs, launchTaxIx(me, p.dev), ...buyIx.slice(0, n).flat(), ...(L.fire === 'safe' ? [] : [tipIx(me, BUNDLE_TIP_CREATE)])] }).compileToV0Message([alt]);
    const all = [...built.ixs, ...buyIx.flat()]; const keys = altKeysOf(all, signersOf(all));
    const planAlt = new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: { deactivationSlot: NEVER, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: keys.map((k) => new PublicKey(k)) } });
    const fakeBh = Keypair.generate().publicKey.toBase58();
    const inTx = 0; // every wallet buys in its own transaction (signed and paid by that wallet), so each shows as its own buyer
    const inside = p.ws.slice(0, inTx), after = p.ws.slice(inTx);
    log('info', 'launch: ' + L.symbol.toUpperCase() + ' · mint ' + mintKp.publicKey.toBase58() + ' · dev buy ' + fsol(L.devBuySol) + ' SOL · ' + inside.length + ' of my wallets inside the create, ' + after.length + ' wallet buys (each its own transaction), ' + team.length + ' teammate(s)');
    // the create's blockhash must be young when the relay fires: hold until ~T-25s, then make the table and sign
    if (goLive > 28) { CD.stage = 'holding'; await holdUntil(CD.at - 25000); }
    let alt = planAlt;
    if (dry) log('info', 'rehearsal: a real launch makes a lookup table here (' + keys.length + ' accounts, ~' + fsol((128 + 56 + 32 * keys.length) * 6960 / 1e9) + ' SOL rent, reclaimable)');
    else { CD.stage = 'lookup table'; tick(); alt = await makeAlt(keys); log('info', 'launch: lookup table ' + alt.key.toBase58() + ' ready'); }
    CD.stage = 'signing'; tick();
    // a rehearsal signs against a made-up blockhash: every transaction it produces is unlandable, whoever holds it
    const bh = dry ? Keypair.generate().publicKey.toBase58() : await blockhash();
    let vtx = new VersionedTransaction(msgFor(inTx, alt, bh));
    vtx.sign([mintKp]);
    if (W.mode === 'phantom') log('warn', 'launch: approve the create in Phantom NOW');
    vtx = await signTx(vtx);
    const createRaw = vtx.serialize();
    log('info', 'launch: one transaction · ' + createRaw.length + ' bytes · create + dev buy + ' + inside.length + ' wallet buy(s)');
    // simulate with signatures checked — only possible against the real table
    if (!dry) {
      CD.stage = 'simulating'; tick();
      const sim = (await rpc('simulateTransaction', [Buffer.from(createRaw).toString('base64'), { encoding: 'base64', sigVerify: true, replaceRecentBlockhash: false, commitment: 'confirmed' }]))?.value;
      if (sim?.err) throw new Error('the launch transaction would fail on chain, NOT sent: ' + JSON.stringify(sim.err) + ' — ' + tailLogs(sim.logs));
      log('success', 'launch: simulated OK on mainnet (' + (sim?.unitsConsumed || '?') + ' compute units)');
    }
    // my wallets that did not fit: ordinary transactions, fired by the relay the instant the create lands
    const template = { ...built.template, blockhash: bh, plannedLamports: p.planned, cu: 200000, prio: Number(L.prio) || 0, bundleTip: L.fire === 'safe' ? 0 : BUNDLE_TIP_BUY, lockUntil: Math.floor((CD.at || Date.now()) / 1000) + (Number(L.lockHours) || 24) * 3600 };
    const locks = [];
    if (lockedW(activeW())) locks.push(rawOf(await signTx(await lockTxFor(template, me, p.devMinOut))));
    const localTxs = [];
    for (const x of after) {
      const t = new Transaction({ feePayer: x.pk, recentBlockhash: bh }); t.add(...prioIxs(200000, L.prio), ...buyIxsFor(template, x.pk, x.lamports, x.minOut), launchTaxIx(x.pk, x.lamports), ...buyTipIxs(template, x.pk));
      if (x.w.id === 'phantom') log('warn', 'launch: approve the Phantom wallet\'s buy in Phantom NOW');
      const st2 = await signAs(x.w, t); localTxs.push(bs58.encode(st2.serialize({ requireAllSignatures: true, verifySignatures: true })));
      if (lockedW(x.w)) locks.push(rawOf(await signAs(x.w, await lockTxFor(template, x.pk, x.minOut))));
    }
    // squad fee split: the dev + every ready teammate, equal shares, signed now; the relay sends it after the block-0 buys
    let feeTx = null;
    if (L.fees === 'squad') {
      const people = [me.toBase58(), ...teamReady().map((m) => m.wallet)].filter((v, i, a) => a.indexOf(v) === i);
      if (people.length > 10) throw new Error('pump.fun splits creator fees between at most 10 wallets, and this lobby has ' + people.length + ' people. Pick "Dev wallet" or ask someone to leave.');
      if (people.length < 2) log('info', 'launch: nobody else is ready in the lobby, so the creator fees stay with your ★ wallet');
      else {
        template.feeSplit = equalShares(people);
        let ftx = new VersionedTransaction(new TransactionMessage({ payerKey: me, recentBlockhash: bh, instructions: [...prioIxs(300000, Math.min(0.001, Number(L.prio) || 0)), ...(await feeSplitIxs(new PublicKey(built.template.mint), me, template.feeSplit))] }).compileToV0Message([alt]));
        ftx = await signTx(ftx); const fraw = ftx.serialize();
        if (fraw.length > 1232) throw new Error('the fee-split transaction is too large (' + fraw.length + ' bytes)');
        feeTx = bs58.encode(fraw);
        log('info', 'launch: creator fees will be split ' + template.feeSplit.map((h) => short(h.address) + ' ' + h.bps / 100 + '%').join(', ') + ' — set right after the block-0 buys, permanently');
      }
    }
    ysend({ t: 'launch', single: true, fire: L.fire === 'safe' ? 'safe' : 'block0', template, createTx: bs58.encode(createRaw), preTxs: [], localTxs, tip: 0, dry, mint: built.template.mint, fireAt: CD.at, feeTx, locks });
    if (locks.length) log('info', 'launch: ' + locks.length + ' of my wallets will lock their tokens on Streamflow until ' + new Date(template.lockUntil * 1000).toLocaleString());
    Y.phase = 'launching'; CD.mint = built.template.mint; CD.stage = ''; CD.handed = true; tick();
    log('success', (dry ? 'rehearsal: ' : '') + 'handed to the lobby — ' + team.length + ' teammate(s) signing · goes live ' + (CD.at > Date.now() + 1000 ? 'in ' + fmtCd((CD.at - Date.now()) / 1000) + 's' : 'as soon as the signatures are in'));
  } catch (e) { cdReset(dry); throw e; }
  finally { launching = false; render(); }
}
// lookup tables: deactivate, then (~513 slots later) close and get the rent back
async function reclaimAlts() {
  const me = address(); if (!me || !unlocked()) throw new Error('unlock the wallet that launched first');
  const mine = ALTS.list.filter((a) => a.authority === me); if (!mine.length) throw new Error('no lookup tables from this wallet');
  const accs = await getAccounts(mine.map((a) => a.addr)); const slot = await rpc('getSlot', [{ commitment: 'finalized' }]);
  const ixs = []; let waiting = 0;
  mine.forEach((a, i) => {
    const acc = accs[i]; if (!acc) { ALTS.list = ALTS.list.filter((x) => x.addr !== a.addr); return; }
    const t = AddressLookupTableAccount.deserialize(Buffer.from(acc.data[0], 'base64')); const key = new PublicKey(a.addr), auth = new PublicKey(me);
    if (Date.now() - a.at < 120000) { waiting++; return; } // a table this fresh may still be in use by a launch
    if (t.deactivationSlot === NEVER) ixs.push(AddressLookupTableProgram.deactivateLookupTable({ lookupTable: key, authority: auth }));
    else if (BigInt(slot) > t.deactivationSlot + 513n) ixs.push(AddressLookupTableProgram.closeLookupTable({ lookupTable: key, authority: auth, recipient: auth }));
    else waiting++;
  });
  saveAlts();
  if (!ixs.length) { log('info', 'lookup tables: nothing to do yet' + (waiting ? ' — ' + waiting + ' cooling down, try again in a few minutes' : '')); render(); return; }
  for (let i = 0; i < ixs.length; i += 10) { const tx = await signTx(new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(me), recentBlockhash: await blockhash(), instructions: ixs.slice(i, i + 10) }).compileToV0Message())); log('info', 'lookup tables: ' + await sendAndConfirm(tx)); }
  log('success', 'lookup tables: ' + ixs.length + ' step(s) done' + (waiting ? ', ' + waiting + ' still cooling down' : '') + ' — closed tables return their rent');
  setTimeout(refreshBalances, 3000); render();
}

// ---------------- pump.fun callouts (session stays in this browser; /api/pump only proxies) ----------------
// pre-call: each person arms their OWN callout; it posts once, when their next launch lands, then disarms itself
const P = { sess: ls.get('sq_pump', null), text: ls.get('sq_callout', ''), armed: ls.get('sq_precall', false), busy: false, last: null };
const setArmed = (v) => { P.armed = !!v; ls.set('sq_precall', P.armed); }; // automatic squad-wide callouts are off: pump.fun's callout reward terms ban coordinated buying/selling around calls
const pumpOk = () => !!(P.sess && P.sess.address === address() && P.sess.expiresAt > Date.now());
async function pumpLogin() {
  if (!unlocked()) throw new Error('unlock your wallet first');
  const timestamp = Date.now(); const signature = await signMessage(enc.encode('Sign in to pump.fun: ' + timestamp));
  const r = await fetch('/api/pump', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'login', address: address(), signature, timestamp }) });
  const j = await r.json(); if (!r.ok || !j.jwt) throw new Error(j.error || 'login failed');
  P.sess = { jwt: j.jwt, expiresAt: j.expiresAt, address: address(), profile: j.profile }; ls.set('sq_pump', P.sess);
  log('success', 'pump.fun: signed in as ' + (j.profile?.username || short(address())));
}
function pumpLogout() { P.sess = null; ls.del('sq_pump'); log('info', 'pump.fun: signed out'); }
// retries while pump.fun hasn't indexed the brand-new coin yet (PRICE_UNAVAILABLE / INSUFFICIENT_BALANCE right after launch)
async function callout(mint, why) {
  if (!pumpOk()) throw new Error('sign in to pump.fun first');
  if (!P.text.trim()) throw new Error('write your callout first');
  if (P.busy) throw new Error('a callout is already in flight');
  P.busy = true; render();
  try {
    const deadline = Date.now() + 180000; let attempt = 0, last = '';
    for (;;) {
      attempt++;
      const r = await fetch('/api/pump', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'callout', jwt: P.sess.jwt, mint, thesis: P.text.trim() }) });
      const j = await r.json(); last = j.body || j.error || '';
      if (j.ok) { P.last = { at: Date.now(), ok: true, mint }; log('success', 'pump.fun: callout live for ' + short(mint) + (attempt > 1 ? ' (try ' + attempt + ')' : '') + ' — ' + why); return; }
      if (j.expired) { pumpLogout(); throw new Error('pump.fun session expired — sign in again'); }
      if (!j.retryable || Date.now() + 4000 > deadline) { P.last = { at: Date.now(), ok: false, mint, err: last }; throw new Error('pump.fun refused: ' + last.slice(0, 160)); }
      let why2 = 'not indexed yet'; try { why2 = JSON.parse(last).error || why2; } catch {}
      log('warn', 'pump.fun: ' + why2 + ' — retry ' + attempt); await sleep(4000);
    }
  } finally { P.busy = false; render(); }
}

// ---------------- render ----------------
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const show = (id, on) => $(id).classList.toggle('hide', !on);
const val = (id, v) => { if (document.activeElement !== $(id)) $(id).value = v ?? ''; };
function render() {
  const addr = address(); const vault = W.mode === 'launch';
  $('#wBal').textContent = addr ? (W.balance == null ? '…' : fsol(W.balance) + ' SOL') : '—';
  $('#tWallet').innerHTML = ''; $('#tWallet').append(el('i', 'dot' + (unlocked() ? ' on' : '')), document.createTextNode(unlocked() ? short(addr) : 'none'));
  $('#tLobby').innerHTML = ''; $('#tLobby').append(el('i', 'dot' + (Y.connected ? (Y.phase === 'launching' ? ' hot' : ' on') : '')), document.createTextNode(Y.code ? Y.code + ' · ' + (Y.role === 'dev' ? 'dev' : 'member') : 'none'));
  // vault table
  $('#vState').textContent = A.key ? (A.saving ? 'saving…' : A.dirty ? 'unsaved changes' : sols().length ? 'saved to your account' : '') : '';
  $('#tAcct').innerHTML = ''; $('#tAcct').append(el('i', 'dot' + (A.key ? ' on' : '')), document.createTextNode(A.key ? (A.kind === 'wallet' ? short(A.name) : A.name) : 'signed out')); show('#logoutBtn', !!A.key);
  const lg = A.key ? legacy() : []; show('#legacyBox', lg.length > 0 && !ls.get('sq_legacy_skip', false));
  if (lg.length) $('#legacyMsg').textContent = lg.length + ' wallet' + (lg.length === 1 ? ' is' : 's are') + ' saved in this browser from before accounts (' + lg.map((w) => w.name).join(', ') + '). Enter the vault password you used then to move them into your account.';
  const box = $('#vList'); box.innerHTML = '';
  const rows = [...sols(), ...(W.phantomPk || injected() ? [phW()] : [])];
  if (!rows.length) { const tr = el('tr'); const td = el('td', 'empty', 'No wallets yet — press “+ Create wallet”.'); td.colSpan = 7; tr.append(td); box.append(tr); }
  for (const w of rows) {
    const isPh = w.id === 'phantom', star = w.id === V.active.sol, can = isPh ? !!W.phantomPk : V.keys.has(w.id);
    const tr = el('tr', can || isPh ? (star ? 'me' : '') : 'locked');
    const ck = el('input'); ck.type = 'checkbox'; ck.title = 'buys in my launches'; ck.checked = star || !!w.on; ck.disabled = star || !can;
    ck.onchange = () => { if (isPh) { PH.on = ck.checked; savePH(); } else { w.on = ck.checked; saveV(); } sendAmount(); render(); };
    const st = el('button', 'star' + (star ? ' on' : ''), '★'); st.title = 'my main wallet (creator when I host)'; st.disabled = !can;
    st.onclick = () => { if (star) return; if (Y.code) { if (!confirm('Your ★ wallet is who you are in lobby ' + Y.code + '. Switching leaves the lobby — continue?')) return; lobbyLeave(false); } V.active.sol = w.id; saveV(); render(); refreshBalances(); };
    const name = el('td'); const nm = el('span', 'nm', w.name); name.append(nm); if (isPh) name.append(el('span', 'tag phm', 'sign-in wallet · signs in Phantom')); if (star) name.append(el('span', 'tag ok', 'main'));
    if (!isPh && !V.keys.has(w.id)) name.append(el('span', 'tag', 'locked'));
    const ad = el('div', 'addr', w.address ? short(w.address) : 'not connected'); if (w.address) { ad.title = w.address; const cp = el('button', null, 'copy'); cp.onclick = () => navigator.clipboard?.writeText(w.address).then(() => { cp.textContent = 'copied ✓'; setTimeout(() => (cp.textContent = 'copy'), 1200); }); ad.append(cp); } name.append(ad);
    const amtTd = el('td', 'r'); const amt = el('input', 'buy'); amt.type = 'number'; amt.step = '0.01'; amt.min = '0'; amt.placeholder = '0.00'; amt.value = w.amount || ''; amt.disabled = !(star || w.on) || !can;
    amt.onchange = () => { const n = Number(amt.value); const v = Number.isFinite(n) && n > 0 && n <= 100 ? n : 0; if (n > 100) alert('a buy is at most 100 SOL'); if (isPh) { PH.amount = v; savePH(); } else { w.amount = v; saveV(); } sendAmount(); render(); }; amtTd.append(amt);
    const lkTd = el('td', 'r'); const lk = el('input'); lk.type = 'checkbox'; lk.className = 'lk'; lk.checked = lockedW(w); lk.disabled = !(star || w.on) || !can;
    lk.title = 'Lock this wallet\'s tokens on Streamflow right after its buy lands, until the lobby\'s lock time. Nobody can unlock early. Costs ' + LOCK_COST.toFixed(3) + ' SOL + ' + LOCK_FEE_PCT + '% of the tokens (Streamflow\'s fee).';
    lk.onchange = () => { if (isPh) { PH.lock = lk.checked; savePH(); } else { w.lock = lk.checked; saveV(); } render(); }; lkTd.append(lk);
    const acts = el('div', 'acts');
    if (isPh && !W.phantomPk) { const c = el('button', 'btn sm', 'Connect'); c.onclick = () => phantomConnect().then(() => { render(); refreshBalances(); }).catch((e) => alert(e.message)); acts.append(c); }
    else { const sb = el('button', 'btn sm', 'Send'); sb.disabled = !can; sb.onclick = () => xferOpen(isPh ? 'phantom' : 'w:' + w.id); acts.append(sb); if (!isPh) { const mg = el('button', 'btn ghost sm', V.sel === w.id ? 'close' : '⋯'); mg.title = 'private key, remove'; mg.onclick = () => { V.sel = V.sel === w.id ? null : w.id; render(); }; acts.append(mg); } }
    const c0 = el('td'); c0.append(ck); const c1 = el('td'); c1.append(st); const c5 = el('td', 'r'); c5.append(acts);
    tr.append(c0, c1, name, el('td', 'r bal', w.address ? (V.bal[w.address] == null ? '…' : fsol(V.bal[w.address])) : '—'), amtTd, lkTd, c5); box.append(tr);
  }
  const tot = rows.reduce((a, w) => a + (w.address ? V.bal[w.address] || 0 : 0), 0); $('#wTotal').textContent = rows.length ? fsol(Math.round(tot * 1e4) / 1e4) : '—';
  { const ex = extraWallets(); const buys = mainAmt() + ex.reduce((a, w) => a + w.amount, 0); $('#wSum').innerHTML = ''; for (const [k, v] of [['★ main', activeW() ? activeW().name + ' · ' + fsol(mainAmt()) + ' SOL' : 'none'], ['other wallets buying', ex.length + ' · ' + fsol(ex.reduce((a, w) => a + w.amount, 0)) + ' SOL'], ['my total buys', fsol(buys) + ' SOL']]) { const sp = el('span'); sp.append(document.createTextNode(k + ' '), el('b', null, v)); $('#wSum').append(sp); } }
  const selW = sols().find((w) => w.id === V.sel); show('#vManage', !!selW);
  if (selW) $('#vmName').textContent = selW.name + ' · ' + selW.address;
  renderXfer();
  $('#altCount').textContent = ALTS.list.length ? '(' + ALTS.list.length + ')' : ''; show('#altBox', ALTS.list.length > 0);
  $('#wStatus').textContent = unlocked() ? 'ready · ' + short(addr) : 'not ready';
  // my wallets in the launch
  const lb = $('#lWallets'); lb.innerHTML = ''; const mineList = [...(activeW() ? [{ ...activeW(), amount: mainAmt(), main: true }] : []), ...extraWallets()];
  if (!mineList.length || !(mainAmt() > 0 || extraWallets().length)) { const tr = el('tr'); const td = el('td', 'empty', 'No buys set — pick your wallets and amounts in the Wallets tab.'); td.colSpan = 3; tr.append(td); lb.append(tr); }
  else for (const w of mineList) { const tr = el('tr'); const n = el('td'); n.append(document.createTextNode((w.main ? '★ ' : '') + w.name), el('span', 'tag', short(w.address))); if (lockedW(w)) n.append(el('span', 'tag ok', 'locks')); tr.append(n, el('td', 'r m', w.address && V.bal[w.address] != null ? fsol(V.bal[w.address]) + ' held' : ''), el('td', 'r m', fsol(w.amount) + ' SOL')); lb.append(tr); }
  // lobby
  const inL = !!Y.code; show('#yOut', !inL); show('#yIn', inL);
  val('#yName', Y.name);
  $('#yState').textContent = Y.connected ? (Y.phase === 'launching' ? 'launching' : 'connected') : (inL ? 'connecting…' : 'not connected');
  $('#yCreate').disabled = !unlocked(); $('#yJoin').disabled = !unlocked();
  if (inL) {
    $('#yCodeShow').textContent = Y.code; $('#yRole').textContent = Y.role === 'dev' ? 'you are the dev' : 'member';
    show('#yMemberCtl', Y.role === 'member'); show('#yDevCtl', Y.role === 'dev'); show('#yAbort', Y.role === 'dev' && Y.phase === 'launching');
    const r = Y.roster; const box2 = $('#yRoster'); box2.innerHTML = '';
    if (r) {
      val('#yWait', Math.round((r.policy?.waitMs || 8000) / 1000)); const me = r.members.find((m) => m.wallet === r.you); if (me?.role === 'member') $('#yReady').checked = !!me.ready;
      for (const m of r.members) {
        const tr = el('tr', m.wallet === r.you ? 'me' : ''); if (!m.online) tr.style.opacity = '.5';
        const need = m.role === 'member' ? memberNeed(m) : Number(L.devBuySol || 0) + 0.03;
        const isShort = m.balance != null && m.balance < need;
        const nm = el('td'); nm.append(document.createTextNode((m.role === 'dev' ? '★ ' : '') + m.name + (m.wallet === r.you ? ' (you)' : '') + (m.online ? '' : ' · offline')));
        if (isShort) nm.append(el('span', 'tag bad', 'short — needs ~' + fsol(need)));
        nm.append(el('div', 'm', short(m.wallet))); nm.lastChild.style.color = 'var(--mute)';
        const pip = (on) => { const td = el('td', 'r'); td.append(el('span', 'pip' + (on ? ' on' : ''))); return td; };
        const x = el('td', 'r'); if (Y.role === 'dev' && m.role === 'member') { const b = el('button', 'x', '×'); b.title = 'remove'; b.onclick = () => { if (confirm('Remove ' + m.name + '?')) ysend({ t: 'kick', wallet: m.wallet }); }; x.append(b); }
        tr.append(nm, el('td', 'r m', m.balance != null ? fsol(m.balance) : '…'), el('td', 'r m', m.role === 'dev' ? 'creator' : fsol(m.amount) + (m.extra ? ' + ' + m.extra.n + ' wallet' + (m.extra.n === 1 ? '' : 's') + ' · ' + fsol(m.extra.sol) : '')), pip(m.role === 'dev' || m.ready), pip(m.signed), x); box2.append(tr);
      }
    }
  }
  { const r = Y.last; let txt = ''; if (r) { const ms = (r.members || []).filter((m) => m && typeof m === 'object'); const b0 = ms.filter((m) => m.ok && r.slot && m.slot === r.slot).length, inN = ms.filter((m) => m.ok).length; txt = 'last: ' + new Date(r.at).toLocaleTimeString() + ' · ' + (r.dry ? 'rehearsal assembled — nothing sent' : r.ok ? 'LIVE' + (r.mint ? ' · ' + short(r.mint) : '') + (ms.length ? ' · ' + inN + '/' + ms.length + ' wallet buys in' + (r.slot ? ' · ' + b0 + ' in block 0' : '') : '') : 'failed — ' + (r.error || 'dropped')); } $('#yLast').textContent = txt; }
  // coin form
  const devHere = Y.connected && Y.role === 'dev';
  $('#launchCard').classList.toggle('off', !devHere);
  $('#lHint').textContent = devHere ? 'You are the dev of lobby ' + Y.code + '. Fill this in, rehearse, then launch — ready teammates sign on their own.' : 'Host a lobby to launch as its dev. Teammates don\'t need this section.';
  for (const k of ['name', 'symbol', 'description', 'website', 'twitter', 'telegram']) val('#l_' + k, L[k]);
  $('#lNameCnt').textContent = L.name.length + '/32'; $('#lSymCnt').textContent = L.symbol.length + '/13';
  document.querySelectorAll('#lFees button').forEach((b) => b.classList.toggle('on', b.dataset.v === L.fees));
  $('#lFeesNote').textContent = L.fees === 'holders' ? 'Holder-rewards coin: the creator fee on every trade is paid out to holders by pump.fun. Permanent.' : L.fees === 'squad' ? 'The creator fee on every trade is split equally between you and every teammate in the lobby (max 10 people), set on pump.fun right after the block-0 buys and locked for good. Costs ~0.006 SOL.' : 'Regular coin: the creator fee on every trade goes to your ★ wallet (claim it on pump.fun).';
  val('#lCountdown', L.countdown); val('#lPrio', L.prio); if(document.activeElement!==$('#lDevBuy')) $('#lDevBuy').value = mainAmt() || '';
  document.querySelectorAll('#lFireMode button').forEach((b) => b.classList.toggle('on', b.dataset.v === (L.fire === 'safe' ? 'safe' : 'block0')));
  document.querySelectorAll('#lLock button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === (Number(L.lockHours) || 24)));
  $('#lFireNote').textContent = L.fire === 'safe' ? 'Every wallet buys the instant the coin is seen on chain — usually the next block, never too early.' : 'Every wallet\'s buy goes out with the create. The create pays 3× the priority so the leader runs it first; a buy that reaches the leader before the coin exists fails and costs only its fee.';
  $('#lLogoInfo').textContent = LOGO ? LOGO.name + ' · ' + (LOGO.size / 1024).toFixed(0) + ' KB' : 'PNG, JPEG, WebP or GIF, square, up to 2 MB';
  $('#lLogoPrev').style.backgroundImage = LOGO ? 'url("' + LOGO.dataUrl + '")' : '';
  // launch control
  const team = devHere ? teamFunded() : teamReady();
  const mine = extraWallets(); const mineSol = mine.reduce((s, w) => s + w.amount, 0); const teamSol = team.reduce((s, m) => s + teamSolOf(m), 0); const teamN = team.reduce((s, m) => s + teamNOf(m), 0);
  $('#ctlRole').textContent = !Y.connected ? '—' : Y.role === 'dev' ? 'dev · ' + Y.code : 'member · ' + Y.code;
  $('#sDev').textContent = devHere ? fsol(L.devBuySol) + ' SOL' : '—';
  $('#sMine').textContent = devHere ? mine.length + ' · ' + fsol(mineSol) + ' SOL' : '—';
  $('#sTeam').textContent = Y.connected ? team.length + ' people · ' + teamN + ' wallets · ' + fsol(teamSol) + ' SOL' : '—';
  $('#sTotal').textContent = Y.connected ? fsol((devHere ? Number(L.devBuySol) || 0 : 0) + mineSol * (devHere ? 1 : 0) + teamSol) + ' SOL' : '—';
  $('#sTax').textContent = devHere ? 'you ' + fsol(((Number(L.devBuySol) || 0) + mineSol) * (TAXED - 1)) + ' SOL · squad ' + fsol(((Number(L.devBuySol) || 0) + mineSol + teamSol) * (TAXED - 1)) + ' SOL' : Y.connected ? fsol((Number(Y.amount) || 0) * (TAXED - 1)) + ' SOL on your ★ buy' : '—';
  $('#sCost').textContent = devHere ? 'table ~0.008 back · create ' + fsol((Number(L.prio) || 0) * (L.fire === 'safe' ? 1 : 3)) + ' · ' + fsol(L.prio) + '/wallet' : '—';
  const why = !unlocked() ? 'Unlock a wallet first.' : !Y.connected ? 'Open or join a lobby.' : Y.role !== 'dev' ? 'Only the dev launches. Tick ready and keep this tab open.' : !L.name.trim() || !L.symbol.trim() ? 'Name and ticker are missing.' : !LOGO ? 'Choose an image.' : !(Number(L.devBuySol) > 0) ? 'Set a dev buy.' : '';
  $('#lWhy').textContent = launching ? 'launching…' : why;
  $('#lFire').disabled = launching || !!why; $('#lRehearse').disabled = launching || !!why;
  $('#lFire').textContent = launching ? 'Launching…' : 'Launch' + (devHere ? ' · ' + (1 + mine.length + teamN) + (mine.length + teamN ? ' wallets' : ' wallet') : '');
  // callouts
  const ok = pumpOk();
  $('#cState').textContent = P.busy ? 'posting…' : ok ? 'signed in' : P.sess && P.sess.address !== address() ? 'signed in with another wallet' : 'not signed in';
  $('#cWho').textContent = ok ? (P.sess.profile?.username ? P.sess.profile.username + ' · ' : '') + short(P.sess.address) : '—';
  show('#cLogin', !ok); show('#cLogout', ok); $('#cLogin').disabled = !unlocked();
  val('#cText', P.text); $('#cCnt').textContent = P.text.length + '/500'; const pre = $('#cPre'); pre.textContent = P.armed ? 'Pre-called ✓ · tap to cancel' : 'Pre-call'; pre.classList.toggle('pri', !P.armed); pre.disabled = P.busy || (!P.armed && (!ok || !P.text.trim()));
  $('#cArmed').textContent = P.armed ? 'Armed: your callout posts by itself when the coin from your next launch lands in your ★ wallet.' : !ok ? 'Sign in to pump.fun, write your callout, then pre-call.' : !P.text.trim() ? 'Write your callout, then pre-call.' : 'Ready to pre-call.';
  $('#cLast').textContent = P.last ? 'last: ' + new Date(P.last.at).toLocaleTimeString() + ' · ' + (P.last.ok ? 'callout live · ' + P.last.mint : 'failed — ' + (P.last.err || '').slice(0, 120)) : '';
  tick();
}

// ---------------- launched on arenalaunch (public showcase, from the relay) ----------------
const ago = (t) => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 90 ? 'just now' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 129600 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; };
async function loadShowcase() {
  try {
    await gateToken(); const j = await (await fetch(Y.relay + '/launches')).json(); const list = (j.launches || []).filter((x) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x.mint || ''));
    const box = $('#lcList'); box.innerHTML = ''; show('#secLaunched', list.length > 0); $('#lcCount').textContent = list.length ? list.length + ' coin' + (list.length === 1 ? '' : 's') : '';
    for (const c of list) {
      const a = el('a', 'coin'); a.href = 'https://pump.fun/coin/' + c.mint; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = c.mint;
      if (c.image && String(c.image).startsWith('https://')) { const im = el('img'); im.src = c.image; im.alt = ''; im.loading = 'lazy'; im.referrerPolicy = 'no-referrer'; im.onerror = () => im.replaceWith(el('span', 'ph')); a.append(im); } else a.append(el('span', 'ph'));
      const t = el('div', 't'); t.append(el('div', 'nm', c.name || short(c.mint)), el('div', 'tk', (c.symbol ? '$' + c.symbol + ' · ' : '') + ago(c.t))); a.append(t); box.append(a);
    }
  } catch {}
}

// ---------------- wire up ----------------
const fail = (where) => (e) => { log('error', where + ': ' + e.message); alert(e.message); };
function bind() {
  // theme: follows the system unless picked; remembered
  const th = ls.get('sq_theme', null); if (th) document.documentElement.dataset.theme = th;
  $('#themeBtn').onclick = () => { const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; const t = dark ? 'light' : 'dark'; document.documentElement.dataset.theme = t; ls.set('sq_theme', t); };
  // vault
  $('#vCreate').onclick = () => { try { vaultAdd($('#vName').value, null); $('#vName').value = ''; refreshBalances(); } catch (e) { alert(e.message); } };
  // account
  const amsg = (t, err) => { $('#aMsg').textContent = t; $('#aMsg').className = 'note' + (err ? ' err' : ''); };
  $('#aWallet').onclick = async () => { $('#aWallet').disabled = true; amsg('approve the two signatures in Phantom…'); try { await walletLogin(); amsg(''); } catch (e) { amsg(e.message, true); report('sign-in: ' + e.message); } finally { $('#aWallet').disabled = false; } };
  // email sign-in: email → code → password (a new account sets one, twice)
  const em = (step) => { for (const id of ['#eStep1', '#eStep2', '#eStep3']) show(id, id === step); };
  const busy = async (btn, msg, fn) => { $(btn).disabled = true; amsg(msg); try { await fn(); } catch (e) { amsg(e.message, true); if (e.status !== 401) report('sign-in: ' + e.message); } finally { $(btn).disabled = false; } };
  $('#aEmail').onclick = () => { show('#emailBox', true); em('#eStep1'); $('#eAddr').focus(); };
  $('#eSend').onclick = () => busy('#eSend', 'sending a code…', async () => { await emailSend($('#eAddr').value); $('#eSentTo').textContent = E.email; em('#eStep2'); amsg('check your inbox (and spam) for a 6-digit code'); $('#eCode').focus(); });
  $('#eVerify').onclick = () => busy('#eVerify', 'checking the code…', async () => {
    const exists = await emailCheck($('#eCode').value); show('#ePw2Row', !exists);
    $('#ePwNote').textContent = exists ? 'Enter your password.' : 'New account: choose a password (10+ characters). It also locks your saved wallets, so nobody can reset it, us included. If you forget it, your saved wallets are gone. Write it down.';
    em('#eStep3'); amsg(''); $('#ePw').focus();
  });
  $('#eLogin').onclick = () => busy('#eLogin', 'signing in…', async () => { await emailLogin($('#eCode').value, $('#ePw').value, $('#ePw2').value); $('#ePw').value = $('#ePw2').value = $('#eCode').value = ''; show('#emailBox', false); amsg(''); });
  $('#eBack').onclick = () => { em('#eStep1'); amsg(''); };
  for (const [inp, btn] of [['#eAddr', '#eSend'], ['#eCode', '#eVerify'], ['#ePw', '#eLogin'], ['#ePw2', '#eLogin']]) $(inp).addEventListener('keydown', (e) => { if (e.key === 'Enter') $(btn).click(); });
  $('#logoutBtn').onclick = async () => { if (A.dirty) await flushVault(); signOut(false); };
  $('#legacyGo').onclick = () => importLegacy($('#legacyPw').value).then(() => { $('#legacyPw').value = ''; render(); refreshBalances(); }).catch((e) => alert(e.message));
  $('#legacySkip').onclick = () => { ls.set('sq_legacy_skip', true); render(); };
  window.addEventListener('beforeunload', (e) => { if (A.dirty || A.saving) { flushVault(); e.preventDefault(); } });
  const selW = () => sols().find((w) => w.id === V.sel);
  $('#vmExport').onclick = () => { const w = selW(); if (!w || !confirm('Show the private key of ' + w.name + ' on screen? Anyone who sees it controls the wallet.')) return; $('#vmOut').textContent = bs58.encode(keyOf(w).secretKey); log('warn', 'private key of ' + w.name + ' is on screen — hide it when done'); };
  $('#vmClear').onclick = () => { $('#vmOut').textContent = ''; };
  $('#vmRemove').onclick = () => { const w = selW(); if (!w) return; if (confirm('Remove ' + w.name + ' from your account? Withdraw or copy its private key FIRST — this cannot be undone.')) { vaultRemove(w); $('#vmOut').textContent = ''; render(); } };
  $('#wRefresh').onclick = refreshBalances;
  // tabs: Launch | Wallets (remembered)
  const tab = (t) => { document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t)); show('#tabWallets', t === 'wallets'); show('#tabLaunch', t === 'launch'); ls.set('sq_tab', t); if (t === 'wallets') refreshBalances(); };
  document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => tab(b.dataset.tab))); tab(ls.get('sq_tab', 'launch') === 'wallets' ? 'wallets' : 'launch');
  $('#goWallets').onclick = (e) => { e.preventDefault(); tab('wallets'); };
  // the import field is only put on the page when someone asks to import (keeps key fields out of the page until then)
  const showImport = () => { if (!$('#vImportKey')) { const row = el('div', 'row'); const f = el('div', 'f'); f.append(el('label', null, 'Import a wallet you already have — its key is encrypted in this browser and never leaves it')); const inp = el('input'); inp.id = 'vImportKey'; inp.type = 'password'; inp.autocomplete = 'off'; inp.placeholder = 'base58 or [1,2,…]'; f.append(inp); const g = el('div', 'f xs'); const b = el('button', 'btn', 'Import'); b.id = 'vImport'; g.append(b); row.append(f, g); $('#vImportRow').append(row);
    $('#vImport').onclick = () => { const s = $('#vImportKey').value; if (!s.trim()) return alert('paste a private key'); try { vaultAdd($('#vName').value, s); $('#vImportKey').value = ''; $('#vName').value = ''; refreshBalances(); } catch (e) { alert(/already|sign in/.test(e.message) ? e.message : 'invalid private key (base58 or [..] array)'); } }; } };
  $('#vImportBtn').onclick = () => { $('#vAdd').open = true; showImport(); $('#vImportKey').focus(); };
  document.querySelectorAll('#lFireMode button').forEach((b) => (b.onclick = () => { L.fire = b.dataset.v; saveL(); render(); }));
  document.querySelectorAll('#lLock button').forEach((b) => (b.onclick = () => { L.lockHours = Number(b.dataset.v); saveL(); render(); }));
  $('#tOpen').onclick = () => xferOpen();
  $('#tDeposit').onclick = () => xferOpen('phantom', V.active.sol ? 'w:' + V.active.sol : null);
  $('#tClose').onclick = () => { T.open = false; render(); };
  $('#tSwap').onclick = () => { T.picked = true; const f = T.from; T.from = T.to === 'other' ? T.from : T.to; T.to = f; renderXfer(); };
  $('#tFrom').onchange = () => { T.picked = true; T.from = $('#tFrom').value; $('#tFrom').blur(); renderXfer(); };
  $('#tTo').onchange = () => { T.picked = true; T.to = $('#tTo').value; $('#tTo').blur(); renderXfer(); };
  $('#tToAddr').addEventListener('input', renderXfer); $('#tAmt').addEventListener('input', renderXfer);
  let pvtDebounce = null;
  const maybeEstimate = () => { if (T.mode === 'private') { T.est = null; renderXfer(); clearTimeout(pvtDebounce); pvtDebounce = setTimeout(pvtEstimate, 600); } };
  document.querySelectorAll('#xfer .chips button').forEach((c) => (c.onclick = () => { const p = Number(c.dataset.p); $('#tAmt').value = p === 100 ? tMax() : Math.floor(tMax() * p / 100 * 1e6) / 1e6; renderXfer(); maybeEstimate(); }));
  $('#tGo').onclick = () => { if (T.mode === 'private') pvtCreate().catch((e) => { $('#tMsg').textContent = e.message; }); else xferSend().catch((e) => { $('#tMsg').textContent = e.message; }); };
  // mode toggle
  document.querySelectorAll('#tMode button').forEach((b) => (b.onclick = () => { T.mode = b.dataset.m; T.est = null; pvtReset(); renderXfer(); if (T.mode === 'private') { clearTimeout(pvtDebounce); pvtDebounce = setTimeout(pvtEstimate, 400); } }));
  $('#tAmt').addEventListener('input', maybeEstimate);
  $('#pvtSend').onclick = () => pvtDeposit().catch((e) => { $('#tMsg').textContent = e.message; });
  $('#pvtCopy').onclick = () => { const a = T.order?.payinAddress; if (a) navigator.clipboard?.writeText(a).then(() => { $('#pvtCopy').textContent = '✓'; setTimeout(() => ($('#pvtCopy').textContent = '📋'), 1200); }); };
  $('#vAddBtn').onclick = () => { $('#vAdd').open = true; $('#vName').focus(); };
  $('#altReclaim').onclick = () => reclaimAlts().catch(fail('lookup tables'));
  // lobby
  $('#yName').onchange = () => { Y.name = $('#yName').value.trim().slice(0, 24); ls.set('sq_name', Y.name); if (Y.connected) ysend({ t: 'name', name: Y.name }); };
  $('#yReady').onchange = () => ysend({ t: 'ready', ready: $('#yReady').checked });
  $('#yWait').onchange = () => ysend({ t: 'policy', waitMs: Number($('#yWait').value) * 1000 });
  $('#yCreate').onclick = async () => { try { await gateToken(); const r = await (await fetch(Y.relay + '/lobby/create', { method: 'POST', headers: { 'x-gate': Y.token, 'content-type': 'application/json' }, body: JSON.stringify({ chain: 'sol' }) })).json(); if (!r.code) throw new Error(r.error || 'relay'); await lobbyConnect(r.code, 'dev'); log('info', 'lobby ' + r.code + ' open — share the code or the invite link'); } catch (e) { report('open lobby: ' + e.message); alert(e.message); } };
  $('#yJoin').onclick = () => { const c = $('#yCode').value.trim().toUpperCase(); if (!/^[A-Z2-9]{6}$/.test(c)) return alert('codes are 6 characters'); lobbyConnect(c, 'member').catch((e) => { report('join lobby: ' + e.message); alert(e.message); }); };
  $('#yCode').onkeydown = (e) => { if (e.key === 'Enter') $('#yJoin').click(); };
  $('#yLeave').onclick = () => { if (confirm('Leave the lobby?')) lobbyLeave(false); };
  $('#yAbort').onclick = () => { if (confirm('Abort the launch?')) ysend({ t: 'abort' }); };
  const flash = (id, txt, back) => { $(id).textContent = txt; setTimeout(() => ($(id).textContent = back), 1300); };
  $('#yCopy').onclick = () => navigator.clipboard?.writeText(Y.code || '').then(() => flash('#yCopy', 'copied', 'copy'));
  $('#yLink').onclick = () => navigator.clipboard?.writeText(location.origin + '/?join=' + (Y.code || '')).then(() => flash('#yLink', 'link copied', 'invite link'));
  // ?join=CODE invite links prefill the code (the site password is still required first)
  const j = new URLSearchParams(location.search).get('join'); if (j && /^[A-Z2-9]{6}$/i.test(j)) { $('#yCode').value = j.toUpperCase(); log('info', 'invite for lobby ' + j.toUpperCase() + ' — unlock your wallet, set your buy, then Join'); history.replaceState(null, '', '/'); }
  // callouts
  $('#cLogin').onclick = () => pumpLogin().then(render).catch(fail('pump.fun'));
  $('#cLogout').onclick = () => { pumpLogout(); render(); };
  $('#cText').addEventListener('input', () => { P.text = $('#cText').value.slice(0, 500); ls.set('sq_callout', P.text); $('#cCnt').textContent = P.text.length + '/500'; });
  $('#cPre').onclick = () => { if (P.armed) { setArmed(false); log('info', 'pre-call cancelled'); } else { if (!pumpOk()) return alert('Sign in to pump.fun first'); if (!P.text.trim()) return alert('Write your callout first'); setArmed(true); log('success', 'pre-called: your callout posts when the coin from your next launch lands'); } render(); };
  // coin form
  const lim = { name: 32, symbol: 13, description: 500 };
  for (const k of ['name', 'symbol', 'description', 'website', 'twitter', 'telegram']) $('#l_' + k).addEventListener('input', () => { L[k] = $('#l_' + k).value.slice(0, lim[k] || 200); saveL(); render(); });
  document.querySelectorAll('#lFees button').forEach((b) => (b.onclick = () => { L.fees = b.dataset.v; saveL(); render(); }));
  $('#lDevBuy').oninput = () => setMainAmt($('#lDevBuy').value);
  $('#lCountdown').onchange = () => { L.countdown = Math.min(600, Math.max(0, Math.round(Number($('#lCountdown').value) || 0))); saveL(); render(); };
  $('#lPrio').onchange = () => { L.prio = Math.min(0.05, Math.max(0, Number($('#lPrio').value) || 0)); saveL(); render(); };
  $('#goLive').onclick = () => { if (launching && !CD.handed && CD.at && confirm('Cancel this launch? Nothing has been sent to the lobby yet.')) CD.cancel = true; };
  $('#lLogoBtn').onclick = () => $('#lLogo').click();
  $('#lLogo').onchange = () => { const f = $('#lLogo').files[0]; if (!f) return; if (f.size > 2 * 1024 * 1024) return alert('image must be 2 MB or less'); const rd = new FileReader(); rd.onload = () => { LOGO = { name: f.name, type: f.type, size: f.size, dataUrl: rd.result }; ls.set('sq_logo', LOGO); render(); }; rd.readAsDataURL(f); };
  $('#lRehearse').onclick = () => launch(true).catch(fail('launch'));
  $('#lFire').onclick = () => { if (confirm('Launch ' + L.symbol.toUpperCase() + ' on pump.fun now?\n\nThis spends real SOL: the dev buy, your ticked wallets\' buys, rent, and every ready teammate\'s buy.')) launch(false).catch(fail('launch')); };
  $('#logClear').onclick = () => { $('#log').innerHTML = ''; };
}
async function refreshBalances() {
  const ws = sols(); const addrs = [...ws.map((w) => w.address), ...(W.phantomPk ? [W.phantomPk] : [])];
  if (addrs.length) { try { const r = await rpc('getMultipleAccounts', [addrs, { encoding: 'base64', commitment: 'processed', dataSlice: { offset: 0, length: 0 } }]); (r?.value || []).forEach((a, i) => { V.bal[addrs[i]] = a ? a.lamports / LAMPORTS_PER_SOL : 0; }); } catch {} }
  const a = address(); W.balance = a ? (V.bal[a] ?? null) : null; render();
}

(async () => {
  bind(); render();
  await resume();
  if (!A.key) log('info', 'ready — sign in with Phantom');
  refreshBalances(); setInterval(refreshBalances, 20000);
  // usage counter: one anonymous visit per page load (a random id kept in this browser — no IP, no wallet)
  gateToken().then(() => { let v = ls.get('sq_vid', null); if (!v) { v = Array.from(crypto.getRandomValues(new Uint8Array(12)), (x) => (x % 36).toString(36)).join(''); ls.set('sq_vid', v); } return fetch(Y.relay + '/stats/visit', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gate': Y.token }, body: JSON.stringify({ v }) }); }).catch(() => {});
  pump().catch((e) => log('warn', 'pump.fun state not loaded yet (' + e.message + ')'));
  loadShowcase(); setInterval(loadShowcase, 120000);
})();
