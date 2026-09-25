// api/fridge-scan.js
// Vercel Serverless Function for fridge photo scanning.
// v2 (Sep 2026): sure list + "maybe" list, optional zoomed tiles, Dutch names, no 25-item cap.
// v3 (Sep 2026): gpt-6-luna without reasoning (faster), whole photo at low detail, zoomed tiles at high detail.

// v4 (Sep 2026): strict JSON schema (Structured Outputs) instead of plain JSON mode.

// Change here if the scan misses too much: 'none' (fastest) -> 'low' -> 'medium'
const MODEL = 'gpt-6-luna';
const REASONING = 'none';
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
You get one photo of a fridge (or pantry or kitchen counter). Sometimes 4 zoomed-in quarters of the SAME photo follow (top-left, top-right, bottom-left, bottom-right). Use the quarters to read small items and labels. They show the same fridge, so never list an item twice.

Goal: list every FOOD item a parent could cook with or give to the kids.

Make two lists:
- "ingredients": items you can clearly see and identify.
- "maybe": items you think you see but are not sure of (partly hidden, blurry, label hard to read). Max 10. Use your best guess name.

Rules:
- Only list what is visible in THIS photo. Never add items just because fridges usually have them. If you cannot see it, leave it out.
- Food only: fruit, vegetables, herbs, dairy, eggs, meat, fish, bread, leftovers you can identify, sauces, spreads, condiments, jars, pickles.
- Drinks: only milk, plant milk and yogurt drinks. Skip water, juice, soft drinks and alcohol.
- Skip non-food and trivia: packaging, wrappers, paper, bags, foil, empty or closed containers you cannot identify, medicine, cosmetics, fridge parts, magnets, toys.
- Be specific and simple: "Cherry tomatoes", "Greek yogurt", "Grated cheese", not "vegetables" or "dairy".
- Merge duplicates: three yogurt pots is one "Yogurt".
- No quantities, no brand names ("Chocolate spread", not the brand).
- No limit on the number of items, but never pad the list.
- If the message says LANGUAGE:nl, write every name in Dutch with a capital first letter ("Kerstomaatjes", "Griekse yoghurt", "Geraspte kaas"). Otherwise English.

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
      .map((k) => files[k] && files[k][0])
      .filter((f) => f && f.buffer);

    const content = [
      { type: 'text', text: 'LANGUAGE:' + lang + '\nThe whole fridge photo:' },
      // With tiles the whole photo is only for orientation, so low detail is enough.
      // Old app versions send no tiles: then the whole photo stays at high detail.
      { type: 'image_url', image_url: { url: toDataUrl(main), detail: tiles.length ? 'low' : 'high' } },
    ];
    if (tiles.length) {
      content.push({ type: 'text', text: 'Zoomed-in quarters of the same photo (top-left, top-right, bottom-left, bottom-right):' });
      tiles.forEach((t) => content.push({ type: 'image_url', image_url: { url: toDataUrl(t), detail: 'high' } }));
    }
    content.push({ type: 'text', text: 'List the food you can see. Sure items in "ingredients", unsure items in "maybe".' });

    // Call OpenAI Vision API
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: MODEL,
        reasoning_effort: REASONING,
        messages: [
          { role: 'system', content: FRIDGE_SCAN_PROMPT },
          { role: 'user', content },
        ],
        max_completion_tokens: 2500,
        response_format: SCAN_SCHEMA,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        timeout: 55000,
      }
    );

    const text = response.data?.choices?.[0]?.message?.content || '';

    // Parse JSON
    let parsed;
    try {
      const cleanText = text.replace(/```json\n?|\n?```/g, '').trim();
      parsed = JSON.parse(cleanText);
    } catch (e) {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      } else {
        throw new Error('Could not parse response');
      }
    }

    const ingredients = cleanList(parsed.ingredients, 60);
    const sureKeys = new Set(ingredients.map((x) => x.toLowerCase()));
    const maybe = cleanList(parsed.maybe, 10).filter((x) => !sureKeys.has(x.toLowerCase()));
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
};
