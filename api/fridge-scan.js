// api/fridge-scan.js
// Vercel Serverless Function for fridge photo scanning
const multer = require('multer');
const axios = require('axios');

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// Helper to run multer as promise
function runMulter(req, res) {
  return new Promise((resolve, reject) => {
    upload.single('image')(req, res, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

const FRIDGE_SCAN_PROMPT = `You are FooddAI, a friendly assistant that helps families cook.
Task: Look at this fridge/food photo and list visible food ingredients.

Rules:
- Return ONLY valid JSON (no markdown, no code blocks, no extra text)
- JSON format: {"ingredients": ["Eggs", "Milk", "Cheese", ...], "notes": "optional note"}
- Use simple grocery words kids understand
- Max 20 most useful cooking ingredients
- If unclear: {"ingredients": [], "notes": "Could not identify ingredients"}`;

module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST with image.' });
  }

  try {
    // Parse multipart form data
    await runMulter(req, res);

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'No image received. Upload an image field named "image".' });
    }

    // Convert to base64
    const mime = req.file.mimetype || 'image/jpeg';
    const base64 = req.file.buffer.toString('base64');
    const dataUrl = `data:${mime};base64,${base64}`;

    // Call OpenAI Vision API
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: FRIDGE_SCAN_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'List the food ingredients you see:' },
              { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
            ],
          },
        ],
        max_tokens: 300,
        temperature: 0.2,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        timeout: 30000,
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

    const ingredients = Array.isArray(parsed.ingredients) ? parsed.ingredients : [];
    const notes = typeof parsed.notes === 'string' ? parsed.notes : '';

    return res.status(200).json({ ingredients, notes });

  } catch (error) {
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
