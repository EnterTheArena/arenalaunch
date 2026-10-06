// A phished vault-unlock signature plus a stolen session must not open a Phantom account's vault. Runs the relay's real
// Accounts class (in memory) and the page's real vaultKey. No network.   node tools/vault-pepper-check.mjs   (from site/)
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import { Accounts } from '../../relay/src/accounts.js';
import { vaultKey } from '../src/vault.js';

let fails = 0; const ok = (c, w) => { console.log((c ? 'ok   ' : 'FAIL ') + w); if (!c) fails++; };
globalThis.fetch = async (u) => { throw new Error('unexpected ' + u); };
const mem = new Map();
const storage = { get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => mem.has(x)).map((x) => [x, structuredClone(mem.get(x))])) : structuredClone(mem.get(k))), put: async (k, v) => mem.set(k, structuredClone(v)), delete: async (k) => mem.delete(k), list: async ({ prefix = '', start, limit } = {}) => { let ks = [...mem.keys()].filter((k) => k.startsWith(prefix) && (start == null || k >= start)).sort(); if (limit) ks = ks.slice(0, limit); return new Map(ks.map((k) => [k, structuredClone(mem.get(k))])); } };
const env = { ACCOUNT_SECRET: 'acct', ALLOWED_ORIGINS: 'https://arenalaunch.bond', STATS: { idFromName: () => 0, get: () => ({ fetch: async () => new Response('{}') }) } };
const A = new Accounts({ storage }, env);
const call = async (op, b) => { const r = await A.fetch(new Request('https://acct/' + op, { method: 'POST', body: JSON.stringify(b) })); return { status: r.status, ...(await r.json()) }; };
const enc = new TextEncoder(); const unb64url = (s) => new Uint8Array(Buffer.from(s, 'base64url'));
const kp = ed25519.utils.randomSecretKey(), pub = bs58.encode(ed25519.getPublicKey(kp));
async function signIn() {
  const { nonce } = await call('nonce', {});
  const m = enc.encode('arenalaunch.bond wants you to sign in with your Solana account:\n' + pub + '\n\nSign in.\n\nURI: https://arenalaunch.bond\nVersion: 1\nChain ID: mainnet\nNonce: ' + nonce + '\nIssued At: ' + new Date().toISOString());
  return call('wallet', { address: pub, message: bs58.encode(m), sig: bs58.encode(ed25519.sign(m, kp)) });
}
// AES-GCM vault the way the page seals it
const imp = (raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
const seal = async (raw, obj) => { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await imp(raw), enc.encode(JSON.stringify(obj)))); return 'v1.' + Buffer.from(iv).toString('base64') + '.' + Buffer.from(ct).toString('base64'); };
const opens = async (blob, raw) => { try { const [, iv, ct] = blob.split('.'); await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(iv, 'base64') }, await imp(raw), Buffer.from(ct, 'base64')); return true; } catch { return false; } };
const VAULT_MSG = 'arenalaunch: unlock my saved wallets\n' + pub + '\n\nSigning this does not move funds. Only sign it on arenalaunch.';
const vsig = ed25519.sign(enc.encode(VAULT_MSG), kp); // what a phishing page would collect

const s1 = await signIn(); ok(s1.status === 200 && /^[A-Za-z0-9_-]{43}$/.test(s1.pepper || ''), 'a Phantom sign-in returns the account pepper');
const s2 = await signIn(); ok(s2.pepper === s1.pepper, 'the pepper is stable across sign-ins (the vault key does not change)');
const stolen = await call('vault', { session: s1.session }); ok(stolen.status === 200 && !('pepper' in stolen), 'a session alone (the vault read) never gets the pepper');
// an account from before the pepper: vault sealed with SHA-256(signature)
const legacyKey = await vaultKey(vsig); const blob0 = await seal(legacyKey, { wallets: [{ id: 'w1', secret: 'x' }] });
const newKey = await vaultKey(vsig, unb64url(s1.pepper));
ok(!(await opens(blob0, newKey)) && (await opens(blob0, legacyKey)), 'old vaults are found under the old key (the page re-seals them on sign-in)');
const blob1 = await seal(newKey, { wallets: [{ id: 'w1', secret: 'x' }] }); await call('save', { session: s1.session, vault: blob1, ver: 0 });
const got = (await call('vault', { session: s1.session })).vault;
ok(got === blob1 && (await opens(got, newKey)), 're-sealed vault opens with the peppered key');
ok(!(await opens(got, await vaultKey(vsig))), 'phished unlock signature + stolen session: the vault does NOT open');
const other = ed25519.utils.randomSecretKey(); const s3 = await (async () => { const pub2 = bs58.encode(ed25519.getPublicKey(other)); const { nonce } = await call('nonce', {}); const m = enc.encode('arenalaunch.bond wants you to sign in with your Solana account:\n' + pub2 + '\n\nSign in.\n\nURI: https://arenalaunch.bond\nVersion: 1\nChain ID: mainnet\nNonce: ' + nonce + '\nIssued At: ' + new Date().toISOString()); return call('wallet', { address: pub2, message: bs58.encode(m), sig: bs58.encode(ed25519.sign(m, other)) }); })();
ok(s3.pepper && s3.pepper !== s1.pepper, 'every account has its own pepper');

console.log(fails ? fails + ' FAILED' : 'all vault pepper checks passed'); process.exit(fails ? 1 : 0);
