// Email sign-in rules, run against the real Accounts class with in-memory storage and a fake email sender.
// No network: the Resend call is intercepted and the code read from it.   node tools/email-check.mjs   (from site/)
import { Accounts, readSession, cleanEmail } from '../../relay/src/accounts.js';

const enc = new TextEncoder();
const b64url = (u8) => Buffer.from(u8).toString('base64url');
// same derivation as site/src/app.js emailKeys
async function emailKeys(email, password) {
  const km = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const master = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode('arenalaunch email v1:' + email), iterations: 600000, hash: 'SHA-256' }, km, 256));
  const hk = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits']);
  const part = async (info) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(info) }, hk, 256));
  return { auth: b64url(await part('arenalaunch auth')), vault: await part('arenalaunch vault') };
}

const mem = new Map();
const storage = { get: async (k) => mem.get(k), put: async (k, v) => { mem.set(k, structuredClone(v)); }, delete: async (k) => mem.delete(k), list: async ({ prefix }) => new Map([...mem].filter(([k]) => k.startsWith(prefix))) };
const env = { ACCOUNT_SECRET: 'test-secret', RESEND_API_KEY: 'x', EMAIL_FROM: 'arenalaunch <login@example.com>', STATS: { idFromName: () => 0, get: () => ({ fetch: async () => new Response('{}') }) } };
const A = new Accounts({ storage }, env);
let sent = [];
globalThis.fetch = async (url, init) => { if (String(url).startsWith('https://api.resend.com/')) { sent.push(JSON.parse(init.body)); return new Response('{}'); } throw new Error('unexpected network call ' + url); };
const call = async (op, body) => { const r = await A.fetch(new Request('https://acct/' + op, { method: 'POST', body: JSON.stringify(body) })); return { status: r.status, ...(await r.json()) }; };
const lastCode = () => /code is (\d{6})/.exec(sent.at(-1).text)[1];
let T = null; // the ticket of the latest email-start (this browser's)
const call0 = call; const callT = async (op, body) => { const r = await call0(op, op === 'email-start' ? body : { ticket: T, ...body }); if (op === 'email-start' && r.ticket) T = r.ticket; return r; };
let fails = 0; const ok = (cond, what) => { console.log((cond ? 'ok   ' : 'FAIL ') + what); if (!cond) fails++; };
const clock = { now: Date.now() }; const realNow = Date.now; Date.now = () => clock.now;

const email = 'Kai@Example.com ', E = 'kai@example.com';
ok(cleanEmail(email) === E && !cleanEmail('a|b@x.io') && !cleanEmail('nope') && !cleanEmail('a@b'), 'emails are normalised; separators and junk refused');
let r = await callT('email-start', { email }); ok(r.ok && /^[A-Za-z0-9_-]{22}$/.test(r.ticket) && sent.length === 1 && sent[0].to[0] === E, 'start sends one code to the normalised address');
ok(!('exists' in r), 'start says nothing about whether the account exists');
r = await callT('email-start', { email }); ok(r.status === 429 && sent.length === 1, 'a second code within a minute is refused');
const code = lastCode();
r = await callT('email-check', { email, code: '000000' === code ? '111111' : '000000' }); ok(r.status === 401, 'wrong code refused');
r = await callT('email-check', { email, code }); ok(r.status === 200 && r.exists === false, 'right code: no account yet');
const k = await emailKeys(E, 'correct horse battery');
r = await callT('email-login', { email, code, auth: k.auth }); const sess = r.session; ok(r.status === 200 && r.id === 'e:' + E && (await readSession(env, r.session)) === 'e:' + E, 'first login creates the account and a session');
ok(!JSON.stringify([...mem.values()]).includes(k.auth), 'the auth key itself is not stored, only its HMAC');
r = await callT('email-login', { email, code, auth: k.auth }); ok(r.status === 400, 'a code works for one sign-in only');

// existing account: the code alone, or the password alone, opens nothing
clock.now += 61000; await callT('email-start', { email }); let c2 = lastCode();
r = await callT('email-check', { email, code: c2 }); ok(r.exists === true, 'right code: account exists');
const bad = await emailKeys(E, 'wrong password!!');
r = await callT('email-login', { email, code: c2, auth: bad.auth }); ok(r.status === 401 && /password/.test(r.error), 'right code + wrong password refused');
r = await callT('email-login', { email, code: c2, auth: k.auth }); ok(r.status === 200, 'right code + right password signs in');
r = await callT('email-login', { email, code: '123456', auth: k.auth }); ok(r.status >= 400, 'password without a live code refused');

// code guessing: 5 wrong tries kill the code
clock.now += 61000; await callT('email-start', { email }); c2 = lastCode();
for (let i = 0; i < 5; i++) await callT('email-check', { email, code: String((Number(c2) + 1 + i) % 900000 + 100000) });
r = await callT('email-check', { email, code: c2 }); ok(r.status === 429, 'after 5 wrong codes even the right one is refused');
// codes expire
clock.now += 61000; await callT('email-start', { email }); c2 = lastCode(); clock.now += 11 * 60000;
r = await callT('email-check', { email, code: c2 }); ok(r.status === 400 && /expired/.test(r.error), 'codes expire after 10 minutes');
// at most 8 codes an hour per email (four sent so far, all within ~15 minutes)
for (let i = 0; i < 4; i++) { clock.now += 31000; r = await callT('email-start', { email }); } ok(r.ok, 'up to 8 codes within the hour are sent');
clock.now += 31000; r = await callT('email-start', { email }); ok(r.status === 429 && /hour/.test(r.error), 'a ninth code within the hour is refused');

// password lockout after 10 wrong passwords
clock.now += 3600000; await callT('email-start', { email }); c2 = lastCode();
for (let i = 0; i < 10; i++) await callT('email-login', { email, code: c2, auth: bad.auth });
r = await callT('email-login', { email, code: c2, auth: k.auth }); ok(r.status === 429 && /wrong passwords/.test(r.error), '10 wrong passwords lock the account for an hour');
clock.now += 3600000 + 1000; await callT('email-start', { email }); c2 = lastCode();
r = await callT('email-login', { email, code: c2, auth: k.auth }); ok(r.status === 200, 'the lock lifts after an hour');

// sessions: vault save works for an email account, and a wallet sign-in cannot touch it
r = await call('save', { session: sess, vault: 'v1.aaa.bbb', ver: 0 }); ok(r.ver === 1, 'an email session saves its vault');
ok((await callT('email-login', { email: 'x@y.io', code: '123456', auth: 'a'.repeat(43) })).status === 400, 'no code was ever sent to another email: refused');
ok((await callT('email-login', { email, code: c2, auth: 'short' })).status === 400, 'malformed auth refused');

// unconfigured sender fails closed
delete env.RESEND_API_KEY; clock.now += 3600000;
r = await callT('email-start', { email: 'new@person.io' }); ok(r.status === 503 && /not set up/.test(r.error), 'no RESEND_API_KEY: email sign-in is off, nothing stored');
ok(![...mem.keys()].some((k) => k.startsWith('c:new@person.io')), 'no code stored when the email could not be sent');

// someone else asking for codes for your email, or guessing them, does not touch yours
env.RESEND_API_KEY = 'x'; clock.now += 3600000; await callT('email-start', { email }); const mine = T, myCode = lastCode();
clock.now += 31000; const atk = await call0('email-start', { email });
for (let i = 0; i < 5; i++) await call0('email-check', { email, ticket: atk.ticket, code: String((Number(myCode) + 1 + i) % 900000 + 100000) });
r = await call0('email-check', { email, ticket: mine, code: myCode }); ok(r.status === 200, 'another browser burning its guesses leaves my code working');
r = await call0('email-check', { email, ticket: atk.ticket, code: myCode }); ok(r.status >= 400, 'my code does not work with someone else\'s ticket');

Date.now = realNow;
console.log(fails ? fails + ' FAILED' : 'all email sign-in checks passed'); process.exit(fails ? 1 : 0);
