// "Get started" checklist: reads what the page already shows (balance, buys, lobby, activity log) and marks the four first
// steps done; each step jumps to where it happens. Hidden when signed out, when all four are done, or when dismissed.
(() => {
  const $ = (s) => document.querySelector(s);
  // the landing page's closing "Get started" button signs in like the hero button
  const a2 = $('#aWallet2'); if (a2) a2.onclick = () => { const a = $('#aWallet'); if (a) a.click(); };
  const box = $('#gStart'); if (!box) return;
  const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const tab = (t) => { const b = document.querySelector('[data-tab="' + t + '"]'); if (b) b.click(); };
  const jump = (sel, focus) => setTimeout(() => { const e = $(sel); if (!e) return; e.scrollIntoView({ behavior: 'smooth', block: 'center' }); if (focus) e.focus(); }, 120);
  const actions = {
    fund: () => { tab('wallets'); jump('#xfer'); },
    buys: () => { tab('wallets'); jump('#vTable'); },
    lobby: () => { tab('launch'); jump('#yName', true); },
    rehearse: () => { tab('launch'); jump('#lRehearse'); },
  };
  box.querySelectorAll('[data-step]').forEach((b) => { b.onclick = () => actions[b.dataset.step](); });
  $('#gStartHide').onclick = () => { set('sq_start_hide', '1'); box.classList.add('hide'); };
  const num = (t) => { const m = /([0-9]+(?:\.[0-9]+)?)/.exec(t || ''); return m ? Number(m[1]) : 0; };
  function state() {
    const lw = ($('#lWallets') || {}).innerText || '';
    const log = ($('#log') || {}).innerText || '';
    if (/would have fired|NOT sent/.test(log)) set('sq_rehearsed', '1');
    return {
      fund: num(($('#wBal') || {}).innerText) > 0,
      buys: !/No buys set/.test(lw) && /SOL/.test(lw),
      lobby: !/none/.test(($('#tLobby') || {}).innerText || 'none'),
      rehearse: get('sq_rehearsed') === '1',
    };
  }
  function update() {
    const out = document.body.classList.contains('out');
    const s = state(); const order = ['fund', 'buys', 'lobby', 'rehearse'];
    const allDone = order.every((k) => s[k]);
    box.classList.toggle('hide', out || allDone || get('sq_start_hide') === '1');
    const next = order.find((k) => !s[k]);
    box.querySelectorAll('[data-step]').forEach((b) => { const k = b.dataset.step; b.classList.toggle('done', !!s[k]); b.classList.toggle('next', k === next); });
  }
  update(); setInterval(update, 1000);
})();
