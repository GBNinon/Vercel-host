const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');

const app = express();

const corsOptions = {
    origin: ['https://gbninon.github.io'], // Allowed origin for your GitHub Pages
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(bodyParser.json());

app.post('/api/generate', async (req, res) => {
    const { prompt } = req.body;

    if (!prompt || prompt.trim() === '') {
        return res.status(400).json({ error: 'Prompt cannot be empty.' });
    }

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: 'gpt-4o-mini', // Updated model name
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 3000, // Updated max tokens
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                },
            }
        );

        res.status(200).json(response.data);
    } catch (error) {
        console.error('Error calling OpenAI API:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to fetch response from OpenAI.' });
    }
});

module.exports = app;
