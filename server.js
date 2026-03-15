require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Joi = require('joi');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',')
      : ['http://localhost:8080', 'https://localhost:8080', 'http://127.0.0.1:8080'],
    methods: ['GET', 'POST'],
    credentials: true
  }
});

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const deviceLimiter = rateLimit({ windowMs: 15*60*1000, max: 500,  standardHeaders: true, legacyHeaders: false });
const appLimiter    = rateLimit({ windowMs: 10*60*1000, max: 200,  standardHeaders: true, legacyHeaders: false });

const devices      = new Map(); // deviceId -> { ...status, lastSeen }
const deviceTokens = new Map(); // token -> deviceId

// Pending commands queue: deviceId -> { buzzer?, alarm_h?, alarm_m?, alarm_armed? }
// The Arduino polls this on each POST and we piggyback the reply
const pendingCmds  = new Map(); // deviceId -> command object

// ── Health ──────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), devices: devices.size });
});

// ── List devices ────────────────────────────────────────────────────────────
app.get('/api/v1/devices', appLimiter, (req, res) => {
  res.json(Array.from(devices.keys()));
});

// ── Arduino POST status ─────────────────────────────────────────────────────
app.post('/api/v1/device/:id/status', deviceLimiter, (req, res) => {
  const { id } = req.params;
  const token   = req.headers['x-device-token'];

  if (!token) return res.status(401).json({ error: 'Missing device token' });
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
    buzzer_on  : Joi.boolean().required()
  });

  const { error: ve } = schema.validate(req.body);
  if (ve) return res.status(400).json({ error: 'Invalid data', details: ve.details[0].message });

  devices.set(id, { ...req.body, lastSeen: new Date().toISOString() });
  io.to(id).emit('status', { ...req.body, lastSeen: new Date().toISOString() });

  // Return any pending command (piggyback pattern)
  const cmd = pendingCmds.get(id) || null;
  if (cmd) pendingCmds.delete(id);

  res.json({ ok: true, cmd });
});

// ── Flutter → send command to device ───────────────────────────────────────
// POST /api/v1/device/:id/command
// Headers: x-master-token: <MASTER_TOKEN>
// Body: { buzzer?: bool, alarm_h?: int, alarm_m?: int, alarm_armed?: bool }
app.post('/api/v1/device/:id/command', appLimiter, (req, res) => {
  const { id } = req.params;
  const master  = req.headers['x-master-token'];

  if (master !== process.env.MASTER_TOKEN)
    return res.status(401).json({ error: 'Master token required' });

  const schema = Joi.object({
    buzzer      : Joi.boolean(),
    alarm_h     : Joi.number().integer().min(0).max(23),
    alarm_m     : Joi.number().integer().min(0).max(59),
    alarm_armed : Joi.boolean()
  }).min(1);

  const { error: ve, value } = schema.validate(req.body);
  if (ve) return res.status(400).json({ error: ve.details[0].message });

  // Merge with existing pending cmd
  const existing = pendingCmds.get(id) || {};
  pendingCmds.set(id, { ...existing, ...value });

  console.log(`[CMD] Queued for ${id}:`, pendingCmds.get(id));

  // Also emit to any live socket listeners (for dashboard feedback)
  io.to(id).emit('command_queued', value);

  res.json({ ok: true, queued: pendingCmds.get(id) });
});

// ── Register device token ────────────────────────────────────────────────────
app.post('/api/v1/device/:id/token', (req, res) => {
  const { id }    = req.params;
  const master    = req.headers['x-master-token'];
  if (master !== process.env.MASTER_TOKEN)
    return res.status(401).json({ error: 'Master token required' });

  const token = 'ebc8445e-33d1-4073-8906-aa1189f04ba2'; // Arduino hardcoded token
  deviceTokens.set(token, id);
  console.log(`[TOKEN] Registered token for device ${id}`);
  res.json({ deviceId: id, token, message: 'Token registered' });
});

// ── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[SOCKET] Client ${socket.id} connected`);

  socket.on('join-device', (deviceId) => {
    socket.join(deviceId);
    socket.emit('connected', { deviceId });
    const data = devices.get(deviceId);
    if (data) socket.emit('status', data);
  });

  socket.on('disconnect', () => {
    console.log(`[SOCKET] Client ${socket.id} disconnected`);
  });
});

// ── 404 / error ──────────────────────────────────────────────────────────────
app.use('*', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`UNO Clock backend on port ${PORT}`);
  console.log(`Set MASTER_TOKEN and ALLOWED_ORIGINS in .env`);
});
