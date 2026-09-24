// api/recipes.js
// Vercel Serverless Function: kid-friendly recipes as clean JSON.
// NEW FILE - the old api/generate.js stays untouched so the live app keeps working.
// v2 (Sep 2026): amounts, 5 to 8 cook-proof steps, time field, better Dutch.
const axios = require('axios');
const { takeQuota, giveBack, limitReply } = require('./_quota');

const SYSTEM_PROMPT = `You are FoodAI, the family cook of a family app. You write recipes a busy parent can cook tonight from the steps alone, and that kids actually want to eat.

Return ONLY valid JSON, no markdown, in exactly this shape:
{"recipes":[{"name":"","dish":"","why":"","time":"","ingredients":["",""],"steps":["",""]}]}

RECIPE RULES
- Exactly 3 recipes, and 3 different kinds of dish (for example one pasta or rice dish, one oven or pan dish, one lunch, snack or breakfast style dish).
- Every recipe is a real, recognisable dish or a sensible kids' twist on one. A real cook would make it this way. No odd combinations and no gimmicks that do not work in a real kitchen.
- Use only ingredients from the list plus pantry basics: oil, butter, salt, pepper, flour, sugar, water, stock cube, dried herbs and spices. Never add other fresh ingredients. You do not have to use everything.
- "name": a fun name kids love, max 6 words, that still makes clear what the dish is.
- "dish": the plain, generic dish type in English, lowercase, 1 to 3 words, no fun words, always in English even for Dutch recipes. Examples: "potato pizza", "cheese omelette", "pasta pesto", "fruit yogurt bowl".
- "why": one short sentence on why kids love it.
- "time": total time, for example "25 min".
- "ingredients": every ingredient WITH an amount for a family of 4 (2 adults, 2 kids), in metric units: "300 g pasta", "2 eggs", "1 onion", "1 tbsp tomato paste". Max 10 lines; pantry basics may share one line.
- "steps": 5 to 8 steps, in order. Each step is one clear action with what a beginner needs to know: how to cut (size or thickness), heat level, which pan, tray or dish, oven temperature in degrees Celsius, time in minutes, and how you can tell it is done ("until golden", "until a fork slides easily into the potato").
- When a technique is not obvious, explain it in a few words inside the step. Example: "Add the tomato paste to the onion and fry it for 1 minute, this takes away the sour taste. Then pour in ..." Never give a technique as a bare instruction without what it is for and what comes next.
- If a dish uses something unusual as a base, crust, wrap or binder (potato slices, grated potato, cauliflower, bread, tortilla), explain exactly how it holds together. Example for a potato pizza base: slice the potatoes 2 to 3 mm thin, lay them overlapping like roof tiles on baking paper, brush with oil and pre-bake 15 to 20 minutes at 220 degrees until the edges are golden and the slices stick together, only then add the topping. Or mix grated potato with egg and grated cheese so it binds. Never assume things stick together by themselves.
- Oven dishes: step 1 says to preheat the oven and to what temperature; a later step gives the bake time and the doneness sign.
- Meat, chicken and fish are always fully cooked; say how to check it in the step.
- Before you answer, check each recipe: does it taste good, is the order logical, are all amounts and times there, and could a parent cook it with only these steps? Fix anything that fails.

LANGUAGE
- If the user message says LANGUAGE:nl, write every value in natural, warm Dutch, the way a Dutch parent talks: "je"-form, Dutch kitchen words (bakken, koken, roerbakken, de oven voorverwarmen op 200 graden), units g, ml, el, tl, correct Dutch spelling, no English words where a normal Dutch word exists. Otherwise English.
- No em dashes and no emojis anywhere.`;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Id');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  const { ingredients, lang } = req.body || {};
  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    return res.status(400).json({ error: 'ingredients must be a non-empty array.' });
  }

  const userMsg =
    'LANGUAGE:' + (lang === 'nl' ? 'nl' : 'en') + '\n' +
    'Ingredients available: ' + ingredients.slice(0, 60).map(String).join(', ') + '\n' +
    'Make 3 kid-friendly recipes with full amounts and clear steps.';

  // Daily / monthly limit per member (see _quota.js)
  const q = await takeQuota(req, 'recipes');
  if (!q.allowed) return limitReply(res, q);

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-5.6-luna',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
        ],
        max_completion_tokens: 4000,
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        timeout: 55000,
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
    await giveBack(req, 'recipes');
    console.error('Recipes error:', error?.response?.data || error.message);
    const msg = error?.response?.data?.error?.message || error.message || 'Recipe generation failed.';
    return res.status(500).json({ error: msg });
  }
};
