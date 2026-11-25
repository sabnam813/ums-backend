const AuditLog = require('../models/AuditLog');
async function logActivity(req, action, {
  targetType = null,
  targetId = null,
  message = '',
  meta = {}
} = {}) {
  try {
    const actor = req?.user ? {
      id: req.user._id,
      username: req.user.username,
      role: req.user.role
    } : {
      id: null,
      username: meta.username || 'unknown',
      role: 'unknown'
    };
    await AuditLog.create({
      actor,
      action,
      targetType,
      targetId: targetId ? String(targetId) : null,
      message,
      meta,
      ip: req?.ip || req?.headers?.['x-forwarded-for'] || null
    });
  } catch (err) {
    console.warn('Audit log write failed:', err.message);
  }
}
module.exports = {
  logActivity
};
