// /api/activity - operator audit trail.
//
// Returns rows from the `user_activity` table (migration 0008), newest first.
// Query params:
//   ?days=N       - lookback window, default 7
//   ?limit=N      - cap returned rows, default 5000
//   ?action=X     - optional single-action filter (icp_created, sweep_resumed, ...)
//   ?user=X       - optional per-user lookup. Bluebird is single-operator
//                   today, so this is mostly future-proofing.
//
// Read-only. The actual write path is the trackActivity middleware attached
// to mutating endpoints (see api/middleware/activity.js).

const express = require('express');
const { getAllActivity, getUserActivity } = require('../utils/activity-tracker');

const router = express.Router();

router.get('/', async (req, res) => {
    try {
        const days = Math.max(1, parseInt(req.query.days, 10) || 7);
        const limit = Math.max(1, parseInt(req.query.limit, 10) || 5000);
        const userFilter = req.query.user ? String(req.query.user) : null;
        const actionFilter = req.query.action ? String(req.query.action) : null;

        let activity = userFilter
            ? await getUserActivity(userFilter, days)
            : await getAllActivity(days, limit);

        if (actionFilter) {
            activity = activity.filter((a) => a.action === actionFilter);
        }
        res.json({ success: true, activity });
    } catch (err) {
        console.error(`[Activity] fetch failed: ${err.message}`);
        res.status(500).json({ success: false, error: err.message || 'failed to fetch activity' });
    }
});

module.exports = router;
