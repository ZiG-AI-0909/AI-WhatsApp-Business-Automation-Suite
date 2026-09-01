require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const path = require('path');

const whatsappService = require('./whatsapp/providerManager');
const messageQueue = require('./campaigns/messageQueue');
const schedulerService = require('./campaigns/schedulerService');
const { requireAuth } = require('./middleware/auth');

const app = express();
const server = http.createServer(app);
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the existing backend before starting another one.`);
    return;
  }
  console.error('Server error:', error);
});
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  },
});

const PORT = Number(process.env.PORT || 3000);
const FRONTEND_DIST = path.join(__dirname, '..', '..', 'frontend', 'dist');

app.set('io', io);
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    whatsapp: whatsappService.getStatus(),
  });
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/whatsapp', requireAuth, require('./routes/whatsapp'));
app.use('/api/webhooks/whatsapp', require('./routes/whatsappWebhook'));
app.use('/api/contacts', requireAuth, require('./routes/contacts'));
app.use('/api/conversations', requireAuth, require('./routes/conversations'));
app.use('/api/campaigns', requireAuth, require('./routes/campaigns'));
app.use('/api/templates', requireAuth, require('./routes/templates'));
app.use('/api/knowledge', requireAuth, require('./routes/knowledge'));
app.use('/api/analytics', requireAuth, require('./routes/analytics'));
app.use('/api/settings', requireAuth, require('./routes/settings'));
app.use('/api/schedules', requireAuth, require('./routes/schedules'));

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
      app: 'Sudarshan WhatsApp AI Assistant',
      message: 'Frontend build not generated yet. Run the Vite app separately or build the frontend.',
    });
  });
}

io.on('connection', (socket) => {
  socket.emit('whatsapp:status', { status: whatsappService.getStatus() });
  socket.emit('campaign:status', {
    running: messageQueue.isRunning(),
    paused: messageQueue.isPaused(),
    currentCampaignId: messageQueue.getCurrentCampaignId(),
  });

  socket.on('disconnect', () => {
    console.log('Socket client disconnected');
  });
});

whatsappService.setIO(io);
messageQueue.setIO(io);

async function startServer() {
  try {
    whatsappService.initialize();
    messageQueue.resumeInterrupted(whatsappService, io);
    schedulerService.startPolling(io);
    server.listen(PORT, () => {
      console.log(`🚀 Sudarshan WhatsApp API started on http://localhost:${PORT}`);
      console.log(`📱 WhatsApp status: ${whatsappService.getStatus()}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  try { await whatsappService.disconnect(); } catch (error) {}
  server.close(() => process.exit(0));
});

module.exports = { app, server, io };
