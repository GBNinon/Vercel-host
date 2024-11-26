const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');

const app = express();

const corsOptions = {
    origin: ['https://gbninon.github.io'], // Allowed origin
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
    console.log('Received prompt:', prompt); // Log the incoming prompt

    try {
        if (!process.env.OPENAI_API_KEY) {
            console.error('Missing OPENAI_API_KEY in environment variables');
            return res.status(500).json({
                error: 'Server configuration error: Missing API key.',
            });
        }

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

        console.log('OpenAI API Response:', response.data); // Log OpenAI's response

        // Send the response back to the frontend
        res.status(200).json(response.data);
    } catch (error) {
        console.error('Error calling OpenAI API:', error.response?.data || error.message); // Log detailed error
        res.status(500).json({
            error: 'Failed to fetch response from OpenAI.',
        });
    }
});

// Export the handler for Vercel
module.exports = app;
