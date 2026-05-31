const express = require('express');
const mode = require('../utils/mode');

const router = express.Router();

router.get('/mode', (_req, res) => {
    res.json({ success: true, ...mode.getState() });
});

router.post('/mode', (req, res) => {
    try {
        const next = String(req.body?.mode || '').toLowerCase();
        const state = mode.setMode(next);
        res.json({ success: true, ...state });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

module.exports = router;
