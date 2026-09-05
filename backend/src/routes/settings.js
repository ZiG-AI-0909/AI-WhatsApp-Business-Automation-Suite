const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const aiService = require('../ai/aiService');

const ENV_PATH = path.join(__dirname, '..', '..', '..', '.env');
const fieldKeys = {
    aiApiKey: 'AI_API_KEY',
    aiBaseURL: 'AI_BASE_URL',
    aiModel: 'AI_MODEL',
    businessName: 'BUSINESS_NAME',
    businessTagline: 'BUSINESS_TAGLINE',
};

function getSettings() {
    return {
        ai: {
            available: aiService.isAvailable(),
            model: aiService.getModel(),
            baseURL: process.env.AI_BASE_URL || '',
        },
        business: {
            name: process.env.BUSINESS_NAME || 'Bhavesh Pipes',
            tagline: process.env.BUSINESS_TAGLINE || '',
        },
    };
}

// GET /api/settings
router.get('/', (req, res) => {
    res.json(getSettings());
});

router.put('/', (req, res) => {
    const provided = Object.entries(fieldKeys)
        .map(([field, key]) => [key, req.body?.[field]])
        .filter(([, value]) => typeof value === 'string' && value.trim());
    if (!provided.length) return res.json(getSettings());

    let envText = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
    const ending = envText.endsWith('\n') ? '' : '\n';
    for (const [key, value] of provided) {
        const line = `${key}=${value.trim()}`;
        const pattern = new RegExp(`^${key}=.*$`, 'm');
        if (pattern.test(envText)) envText = envText.replace(pattern, line);
        else envText += `${ending}${line}\n`;
        process.env[key] = value.trim();
    }
    fs.writeFileSync(ENV_PATH, envText);
    aiService.reconfigure();
    res.json(getSettings());
});

module.exports = router;
