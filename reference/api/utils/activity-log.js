// In-memory ring buffer of sweep events for the Coverage activity feed.
//
// Each sweep step (cell start, company found, cell complete, cell error)
// calls pushEvent with a one-line description + metadata. The frontend
// polls /api/grid/activity?since=<ts> every few seconds and prepends new
// events to a scrollable log on the Coverage page.
//
// Capped at MAX_EVENTS so a long overnight run doesn't balloon memory.
// No persistence - restart wipes the log; that's fine because the cells
// + companies.json hold the durable state and the log is just a
// "what's happening right now" UI affordance.

const MAX_EVENTS = 250;

let events = [];      // newest first
let nextId = 1;

// Lazy-required so this module doesn't blow up if loaded in a context
// where Socket.IO isn't wired (e.g. a CLI script that imports activity-log
// for read access). emitSweepEvent is a safe no-op until realtime.attach()
// has been called by api/index.js, so we can call it unconditionally here.
const { emitSweepEvent } = require('./realtime');

function pushEvent(evt) {
    const stored = {
        id: nextId++,
        ts: Date.now(),
        ...evt,
    };
    // Newest-first ordering matches how the UI renders so the frontend
    // can do `events.slice(0, n)` to show the latest n without sorting.
    events.unshift(stored);
    if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
    // Fan out to Socket.IO room for the ICP. Subscribed clients get the
    // event in real time; cold loads still go through /api/grid/activity
    // for the historical context.
    emitSweepEvent(stored);
    return stored;
}

// Return events strictly newer than `sinceId`. The frontend tracks the
// largest id it has seen and asks for everything after that - robust to
// dropped polls and avoids time-clock skew compared to ts-based since.
function eventsSince(sinceId = 0) {
    if (!sinceId) return events.slice(0, 50); // initial load - last 50
    return events.filter(e => e.id > sinceId);
}

function clear() {
    events = [];
    nextId = 1;
}

module.exports = { pushEvent, eventsSince, clear };
