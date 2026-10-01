// api/result-pdf.js
// Vercel Serverless Function: turns a quiz result (onboarding_intents row) into a branded PDF.
// Made once per result and language, stored in Supabase Storage (bucket "results"), the link
// is written back on the row (pdf_url, pdf_lang). Every next tap just opens that link.
//
// Called by the app (assets/js/match.js, AMSMatch.pdf) with the member's Supabase token:
//   POST { id: <row id>, lang: 'en'|'nl' }   Authorization: Bearer <user access token>
// Returns { url }.
//
// Members only: the app shows the Save button to members only; here we require a valid user
// token and only build rows that belong to that user (RLS on onboarding_intents).
//
// NEEDS THESE ENVIRONMENT VARIABLES IN VERCEL (Settings -> Environment Variables):
//   QCZ_SERVICE_KEY   = service_role key of project qczutthumgpgxwepatte (to upload and to write pdf_url)
// NEEDS IN package.json dependencies:  "pdfkit": "^0.15.0"
// Fonts and logo live next to this file: api/fonts/Karla-*.ttf, api/assets/logo.png

const path = require('path');
const PDFDocument = require('pdfkit');

const QCZ = 'https://qczutthumgpgxwepatte.supabase.co';
const QCZ_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFjenV0dGh1bWdwZ3h3ZXBhdHRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkwNzg5NzAsImV4cCI6MjA4NDY1NDk3MH0.vleNYVReRJnMruKBTXEb9gwdKVdhbiuLJTZoDiuUM0g';
const CB = 'https://cbldlpuhmuojdvljdtsk.supabase.co';
const CB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNibGRscHVobXVvamR2bGpkdHNrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjAxNTY5OTUsImV4cCI6MjA3NTczMjk5NX0.HqkbwYs6wpr4Ui78H2AUcGnlIxUWkrvJ2m1JPqACPxM';
const BUCKET = 'results';

const FONT = {
  regular: path.join(__dirname, 'fonts', 'Karla-Regular.ttf'),
  bold: path.join(__dirname, 'fonts', 'Karla-Bold.ttf'),
  extra: path.join(__dirname, 'fonts', 'Karla-ExtraBold.ttf'),
};
const LOGO = path.join(__dirname, 'assets', 'logo.png');

// App colours
const C = { ink: '#2F2A38', soft: '#6B6574', muted: '#9A90A8', purple: '#8E6FA0', lilac: '#B597C1', pink: '#E8B0C8',
  cream: '#FBF1F6', paper: '#F8F6FA', line: '#EFE4F2', pillBg: '#F4EEF7', free: '#DDEFE0', freeTx: '#2F6B45' };

// The six family types and the food names, so the PDF speaks the member's language
const NAMES = [
  ['Bakfiets Nomads', 'Bakfietsnomaden'], ['Sandpit Sommeliers', 'Zandbak-Sommeliers'], ['Free Rangers', 'Vrije Uitlopers'],
  ['Culture Hoppers', 'Cultuurhoppers'], ['Talent Managers', 'Talent Managers'], ["The No-FOMO's", "De No-FOMO's"],
  ['The Anything Table', 'De Alles-Tafel'], ['The Beige Brigade', 'De Beige Brigade'], ['Pasta. Plain. No sauce.', 'Pasta. Naturel. Geen saus.'],
  ['The Untouchables', 'De Onaanraakbaren'],
];
function nameIn(n, lang) {
  const k = String(n || '').trim().toLowerCase();
  for (const pair of NAMES) if (pair[0].toLowerCase() === k || pair[1].toLowerCase() === k) return pair[lang === 'nl' ? 1 : 0];
  const m = k.match(/^(\d+)\s+(kids, sorted|kinderen, geregeld)$/);
  if (m) return m[1] + (lang === 'nl' ? ' kinderen, geregeld' : ' kids, sorted');
  return n;
}

const TX = {
  en: { tab: 'Picked for you', top100: 'Your family type', food: 'Your Food Picks', bday: 'Your Party Picks',
        gift: { top100: (n) => `${n} of our Top 100, picked for your family`, food: (n) => `${n} spots that fit your family`, bday: (n) => `${n} picks for your party` },
        made: 'Made with Amsterdam Families', site: 'amsterdamfamilies.com', free: 'Free', date: 'Picked on', page: 'Page' },
  nl: { tab: 'Voor jou gekozen', top100: 'Jouw gezinstype', food: 'Voor jullie uitgezocht', bday: 'Jouw feesttips',
        gift: { top100: (n) => `${n} uit onze Top 100, gekozen voor jouw gezin`, food: (n) => `${n} plekken die bij jullie passen`, bday: (n) => `${n} tips voor jullie feestje` },
        made: 'Gemaakt met Amsterdam Families', site: 'amsterdamfamilies.com', free: 'Gratis', date: 'Gekozen op', page: 'Pagina' },
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function getJson(url, headers) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`fetch ${r.status} ${url.slice(0, 80)}`);
  return r.json();
}

// Photo: Cloudinary links get a fitted transform, everything else is fetched as is. Null on any failure.
async function photo(url, w, h) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  let u = url;
  if (/res\.cloudinary\.com\/.*\/image\/upload\//.test(u)) u = u.replace('/image/upload/', `/image/upload/w_${w},h_${h},c_fill,g_auto,q_auto:good,f_jpg/`);
  else if (/images\.unsplash\.com/.test(u)) u = u.split('?')[0] + `?w=${w}&h=${h}&fit=crop&fm=jpg&q=75`;
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    if (!/image\/(jpeg|jpg|png)/i.test(ct)) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch (e) { return null; }
}

// ---- per campaign: which table, which fields ----
async function loadItems(source, payload, lang) {
  const nl = lang === 'nl';
  if (source === 'family_quiz') {
    const nums = (payload.plan_numbers || []).map(Number).filter((n) => !isNaN(n));
    if (!nums.length) return [];
    const rows = await getJson(`${CB}/rest/v1/ams_top100_plans?plan_number=in.(${nums.join(',')})&select=plan_number,title_en,title_nl,description_en,description_nl,categories,cost_text_en,cost_text_nl,cost_info,is_free,neighbourhood,address,image_url`, { apikey: CB_ANON });
    const by = {}; rows.forEach((r) => { by[Number(r.plan_number)] = r; });
    return nums.map((n) => by[n]).filter(Boolean).map((p) => ({
      number: p.plan_number,
      title: nl ? (p.title_nl || p.title_en) : (p.title_en || p.title_nl),
      meta: [p.neighbourhood, p.address].filter(Boolean).join(' · '),
      text: nl ? (p.description_nl || p.description_en) : (p.description_en || p.description_nl),
      pills: (Array.isArray(p.categories) ? p.categories : String(p.categories || '').split(',')).map((x) => String(x).trim()).filter(Boolean).slice(0, 3),
      free: !!p.is_free, cost: nl ? (p.cost_text_nl || p.cost_info) : (p.cost_text_en || p.cost_info),
      image: p.image_url,
    }));
  }
  if (source === 'food_map') {
    const ids = (payload.ids || []).map(Number).filter((n) => !isNaN(n));
    if (!ids.length) return [];
    const rows = await getJson(`${CB}/rest/v1/ams_restaurants?id=in.(${ids.join(',')})&select=id,name,area,cuisine,curated_text,curated_text_nl,kids_menu,kids_play_area,image_url,address,website`, { apikey: CB_ANON });
    const by = {}; rows.forEach((r) => { by[Number(r.id)] = r; });
    return ids.map((n) => by[n]).filter(Boolean).map((r, i) => ({
      number: i + 1, title: r.name,
      meta: [r.area, r.cuisine].filter(Boolean).join(' · '),
      text: nl ? (r.curated_text_nl || r.curated_text) : (r.curated_text || r.curated_text_nl),
      pills: [r.kids_menu ? (nl ? 'Kindermenu' : 'Kids menu') : null, r.kids_play_area ? (nl ? 'Speelhoek' : 'Play corner') : null].filter(Boolean),
      free: false, cost: r.address, image: r.image_url,
    }));
  }
  if (source === 'birthday') {
    const ids = (payload.entry_ids || []).map(Number).filter((n) => !isNaN(n));
    if (!ids.length) return [];
    const rows = await getJson(`${CB}/rest/v1/ams_birthday_directory?id=in.(${ids.join(',')})&select=id,business_name,listing_title,listing_title_en,description,description_en,district,ages,price,image,tab,website`, { apikey: CB_ANON });
    const by = {}; rows.forEach((r) => { by[Number(r.id)] = r; });
    return ids.map((n) => by[n]).filter(Boolean).map((r, i) => ({
      number: i + 1,
      title: (nl ? (r.listing_title || r.listing_title_en) : (r.listing_title_en || r.listing_title)) || r.business_name,
      meta: [r.business_name, r.district].filter(Boolean).join(' · '),
      text: nl ? (r.description || r.description_en) : (r.description_en || r.description),
      pills: [r.ages ? (nl ? 'Leeftijd ' : 'Ages ') + r.ages : null, r.tab === 'party_crew' ? (nl ? 'Entertainer' : 'Entertainer') : (nl ? 'Locatie' : 'Venue')].filter(Boolean),
      free: false, cost: r.price, image: r.image,
    }));
  }
  return [];
}

// ---- drawing helpers ----
// photo with rounded top corners only: clip to the card shape, draw only the photo height
function roundedImage(doc, buf, x, y, w, h, r, cardH) {
  doc.save();
  doc.roundedRect(x, y, w, cardH, r).clip();
  try { doc.image(buf, x, y, { cover: [w, h], align: 'center', valign: 'center' }); }
  catch (e) { doc.rect(x, y, w, h).fill(C.pillBg); }
  doc.restore();
}
function placeholder(doc, x, y, w, h, r, cardH) {
  doc.save().roundedRect(x, y, w, cardH, r).clip().rect(x, y, w, h).fill(C.pillBg).restore();
}
function pill(doc, text, x, y, opts) {
  opts = opts || {};
  doc.font(FONT.bold).fontSize(8.5);
  const w = doc.widthOfString(text) + 14, h = 16;
  doc.save().roundedRect(x, y, w, h, 8).fill(opts.bg || C.pillBg).restore();
  doc.fillColor(opts.color || C.purple).text(text, x + 7, y + 4, { lineBreak: false });
  return w;
}
function footer(doc, t, pageNo) {
  const W = doc.page.width, H = doc.page.height;
  doc.font(FONT.regular).fontSize(8.5).fillColor(C.muted)
    .text(`${t.made}  ·  ${t.site}`, 40, H - 56, { width: W - 80, align: 'left', lineBreak: false });
  doc.text(`${t.page} ${pageNo}`, 40, H - 56, { width: W - 80, align: 'right', lineBreak: false });
}

function cover(doc, t, page, name, n, lang) {
  const W = doc.page.width, H = doc.page.height;
  // paper
  doc.rect(0, 0, W, H).fill(C.paper);
  // soft gradient band at the top
  const g = doc.linearGradient(0, 0, W, 300);
  g.stop(0, '#F1E6F6').stop(0.6, '#FBE4EE').stop(1, '#FDEFE8');
  doc.rect(0, 0, W, 300).fill(g);
  // big soft circle, like the banner highlight
  doc.save().opacity(0.55).circle(W - 60, 300, 170).fill('#FFFFFF').restore();
  // logo card
  doc.save().roundedRect(40, 40, 120, 76, 16).fill('#FFFFFF').restore();
  try { doc.image(LOGO, 52, 48, { fit: [96, 60], align: 'center', valign: 'center' }); } catch (e) {}
  // ribbon
  doc.font(FONT.extra).fontSize(10);
  const rt = t.tab.toUpperCase();
  const rw = doc.widthOfString(rt, { characterSpacing: 2 }) + 30;
  const rg = doc.linearGradient(40, 150, 40 + rw, 150); rg.stop(0, C.purple).stop(1, C.pink);
  doc.save().roundedRect(40, 150, rw, 24, 12).fill(rg).restore();
  doc.fillColor('#FFFFFF').text(rt, 55, 157, { characterSpacing: 2, lineBreak: false });
  // kicker, name, gift line
  doc.font(FONT.extra).fontSize(11).fillColor(C.purple).text(t[page].toUpperCase(), 40, 200, { characterSpacing: 2.2 });
  doc.font(FONT.extra).fontSize(name.length > 22 ? 30 : 38).fillColor(C.ink).text(name, 40, 218, { width: W - 80 });
  doc.moveDown(0.2);
  doc.font(FONT.regular).fontSize(14).fillColor(C.soft).text(t.gift[page](n), 40, doc.y + 2, { width: W - 80 });
  // date + what this is
  const d = new Date();
  const ds = d.toLocaleDateString(lang === 'nl' ? 'nl-NL' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  doc.font(FONT.regular).fontSize(10.5).fillColor(C.muted).text(`${t.date} ${ds}`, 40, 330);
  // a short promise block
  const lines = lang === 'nl'
    ? ['Dit is jullie persoonlijke lijst uit de Amsterdam Families app.', 'Bewaar hem, deel hem, print hem. Elke keuze staat ook in de app, met kaart en favorieten.']
    : ['This is your personal list from the Amsterdam Families app.', 'Keep it, share it, print it. Every pick is in the app too, with map and favourites.'];
  doc.font(FONT.regular).fontSize(12).fillColor(C.ink).text(lines.join(' '), 40, 360, { width: W - 120, lineGap: 3 });
  footer(doc, t, 1);
}

function itemBlock(doc, it, t, x, y, w, img) {
  // card
  const ph = 180, pad = 14;
  doc.save().roundedRect(x, y, w, 360, 18).fill('#FFFFFF').restore();
  if (img) roundedImage(doc, img, x, y, w, ph, 18, 360); else placeholder(doc, x, y, w, ph, 18, 360);
  // number badge
  doc.save().circle(x + 24, y + 24, 16).fill(C.lilac).restore();
  doc.save().circle(x + 24, y + 24, 16).lineWidth(2.5).stroke('#FFFFFF').restore();
  doc.font(FONT.extra).fontSize(String(it.number).length > 2 ? 10 : 12).fillColor('#FFFFFF')
    .text(String(it.number), x + 24 - 16, y + 24 - 6, { width: 32, align: 'center', lineBreak: false });
  // free pill on the photo
  if (it.free) pill(doc, t.free.toUpperCase(), x + w - 60, y + 12, { bg: C.free, color: C.freeTx });
  // title
  let ty = y + ph + 14;
  doc.font(FONT.extra).fontSize(14.5).fillColor(C.ink).text(it.title || '', x + pad, ty, { width: w - pad * 2, height: 40, ellipsis: true });
  ty = doc.y + 3;
  if (it.meta) { doc.font(FONT.bold).fontSize(9.5).fillColor(C.purple).text(it.meta, x + pad, ty, { width: w - pad * 2, height: 14, ellipsis: true, lineBreak: false }); ty = doc.y + 5; }
  // description, clipped to the card
  const textH = (y + 360 - 44) - ty;
  if (it.text && textH > 20) {
    doc.font(FONT.regular).fontSize(9.5).fillColor(C.soft).text(String(it.text).replace(/\s+/g, ' ').trim(), x + pad, ty, { width: w - pad * 2, height: textH, ellipsis: true, lineGap: 1.5 });
  }
  // pills row at the bottom
  let px = x + pad; const py = y + 360 - 30;
  (it.pills || []).forEach((p) => { if (px + 60 < x + w) px += pill(doc, p, px, py) + 6; });
  if (it.cost && !it.free && px + 80 < x + w) { doc.font(FONT.regular).fontSize(8.5).fillColor(C.muted).text(String(it.cost).replace(/\s+/g, ' '), px + 2, py + 4, { width: x + w - px - pad, height: 11, ellipsis: true }); }
}

async function buildPdf({ page, name, items, lang }) {
  const t = TX[lang === 'nl' ? 'nl' : 'en'];
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `${name} - Amsterdam Families`, Author: 'Amsterdam Families' } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  doc.registerFont('K', FONT.regular); doc.registerFont('KB', FONT.bold); doc.registerFont('KX', FONT.extra);
  cover(doc, t, page, name, items.length, lang);

  // photos in parallel (small, fitted), then 2 items per page
  const imgs = await Promise.all(items.map((it) => photo(it.image, 900, 360)));
  const W = doc.page.width, H = doc.page.height, cw = W - 80;
  let pageNo = 1;
  for (let i = 0; i < items.length; i += 2) {
    doc.addPage(); pageNo++;
    doc.rect(0, 0, W, H).fill(C.paper);
    // page header
    doc.font(FONT.extra).fontSize(9).fillColor(C.purple).text(t.tab.toUpperCase(), 40, 28, { characterSpacing: 2, lineBreak: false });
    doc.font(FONT.bold).fontSize(9).fillColor(C.muted).text(name, 40, 28, { width: cw, align: 'right', lineBreak: false });
    itemBlock(doc, items[i], t, 40, 50, cw, imgs[i]);
    if (items[i + 1]) itemBlock(doc, items[i + 1], t, 40, 50 + 360 + 18, cw, imgs[i + 1]);
    footer(doc, t, pageNo);
  }
  doc.end();
  return done;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  const svc = process.env.QCZ_SERVICE_KEY;
  if (!svc) return res.status(500).json({ error: 'QCZ_SERVICE_KEY env var missing.' });

  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'not signed in' });
  const { id, lang: langIn } = req.body || {};
  const lang = langIn === 'nl' ? 'nl' : 'en';
  if (!id) return res.status(400).json({ error: 'id is required' });

  try {
    // 1. who is calling + their own row (RLS: own email only)
    const rows = await getJson(`${QCZ}/rest/v1/onboarding_intents?id=eq.${encodeURIComponent(id)}&select=id,source,result_type,payload,pdf_url,pdf_lang,email`,
      { apikey: QCZ_ANON, Authorization: `Bearer ${token}` });
    const row = rows && rows[0];
    if (!row) return res.status(404).json({ error: 'result not found' });
    if (row.pdf_url && row.pdf_lang === lang) return res.status(200).json({ url: row.pdf_url, cached: true });

    const PAGE = { family_quiz: 'top100', food_map: 'food', birthday: 'bday' }[row.source];
    if (!PAGE) return res.status(400).json({ error: 'no PDF for this result' });
    const payload = row.payload || {};
    const name = nameIn(payload['name_' + lang] || payload.name || row.result_type || '', lang);

    // 2. the picks
    const items = await loadItems(row.source, payload, lang);
    if (!items.length) return res.status(400).json({ error: 'no picks on this result' });

    // 3. the PDF
    const pdf = await buildPdf({ page: PAGE, name, items, lang });

    // 4. store it (public bucket, unguessable path) and remember the link
    const key = `${row.source}/${row.id}-${lang}.pdf`;
    const up = await fetch(`${QCZ}/storage/v1/object/${BUCKET}/${key}`, {
      method: 'POST', body: pdf,
      headers: { apikey: svc, Authorization: `Bearer ${svc}`, 'Content-Type': 'application/pdf', 'x-upsert': 'true' },
    });
    if (!up.ok) throw new Error('upload failed ' + up.status + ' ' + (await up.text()).slice(0, 200));
    const url = `${QCZ}/storage/v1/object/public/${BUCKET}/${key}`;
    await fetch(`${QCZ}/rest/v1/onboarding_intents?id=eq.${encodeURIComponent(row.id)}`, {
      method: 'PATCH', headers: { apikey: svc, Authorization: `Bearer ${svc}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ pdf_url: url, pdf_lang: lang }),
    });
    return res.status(200).json({ url, cached: false, items: items.length });
  } catch (error) {
    console.error('result-pdf error:', error.message);
    return res.status(500).json({ error: error.message || 'PDF failed' });
  }
};

module.exports.__test = { loadItems, buildPdf };
