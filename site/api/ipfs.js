import { limited } from './_limit.js';
// POST /api/ipfs {name, symbol, description, website, twitter, telegram, dataUrl} → {imageUrl, metadataUri}
// Uploads the coin image + metadata through pump.fun's own IPFS endpoint (the one their create page uses, no account
// needed). metadataUri is what the create instruction carries. Gate enforced by middleware.
export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (await limited(req, res, 'ipfs', 20)) return; // one upload per launch (cached by the page)
  const b = req.body || {};
  const m = /^data:(image\/(png|jpeg|webp|gif));base64,(.+)$/.exec(String(b.dataUrl || ''));
  if (!m) return res.status(400).json({ error: 'PNG, JPEG, WebP or GIF data URL required' });
  const bytes = Buffer.from(m[3], 'base64'); if (bytes.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'image must be ≤ 2 MB' });
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: m[1] }), 'logo.' + m[2]);
  const link = (v) => { const s = String(v || '').trim().slice(0, 200); return /^https?:\/\//i.test(s) || !s ? s : 'https://' + s; };
  fd.append('name', String(b.name || 'token').slice(0, 32)); fd.append('symbol', String(b.symbol || 'TKN').slice(0, 13)); fd.append('description', String(b.description || '').slice(0, 500));
  fd.append('twitter', link(b.twitter)); fd.append('telegram', link(b.telegram)); fd.append('website', link(b.website)); fd.append('showName', 'true');
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 25000);
    const r = await fetch('https://pump.fun/api/ipfs', { method: 'POST', body: fd, headers: { 'User-Agent': 'Mozilla/5.0', 'Origin': 'https://pump.fun', 'Referer': 'https://pump.fun/' }, signal: ctrl.signal }).finally(() => clearTimeout(t));
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.metadata?.image || !j.metadataUri) return res.status(502).json({ error: 'upload failed: ' + JSON.stringify(j).slice(0, 160) });
    return res.status(200).json({ imageUrl: j.metadata.image, metadataUri: j.metadataUri || null });
  } catch (e) { return res.status(504).json({ error: 'upload unreachable: ' + e.message }); }
}
