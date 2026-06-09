// /api/admin/* - operator-tunable settings.
//
// GET  /api/admin/settings  -> { state, defaults, effective }
// PUT  /api/admin/settings  body: { cellGeneration?, firecrawl? }
//
// PUT accepts partial payloads: only the groups present in the body are
// updated. Each group must be `{ useDefault, custom }`. Toggling
// useDefault: true preserves the previously-typed custom values so the
// user can flip back to Custom later without retyping.

const express = require('express');
const settings = require('../utils/settings');

const router = express.Router();

router.get('/settings', (_req, res) => {
    res.json({ success: true, ...settings.getState() });
});

router.put('/settings', (req, res) => {
    try {
        const next = settings.setSettings(req.body || {});
        console.log('[Admin] settings updated', {
            cellGeneration: { useDefault: next.state.cellGeneration.useDefault },
            firecrawl: { useDefault: next.state.firecrawl.useDefault, mode: next.effective.firecrawl.mode, maxPages: next.effective.firecrawl.crawlMaxPages },
        });
        res.json({ success: true, ...next });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

module.exports = router;
