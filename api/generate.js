// api/generate.js
// Vercel Serverless Function for recipe generation
const axios = require('axios');

// Optimized system prompt for shorter, faster responses
const RECIPE_SYSTEM_PROMPT = `You are FooddAI, a fun kids' recipe assistant.

OUTPUT FORMAT (strict):
For each recipe give ONLY:
- **Recipe Name** (creative kid-friendly name)
- *Why kids love it:* (1 short sentence)
- **Ingredients:** (max 8 items, group pantry staples as "+pantry basics")
- **Steps:** (max 5 numbered steps, short sentences)

RULES:
- Give exactly 3 recipes
- NO intro paragraph, NO outro
- Keep it SHORT - each recipe max 120 words
- Use fun names kids will love
- Start immediately with "**1."`;

module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only POST allowed
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const { prompt } = req.body || {};

  if (!prompt || prompt.trim() === '') {
    return res.status(400).json({ error: 'Prompt cannot be empty.' });
  }

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: RECIPE_SYSTEM_PROMPT },
          { role: 'user', content: prompt }
        ],
        max_tokens: 600,
        temperature: 0.7,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        timeout: 25000,
      }
    );

    // Return OpenAI response in same format frontend expects
    return res.status(200).json(response.data);

  } catch (error) {
    console.error('Generate error:', error?.response?.data || error.message);
    const msg = error?.response?.data?.error?.message || error.message || 'Recipe generation failed.';
    return res.status(500).json({ error: msg });
  }
};
