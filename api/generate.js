const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');

const app = express();

// CORS configuration
const corsOptions = {
    origin: ['https://gbninon.github.io'], // Allowed origin for your GitHub Pages
    methods: ['GET', 'POST', 'OPTIONS'], // Allowed HTTP methods
    allowedHeaders: ['Content-Type', 'Authorization'], // Allowed headers
    credentials: true, // Allow credentials like cookies or Authorization headers
};

app.use(cors(corsOptions)); // Apply CORS middleware
app.options('*', cors(corsOptions)); // Handle preflight requests
app.use(bodyParser.json());

// Default route (optional, for testing if the server is running)
app.get('/', (req, res) => {
    res.send('Server is running. Use POST /api/generate to interact with OpenAI.');
});

// OpenAI API endpoint
app.post('/api/generate', async (req, res) => {
    const { prompt } = req.body;

    // Validate prompt
    if (!prompt || prompt.trim() === '') {
        return res.status(400).json({ error: 'Prompt cannot be empty.' });
    }

    try {
        // Call OpenAI API with GPT-3.5 Turbo model
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: 'gpt-3.5-turbo', // Ensure to use the correct model name
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 300,
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, // Use the environment variable for the API key
                },
            }
        );

        // Send the response back to the frontend
        res.status(200).json(response.data);
    } catch (error) {
        console.error('Error calling OpenAI API:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to fetch response from OpenAI.' });
    }
});

// Export the handler for Vercel
module.exports = app;
