// Socket.IO wrapper for real-time sweep progress.
//
// Why Socket.IO instead of polling: per-company sweep steps fire faster
// than the activity-log poll cadence (4s) can show - by the time the
// frontend pulls "scraping company 3", the server is already on company 5.
// Socket.IO pushes each event the instant it happens so the UI shows the
// real current step.
//
// Why rooms: a multi-tenant deploy will eventually have one user watching
// ICP A while another watches ICP B. Joining `icp:<icpId>` rooms means each
// client only receives the events for the ICP they're looking at - no
// fan-out cost on irrelevant updates. Today there's one user; the rooms
// just future-proof the wire format.
//
// Wire shape - every emit looks like:
//   io.to(`icp:${icpId}`).emit('sweep_event', { ...activityEvent })
// where activityEvent is whatever pushEvent() in activity-log.js stamped
// (id, ts, type, icpId, cellId, parentCity, message, plus per-type fields).
//
// History is still served by /api/grid/activity for cold loads; the socket
// only carries new events from the moment the client connects. The two
// channels are complementary: REST gets you context, socket keeps you
// current.

let io = null;

// Lazy-initialise on first attach() so this module can be required from
// anywhere (sweep-pipeline, activity-log, routes) without blowing up if
// Socket.IO hasn't been wired yet - we just become a no-op until then.
function attach(httpServer, opts = {}) {
    if (io) return io;
    const { Server } = require('socket.io');
    io = new Server(httpServer, {
        cors: { origin: true, credentials: true },
        // Path matches the default - keeps Vite's proxy config simple.
        path: '/socket.io',
        ...opts,
    });

    io.on('connection', (socket) => {
        // Clients tell us which ICP they care about by emitting `subscribe`
        // with an icpId. They can resubscribe (e.g. user switches ICP in
        // the dropdown) without reconnecting - just join the new room and
        // leave the old one.
        let currentIcp = null;
        socket.on('subscribe', (icpId) => {
            const id = String(icpId || '').trim();
            if (currentIcp && currentIcp !== id) {
                socket.leave(`icp:${currentIcp}`);
            }
            if (id) {
                socket.join(`icp:${id}`);
                currentIcp = id;
            }
        });
        socket.on('unsubscribe', () => {
            if (currentIcp) {
                socket.leave(`icp:${currentIcp}`);
                currentIcp = null;
            }
        });
    });

    console.log('[Realtime] Socket.IO attached');
    return io;
}

// Emit a sweep event to everyone subscribed to the ICP room. Called by
// activity-log.js so EVERY pushEvent() automatically fans out to the
// socket without callers needing to think about it.
function emitSweepEvent(evt) {
    if (!io || !evt || !evt.icpId) return;
    io.to(`icp:${evt.icpId}`).emit('sweep_event', evt);
}

function getIO() {
    return io;
}

module.exports = { attach, emitSweepEvent, getIO };
