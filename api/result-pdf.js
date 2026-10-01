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
const LOGO = path.join(__dirname, 'assets', 'logo-t.png');   // transparent background

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

// The six family types: illustration (Cloudinary) + tagline + description, both languages (her copy, 1 Oct 2026).
const TYPES = {
  'bakfiets nomads': { img: 'https://res.cloudinary.com/dhgfmuuo9/image/upload/w_1000,q_auto:good,f_jpg/bakfiets-nomads_rxj47n.png',
    nl: { name: 'Bakfietsnomaden', tag: 'Niets is ver als de accu vol is.', text: 'Voor jullie begint een leuk uitje waar andere gezinnen Google Maps openen en zeggen: “Dat is best een eind.” Elf kilometer tegenwind is geen afstand, het is frisse lucht. Regenkap dicht, kinderen erin, snacks mee en gáán.' },
    en: { name: 'Bakfiets Nomads', tag: 'Nothing’s far when the battery’s full.', text: 'For you, a good day out starts where other families open Google Maps and say, “That’s quite far.” Eleven kilometres into a headwind isn’t distance, it’s fresh air. Rain cover down, kids in, snacks packed - go.' } },
  'sandpit sommeliers': { img: 'https://res.cloudinary.com/dhgfmuuo9/image/upload/w_1000,q_auto:good,f_jpg/De_Zandbak-sommeliers_ls0lwi.png',
    nl: { name: 'Zandbak-Sommeliers', tag: 'De zandbak voor hen. Wijntjes voor jullie.', text: 'Een geslaagd familie-uitje heeft bij jullie twee doelgroepen. De kinderen willen spelen, rennen en verdwijnen. Jullie willen goed eten, een fijn terras, nog een rondje. Met de kids dichtbij en veilig, maar vooral 100% vermaakt.' },
    en: { name: 'Sandpit Sommeliers', tag: 'The sandpit for them. Wine for you.', text: 'A successful family outing has two target groups. The kids want to play, run around and disappear. You want good food, a nice terrace and one more round. Kids close by and safe - but preferably 100% occupied.' } },
  'free rangers': { img: 'https://res.cloudinary.com/dhgfmuuo9/image/upload/w_1000,q_auto:good,f_jpg/Vrije_uitlopers_znrxby.png',
    nl: { name: 'Vrije Uitlopers', tag: 'Hoe viezer het kind, hoe beter de dag.', text: 'Een grasveld met klimboom en modder. Een geit en water waar eigenlijk niet in gesprongen mocht worden: doe er nog een zelfgemaakt vlot bij en het is een geslaagde middag. Waar het misgaat? Als de reservebroek thuisligt. Of bij schoonouders die nét de vloer hebben gedweild.' },
    en: { name: 'Free Rangers', tag: 'The dirtier the child, the better the day.', text: 'A field, a climbing tree and some mud. Add a goat, water they definitely weren’t meant to jump into and a homemade raft: perfect afternoon. It only goes wrong when the spare trousers are still at home. Or when the grandparents have just mopped the floor.' } },
  'culture hoppers': { img: 'https://res.cloudinary.com/dhgfmuuo9/image/upload/w_1000,q_auto:good,f_jpg/Cultuurhoppers_x4ldx9.png',
    nl: { name: 'Cultuurhoppers', tag: 'Een beetje cultuur kan nooit kwaad. Zeker niet als er een speurtocht bij zit.', text: 'Jullie vinden dat kinderen best wat cultuur mogen meekrijgen. Dus gaan ze mee naar musea, jeugdtheater, lichtshows en exposities waar je vaak óók ergens op een knop mag drukken. Jullie staan ondertussen diep onder de indruk van de kunst; zij hebben na twaalf minuten hun ware passie gevonden: de museumshop.' },
    en: { name: 'Culture Hoppers', tag: 'A little culture never hurt anyone. Especially if there’s a treasure hunt.', text: 'You think children should get a bit of culture too. So along they come to museums, children’s theatre, light shows and exhibitions where, thankfully, there’s usually something they’re allowed to press. You’re deeply moved by the art; twelve minutes in, they’ve discovered their true passion: the museum shop.' } },
  'talent managers': { img: 'https://res.cloudinary.com/dhgfmuuo9/image/upload/w_1000,q_auto:good,f_jpg/Talentmanager_updkhd.png',
    nl: { name: 'Talent Managers', tag: 'Ze hoeven echt niet overal op. Alleen op de goede dingen.', text: 'Jullie kind hoeft echt niet overal de beste in te zijn. Natuurlijk niet. Het is alleen wel fijn als ze zwemmen, klimmen, muziek maken, creatief bezig zijn, een beetje techniek meekrijgen en misschien nog iets met zelfvertrouwen. Jullie noemen dat geen volle agenda. Jullie noemen dat kijken waar hun talent ligt. En terwijl het kind bij circus hangt, drinken jullie een matcha en googelen jullie alvast “AI-cursus kinderen Amsterdam”.' },
    en: { name: 'Talent Managers', tag: 'They don’t need to do everything. Just the right things.', text: 'Your child really doesn’t have to be the best at everything. Obviously. It’s just nice if they swim, climb, play music, make things, pick up a little tech and maybe work on their confidence too. You don’t call that an overloaded schedule. You call it discovering their talents. And while they’re hanging upside down at circus class, you’re drinking a matcha and googling “AI classes for kids Amsterdam”.' } },
  "the no-fomo's": { img: 'https://res.cloudinary.com/dhgfmuuo9/image/upload/w_1000,q_auto:good,f_jpg/De_no-fomos_igrclh.png',
    nl: { name: "De No-FOMO's", tag: 'Amsterdam loopt niet weg. Het is om de hoek. We gaan nog wel een keer.', text: 'Geen FOMO hier; alles is dichtbij, dus tijd zat. Jullie kennen de beste koffie drie straten verderop, maar zijn nog nooit met de kinderen op een rondvaartboot geweest. Artis komt “binnenkort”, de Poezenboot “een keer met bezoek” en die kinderboerderij sluit altijd zooo vroeg. Tot je kind ineens vraagt waarom jullie eigenlijk nog nooit iets leuks doen.' },
    en: { name: "The No-FOMO's", tag: 'Amsterdam isn’t going anywhere. It’s around the corner. We’ll go another time.', text: 'No FOMO here, everything’s nearby, so there’s plenty of time. You know the best coffee three streets away, but you’ve never taken the kids on a canal cruise. Artis is “soon”, the Catboat is “when we have visitors”, and the petting zoo always closes soooo early. Until your child suddenly asks why you never actually do anything fun.' } },
};
function typeOf(name) {
  const k = String(name || '').trim().toLowerCase();
  for (const pair of NAMES.slice(0, 6)) if (pair[0].toLowerCase() === k || pair[1].toLowerCase() === k) return TYPES[pair[0].toLowerCase()] || null;
  return null;
}

const TX = {
  en: { tab: 'Picked for you', top100: 'Your family type', food: 'Your Food Picks', bday: 'Your Party Picks',
        gift: { top100: (n) => `${numWord(n, 'en')} fun picks especially for you, of our Favorite Amsterdam Family plans.`, food: (n) => `${n} spots that fit your family`, bday: (n) => `${n} picks for your party` },
        made: 'Made with Amsterdam Families', site: 'amsterdamfamilies.com', free: 'Free', date: 'Picked on', page: 'Page' },
  nl: { tab: 'Voor jou gekozen', top100: 'Jouw gezinstype', food: 'Voor jullie uitgezocht', bday: 'Jouw feesttips',
        gift: { top100: (n) => `${numWord(n, 'nl')} leuke tips speciaal voor jullie, uit onze favoriete Amsterdamse familieplannen.`, food: (n) => `${n} plekken die bij jullie passen`, bday: (n) => `${n} tips voor jullie feestje` },
        made: 'Gemaakt met Amsterdam Families', site: 'amsterdamfamilies.com', free: 'Gratis', date: 'Gekozen op', page: 'Pagina' },
};

const WORDS = { en: { 20: 'Twenty', 15: 'Fifteen', 10: 'Ten', 5: 'Five', 3: 'Three' }, nl: { 20: 'Twintig', 15: 'Vijftien', 10: 'Tien', 5: 'Vijf', 3: 'Drie' } };
function numWord(n, lang) { return (WORDS[lang] && WORDS[lang][n]) || String(n); }

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
  if (/res\.cloudinary\.com\/.*\/image\/upload\//.test(u) && !/\/image\/upload\/w_/.test(u)) u = u.replace('/image/upload/', `/image/upload/w_${w},h_${h},c_fill,g_auto,q_auto:good,f_jpg/`);
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

// width/height of a JPEG or PNG buffer (enough for the cover's fit box)
function pngOrJpgSize(buf) {
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xFF) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
  } catch (e) {}
  return null;
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

function cover(doc, t, page, name, n, lang, ill, ty) {
  const W = doc.page.width, H = doc.page.height;
  doc.rect(0, 0, W, H).fill(C.paper);
  const g = doc.linearGradient(0, 0, W, 420);
  g.stop(0, '#F1E6F6').stop(0.6, '#FBE4EE').stop(1, '#FDEFE8');
  doc.rect(0, 0, W, ill ? 410 : 300).fill(g);
  let y = 40;
  if (ill) {
    // Poster: the whole illustration (never cropped), centered on the pastel band, white frame
    const ih = 330, iw = Math.round(ih * (ill.w / ill.h)), ix = Math.round((W - iw) / 2), iy = 44;
    doc.save().roundedRect(ix - 8, iy - 8, iw + 16, ih + 16, 24).fill('#FFFFFF').restore();
    doc.save().roundedRect(ix, iy, iw, ih, 18).clip();
    try { doc.image(ill.buf, ix, iy, { fit: [iw, ih], align: 'center', valign: 'center' }); } catch (e) {}
    doc.restore();
    y = iy + ih + 28;
  } else {
    doc.save().opacity(0.55).circle(W - 60, 300, 170).fill('#FFFFFF').restore();
    y = 150;
  }
  // logo top right, no card
  try { doc.image(LOGO, W - 40 - 92, ill ? 44 : 40, { fit: [92, 56], align: 'right', valign: 'top' }); } catch (e) {}
  // ribbon
  doc.font(FONT.extra).fontSize(10);
  const rt = t.tab.toUpperCase();
  const rw = doc.widthOfString(rt, { characterSpacing: 2 }) + 30;
  const rg = doc.linearGradient(40, y, 40 + rw, y); rg.stop(0, C.purple).stop(1, C.pink);
  doc.save().roundedRect(40, y, rw, 24, 12).fill(rg).restore();
  doc.fillColor('#FFFFFF').text(rt, 55, y + 7, { characterSpacing: 2, lineBreak: false });
  y += 40;
  // label + name
  doc.font(FONT.extra).fontSize(10.5).fillColor(C.purple).text(t[page].toUpperCase(), 40, y, { characterSpacing: 2.2 });
  doc.font(FONT.extra).fontSize(name.length > 22 ? 28 : 34).fillColor(C.ink).text(name, 40, doc.y + 4, { width: W - 80 });
  // the type: tagline + description (Top 100 only), then the gift line
  if (ty) {
    doc.font(FONT.bold).fontSize(13.5).fillColor(C.purple).text(ty.tag, 40, doc.y + 6, { width: W - 80, lineGap: 2 });
    doc.font(FONT.regular).fontSize(11).fillColor(C.ink).text(ty.text, 40, doc.y + 8, { width: W - 80, lineGap: 3 });
  }
  doc.font(FONT.bold).fontSize(12.5).fillColor(C.soft).text(t.gift[page](n), 40, doc.y + 14, { width: W - 80, lineGap: 2 });
  const d = new Date();
  const ds = d.toLocaleDateString(lang === 'nl' ? 'nl-NL' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  doc.font(FONT.regular).fontSize(9.5).fillColor(C.muted).text(`${t.date} ${ds}`, 40, doc.y + 8);
  footer(doc, t, 1);
}

function itemBlock(doc, it, t, x, y, w, img) {
  // Compact card: photo left (190 wide), text right, 3 per page
  const ch = 228, pw = 190, pad = 14;
  doc.save().roundedRect(x, y, w, ch, 18).fill('#FFFFFF').restore();
  if (img) {
    doc.save().roundedRect(x, y, w, ch, 18).clip();
    try { doc.image(img, x, y, { cover: [pw, ch], align: 'center', valign: 'center' }); } catch (e) { doc.rect(x, y, pw, ch).fill(C.pillBg); }
    doc.restore();
  } else {
    doc.save().roundedRect(x, y, w, ch, 18).clip().rect(x, y, pw, ch).fill(C.pillBg).restore();
  }
  // number badge
  doc.save().circle(x + 24, y + 24, 15).fill(C.lilac).restore();
  doc.save().circle(x + 24, y + 24, 15).lineWidth(2.5).stroke('#FFFFFF').restore();
  doc.font(FONT.extra).fontSize(String(it.number).length > 2 ? 10 : 12).fillColor('#FFFFFF')
    .text(String(it.number), x + 24 - 16, y + 24 - 6, { width: 32, align: 'center', lineBreak: false });
  if (it.free) pill(doc, t.free.toUpperCase(), x + pw - 58, y + 12, { bg: C.free, color: C.freeTx });
  const tx = x + pw + pad, tw = w - pw - pad * 2;
  doc.font(FONT.extra).fontSize(14).fillColor(C.ink).text(it.title || '', tx, y + 16, { width: tw, height: 38, ellipsis: true });
  let ty = doc.y + 3;
  if (it.meta) { doc.font(FONT.bold).fontSize(9.5).fillColor(C.purple).text(it.meta, tx, ty, { width: tw, height: 13, ellipsis: true, lineBreak: false }); ty = doc.y + 6; }
  const textH = (y + ch - 36) - ty;
  if (it.text && textH > 20) {
    doc.font(FONT.regular).fontSize(9.5).fillColor(C.soft).text(String(it.text).replace(/\s+/g, ' ').trim(), tx, ty, { width: tw, height: textH, ellipsis: true, lineGap: 1.5 });
  }
  let px = tx; const py = y + ch - 28;
  (it.pills || []).forEach((p) => { if (px + 60 < x + w) px += pill(doc, p, px, py) + 6; });
  if (it.cost && !it.free && px + 80 < x + w) { doc.font(FONT.regular).fontSize(8.5).fillColor(C.muted).text(String(it.cost).replace(/\s+/g, ' '), px + 2, py + 4, { width: x + w - px - pad, height: 11, ellipsis: true }); }
}

async function buildPdf({ page, name, items, lang }) {
  const t = TX[lang === 'nl' ? 'nl' : 'en'];
  const typ = page === 'top100' ? typeOf(name) : null;
  let ill = null;
  if (typ) {
    const buf = await photo(typ.img, 1000, 1000);
    if (buf) { const dim = pngOrJpgSize(buf); if (dim) ill = { buf, w: dim.w, h: dim.h }; }
  }
  const ty = typ ? typ[lang === 'nl' ? 'nl' : 'en'] : null;
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `${name} - Amsterdam Families`, Author: 'Amsterdam Families' } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  doc.registerFont('K', FONT.regular); doc.registerFont('KB', FONT.bold); doc.registerFont('KX', FONT.extra);
  cover(doc, t, page, name, items.length, lang, ill, ty);

  // photos in parallel (small, fitted), then 2 items per page
  const imgs = await Promise.all(items.map((it) => photo(it.image, 600, 720)));
  const W = doc.page.width, H = doc.page.height, cw = W - 80;
  let pageNo = 1;
  for (let i = 0; i < items.length; i += 3) {
    doc.addPage(); pageNo++;
    doc.rect(0, 0, W, H).fill(C.paper);
    // page header
    doc.font(FONT.extra).fontSize(9).fillColor(C.purple).text(t.tab.toUpperCase(), 40, 28, { characterSpacing: 2, lineBreak: false });
    doc.font(FONT.bold).fontSize(9).fillColor(C.muted).text(name, 40, 28, { width: cw, align: 'right', lineBreak: false });
    for (let k = 0; k < 3 && items[i + k]; k++) itemBlock(doc, items[i + k], t, 40, 50 + k * (228 + 14), cw, imgs[i + k]);
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
