// A one-time notice (shown once per browser; bump NOTICE_ID to show a new one). No libraries; closes with the button,
// Escape, or a click outside the card.
(() => {
  const NOTICE_ID = 'sq_notice_dex1';
  try { if (localStorage.getItem(NOTICE_ID)) return; } catch {}
  const box = document.getElementById('notice'); if (!box) return;
  const close = () => { box.classList.add('hide'); try { localStorage.setItem(NOTICE_ID, '1'); } catch {} document.removeEventListener('keydown', esc); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  box.addEventListener('click', (e) => { if (e.target === box) close(); });
  document.getElementById('noticeOk').onclick = close;
  setTimeout(() => { box.classList.remove('hide'); document.addEventListener('keydown', esc); document.getElementById('noticeOk').focus(); }, 700);
})();
