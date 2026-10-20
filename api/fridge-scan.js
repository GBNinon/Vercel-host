// api/fridge-scan.js
// Vercel Serverless Function for fridge photo scanning.
// v2 (Sep 2026): sure list + "maybe" list, optional zoomed tiles, Dutch names, no 25-item cap.
// v3 (Sep 2026): gpt-6-luna without reasoning (faster), whole photo at low detail, zoomed tiles at high detail.

// v4 (Sep 2026): strict JSON schema (Structured Outputs) instead of plain JSON mode.
// v5 (Oct 2026): low reasoning (better recall), 'maybe' only for really unclear items (max 5), shelf-by-shelf search, 60 s limit.
// v6 (14 Oct 2026): fewer false items (unsure = maybe, not sure list), never a category word as a name
//    ("vegetable" for spinach), generic names filtered out on the server too, shorter answer = a bit faster.
// v7 (20 Oct 2026): faster and fewer missed items, never Danish.
//    - Each zoomed quarter (tile) is now its own OpenAI request and the 4 requests run in PARALLEL
//      (each one also gets the whole photo at low detail for orientation). A smaller job per request
//      means a shorter answer and a closer look: the scan waits only for the slowest quarter.
//    - The server merges the 4 answers: sure in any quarter = sure, same item twice (case, accents,
//      plural, "Kaas" in maybe while "Geraspte kaas" is sure) is listed once.
//    - Per-request timeout + one quick retry; if a quarter still fails the others are used (partial result).
//    - Language named in full: "Dutch (Nederlands, as spoken in the Netherlands)", never Danish, Norwegian,
//      Swedish or German. Safety net: names with ae/o-slash/a-ring letters or typical Scandinavian/German
//      food words get one small fast text call that translates only those names; what still looks wrong is dropped.
//    - Old app versions without tiles keep the single request with the whole photo at high detail.

// Change here if the scan misses too much: 'none' (fastest) -> 'low' -> 'medium'
const MODEL = 'gpt-6-luna';
const REASONING = 'low';
// The small name-translation call (safety net) needs no thinking at all.
const FIX_REASONING = 'none';
const TILE_TIMEOUT_MS = 26000; // one OpenAI request (whole run must stay under the 60 s Vercel limit)
const FIX_TIMEOUT_MS = 8000;
const NAMES = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const multer = require('multer');
const axios = require('axios');
const { takeQuota, giveBack, limitReply } = require('./_quota');

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// Helper to run multer as promise
function runMulter(req, res) {
  return new Promise((resolve, reject) => {
    // 'image' = the whole photo; tile0..tile3 = optional zoomed quarters (app v1.1+)
    upload.fields([
      { name: 'image', maxCount: 1 },
      { name: 'tile0', maxCount: 1 }, { name: 'tile1', maxCount: 1 },
      { name: 'tile2', maxCount: 1 }, { name: 'tile3', maxCount: 1 },
    ])(req, res, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

const FRIDGE_SCAN_PROMPT = `You are FoodAI, the fridge helper of a family app.
You get one photo of a fridge (or pantry or kitchen counter). Often you get one zoomed-in part of that photo (a quarter) plus the whole photo at low resolution for orientation: then list ONLY the food you can see in the zoomed part (items cut off at its edge count too). Other parts of the fridge are checked separately, so do not list things you only see in the small whole photo.

Goal: list every FOOD item a parent could cook with or give to the kids. Missing an item is the most common mistake, so look carefully.

Make two lists:
- "ingredients": every item you can name with reasonable confidence. This is the main list and is usually long.
- "maybe": items you think you see but are not sure about (partly hidden, blurry, or you cannot tell exactly what it is). Max 8. Use your best guess name.
Only put an item in "ingredients" when you can really see it and know what it is. If you doubt whether it is there or what it is, it goes in "maybe": the parent ticks it on with one tap, but a wrong item in the main list ends up in the recipes. A clear package, jar or carton you can read or recognise by shape and colour (milk carton, egg box, cheese block, butter, yogurt pot) is a sure item, not a maybe.

How to look: go through the image systematically, shelf by shelf from top to bottom and left to right, then the door shelves, then the drawers and boxes. Look behind the front row and through transparent boxes, bags and drawers. Read every label you can (any language on the label is fine, but write the name in the requested language). Recognise partly hidden packaging by shape, colour and lid: egg boxes, cheese, butter, yogurt pots, cream, milk cartons, jars, tubs, cold cuts, meat and fish packs. Count small things too: herbs, lemons, a single pepper, a pot of olives.

Rules:
- Only list what is visible in THIS photo. Never add items just because fridges usually have them. If you cannot see it, leave it out.
- Food only: fruit, vegetables, herbs, dairy, eggs, meat, fish, bread, leftovers you can identify, sauces, spreads, condiments, jars, pickles.
- Drinks: only milk, plant milk and yogurt drinks. Skip water, juice, soft drinks and alcohol.
- Skip non-food and trivia: packaging, wrappers, paper, bags, foil, empty or closed containers you cannot identify, medicine, cosmetics, fridge parts, magnets, toys.
- Be specific and simple: "Cherry tomatoes", "Greek yogurt", "Grated cheese".
- Never use a category word as a name: not "Vegetable", "Vegetables", "Greens", "Fruit", "Herbs", "Sauce", "Dairy", "Meat", "Leftovers" (Dutch: not "Groente", "Fruit", "Kruiden", "Saus", "Zuivel", "Vlees", "Restjes"). Name the actual thing: leaves are "Spinach", "Lettuce", "Rocket" or "Kale". If you cannot tell which one it is, put your best guess in "maybe".
- Merge duplicates: three yogurt pots is one "Yogurt".
- No quantities, no brand names ("Chocolate spread", not the brand).
- No limit on the number of items, but never pad the list.
- Write every name in the language the message asks for, with a capital first letter. Dutch means Nederlands as spoken in the Netherlands ("Kerstomaatjes", "Griekse yoghurt", "Geraspte kaas", "Wortels", "Aardbeienjam"): never Danish, Norwegian, Swedish or German, so never the letters æ, ø or å ("Wortels", not "Gulerødder").

Return ONLY valid JSON: {"ingredients":["..."],"maybe":["..."],"notes":""}
"notes": one short sentence only when the photo is too dark or blurry, otherwise "".`;

// Structured Outputs: the model must return exactly this shape.
const SCAN_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'fridge_scan',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['ingredients', 'maybe', 'notes'],
      properties: {
        ingredients: { type: 'array', items: { type: 'string' } },
        maybe: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
      },
    },
  },
};

function toDataUrl(file) {
  const mime = file.mimetype || 'image/jpeg';
  return `data:${mime};base64,${file.buffer.toString('base64')}`;
}

function cleanList(arr, max) {
  const seen = new Set();
  const out = [];
  (Array.isArray(arr) ? arr : []).forEach((x) => {
    const name = String(x || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) return;
    seen.add(key);
    out.push(name);
  });
  return out.slice(0, max);
}

// v7: the language in full words ("nl" alone was sometimes read as Danish)
const LANG_LINE = {
  nl: 'LANGUAGE: Dutch (Nederlands, as spoken in the Netherlands). Write every name in Dutch. Never Danish, Norwegian, Swedish or German.',
  en: 'LANGUAGE: English. Write every name in English.',
};

function parseJson(text) {
  try {
    return JSON.parse(String(text || '').replace(/```json\n?|\n?```/g, '').trim());
  } catch (e) {
    const match = String(text || '').match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Could not parse response');
  }
}

async function askOpenAI(body, timeout) {
  const response = await axios.post('https://api.openai.com/v1/chat/completions', body, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    timeout,
  });
  return parseJson(response.data?.choices?.[0]?.message?.content || '');
}

function scanBody(content) {
  return {
    model: MODEL,
    reasoning_effort: REASONING,
    messages: [
      { role: 'system', content: FRIDGE_SCAN_PROMPT },
      { role: 'user', content },
    ],
    max_completion_tokens: 1800,
    response_format: SCAN_SCHEMA,
  };
}

// One quick retry when OpenAI fails fast (busy, 5xx, unreadable answer). A timeout or a bad request is not retried.
// The retry only happens when there is still enough time left before the deadline.
async function withRetry(fn, deadline) {
  try {
    return await fn();
  } catch (e) {
    const status = e?.response?.status;
    const timedOut = e?.code === 'ECONNABORTED' || /timeout/i.test(e?.message || '');
    if (timedOut || (status && status < 500 && status !== 429) || deadline - Date.now() < 15000) throw e;
    return fn();
  }
}

// Time left for one request: its own limit, but never past the deadline of the whole scan.
function timeLeft(ms, deadline) {
  return Math.max(1000, Math.min(ms, deadline - Date.now()));
}

// Key to spot the same item twice: case, accents, punctuation and a simple plural do not matter.
function itemKey(name, lang) {
  const s = String(name || '').toLowerCase().replace(/['\u2019]s\b/g, 's')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u00e6\u00f8\u00df ]+/g, ' ').trim().replace(/\s+/g, ' ');
  const words = s.split(' ');
  let last = words.pop() || '';
  if (last.length > 3) {
    last = last.replace(/oes$/, 'o');
    last = lang === 'nl' ? last.replace(/(s|en)$/, '') : last.replace(/s$/, '');
  }
  return words.concat(last).join(' ');
}

// Merge the answers of the parallel requests: sure in any part = sure, every item once.
function mergeResults(results, lang) {
  const sure = new Map();
  const maybe = new Map();
  let notes = '';
  results.forEach((r) => (Array.isArray(r.ingredients) ? r.ingredients : []).forEach((n) => {
    const k = itemKey(n, lang);
    if (k && !sure.has(k)) sure.set(k, n);
  }));
  // "Kaas" as a maybe adds nothing when "Geraspte kaas" is already sure
  const sureLast = new Set([...sure.keys()].map((k) => k.split(' ').pop()));
  results.forEach((r) => {
    (Array.isArray(r.maybe) ? r.maybe : []).forEach((n) => {
      const k = itemKey(n, lang);
      if (!k || sure.has(k)) return;
      if (!k.includes(' ') && sureLast.has(k)) return;
      if (maybe.has(k)) maybe.get(k).n += 1;
      else maybe.set(k, { name: n, n: 1 });
    });
    if (!notes && typeof r.notes === 'string') notes = r.notes;
  });
  // A maybe seen in more than one part comes first (the list is capped at 10 later)
  const maybeList = [...maybe.values()].sort((a, b) => b.n - a.n).map((m) => m.name);
  return { ingredients: [...sure.values()], maybe: maybeList, notes: sure.size ? '' : notes };
}

// Safety net: names that are clearly not Dutch (or not English). Danish/Norwegian letters always;
// for Dutch also common Danish, Swedish and German food words.
const FOREIGN_CHARS = /[\u00e6\u00f8\u00e5\u00c6\u00d8\u00c5]/;
const FOREIGN_WORDS_NL = /\b(ost|kylling|skinke|agurk|agurker|tomater|kartofler|leverpostej|rugbrod|flode|gurka|skinka|kyckling|potatis|morot|milch|sahne|schinken|gurke|gurken|wurst|zwiebel|zwiebeln|kartoffel|kartoffeln|karotten|hackfleisch|frischkase|joghurt)\b/i;
function looksForeign(name, lang) {
  const s = String(name || '');
  if (FOREIGN_CHARS.test(s)) return true;
  if (lang !== 'nl') return false;
  // German umlauts / Swedish letters are never in everyday Dutch food names (accents like e-acute are fine)
  if (/[\u00e4\u00f6\u00fc\u00df]/i.test(s) && !/^(m\u00fcsli|r\u00f6sti|h\u00fcttenk\u00e4se)$/i.test(s.trim())) return true;
  return FOREIGN_WORDS_NL.test(s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
}

const NAMES_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'food_names',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['names'],
      properties: { names: { type: 'array', items: { type: 'string' } } },
    },
  },
};

// Translate only the wrong-language names with one small, fast text call. Names that still look
// foreign afterwards (or when the call fails) are dropped, so the family never sees them.
async function fixLanguage(merged, lang, deadline) {
  const bad = merged.ingredients.concat(merged.maybe).filter((n) => looksForeign(n, lang));
  if (!bad.length) return merged;
  // Hardly any time left: skip the call, the wrong names are simply dropped below
  const skip = deadline - Date.now() < 3000;
  const target = lang === 'nl' ? 'Dutch (Nederlands, as spoken in the Netherlands)' : 'English';
  let map = new Map();
  if (!skip) try {
    const out = await askOpenAI({
      model: MODEL,
      reasoning_effort: FIX_REASONING,
      messages: [
        {
          role: 'system',
          content: 'Translate each food name into ' + target + '. Keep the same order and the same number of names. '
            + 'Use simple everyday supermarket words with a capital first letter, no brand names. '
            + 'Never Danish, Norwegian, Swedish or German. Return JSON {"names":[...]}.',
        },
        { role: 'user', content: JSON.stringify(bad) },
      ],
      max_completion_tokens: 400,
      response_format: NAMES_SCHEMA,
    }, timeLeft(FIX_TIMEOUT_MS, deadline));
    const names = Array.isArray(out && out.names) ? out.names : [];
    if (names.length === bad.length) bad.forEach((b, i) => map.set(b, String(names[i] || '').trim()));
  } catch (e) {
    console.error('Fridge scan language fix failed:', e?.response?.data || e.message);
    map = new Map();
  }
  const fix = (n) => {
    if (!looksForeign(n, lang)) return n;
    const t = map.get(n);
    return t && !looksForeign(t, lang) ? t : null;
  };
  return {
    ingredients: merged.ingredients.map(fix).filter(Boolean),
    maybe: merged.maybe.map(fix).filter(Boolean),
    notes: merged.notes,
  };
}

module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Id');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST with image.' });
  }

  let counted = false;
  try {
    // Parse multipart form data
    await runMulter(req, res);

    const files = req.files || {};
    const main = files.image && files.image[0];
    if (!main || !main.buffer) {
      return res.status(400).json({ error: 'No image received. Upload an image field named "image".' });
    }

    // Daily / monthly limit per member (see _quota.js)
    const q = await takeQuota(req, 'fridge_scan');
    if (!q.allowed) return limitReply(res, q);
    counted = true;

    const lang = (req.body && req.body.lang === 'nl') ? 'nl' : 'en';
    const tiles = ['tile0', 'tile1', 'tile2', 'tile3']
      .map((k, i) => { const f = files[k] && files[k][0]; if (f) f._i = i; return f; })
      .filter((f) => f && f.buffer);

    // Whole scan must finish well inside the 60 s Vercel limit (upload + quota check already took a bit)
    const deadline = Date.now() + 50000;
    const langLine = LANG_LINE[lang];
    const ask = 'Sure items in "ingredients", unsure items in "maybe". ' + langLine;
    const mainUrl = toDataUrl(main);
    let results;

    if (tiles.length) {
      // v7: one request per zoomed quarter, all at the same time. The whole photo rides along at
      // low detail (cheap) so the model knows where the quarter sits in the fridge.
      const settled = await Promise.allSettled(tiles.map((t) => withRetry(() => askOpenAI(scanBody([
        { type: 'text', text: langLine + '\nThe whole fridge photo, only for orientation:' },
        { type: 'image_url', image_url: { url: mainUrl, detail: 'low' } },
        { type: 'text', text: 'The zoomed-in ' + (NAMES[t._i] || 'part') + ' part of the same photo. List the food you can see in THIS part:' },
        { type: 'image_url', image_url: { url: toDataUrl(t), detail: 'high' } },
        { type: 'text', text: ask },
      ]), timeLeft(TILE_TIMEOUT_MS, deadline)), deadline)));
      results = settled.filter((s) => s.status === 'fulfilled' && s.value).map((s) => s.value);
      settled.filter((s) => s.status === 'rejected').forEach((s) => {
        console.error('Fridge scan part failed:', s.reason?.response?.data || s.reason?.message);
      });
      // Every quarter failed: same error path as before (the scan is given back)
      if (!results.length) throw settled[0].reason || new Error('Scan failed');
    } else {
      // Old app versions send no tiles: one request with the whole photo at high detail.
      results = [await withRetry(() => askOpenAI(scanBody([
        { type: 'text', text: langLine + '\nThe whole fridge photo:' },
        { type: 'image_url', image_url: { url: mainUrl, detail: 'high' } },
        { type: 'text', text: 'List the food you can see. ' + ask },
      ]), timeLeft(40000, deadline)), deadline)];
    }

    // Merge again after the language fix ("Græsk yoghurt" may now equal "Griekse yoghurt")
    const parsed = mergeResults([await fixLanguage(mergeResults(results, lang), lang, deadline)], lang);

    // Category words are never an ingredient (a recipe with "vegetable" in it is no use to anyone)
    const GENERIC = new Set(['vegetable', 'vegetables', 'veggies', 'greens', 'leafy greens', 'fruit', 'fruits', 'herbs', 'sauce', 'sauces', 'dairy', 'meat', 'fish', 'food', 'leftovers', 'groente', 'groenten', 'bladgroente', 'kruiden', 'saus', 'sauzen', 'zuivel', 'vlees', 'vis', 'eten', 'restjes']);
    const notGeneric = (x) => !GENERIC.has(String(x || '').trim().toLowerCase());
    const ingredients = cleanList((parsed.ingredients || []).filter(notGeneric), 60);
    const sureKeys = new Set(ingredients.map((x) => x.toLowerCase()));
    const maybe = cleanList((parsed.maybe || []).filter(notGeneric), 10).filter((x) => !sureKeys.has(x.toLowerCase()));
    const notes = typeof parsed.notes === 'string' ? parsed.notes : '';

    // "maybe" is new: older app versions simply ignore it.
    return res.status(200).json({ ingredients, maybe, notes });

  } catch (error) {
    if (counted) await giveBack(req, 'fridge_scan');
    console.error('Fridge scan error:', error?.response?.data || error.message);
    const msg = error?.response?.data?.error?.message || error.message || 'Scan failed';
    return res.status(500).json({ error: msg });
  }
};

// Disable Vercel's default body parser for file uploads
module.exports.config = {
  api: {
    bodyParser: false,
  },
  maxDuration: 60,
};
