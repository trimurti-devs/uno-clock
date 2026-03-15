require('dotenv').config();
const express = require('express');
const http    = require('http');
const socketIo = require('socket.io');
const cors    = require('cors');
const helmet  = require('helmet');
const rateLimit = require('express-rate-limit');
const Joi     = require('joi');

const app    = express();
const server = http.createServer(app);

// ── Allowed origins ──────────────────────────────────────────────────────────
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : [
      'http://localhost:8080',
      'https://localhost:8080',
      'http://localhost:50000',
      'http://127.0.0.1:8080',
      'https://uno-clock.onrender.com',
    ];

const io = socketIo(server, {
  cors: {
    origin     : allowedOrigins,
    methods    : ['GET', 'POST'],
    credentials: true,
  },
});

app.use(helmet());

// ── CORS: restrict to same allowedOrigins list (not open wildcard) ───────────
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, Arduino)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin '${origin}' not allowed`));
  },
  methods: ['GET', 'POST'],
}));

app.use(express.json({ limit: '1mb' }));

const deviceLimiter = rateLimit({
  validate      : { xForwardedForHeader: false },
  windowMs      : 15 * 60 * 1000,
  max           : 500,
  standardHeaders: true,
  legacyHeaders : false,
});

const appLimiter = rateLimit({
  validate      : { xForwardedForHeader: false },
  windowMs      : 10 * 60 * 1000,
  max           : 200,
  standardHeaders: true,
  legacyHeaders : false,
});

const devices      = new Map();
const deviceTokens = new Map();
const pendingCmds  = new Map();

// ── Load device credentials from environment on boot ─────────────────────────
// Set in Render Dashboard → Environment:
//   MASTER_TOKEN = your master secret
//   DEVICE_TOKEN = arduino token uuid
//   DEVICE_ID    = clock01
(function loadDeviceCredentials() {
  const token    = process.env.DEVICE_TOKEN;
  const deviceId = process.env.DEVICE_ID;
  if (token && deviceId) {
    deviceTokens.set(token, deviceId);
    console.log(`[BOOT] Device registered: ${deviceId}`);
  } else {
    console.warn('[BOOT] WARNING: DEVICE_TOKEN or DEVICE_ID not set!');
  }
})();

// ── How long without a heartbeat before declaring offline ────────────────────
// Arduino posts every ~10 s; 15 000 ms gives one full missed cycle of headroom.
const ONLINE_THRESHOLD_MS = 15000;

function isDeviceOnline(data) {
  if (!data || !data.lastSeen) return false;
  return (Date.now() - new Date(data.lastSeen).getTime()) < ONLINE_THRESHOLD_MS;
}

// ── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), devices: devices.size });
});

// ── List devices ─────────────────────────────────────────────────────────────
app.get('/api/v1/devices', appLimiter, (req, res) => {
  const deviceList = Array.from(devices.entries()).map(([id, data]) => ({
    id,
    online  : isDeviceOnline(data),
    lastSeen: data.lastSeen,
    temp    : data.temp,
    hum     : data.hum,
  }));
  res.json(deviceList);
});

// ── Arduino POST status ──────────────────────────────────────────────────────
app.post('/api/v1/device/:id/status', deviceLimiter, (req, res) => {
  const { id } = req.params;
  const token  = req.headers['x-device-token'];

  console.log(`[POST] Device ${id}`);

  if (!token)
    return res.status(401).json({ error: 'Missing device token' });
  if (deviceTokens.get(token) !== id)
    return res.status(401).json({ error: 'Invalid token for device' });

  const schema = Joi.object({
    temp       : Joi.number().required(),
    hum        : Joi.number().required(),
    hms        : Joi.string().required(),
    date       : Joi.string().required(),
    net_ok     : Joi.boolean().required(),
    alarm_state: Joi.number().integer().min(0).max(2).required(),
    alarm_hm   : Joi.string().allow(''),
    alarm_h    : Joi.number().integer().min(0).max(23).required(),
    alarm_m    : Joi.number().integer().min(0).max(59).required(),
    buzzer_on  : Joi.boolean().required(),
  });

  const { error: ve } = schema.validate(req.body);
  if (ve)
    return res.status(400).json({ error: 'Invalid data', details: ve.details[0].message });

  const record = { ...req.body, lastSeen: new Date().toISOString() };
  devices.set(id, record);

  // Emit to Flutter clients watching this device
  io.to(id).emit('status', { ...record, online: true });

  // Return any pending command to the Arduino
  const cmd = pendingCmds.get(id) || null;
  if (cmd) pendingCmds.delete(id);

  res.json({ ok: true, cmd });
});

// ── Flutter GET status ───────────────────────────────────────────────────────
app.get('/api/v1/device/:id/status', appLimiter, (req, res) => {
  const { id } = req.params;
  const data   = devices.get(id);
  if (!data) return res.status(404).json({ error: 'Device not found' });
  res.json({ ...data, online: isDeviceOnline(data) });
});

// ── Flutter POST command → queue for Arduino ─────────────────────────────────
app.post('/api/v1/device/:id/command', appLimiter, (req, res) => {
  const { id } = req.params;
  const master = req.headers['x-master-token'];

  if (!process.env.MASTER_TOKEN || master !== process.env.MASTER_TOKEN)
    return res.status(401).json({ error: 'Unauthorized' });

  const schema = Joi.object({
    buzzer     : Joi.boolean(),
    alarm_h    : Joi.number().integer().min(0).max(23),
    alarm_m    : Joi.number().integer().min(0).max(59),
    alarm_armed: Joi.boolean(),
  }).min(1);

  const { error: ve, value } = schema.validate(req.body);
  if (ve) return res.status(400).json({ error: ve.details[0].message });

  const existing = pendingCmds.get(id) || {};
  pendingCmds.set(id, { ...existing, ...value });

  console.log(`[CMD] Queued for ${id}:`, pendingCmds.get(id));
  io.to(id).emit('command_queued', value);

  res.json({ ok: true, queued: pendingCmds.get(id) });
});

// ── Re-register device token (protected, manual / boot use only) ─────────────
app.post('/api/v1/device/:id/token', (req, res) => {
  const { id }  = req.params;
  const master  = req.headers['x-master-token'];

  if (!process.env.MASTER_TOKEN || master !== process.env.MASTER_TOKEN)
    return res.status(401).json({ error: 'Unauthorized' });

  const token = process.env.DEVICE_TOKEN;
  if (!token)
    return res.status(500).json({ error: 'DEVICE_TOKEN env var not set on server' });

  deviceTokens.set(token, id);
  console.log(`[TOKEN] Re-registered token for device ${id}`);
  res.json({ deviceId: id, message: 'Token registered' });
});

// ── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[SOCKET] Connected: ${socket.id}`);

  socket.on('join-device', (deviceId) => {
    socket.join(deviceId);
    socket.emit('connected', { deviceId });
    const data = devices.get(deviceId);
    if (data) socket.emit('status', { ...data, online: isDeviceOnline(data) });
  });

  socket.on('disconnect', () => {
    console.log(`[SOCKET] Disconnected: ${socket.id}`);
  });
});

// ── Fallback & error handlers ─────────────────────────────────────────────────
app.use('*', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`UNO Clock backend running on port ${PORT}`);
});
