// Live check of the relay's account endpoints (Sign In With Solana, vault save/conflict, password sign-up removed).
//   node tools/account-check.mjs            (RELAY=http://127.0.0.1:8788 for a local wrangler dev)
// Makes ~10 sign-ins: run it at most twice a minute from one IP (the relay rate-limits sign-ins per IP).
import { readFileSync } from 'fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import { mintToken } from '../api/gate.js';
const RELAY = process.env.RELAY || 'https://relay.arenalaunch.bond';
const gate = mintToken(JSON.parse(readFileSync(new URL('../.secrets.json', import.meta.url))).GATE_SECRET);
const call = async (op, body) => { const r = await fetch(RELAY + '/account/' + op, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gate': gate, origin: 'http://localhost:5182' }, body: JSON.stringify(body) }); return [r.status, await r.json()]; };
let bad = 0; const check = (name, ok, got) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : JSON.stringify(got)); };
let s, j;
const kp = ed25519.utils.randomSecretKey(); const pub = bs58.encode(ed25519.getPublicKey(kp));
// Sign In With Solana (Phantom signIn): domain + our single-use nonce
const siws = async (domain, addr, nonce, issued = new Date().toISOString()) => { const m = domain + ' wants you to sign in with your Solana account:\n' + addr + '\n\nSign in to arenalaunch.\n\nURI: https://' + domain + '\nVersion: 1\nChain ID: mainnet\nNonce: ' + nonce + '\nIssued At: ' + issued; const bytes = new TextEncoder().encode(m); return { address: addr, message: bs58.encode(bytes), sig: bs58.encode(ed25519.sign(bytes, kp)) }; };
const nonce = async () => (await call('nonce', {}))[1].nonce;
let n = await nonce(); check('nonce issued', /^[0-9a-z]{25}[A-Za-z0-9]{16}$/.test(n || ''), n);
const first = await siws('arenalaunch.fun', pub, n);
[s, j] = await call('wallet', first); check('SIWS sign-in creates the account', s === 200 && j.id === 'w:' + pub, j); const sess = j.session;
[s, j] = await call('save', { session: sess, vault: 'blob1', ver: 0 }); check('save v1', s === 200 && j.ver === 1, j);
[s, j] = await call('save', { session: sess, vault: 'stale', ver: 0 }); check('stale save refused', s === 409 && j.conflict, j);
[s, j] = await call('vault', { session: sess }); check('read back', j.vault === 'blob1' && j.ver === 1, j);
[s, j] = await call('vault', { session: sess.slice(0, -2) + 'xx' }); check('forged session refused', s === 401, j);
[s, j] = await call('wallet', await siws('arenalaunch.fun', pub, await nonce())); check('second sign-in keeps the vault', s === 200 && j.vault === 'blob1', j);
[s, j] = await call('register', { username: 'nobody' + Date.now(), auth: 'A'.repeat(43) }); check('password sign-up is gone', s === 404, j);
[s, j] = await call('wallet', first); check('the same SIWS message twice is refused', s === 400, j);
[s, j] = await call('wallet', await siws('evil.example', pub, await nonce())); check('another domain is refused', s === 400 && /another site/.test(j.error), j);
[s, j] = await call('wallet', await siws('arenalaunch.fun', pub, n.slice(0, -1) + (n.endsWith('a') ? 'b' : 'a'))); check('a forged nonce is refused', s === 400, j);
[s, j] = await call('wallet', await siws('arenalaunch.fun', pub, await nonce(), new Date(Date.now() - 600000).toISOString())); check('an old Issued At is refused', s === 400, j);
{ const other = bs58.encode(ed25519.getPublicKey(ed25519.utils.randomSecretKey())); const m = await siws('arenalaunch.fun', pub, await nonce()); [s, j] = await call('wallet', { ...m, address: other }); check('a message for another wallet is refused', s === 400, j); }
{ const m = await siws('arenalaunch.fun', pub, await nonce()); [s, j] = await call('wallet', { ...m, sig: bs58.encode(new Uint8Array(64)) }); check('a bad SIWS signature is refused', s === 401, j); }
{ const ts = Date.now(); const sig = bs58.encode(ed25519.sign(new TextEncoder().encode('arenalaunch login\n' + pub + '\n' + ts), kp)); [s, j] = await call('wallet', { address: pub, ts, sig }); check('the old fixed-message sign-in is switched off', s === 400, j); }
process.exit(bad ? 1 : 0);
