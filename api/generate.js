const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');

const app = express();

const corsOptions = {
    origin: [
        'https://gbninon.github.io/kids-recipe-picker', // GitHub Pages
        'http://localhost:3000', // Local testing (optional)
    ],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Access-Control-Allow-Headers'], // Include all necessary headers
};

app.use(cors(corsOptions));
app.use(bodyParser.json());

// Preflight request handling
app.options('*', cors(corsOptions));
app.use(bodyParser.json());

// Default route (optional, for testing if the server is running)
app.get('/', (req, res) => {
    res.send('Server is running. Use POST /api/generate to interact with OpenAI.');
});

// OpenAI API endpoint
app.post('/api/generate', async (req, res) => {
    const { prompt } = req.body;

    try {
        // Call OpenAI API
        const response = await axios.post(
            'https://api.openai.com/v1/completions',
            {
                model: 'text-davinci-003',
                prompt: prompt,
                max_tokens: 150,
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, // Use the environment variable
                },
            }
        );

        // Send the response back to the frontend
        res.status(200).json(response.data);
    } catch (error) {
        console.error('Error calling OpenAI API:', error.response?.data || error.message);
        res.status(500).json({
            error: 'Failed to fetch response from OpenAI.',
        });
    }
});

// Export the handler for Vercel
module.exports = app;
