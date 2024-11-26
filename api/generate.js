const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');

const app = express();

// CORS configuration
const corsOptions = {
    origin: [
        'https://gbninon.github.io/kids-recipe-picker', // GitHub Pages
        'http://localhost:3000', // Local testing (optional)
    ],
    methods: ['GET', 'POST'],
    allowedHeaders: [
        'Content-Type',
        'Authorization', // Include this for API authorization headers
        'Access-Control-Allow-Headers', // Allow additional headers if needed
    ],
};

app.use(cors(corsOptions));
app.use(bodyParser.json());

// Handle preflight (OPTIONS) requests
app.options('*', cors(corsOptions));

// Default route (optional, for testing server status)
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
                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, // Secure environment variable
                },
            }
        );

        // Send the OpenAI response back to the client
        res.status(200).json(response.data);
    } catch (error) {
        console.error('Error calling OpenAI API:', error.response?.data || error.message);
        res.status(500).json({
            error: 'Failed to fetch response from OpenAI.',
        });
    }
});

// Export app for deployment
module.exports = app;
