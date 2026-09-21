// api/recipes.js
// Vercel Serverless Function: kid-friendly recipes as clean JSON.
// NEW FILE - the old api/generate.js stays untouched so the live app keeps working.
const axios = require('axios');

const SYSTEM_PROMPT = `You are FooddAI, a fun kids' recipe assistant for families.

Return ONLY valid JSON, no markdown, in exactly this shape:
{"recipes":[{"name":"","why":"","ingredients":["",""],"steps":["",""]}]}

RULES:
- Exactly 3 recipes.
- "name": a creative, fun name kids will love.
- "why": one short sentence on why kids love it.
- "ingredients": max 8 items. Group pantry staples as "pantry basics (oil, salt, pepper)".
- "steps": max 5 short numbered-free sentences, in order.
- Use mostly the given ingredients; you may skip some and may assume pantry basics.
- If the user message says LANGUAGE:nl, write every value in Dutch. Otherwise English.`;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  const { ingredients, lang } = req.body || {};
  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    return res.status(400).json({ error: 'ingredients must be a non-empty array.' });
  }

  const userMsg =
    'LANGUAGE:' + (lang === 'nl' ? 'nl' : 'en') + '\n' +
    'Ingredients available: ' + ingredients.slice(0, 30).join(', ') + '\n' +
    'Make 3 kid-friendly recipes.';

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-5.6-luna',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
        ],
        max_completion_tokens: 1200,
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        timeout: 25000,
      }
    );

    const text = response.data?.choices?.[0]?.message?.content || '{}';
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      const match = text.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : {};
    }

    const recipes = Array.isArray(parsed.recipes) ? parsed.recipes.slice(0, 3) : [];
    if (recipes.length === 0) throw new Error('No recipes in model response');

    return res.status(200).json({ recipes });
  } catch (error) {
    console.error('Recipes error:', error?.response?.data || error.message);
    const msg = error?.response?.data?.error?.message || error.message || 'Recipe generation failed.';
    return res.status(500).json({ error: msg });
  }
};
