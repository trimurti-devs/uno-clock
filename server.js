require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Joi = require('joi');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
    methods: ['GET', 'POST']
  }
});

// Security middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Rate limiting
const deviceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per IP per window
  message: 'Too many requests from this IP',
  standardHeaders: true,
  legacyHeaders: false,
});

const appLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 50,
  message: 'Too many app requests',
});

const devices = new Map(); // deviceId -> {data, token, lastSeen}
const deviceTokens = new Map(); // token -> deviceId (per-device tokens)

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), devices: devices.size });
});

// API v1 routes - App
app.get('/api/v1/devices', appLimiter, (req, res) => {
  res.json(Array.from(devices.keys()));
});

// Arduino POST (secured)
app.post('/api/v1/device/:id/status', deviceLimiter, (req, res) => {
  const { id } = req.params;
  const token = req.headers['x-device-token'];

  if (!token) {
    return res.status(401).json({ error: 'Missing device token' });
  }

  const expectedDeviceId = deviceTokens.get(token);
  if (expectedDeviceId !== id) {
    return res.status(401).json({ error: 'Invalid token for device' });
  }

  // Validate body
  const schema = Joi.object({
    temp: Joi.number().required(),
    hum: Joi.number().required(),
    hms: Joi.string().required(),
    date: Joi.string().required(),
    net_ok: Joi.boolean().required(),
    alarm_state: Joi.number().integer().min(0).max(2).required(),
    alarm_hm: Joi.string().allow(''),
    alarm_h: Joi.number().integer().min(0).max(23).required(),
    alarm_m: Joi.number().integer().min(0).max(59).required(),
    buzzer_on: Joi.boolean().required()
  });

  const { error: validationError } = schema.validate(req.body);
  if (validationError) {
    return res.status(400).json({ error: 'Invalid data', details: validationError.details[0].message });
  }

  devices.set(id, {
    ...req.body,
    lastSeen: new Date().toISOString()
  });

  io.to(id).emit('status', req.body);
  res.json({ ok: true });
});

// Generate token endpoint (admin/use once)
app.post('/api/v1/device/:id/token', (req, res) => {
  const { id } = req.params;
  const masterToken = req.headers['x-master-token'];
  if (masterToken !== process.env.MASTER_TOKEN) {
    return res.status(401).json({ error: 'Master token required' });
  }
  const token = uuidv4();
  deviceTokens.set(token, id);
  res.json({ deviceId: id, token });
});

// Socket.io - App clients
io.on('connection', (socket) => {
  socket.on('join-device', (deviceId) => {
    socket.join(deviceId);
    socket.emit('connected', { deviceId });
    const data = devices.get(deviceId);
    if (data) socket.emit('status', data);
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Secure Backend on port ${PORT}`);
  console.log('Set DEVICE_TOKEN/MASTER_TOKEN in .env');
  console.log('ALLOWED_ORIGINS: comma-separated Flutter origins');
});
