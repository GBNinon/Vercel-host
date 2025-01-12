// api/generate.js
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');

const app = express();

// CORS config to allow calls from GitHub Pages domain
const corsOptions = {
  origin: ['https://gbninon.github.io', 'https://gbninon.github.io/kids-recipe-picker'], // or "*" if you want to allow all
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(bodyParser.json());

// Our POST route for generating OpenAI text
app.post('/api/generate', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt || prompt.trim() === '') {
    return res.status(400).json({ error: 'Prompt cannot be empty.' });
  }

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        // If your doc says the model name is indeed 'gpt-4o-mini', keep it here
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1000,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      }
    );

    // Return OpenAI’s response to the frontend
    res.status(200).json(response.data);
  } catch (error) {
    if (error.response) {
      console.error('Error Response from OpenAI API:', error.response.data);
      res.status(error.response.status).json({ error: error.response.data });
    } else if (error.request) {
      console.error('No response received from OpenAI API:', error.request);
      res.status(500).json({ error: 'No response received from OpenAI API.' });
    } else {
      console.error('Error setting up OpenAI API request:', error.message);
      res.status(500).json({ error: 'Error setting up OpenAI API request.' });
    }
  }
});

module.exports = app;
