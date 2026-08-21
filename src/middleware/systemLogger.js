const SystemLog = require('../models/SystemLog');
const SystemAlert = require('../models/SystemAlert');
function safeWrite(doc) {
  SystemLog.create(doc).catch(() => {});
}
const SKIP_PREFIXES = ['/api/superadmin'];
function requestLogger(req, res, next) {
  if (SKIP_PREFIXES.some(p => req.path.startsWith(p))) return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    safeWrite({
      type: 'request',
      level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      method: req.method,
      path: req.route ? req.baseUrl + req.route.path : req.path,
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs),
      ip: req.ip,
      userId: req.user?._id
    });
  });
  next();
}
function errorLogger(err, req, res, next) {
  safeWrite({
    type: 'error',
    level: 'error',
    method: req.method,
    path: req.path,
    statusCode: err.status || 500,
    message: err.message || 'Server error',
    stack: err.stack || '',
    ip: req.ip,
    userId: req.user?._id
  });
  if (!err.status || err.status >= 500) {
    SystemAlert.create({
      severity: 'critical',
      source: 'errors',
      title: 'Unhandled server error',
      message: `${req.method} ${req.path}: ${err.message || 'Server error'}`
    }).catch(() => {});
  }
  next(err);
}
function registerCrashHandlers() {
  process.on('uncaughtException', err => {
    console.error('Uncaught exception:', err);
    SystemLog.create({
      type: 'crash',
      level: 'fatal',
      message: err.message,
      stack: err.stack || ''
    }).catch(() => {});
    SystemAlert.create({
      severity: 'critical',
      source: 'crash',
      title: 'Uncaught exception',
      message: err.message
    }).catch(() => {});
  });
  process.on('unhandledRejection', reason => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : '';
    console.error('Unhandled rejection:', reason);
    SystemLog.create({
      type: 'crash',
      level: 'fatal',
      message,
      stack: stack || ''
    }).catch(() => {});
    SystemAlert.create({
      severity: 'critical',
      source: 'crash',
      title: 'Unhandled promise rejection',
      message
    }).catch(() => {});
  });
}
module.exports = {
  requestLogger,
  errorLogger,
  registerCrashHandlers
};
