require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const path = require('path');

const sessionManager = require('./whatsapp/sessionManager');
const messageQueue = require('./campaigns/messageQueue');
const schedulerService = require('./campaigns/schedulerService');
const { requireAuth } = require('./middleware/auth');
const { attachRealtimeAuth, isAllowedOrigin } = require('./realtime');

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 3000);
const FRONTEND_DIST = path.join(__dirname, '..', '..', 'frontend', 'dist');
server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Stop the existing backend before starting another one.`);
        return;
    }
    console.error('Server error:', error);
});

const io = new Server(server, {
    cors: {
        origin: (origin, callback) => {
            if (isAllowedOrigin(origin)) return callback(null, true);
            callback(new Error(`Origin not allowed: ${origin}`));
        },
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    },
});

app.set('io', io);
app.use(cors({
    origin: (origin, callback) => {
        if (isAllowedOrigin(origin)) return callback(null, true);
        callback(new Error(`Origin not allowed: ${origin}`));
    },
    credentials: true,
}));
app.use(express.json({
    limit: '10mb',
    verify: (req, _res, buf) => { req.rawBody = buf; }, // raw bytes for webhook HMAC
}));
app.use(express.urlencoded({ extended: true }));

// Keep the RAW request body for the Meta webhook: X-Hub-Signature-256 is
// an HMAC over the exact bytes Meta sent, so signature verification uses
// req.rawBody (captured by body-parser's verify callback), never the
// re-serialized parsed body.

app.use((req, _res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
    next();
});

// Public health endpoint — deliberately reports no global WhatsApp status:
// connection state is per-user now, so there is nothing meaningful to show
// without an authenticated user.
app.use('/api/health', require('./middleware/rateLimiterMiddleware').mutationLimiter);
app.get('/api/health', (_req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        whatsapp: { mode: 'per-user', note: 'WhatsApp connection status is scoped per user. Use GET /api/whatsapp/status with an auth token.' },
    });
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/whatsapp', requireAuth, require('./routes/whatsapp'));
app.use('/api/webhooks/whatsapp', require('./middleware/rateLimiterMiddleware').webhookLimiter, require('./routes/whatsappWebhook'));
app.use('/api/contacts', requireAuth, require('./routes/contacts'));
app.use('/api/conversations', requireAuth, require('./middleware/rateLimiterMiddleware').sendLimiter, require('./routes/conversations'));
app.use('/api/campaigns', requireAuth, require('./middleware/rateLimiterMiddleware').mutationLimiter, require('./routes/campaigns'));
app.use('/api/templates', requireAuth, require('./routes/templates'));
app.use('/api/knowledge', requireAuth, require('./middleware/rateLimiterMiddleware').mutationLimiter, require('./routes/knowledge'));
app.use('/api/analytics', requireAuth, require('./routes/analytics'));
app.use('/api/settings', requireAuth, require('./middleware/rateLimiterMiddleware').mutationLimiter, require('./routes/settings'));
app.use('/api/schedules', requireAuth, require('./middleware/rateLimiterMiddleware').mutationLimiter, require('./routes/schedules'));
app.use('/api/image-extractor', requireAuth, require('./middleware/rateLimiterMiddleware').aiExtractLimiter, require('./routes/imageExtractor'));

app.use('/api', requireAuth, (req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

if (require('fs').existsSync(FRONTEND_DIST)) {
    app.use(express.static(FRONTEND_DIST));
    app.get('*', (_req, res) => {
        res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
    });
} else {
    app.get('/', (_req, res) => {
        res.json({
            app: 'Sudarshan Pipes AI Assistant',
            message: 'Frontend build not generated yet. Run the Vite app separately or build the frontend.',
        });
    });
}

// SECURITY: per-user rooms with JWT verification. A socket without a
// valid Supabase JWT never joins a room and never receives events.
attachRealtimeAuth(io);

messageQueue.setIO(io);

async function startServer() {
    try {
        // Sessions are created lazily per user on demand — nothing global
        // to initialize at startup. Interrupted campaigns resume per owner.
        await messageQueue.resumeInterrupted(io);
        schedulerService.startPolling(io);
        server.listen(PORT, () => {
            console.log(`🚀 Sudarshan Pipes AI Assistant API started on http://localhost:${PORT}`);
            console.log('📱 WhatsApp sessions: per-user (lazy) — users connect via their own QR.');
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

startServer();

// DEBUG: never let background promise rejections disappear silently.
process.on('unhandledRejection', (reason) => {
    console.error('[process] UNHANDLED REJECTION:', reason);
});
process.on('uncaughtException', (error) => {
    console.error('[process] UNCAUGHT EXCEPTION:', error);
});

process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    try { await sessionManager.shutdown(); } catch (error) {}
    server.close(() => process.exit(0));
});
process.on('SIGTERM', async () => {
    try { await sessionManager.shutdown(); } catch (error) {}
    server.close(() => process.exit(0));
});

module.exports = { app, server, io };
