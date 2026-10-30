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
const { resolveDataOwner, DataAccessError } = require('./security/dataOwner');
const { loadAccess, dataOwnerFor } = require('./security/teamAccess');

const USER_ROOM_PREFIX = 'user:';

function userRoom(userId) {
    return `${USER_ROOM_PREFIX}${userId}`;
}

// Users the owner shared their data with join this room instead of the
// owner's own room, so owner-only events can be withheld from them.
function sharedRoom(ownerUserId) {
    return `${USER_ROOM_PREFIX}${ownerUserId}:shared`;
}

// Events that must reach the owner only: a WhatsApp QR code links a phone
// to the owner's account and is never shown in a shared workspace.
const OWNER_ONLY_EVENTS = new Set(['whatsapp:qr']);

/**
 * Attach per-user room authentication to a Socket.IO server.
 * Clients connect with:  io(url, { auth: { token: '<supabaseJWT>' } })
 * The JWT is validated on every connection (not just once) so revoked
 * sessions stop receiving events. Verification uses getClaims(), which
 * checks the signature LOCALLY against the cached JWKS for asymmetric
 * signing keys (no auth-server round trip) and falls back to the auth
 * server for legacy HS256 projects — matching middleware/auth.js.
 */
function attachRealtimeAuth(io) {
    io.use(async (socket, next) => {
        try {
            const token = socket.handshake.auth?.token || null;
            if (!token || !supabase) return next(new Error('Authentication required'));

            const { data, error } = await supabase.auth.getClaims(token);
            const claims = data?.claims;
            if (error || !claims?.sub) return next(new Error('Session expired or invalid'));

            // Never trust a client-sent userId — derive it from the JWT.
            // A shared workspace (auth.dataOwner) is joined only when the
            // database confirms the owner shared their data with this user.
            // With Team & access on, only accounts allowed into WhatsApp get
            // live events, and they get the company workspace's.
            let roomUserId = claims.sub;
            try {
                const access = await loadAccess(claims.sub, claims.email);
                if (access.enforced) {
                    if (!access.permissions.includes('whatsapp')) return next(new Error('No access to WhatsApp'));
                    roomUserId = dataOwnerFor(access, claims.sub);
                } else {
                    roomUserId = await resolveDataOwner(claims.sub, socket.handshake.auth?.dataOwner || null);
                }
            } catch (accessError) {
                return next(new Error(accessError instanceof DataAccessError ? accessError.message : 'Authentication failed'));
            }
            socket.data.userId = roomUserId;
            socket.data.authUserId = claims.sub;
            socket.join(roomUserId === claims.sub ? userRoom(roomUserId) : sharedRoom(roomUserId));
            next();
        } catch (err) {
            next(new Error('Authentication failed'));
        }
    });

    io.on('connection', (socket) => {
        const userId = socket.data.userId;
        const shared = socket.data.authUserId && socket.data.authUserId !== userId;
        console.log(`[realtime] user ${socket.data.authUserId || userId} connected (room ${shared ? sharedRoom(userId) : userRoom(userId)})`);

        // Send this user's own current state on connect — scoped emit only.
        const statusPayload = whatsappStatusPayloadFor(io, userId);
        if (shared) statusPayload.qrAvailable = false;
        socket.emit('whatsapp:status', statusPayload);

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

/** Emit only to a specific user's room (and their shared viewers). */
function emitToUser(io, userId, event, data) {
    if (!io || !userId) return;
    io.to(userRoom(userId)).emit(event, data);
    if (!OWNER_ONLY_EVENTS.has(event)) io.to(sharedRoom(userId)).emit(event, data);
}

module.exports = {
    userRoom,
    sharedRoom,
    OWNER_ONLY_EVENTS,
    attachRealtimeAuth,
    whatsappStatusPayloadFor,
    emitToUser,
    isAllowedOrigin,
};
