const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const http = require('http');
const {
  Server
} = require('socket.io');
const jwt = require('jsonwebtoken');
(function loadEnv() {
  const path = require('path');
  const fs = require('fs');
  const candidates = [
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '..', '..', '.env'),
    path.join(process.cwd(), '.env')
  ];
  const found = candidates.find(p => fs.existsSync(p));
  require('dotenv').config(found ? { path: found } : undefined);
})();

try {
  require('dns').setServers(['8.8.8.8', '1.1.1.1']);
} catch (_) {
}
const REQUIRED_ENV_VARS = ['JWT_SECRET', 'REFRESH_SECRET', 'MONGODB_URI'];
const missingEnvVars = REQUIRED_ENV_VARS.filter(key => !process.env[key]);
if (missingEnvVars.length > 0) {
  console.error(`FATAL: Missing required environment variable(s): ${missingEnvVars.join(', ')}`);
  console.error('Set these in your hosting provider\'s environment settings (e.g. Render dashboard) before starting the server.');
  process.exit(1);
}
const authRoutes = require('./routes/auth');
const countryRoutes = require('./routes/countries');
const applicationRoutes = require('./routes/applications');
const userRoutes = require('./routes/users');
const fieldRoutes = require('./routes/fields');
const chatRoutes = require('./routes/chat');
const inquiryRoutes = require('./routes/inquiries');
const trashRoutes = require('./routes/trash');
const backupRoutes = require('./routes/backup');
const assistantRoutes = require('./routes/assistant');
const testTypeRoutes = require('./routes/testTypes');
const testPrepRoutes = require('./routes/testPrepRecords');
const testPrepFieldRoutes = require('./routes/testPrepFields');
const contactGroupRoutes = require('./routes/contactGroups');
const contactRoutes = require('./routes/contacts');
const countryGroupRoutes = require('./routes/countryGroups');
const reportRoutes = require('./routes/reports');
const CountryGroup = require('./models/CountryGroup');
const Country = require('./models/Country');
const {
  DEFAULT_GROUPS,
  guessContinent
} = require('./utils/countryContinentMap');
const backupService = require('./utils/backupService');
const TestType = require('./models/TestType');
const User = require('./models/User');
const crypto = require('crypto');
const systemRoutes = require('./routes/system');
const logsRoutes = require('./routes/logs');
const featureRoutes = require('./routes/features');
const superAdminRoutes = require('./routes/superadmin');
const followUpRoutes = require('./routes/followUps');
const studentFollowUpRoutes = require('./routes/studentFollowUps');
const commissionRoutes = require('./routes/commission');
const { startReminderSweeper } = require('./utils/followUpReminders');
const dailyReportRoutes = require('./routes/dailyReport');
const departmentRoutes = require('./routes/departments');
const searchRoutes = require('./routes/search');
const achievementRoutes = require('./routes/achievements');
const tpAchievementRoutes = require('./routes/testPrepAchievements');
const ieltsReceiptRoutes = require('./routes/ieltsReceipts');
const portalRoutes = require('./routes/portals');
const diaryRoutes = require('./routes/diary');
const hallBookingRoutes = require('./routes/hallBookings');
const trainingScheduleRoutes = require('./routes/trainingSchedules');
const associateDetailRoutes = require('./routes/associateDetails');
const unicommissionRoutes = require('./routes/unicommission');
const configRoutes = require('./routes/config');
const { cleanupOrphanedDepartments } = require('./scripts/cleanupOrphanedDepartments');
const { renumberAssociates } = require('./scripts/renumberAssociates');
const { migrateOwners } = require('./scripts/migrateOwners');
const {
  requestLogger,
  errorLogger,
  registerCrashHandlers
} = require('./middleware/systemLogger');
const {
  maintenanceGate
} = require('./middleware/maintenanceMode');
const jobRegistry = require('./utils/jobRegistry');
const app = express();
const httpServer = http.createServer(app);
const clientUrlOrigins = (process.env.CLIENT_URL || 'http://localhost:3000').split(',').map(o => o.trim()).filter(Boolean);
const allowedOrigins = [...clientUrlOrigins, 'http://localhost:3000', 'http://127.0.0.1:3000', 'https://ums-frontend-murex.vercel.app', 'https://uniconsultant.com.np', 'https://www.uniconsultant.com.np'];
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    credentials: true
  },
  transports: ['websocket', 'polling']
});
app.set('io', io);
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(express.json({
  limit: '50mb'
}));
app.use(express.urlencoded({
  limit: '50mb',
  extended: true
}));
app.use(cookieParser());
app.use(requestLogger);
registerCrashHandlers();
let isConnected = false;
let connecting = null;
function connectDB(retries = 5, delayMs = 5000) {
  if (isConnected) return Promise.resolve();
  if (!connecting) connecting = doConnect(retries, delayMs).finally(() => { connecting = null; });
  return connecting;
}
async function doConnect(retries, delayMs) {
  const mongoUri = process.env.MONGODB_URI;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await mongoose.connect(mongoUri, {
        maxPoolSize: 10,
        minPoolSize: 2,
        socketTimeoutMS: 45000,
        serverSelectionTimeoutMS: 20000
      });
      isConnected = true;
      console.log('MongoDB connected successfully');
      backupService.scheduleAutoBackup({
        intervalHours: Number(process.env.AUTO_BACKUP_INTERVAL_HOURS) || 24
      });
      jobRegistry.startScheduler();
      startReminderSweeper(io);
      ensureDefaultTestTypes();
      ensureCountryGroups();
      bootstrapSuperAdmin();
      cleanupOrphanedDepartments().catch(err => console.error('Department cleanup failed:', err.message));
      renumberAssociates().catch(err => console.error('Associate renumber failed:', err.message));
      migrateOwners().catch(err => console.error('Owner migration failed:', err.message));
      return;
    } catch (error) {
      console.error(`MongoDB connection attempt ${attempt}/${retries} failed:`, error.message);
      if (attempt === retries) {
        console.error(' Could not connect to MongoDB after multiple attempts. Server stays up and will retry on next request.');
        return;
      }
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}
async function ensureDefaultTestTypes() {
  try {
    const count = await TestType.countDocuments();
    if (count > 0) return;
    const defaults = ['IELTS', 'PTE', 'Duolingo'];
    await TestType.insertMany(defaults.map((name, i) => ({
      name,
      slug: name.toLowerCase(),
      order: i
    })));
    console.log('Seeded default Test Preparation types: IELTS, PTE, Duolingo');
  } catch (err) {
    console.warn('Could not seed default test types:', err.message);
  }
}
async function ensureCountryGroups() {
  try {
    function slugify(name) {
      return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    }
    const groupByName = {};
    const existingGroups = await CountryGroup.find();
    existingGroups.forEach(g => {
      groupByName[g.name] = g;
    });
    for (let i = 0; i < DEFAULT_GROUPS.length; i++) {
      const name = DEFAULT_GROUPS[i];
      if (!groupByName[name]) {
        groupByName[name] = await CountryGroup.create({
          name,
          slug: slugify(name),
          order: i
        });
      }
    }
    const ungrouped = await Country.find({
      group: null
    });
    if (ungrouped.length === 0) return;
    let unassignedGroup = groupByName['Unassigned'];
    for (const country of ungrouped) {
      const continent = guessContinent(country.name);
      let target = continent ? groupByName[continent] : null;
      if (!target) {
        if (!unassignedGroup) {
          unassignedGroup = await CountryGroup.create({
            name: 'Unassigned',
            slug: 'unassigned',
            order: DEFAULT_GROUPS.length,
            isDefault: true
          });
          groupByName['Unassigned'] = unassignedGroup;
        }
        target = unassignedGroup;
      }
      const order = await Country.countDocuments({
        group: target._id
      });
      country.group = target._id;
      country.order = order;
      await country.save();
    }
    console.log(`Country groups migration: assigned ${ungrouped.length} pre-existing countr${ungrouped.length === 1 ? 'y' : 'ies'} into groups.`);
  } catch (err) {
    console.warn('Country groups migration failed:', err.message);
  }
}
async function bootstrapSuperAdmin() {
  try {
    const existing = await User.findOne({
      role: 'super_admin'
    });
    if (existing) return;
    const username = (process.env.SUPER_ADMIN_USERNAME || 'superadmin').toLowerCase().trim();
    const password = process.env.SUPER_ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
    const already = await User.findOne({
      username
    });
    if (already) {
      already.role = 'super_admin';
      await already.save();
      console.log(`Existing account "${username}" promoted to Super Admin.`);
      return;
    }
    await User.create({
      username,
      password,
      name: 'Super Admin',
      role: 'super_admin',
      mustChangePassword: true
    });
    console.log('================================================================');
    console.log(' SUPER ADMIN ACCOUNT CREATED');
    console.log(`   Username: ${username}`);
    console.log(`   Password: ${password}`);
    console.log('   Please log in and change this password immediately.');
    console.log('   Set SUPER_ADMIN_USERNAME / SUPER_ADMIN_PASSWORD in your .env');
    console.log('   to control these values on future first-time deploys.');
    console.log('================================================================');
  } catch (err) {
    console.warn('Could not bootstrap Super Admin:', err.message);
  }
}
mongoose.connection.on('disconnected', () => {
  isConnected = false;
  console.warn('MongoDB disconnected — will retry on next request.');
});
app.use(async (req, res, next) => {
  if (!isConnected) await connectDB(1, 0);
  next();
});
app.use(maintenanceGate);
app.use('/api/auth', authRoutes);
app.use('/api/countries', countryRoutes);
app.use('/api/applications', applicationRoutes);
app.use('/api/users', userRoutes);
app.use('/api/fields', fieldRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/inquiries', inquiryRoutes);
app.use('/api/trash', trashRoutes);
app.use('/api/backup', backupRoutes);
app.use('/api/assistant', assistantRoutes);
app.use('/api/test-types', testTypeRoutes);
app.use('/api/test-prep', testPrepRoutes);
app.use('/api/test-prep-fields', testPrepFieldRoutes);
app.use('/api/contact-groups', contactGroupRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/country-groups', countryGroupRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/system', systemRoutes);
app.use('/api/logs', logsRoutes);
app.use('/api/features', featureRoutes);
app.use('/api/superadmin', superAdminRoutes);
app.use('/api/follow-ups', followUpRoutes);
app.use('/api/student-follow-ups', studentFollowUpRoutes);
app.use('/api/commission', commissionRoutes);
app.use('/api/daily-report', dailyReportRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/achievements', achievementRoutes);
app.use('/api/tp-achievements', tpAchievementRoutes);
app.use('/api/ielts-receipts', ieltsReceiptRoutes);
app.use('/api/portals', portalRoutes);
app.use('/api/diary', diaryRoutes);
app.use('/api/hall-bookings', hallBookingRoutes);
app.use('/api/training-schedules', trainingScheduleRoutes);
app.use('/api/associate-details', associateDetailRoutes);
app.use('/api/unicommission', unicommissionRoutes);
app.use('/api/config', configRoutes);
app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  dbConnected: isConnected,
  time: new Date().toISOString()
}));
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error('Authentication error'));
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId = decoded.id || decoded._id || decoded.userId;
    next();
  } catch (e) {
    next(new Error('Authentication error'));
  }
});
io.on('connection', socket => {
  if (socket.userId) {
    socket.join(`user:${socket.userId}`);
  }
  socket.on('disconnect', () => {});
});
app.use(errorLogger);
app.use((err, req, res, next) => {
  console.error('Error:', err.stack || err);
  res.status(err.status || 500).json({
    message: err.message || 'Server error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});
const path = require('path');
const fs = require('fs');
const frontendBuildPath = process.env.FRONTEND_BUILD_PATH
  ? path.resolve(process.env.FRONTEND_BUILD_PATH)
  : null;
const frontendIndexPath = frontendBuildPath ? path.join(frontendBuildPath, 'index.html') : null;
const canServeFrontend = !!(frontendBuildPath && fs.existsSync(frontendBuildPath) && fs.existsSync(frontendIndexPath));
if (process.env.FRONTEND_BUILD_PATH && !canServeFrontend) {
  console.warn(`FRONTEND_BUILD_PATH is set to "${process.env.FRONTEND_BUILD_PATH}" but no build/index.html was found there — the backend will keep running API-only. Run "npm run build" in the frontend folder first, or unset FRONTEND_BUILD_PATH to deploy the frontend separately.`);
}
if (canServeFrontend) {
  console.log(`Serving frontend build from: ${frontendBuildPath}`);
  app.use(express.static(frontendBuildPath));
}
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  if (canServeFrontend) return res.sendFile(frontendIndexPath);
  next();
});
app.use((req, res) => {
  res.status(404).json({ message: 'Not found' });
});
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log(` Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  connectDB();
});
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  httpServer.close(() => {
    mongoose.connection.close();
    process.exit(0);
  });
});
