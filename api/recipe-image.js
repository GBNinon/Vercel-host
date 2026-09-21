// api/recipe-image.js
// Vercel Serverless Function: one AI photo per recipe, with a Cloudinary cache.
// First request for a dish generates it (lowest cost setting, about 1 cent).
// Every later request for the same dish name is served from Cloudinary for free.
//
// NEEDS THESE ENVIRONMENT VARIABLES IN VERCEL (Settings -> Environment Variables):
//   OPENAI_API_KEY        (already there)
//   CLOUDINARY_CLOUD      = dhgfmuuo9
//   CLOUDINARY_KEY        = your Cloudinary API key
//   CLOUDINARY_SECRET     = your Cloudinary API secret
// (Cloudinary console -> Settings -> API Keys)
const axios = require('axios');
const crypto = require('crypto');

function slugify(name) {
  return String(name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'recipe';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  const { name } = req.body || {};
  if (!name || String(name).trim().length < 2) {
    return res.status(400).json({ error: 'name is required.' });
  }

  const cloud = process.env.CLOUDINARY_CLOUD;
  const key = process.env.CLOUDINARY_KEY;
  const secret = process.env.CLOUDINARY_SECRET;
  if (!cloud || !key || !secret) {
    return res.status(500).json({ error: 'Cloudinary env vars missing.' });
  }

  const publicId = 'recipe-photos/' + slugify(name);
  const cachedUrl = `https://res.cloudinary.com/${cloud}/image/upload/f_auto,q_auto,w_600/${publicId}.png`;

  // 1. Cache check: if the dish was generated before, return it for free.
  try {
    const head = await axios.head(cachedUrl, { timeout: 6000, validateStatus: () => true });
    if (head.status === 200) {
      return res.status(200).json({ url: cachedUrl, cached: true });
    }
  } catch (e) { /* fall through to generation */ }

  try {
    // 2. Generate at the lowest cost setting.
    const gen = await axios.post(
      'https://api.openai.com/v1/images/generations',
      {
        model: 'gpt-image-1',
        prompt:
          'Bright appetizing food photography of "' + String(name).slice(0, 80) + '", ' +
          'a kid-friendly family dish, served on a colorful plate on a light wooden table, ' +
          'soft natural daylight, overhead angle, no people, no text, no hands.',
        size: '1024x1024',
        quality: 'low',
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
    if (!b64) throw new Error('No image in response');

    // 3. Store in Cloudinary under the dish slug (signed upload).
    const timestamp = Math.floor(Date.now() / 1000);
    const toSign = `overwrite=false&public_id=${publicId}&timestamp=${timestamp}${secret}`;
    const signature = crypto.createHash('sha1').update(toSign).digest('hex');

    const params = new URLSearchParams();
    params.append('file', 'data:image/png;base64,' + b64);
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
    console.error('Recipe image error:', error?.response?.data || error.message);
    const msg = error?.response?.data?.error?.message || error.message || 'Image generation failed.';
    return res.status(500).json({ error: msg });
  }
};
