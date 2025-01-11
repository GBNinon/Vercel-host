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
app.use(cors({ origin: '*' }));

app.post('/api/generate', async (req, res) => {
    const { prompt } = req.body;

    if (!prompt || prompt.trim() === '') {
        return res.status(400).json({ error: 'Prompt cannot be empty.' });
    }

    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: 'gpt-4o-mini', // Ensure this matches exactly with OpenAI's documentation
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 1000, // Adjusted max tokens
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, // Corrected syntax
                },
            }
        );

        res.status(200).json(response.data);
    } catch (error) {
        if (error.response) {
            // OpenAI API responded with an error
            console.error('Error Response from OpenAI API:', error.response.data);
            res.status(error.response.status).json({ error: error.response.data });
        } else if (error.request) {
            // No response received from OpenAI API
            console.error('No response received from OpenAI API:', error.request);
            res.status(500).json({ error: 'No response received from OpenAI API.' });
        } else {
            // Other errors
            console.error('Error setting up OpenAI API request:', error.message);
            res.status(500).json({ error: 'Error setting up OpenAI API request.' });
        }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

module.exports = app;
