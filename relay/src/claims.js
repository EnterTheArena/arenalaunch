// ============================================================================
// arenalaunch CLAIMS — each fee payment (a transaction signature) pays for ONE order, ever.
// Reached only through /fee/claim with the site's RL_KEY (the site's API functions call it after checking the payment
// on chain). Body: {op, sig, who, order?}
//   claim   → {ok}            reserves the signature for this account (refused if used, or reserved by someone else)
//   done    → {ok}            the order exists: the signature is spent for good
//   release → {ok}            the order could not be made: the same account may try again with the same payment
// A reservation that was neither done nor released frees itself after 2 minutes (a crashed request never burns a fee).
// Records are kept 3 days (the site only accepts payments from the last 30 minutes) and pruned by a daily alarm.
// ============================================================================
const HOLD_MS = 2 * 60000, KEEP_MS = 3 * 86400000;
const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
export class Claims {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(req) {
    const b = await req.json().catch(() => ({})); const S = this.ctx.storage; const now = Date.now();
    const out = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
    const sig = String(b.sig || ''), who = String(b.who || '').slice(0, 300);
    if (!SIG.test(sig) || !who) return out({ ok: false, error: 'bad request' }, 400);
    const key = 's:' + sig; const rec = await S.get(key);
    if (b.op === 'claim') {
      if (rec?.order) return out({ ok: false, error: 'that fee payment was already used for an order' }, 409);
      if (rec && rec.who !== who) return out({ ok: false, error: 'that fee payment belongs to another account' }, 409);
      if (rec && now - rec.at < HOLD_MS) return out({ ok: false, error: 'an order with that payment is already being made — wait a moment' }, 409);
      await S.put(key, { who, at: now, order: null });
      if (!(await S.getAlarm())) await S.setAlarm(now + 86400000);
      return out({ ok: true });
    }
    if (b.op === 'done') { if (!rec || rec.who !== who) return out({ ok: false, error: 'not reserved' }, 409); rec.order = String(b.order || 'yes').slice(0, 100); rec.at = now; await S.put(key, rec); return out({ ok: true }); }
    if (b.op === 'release') { if (rec && rec.who === who && !rec.order) await S.delete(key); return out({ ok: true }); }
    return out({ ok: false, error: 'unknown op' }, 400);
  }
  async alarm() {
    const now = Date.now(); const S = this.ctx.storage; let last = null;
    const page = await S.list({ prefix: 's:', start: (await S.get('cur')) || 's:', limit: 2000 });
    for (const [k, r] of page) { last = k; if (now - r.at > KEEP_MS) await S.delete(k); }
    const more = page.size === 2000; await S.put('cur', more ? last + '\0' : 's:'); // walk the whole list, a page per alarm
    await S.setAlarm(now + (more ? 60000 : 86400000));
  }
}
