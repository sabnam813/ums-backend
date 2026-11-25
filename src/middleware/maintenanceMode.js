const jwt = require('jsonwebtoken');
const MaintenanceMode = require('../models/MaintenanceMode');
const JWT_SECRET = process.env.JWT_SECRET;
const ALWAYS_ALLOWED_PREFIXES = ['/api/auth', '/api/health', '/api/superadmin'];
let cached = {
  enabled: false,
  message: '',
  fetchedAt: 0
};
const CACHE_MS = 5000;
async function getMaintenanceState() {
  if (Date.now() - cached.fetchedAt < CACHE_MS) return cached;
  try {
    const doc = await MaintenanceMode.findOne({
      key: 'singleton'
    });
    cached = {
      enabled: !!doc?.enabled,
      message: doc?.message || '',
      fetchedAt: Date.now()
    };
  } catch {
    cached = {
      enabled: false,
      message: '',
      fetchedAt: Date.now()
    };
  }
  return cached;
}
async function maintenanceGate(req, res, next) {
  if (ALWAYS_ALLOWED_PREFIXES.some(p => req.path.startsWith(p))) return next();
  const state = await getMaintenanceState();
  if (!state.enabled) return next();
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(auth.split(' ')[1], JWT_SECRET);
      if (payload.role === 'super_admin') return next();
    } catch {}
  }
  return res.status(503).json({
    message: state.message,
    maintenanceMode: true
  });
}
module.exports = {
  maintenanceGate
};
