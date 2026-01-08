// api/fridge-scan.js
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const multer = require('multer');

const app = express();

// CORS config - same as your generate.js
const corsOptions = {
  origin: '*', // Allow all origins for the app
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Multer for handling file uploads (stores in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
});

// POST route for scanning fridge photo
app.post('/api/fridge-scan', upload.single('image'), async (req, res) => {
  try {
    // Check if image was uploaded
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }

    // Convert image buffer to base64
    const base64Image = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype || 'image/jpeg';

    // Call OpenAI Vision API
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `You are a helpful assistant that identifies food ingredients in fridge photos.

Look at this fridge photo and list ALL the food ingredients you can see.

Rules:
- Return ONLY a JSON object with an "ingredients" array
- List everything edible you can identify (vegetables, fruits, dairy, meat, condiments, leftovers, etc.)
- Use simple, common ingredient names
- Be reasonably specific (e.g., "Cheddar cheese" or just "Cheese", "Greek yogurt" or just "Yogurt")
- Only list items you're fairly confident about

Response format (JSON only, no markdown code blocks):
{"ingredients": ["Eggs", "Milk", "Cheddar cheese", "Leftover chicken", "Tomatoes", "Mayonnaise"]}`
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${base64Image}`,
                  detail: 'low'
                }
              }
            ]
          }
        ],
        max_tokens: 500,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      }
    );

    // Parse the response
    const content = response.data.choices[0]?.message?.content || '';
    
    // Try to extract JSON from the response
    let ingredients = [];
    try {
      // Remove any markdown code blocks if present
      const cleanContent = content.replace(/```json\n?|\n?```/g, '').trim();
      const parsed = JSON.parse(cleanContent);
      ingredients = Array.isArray(parsed.ingredients) ? parsed.ingredients : [];
    } catch (parseError) {
      console.error('Failed to parse ingredients:', parseError);
      // Try to extract ingredients from plain text as fallback
      const matches = content.match(/["']([^"']+)["']/g);
      if (matches) {
        ingredients = matches.map(m => m.replace(/["']/g, ''));
      }
    }

    res.status(200).json({ ingredients });

  } catch (error) {
    console.error('Fridge scan error:', error.response?.data || error.message);
    
    if (error.response) {
      res.status(error.response.status).json({ 
        error: 'Failed to analyze image',
        details: error.response.data 
      });
    } else {
      res.status(500).json({ error: 'Failed to process image' });
    }
  }
});

module.exports = app;
