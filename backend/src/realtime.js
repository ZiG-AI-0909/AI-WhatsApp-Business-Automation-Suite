// =============================================================
// Socket.IO realtime — per-user rooms with JWT authentication.
//
// SECURITY: clients must authenticate with the same Supabase JWT
// used for the REST API. After verification the socket joins its
// own room `user:<userId>`. All whatsapp:*, campaign:*, message:*
// and conversation:* events are emitted only to that room, so no
// browser ever receives another user's connection or message
// events. Unauthenticated sockets get no room and no events.
// =============================================================
const { supabase } = require('./database/supabaseClient');

const { isAllowedOrigin } = require('./utils/origins');

const USER_ROOM_PREFIX = 'user:';

function userRoom(userId) {
    return `${USER_ROOM_PREFIX}${userId}`;
}

/**
 * Attach per-user room authentication to a Socket.IO server.
 * Clients connect with:  io(url, { auth: { token: '<supabaseJWT>' } })
 * The JWT is validated against Supabase on every connection
 * (not just once) so revoked sessions stop receiving events.
 */
function attachRealtimeAuth(io) {
    io.use(async (socket, next) => {
        try {
            const token = socket.handshake.auth?.token || null;
            if (!token || !supabase) return next(new Error('Authentication required'));

            const { data, error } = await supabase.auth.getUser(token);
            if (error || !data?.user) return next(new Error('Session expired or invalid'));

            // Never trust a client-sent userId — derive it from the JWT.
            socket.data.userId = data.user.id;
            socket.join(userRoom(data.user.id));
            next();
        } catch (err) {
            next(new Error('Authentication failed'));
        }
    });

    io.on('connection', (socket) => {
        const userId = socket.data.userId;
        console.log(`[realtime] user ${userId} connected (room ${userRoom(userId)})`);

        // Send this user's own current state on connect — scoped emit only.
        socket.emit('whatsapp:status', whatsappStatusPayloadFor(io, userId));

        socket.on('disconnect', () => {
            console.log(`[realtime] user ${userId} disconnected`);
        });
    });
}

/**
 * Build the per-user whatsapp status payload. Provided as a helper so
 * routes/health endpoints can reuse the exact same shape.
 * The IO instance is not used for broadcast — payloads are per-user.
 */
function whatsappStatusPayloadFor(_io, userId) {
    // Lazy require to avoid a circular import with sessionManager.
    const sessionManager = require('./whatsapp/sessionManager');
    return {
        status: sessionManager.getStatus(userId),
        provider: 'web',
        qrAvailable: !!sessionManager.getQRDataUrl(userId),
    };
}

/** Emit only to a specific user's room. */
function emitToUser(io, userId, event, data) {
    io?.to(userRoom(userId)).emit(event, data);
}

module.exports = {
    userRoom,
    attachRealtimeAuth,
    whatsappStatusPayloadFor,
    emitToUser,
    isAllowedOrigin,
};
