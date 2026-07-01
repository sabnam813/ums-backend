const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const countryRoutes = require('./routes/countries');
const applicationRoutes = require('./routes/applications');
const userRoutes = require('./routes/users');
const fieldRoutes = require('./routes/fields');
const chatRoutes = require('./routes/chat');
const inquiryRoutes = require('./routes/inquiries');

const app = express();
const httpServer = http.createServer(app);

const allowedOrigins = [
  process.env.CLIENT_URL || 'http://localhost:3000',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
  },
  transports: ['websocket', 'polling'],
});
app.set('io', io);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, true); // Allow all for dev
    }
  },
  credentials: true,
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser());

// --- Resilient MongoDB connection: never crash the process on a slow/failed connect ---
let isConnected = false;

async function connectDB(retries = 5, delayMs = 5000) {
  if (isConnected) return;
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/ums';

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await mongoose.connect(mongoUri, {
        maxPoolSize: 10,
        minPoolSize: 2,
        socketTimeoutMS: 45000,
        serverSelectionTimeoutMS: 20000, // give a cold/sleeping cluster more time
      });
      isConnected = true;
      console.log('MongoDB connected successfully');
      return;
    } catch (error) {
      console.error(`MongoDB connection attempt ${attempt}/${retries} failed:`, error.message);
      if (attempt === retries) {
        console.error('❌ Could not connect to MongoDB after multiple attempts. Server stays up and will retry on next request.');
        return; // do NOT exit — keep the HTTP server alive so requests still get a real (CORS-headered) response
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

mongoose.connection.on('disconnected', () => {
  isConnected = false;
  console.warn('MongoDB disconnected — will retry on next request.');
});

// If a request comes in before we're connected (e.g. cold start), try once more lazily.
app.use(async (req, res, next) => {
  if (!isConnected) await connectDB(1, 0);
  next();
});

app.use('/api/auth', authRoutes);
app.use('/api/countries', countryRoutes);
app.use('/api/applications', applicationRoutes);
app.use('/api/users', userRoutes);
app.use('/api/fields', fieldRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/inquiries', inquiryRoutes);

app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  dbConnected: isConnected,
  time: new Date().toISOString(),
}));

io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error('Authentication error'));
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret-key-change-in-prod');
    socket.userId = decoded.id || decoded._id || decoded.userId;
    next();
  } catch (e) {
    next(new Error('Authentication error'));
  }
});

io.on('connection', (socket) => {
  if (socket.userId) {
    socket.join(`user:${socket.userId}`);
  }
  socket.on('disconnect', () => {});
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Error:', err.stack || err);
  res.status(err.status || 500).json({
    message: err.message || 'Server error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// Start listening immediately — don't gate the HTTP server on DB connection succeeding first.
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  connectDB(); // connects in background with retries; failures no longer crash the process
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  httpServer.close(() => {
    mongoose.connection.close();
    process.exit(0);
  });
});
