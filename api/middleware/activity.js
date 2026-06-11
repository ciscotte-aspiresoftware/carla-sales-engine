// Express middleware factory for the user-activity log.
//
// Usage on a route file:
//   const { trackActivity } = require('../middleware/activity');
//   router.post('/', trackActivity('icp_created'), handler);
//
// Logs (fire-and-forget) BEFORE the handler runs, so a 400 / 500 from the
// handler still leaves a trace of "the operator attempted X" in the log.
// Sensitive body fields are stripped before persistence.

const { trackUserActivity, DEFAULT_USER } = require('../utils/activity-tracker');

function sanitizeBody(body) {
    if (!body || typeof body !== 'object') return {};
    const clone = { ...body };
    const sensitive = ['password', 'secret', 'token', 'apiKey', 'api_key', 'authorization'];
    for (const key of sensitive) {
        if (clone[key] != null) clone[key] = '[REDACTED]';
    }
    return clone;
}

function trackActivity(action) {
    return (req, _res, next) => {
        // Carla has no auth today - everything is the single local
        // operator. Future multi-user: read req.session?.user or similar
        // here and fall back to 'operator'.
        const userId = req.session?.userName || DEFAULT_USER;
        const details = {
            method: req.method,
            path: req.originalUrl,
            body: sanitizeBody(req.body),
        };
        // Fire-and-forget - never await, never block the request. If Supabase
        // is unhealthy the action still goes through; we just lose the log
        // entry for it.
        void trackUserActivity(userId, action, details);
        next();
    };
}

module.exports = { trackActivity };