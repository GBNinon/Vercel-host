// api/recipe-image.js
// Vercel Serverless Function: one AI photo per recipe, with a Cloudinary cache.
// First request for a dish generates it (v3: gpt-image-2.5-flare, low quality, landscape, about half a cent).
// The cache key is the dish description from recipes.js (e.g. "pasta pesto with chicken"), shared by all families.
// Every later request for the same dish name is served from Cloudinary for free.
//
// NEEDS THESE ENVIRONMENT VARIABLES IN VERCEL (Settings -> Environment Variables):
//   OPENAI_API_KEY        (already there)
//   CLOUDINARY_CLOUD      = dhgfmuuo9
//   CLOUDINARY_KEY        = your Cloudinary API key
//   CLOUDINARY_SECRET     = your Cloudinary API secret
// (Cloudinary console -> Settings -> API Keys)
const axios = require('axios');
const { takeQuota, giveBack, limitReply } = require('./_quota');
const crypto = require('crypto');

// 'low' = about half a cent per new photo. 'medium' looks more real and costs more,
// but only the first time a dish is made; after that Cloudinary serves it for free.
const PHOTO_QUALITY = 'low';

function slugify(name) {
  return String(name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'recipe';
}

// Main ingredients without amounts, so the photo shows the real dish.
function mainIngredients(list) {
  if (!Array.isArray(list)) return '';
  return list
    .map((x) => String(x || '')
      .replace(/^[\d.,/\s]+(g|kg|ml|l|el|tl|tbsp|tsp|cup|cups|stuks?|pieces?|pinch|snufje|handful|handje)?\b\.?\s*/i, '')
      .replace(/\(.*?\)/g, '').trim())
    .filter((x) => x && !/pantry|basis|zout|salt|pepper|peper|oil|olie/i.test(x))
    .slice(0, 6)
    .join(', ');
}

function buildPrompt(name, ingredients) {
  const made = mainIngredients(ingredients);
  return 'Realistic, appetizing photo of a home-cooked family dish called "' + String(name).slice(0, 80) + '"' +
    (made ? ', made with ' + made : '') + '. ' +
    'Show the real, recognisable dish and ignore playful words in the name (like monster, dino, volcano, rainbow). ' +
    'Freshly made and delicious, like a photo in a modern family cookbook: simple white ceramic plate or bowl on a light wooden kitchen table, ' +
    'soft natural window light, 45 degree angle, shallow depth of field, realistic textures and natural colours, neat portion. ' +
    'No cartoon style, no faces made of food, no mush, no people, no hands, no text, no logos.';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Id');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  // dish = plain generic dish name from recipes.js ("potato pizza"), so photos are shared between users
  const { name, ingredients, dish } = req.body || {};
  if (!name || String(name).trim().length < 2) {
    return res.status(400).json({ error: 'name is required.' });
  }

  const cloud = process.env.CLOUDINARY_CLOUD;
  const key = process.env.CLOUDINARY_KEY;
  const secret = process.env.CLOUDINARY_SECRET;
  if (!cloud || !key || !secret) {
    return res.status(500).json({ error: 'Cloudinary env vars missing.' });
  }

  // v3 folder: photos from the new model. Older folders (recipe-photos/, recipe-photos-v2/) are no longer used.
  const photoKey = (dish && String(dish).trim().length > 2) ? dish : name;
  const publicId = 'recipe-photos-v3/' + slugify(photoKey);
  const cachedUrl = `https://res.cloudinary.com/${cloud}/image/upload/f_auto,q_auto,w_900/${publicId}.png`;

  // 1. Cache check: if the dish was generated before, return it for free.
  try {
    const head = await axios.head(cachedUrl, { timeout: 6000, validateStatus: () => true });
    if (head.status === 200) {
      return res.status(200).json({ url: cachedUrl, cached: true });
    }
  } catch (e) { /* fall through to generation */ }

  // Cached photos are free; only a NEW photo counts (see _quota.js)
  const q = await takeQuota(req, 'recipe_photo');
  if (!q.allowed) return limitReply(res, q);

  try {
    // 2. Generate at the lowest cost setting.
    const gen = await axios.post(
      'https://api.openai.com/v1/images/generations',
      {
        model: 'gpt-image-2.5-flare', // fast everyday model; gpt-image-1 is switched off on Oct 23, 2026
        // With a dish description the photo must fit EVERY recipe with that key, so no recipe-specific ingredients then.
        prompt: buildPrompt(photoKey, (dish && String(dish).trim().length > 2) ? [] : ingredients),
        size: '1536x1024',
        quality: PHOTO_QUALITY,
        n: 1,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        timeout: 60000,
      }
    );

    const b64 = gen.data?.data?.[0]?.b64_json;
    const genUrl = gen.data?.data?.[0]?.url;
    if (!b64 && !genUrl) throw new Error('No image in response');

    // 3. Store in Cloudinary under the dish slug (signed upload).
    const timestamp = Math.floor(Date.now() / 1000);
    const toSign = `overwrite=false&public_id=${publicId}&timestamp=${timestamp}${secret}`;
    const signature = crypto.createHash('sha1').update(toSign).digest('hex');

    const params = new URLSearchParams();
    params.append('file', b64 ? 'data:image/png;base64,' + b64 : genUrl);
    params.append('public_id', publicId);
    params.append('overwrite', 'false');
    params.append('timestamp', String(timestamp));
    params.append('api_key', key);
    params.append('signature', signature);

    await axios.post(
      `https://api.cloudinary.com/v1_1/${cloud}/image/upload`,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000, maxBodyLength: 30 * 1024 * 1024 }
    );

    return res.status(200).json({ url: cachedUrl, cached: false });
  } catch (error) {
    await giveBack(req, 'recipe_photo');
    console.error('Recipe image error:', error?.response?.data || error.message);
    const msg = error?.response?.data?.error?.message || error.message || 'Image generation failed.';
    return res.status(500).json({ error: msg });
  }
};
