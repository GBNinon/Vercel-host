// api/recipes.js
// Vercel Serverless Function: kid-friendly recipes as clean JSON.
// NEW FILE - the old api/generate.js stays untouched so the live app keeps working.
// v2 (Sep 2026): amounts, 5 to 8 cook-proof steps, time field, better Dutch.
// v3 (Sep 2026): gpt-6-luna with medium reasoning (it has to check amounts, order and cooking logic).
// v4 (Sep 2026): strict JSON schema, preferences apart from ingredients, lunch/dinner meals with more flair.
// v5 (Oct 2026): low reasoning + 60 s function limit; medium reasoning ran past Vercel's 30 s limit (504).
// v6 (Oct 2026): "dish" describes the whole plate (all visible parts) so the photo matches the recipe.
// v7 (21 Oct 2026, after an external review): medium reasoning + Fast processing (falls back to low, and to
//    standard processing / a looser schema if the API refuses), the schema enforces exactly 3 recipes with
//    5 to 8 steps and max 10 ingredient lines, and two new rules: the fridge ingredients are the heroes, and
//    every listed ingredient is used in the steps (and the other way round).
const axios = require('axios');
const { takeQuota, giveBack, limitReply } = require('./_quota');

const SYSTEM_PROMPT = `You are FoodAI, the family cook of a family app. You write recipes a busy parent can cook tonight from the steps alone, and that kids actually want to eat.

Return ONLY valid JSON, no markdown, in exactly this shape:
{"recipes":[{"name":"","dish":"","why":"","time":"","ingredients":["",""],"steps":["",""]}]}

RECIPE RULES
- Exactly 3 recipes: 3 noticeably different family meal ideas suitable for lunch or dinner. Vary the cooking style, texture and presentation rather than making three versions of the same dish.
- Think like a creative family-food editor before choosing the dishes. Keep them familiar enough that children will eat them, but more inspiring than the most obvious default. Kid-friendly does not mean bland, beige or childish. Avoid defaulting to pasta, wraps and omelettes when the available ingredients allow another familiar, appealing meal.
- Every recipe is a real, recognisable dish or a sensible kids' twist on one. A real cook would make it this way. No odd combinations and no gimmicks that do not work in a real kitchen.
- Words like fast, easy, extrahealthy or glutenfree in the ingredient list are wishes, not ingredients: treat them as PREFERENCES.
- Use only ingredients from the list plus pantry basics: oil, butter, salt, pepper, flour, sugar, water, stock cube, dried herbs and spices. Never add other fresh ingredients. You do not have to use everything.
- "name": a fun name kids love, max 6 words, that still makes clear what the dish is.
- "dish": what the finished plate LOOKS like, for the photo: the dish type plus every visible component and how it is served, in English, lowercase, 8 to 18 words, no fun words, always in English even for Dutch recipes. Only things that are really in this recipe. Examples: "penne with green pesto, sliced roast chicken and steamed broccoli florets, grated cheese on top", "crispy potato slice pizza base topped with tomato sauce, ham strips and melted cheese, cut in squares".
- "why": one short sentence on why kids love it.
- "time": total time, for example "25 min".
- "ingredients": every ingredient WITH an amount for a family of 4 (2 adults, 2 kids), in metric units: "300 g pasta", "2 eggs", "1 onion", "1 tbsp tomato paste". Max 10 lines; pantry basics may share one line.
- "steps": 5 to 8 steps, in order. Each step is one clear action with what a beginner needs to know: how to cut (size or thickness), heat level, which pan, tray or dish, oven temperature in degrees Celsius, time in minutes, and how you can tell it is done ("until golden", "until a fork slides easily into the potato").
- When a technique is not obvious, explain it in a few words inside the step. Example: "Add the tomato paste to the onion and fry it for 1 minute, this takes away the sour taste. Then pour in ..." Never give a technique as a bare instruction without what it is for and what comes next.
- If a dish uses something unusual as a base, crust, wrap or binder (potato slices, grated potato, cauliflower, bread, tortilla), explain exactly how it holds together. Example for a potato pizza base: slice the potatoes 2 to 3 mm thin, lay them overlapping like roof tiles on baking paper, brush with oil and pre-bake 15 to 20 minutes at 220 degrees until the edges are golden and the slices stick together, only then add the topping. Or mix grated potato with egg and grated cheese so it binds. Never assume things stick together by themselves.
- Oven dishes: step 1 says to preheat the oven and to what temperature; a later step gives the bake time and the doneness sign.
- Meat, chicken and fish are always fully cooked; say how to check it in the step.
- Make the available ingredients the heroes of the recipes. Each recipe uses at least 2 to 3 ingredients from the list when possible. Pantry basics support the dish, they never become the main idea.
- Final consistency check: every ingredient in the list is actually used in the steps, and every non-pantry ingredient mentioned in the steps is in the ingredient list.
- Before you answer, check each recipe: does it taste good, is the order logical, are all amounts and times there, and could a parent cook it with only these steps? Fix anything that fails.

PREFERENCES (only when the user message lists them; follow every one given)
- fast: total time 25 minutes or less where the ingredients allow; no long oven or simmer times.
- easy: one or two pans or trays at most, simple techniques, 5 or 6 steps.
- extrahealthy: vegetables fill at least half the plate, go easy on butter, cream, cheese, sugar and frying; whole grains when available.
- glutenfree: no wheat, flour, bread, regular pasta, couscous, bulgur, breadcrumbs or ordinary soy sauce. Leave those out even if they are in the list, use rice, potatoes, corn or gluten-free alternatives that are in the list, and say "gluten-free stock cube" when using stock.

LANGUAGE
- If the user message says LANGUAGE:nl, write every value in natural, warm Dutch, the way a Dutch parent talks: "je"-form, Dutch kitchen words (bakken, koken, roerbakken, de oven voorverwarmen op 200 graden), units g, ml, el, tl, correct Dutch spelling, no English words where a normal Dutch word exists. Otherwise English.
- No em dashes and no emojis anywhere.`;

// Structured Outputs: the model must return exactly this shape.
const RECIPE_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'family_recipes',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['recipes'],
      properties: {
        recipes: {
          type: 'array',
          minItems: 3,
          maxItems: 3,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'dish', 'why', 'time', 'ingredients', 'steps'],
            properties: {
              name: { type: 'string' },
              dish: { type: 'string' },
              why: { type: 'string' },
              time: { type: 'string' },
              ingredients: { type: 'array', maxItems: 10, items: { type: 'string' } },
              steps: { type: 'array', minItems: 5, maxItems: 8, items: { type: 'string' } },
            },
          },
        },
      },
    },
  },
};

const PREFS = ['fast', 'easy', 'extrahealthy', 'glutenfree'];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Id');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  const { ingredients, lang, preferences } = req.body || {};
  // preferences (app v1.1+): wishes like fast or glutenfree, sent apart from the ingredients
  const prefs = (Array.isArray(preferences) ? preferences : []).map(String).filter((p) => PREFS.includes(p));
  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    return res.status(400).json({ error: 'ingredients must be a non-empty array.' });
  }

  const userMsg =
    'LANGUAGE:' + (lang === 'nl' ? 'nl' : 'en') + '\n' +
    'Ingredients available: ' + ingredients.slice(0, 60).map(String).join(', ') + '\n' +
    (prefs.length ? 'PREFERENCES: ' + prefs.join(', ') + '\n' : '') +
    'Make 3 kid-friendly recipes with full amounts and clear steps.';

  // Daily / monthly limit per member (see _quota.js)
  const q = await takeQuota(req, 'recipes');
  if (!q.allowed) return limitReply(res, q);

  try {
    // v7: try medium reasoning with Fast processing first; if that is refused or too slow, fall back step by step.
    // A looser copy of the schema (no min/max) is only used when the API rejects the strict one.
    const LOOSE_SCHEMA = JSON.parse(JSON.stringify(RECIPE_SCHEMA, (k, v) => (k === 'minItems' || k === 'maxItems' ? undefined : v)));
    const started = Date.now();
    const call = (effort, fast, schema, timeout) => axios.post(
      'https://api.openai.com/v1/chat/completions',
      Object.assign({
        model: 'gpt-6-luna',
        reasoning_effort: effort,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
        ],
        max_completion_tokens: 3500,
        response_format: schema,
      }, fast ? { service_tier: 'fast' } : {}),
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        timeout,
      }
    );
    const refused = (e) => e?.response?.status === 400;
    const left = () => Math.max(5000, 55000 - (Date.now() - started));
    let response;
    let fast = true;
    let schema = RECIPE_SCHEMA;
    try {
      response = await call('medium', fast, schema, 36000);
    } catch (e1) {
      if (refused(e1)) {
        const m = String(e1?.response?.data?.error?.message || '');
        console.error('Recipes: request refused, retrying simpler:', m);
        if (/service_tier/i.test(m)) fast = false; else if (/schema|minItems|maxItems/i.test(m)) schema = LOOSE_SCHEMA; else { fast = false; schema = LOOSE_SCHEMA; }
        try { response = await call('medium', fast, schema, Math.min(36000, left())); }
        catch (e2) { response = await call('low', false, LOOSE_SCHEMA, left()); }
      } else {
        // too slow or busy: the fast, low-reasoning version still fits in the 60 s limit
        console.error('Recipes: medium failed, falling back to low:', e1?.message);
        response = await call('low', fast, schema, left());
      }
    }

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

// Give the model up to 60 seconds (Vercel default for this project was 30).
module.exports.config = { maxDuration: 60 };
