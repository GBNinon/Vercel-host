// api/generate.js
// Combined API: Recipe generation + Fridge photo scanning
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');
const multer = require('multer');

const app = express();

// CORS config - allow all origins for GoodBarber app
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(bodyParser.json({ limit: '1mb' }));

// Multer for multipart image upload (memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image uploads are allowed.'));
    }
    cb(null, true);
  },
});

/**
 * POST /api/fridge-scan
 * Expects multipart/form-data with field name "image"
 * Returns: { ingredients: ["Eggs", "Tomatoes", ...], notes?: "..." }
 */
app.post('/api/fridge-scan', upload.single('image'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'No image received. Please upload an image field named "image".' });
    }

    // Convert image buffer to base64 data URL
    const mime = req.file.mimetype || 'image/jpeg';
    const base64 = req.file.buffer.toString('base64');
    const dataUrl = `data:${mime};base64,${base64}`;

    const FRIDGE_SCAN_PROMPT = `
You are FooddAI, a friendly assistant that helps families cook.
Task: Look at the fridge photo and list visible food ingredients.

Rules:
- Return ONLY valid JSON (no markdown, no extra text, no code blocks).
- JSON schema:
  {
    "ingredients": ["Ingredient 1", "Ingredient 2", "..."],
    "notes": "Optional short note if uncertain"
  }
- Ingredients should be simple grocery words (e.g., "Eggs", "Milk", "Tomatoes", "Cheese", "Carrots").
- If you see many items, return the 20 most useful cooking ingredients.
- If nothing is clear or image is not a fridge, return {"ingredients": [], "notes": "Could not identify ingredients"}.
`;

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
              { type: 'text', text: 'Scan this fridge photo and output the JSON.' },
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

    // Parse JSON safely
    let parsed;
    try {
      // Remove markdown code blocks if present
      const cleanText = text.replace(/```json\n?|\n?```/g, '').trim();
      parsed = JSON.parse(cleanText);
    } catch (e) {
      // Try to extract first JSON object in the text
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      } else {
        throw new Error('Could not parse JSON from model output.');
      }
    }

    const ingredients = Array.isArray(parsed.ingredients) ? parsed.ingredients : [];
    const notes = typeof parsed.notes === 'string' ? parsed.notes : '';

    return res.status(200).json({ ingredients, notes });

  } catch (error) {
    const msg = error?.response?.data?.error?.message || error.message || 'Fridge scan failed.';
    console.error('Fridge scan error:', error?.response?.data || error.message);
    return res.status(500).json({ error: msg });
  }
});

/**
 * POST /api/generate
 * Expects JSON: { prompt: "..." }
 * Returns: OpenAI chat completion response
 */
app.post('/api/generate', async (req, res) => {
  const { prompt } = req.body;
  
  if (!prompt || prompt.trim() === '') {
    return res.status(400).json({ error: 'Prompt cannot be empty.' });
  }

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 650,
        temperature: 0.6,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        timeout: 30000,
      }
    );

    // Return OpenAI response
    res.status(200).json(response.data);

  } catch (error) {
    if (error.response) {
      console.error('OpenAI API Error:', error.response.data);
      res.status(error.response.status).json({ error: error.response.data });
    } else if (error.request) {
      console.error('No response from OpenAI API:', error.request);
      res.status(500).json({ error: 'No response received from OpenAI API.' });
    } else {
      console.error('Request setup error:', error.message);
      res.status(500).json({ error: 'Error setting up OpenAI API request.' });
    }
  }
});

module.exports = app;
