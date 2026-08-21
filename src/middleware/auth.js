const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const {
  hasPermission
} = require('../config/rbac');
const JWT_SECRET = process.env.JWT_SECRET;
const REFRESH_SECRET = process.env.REFRESH_SECRET;
const REMEMBER_ME_EXPIRES_IN = '30d';
const DEFAULT_EXPIRES_IN = '7d';
const REMEMBER_ME_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MS = 7 * 24 * 60 * 60 * 1000;
exports.generateTokens = (user, rememberMe = false) => {
  const sessionId = crypto.randomUUID();
  const accessToken = jwt.sign({
    id: user._id,
    role: user.role
  }, JWT_SECRET, {
    expiresIn: '24h'
  });
  const refreshToken = jwt.sign({
    id: user._id,
    remember: !!rememberMe,
    sid: sessionId
  }, REFRESH_SECRET, {
    expiresIn: rememberMe ? REMEMBER_ME_EXPIRES_IN : DEFAULT_EXPIRES_IN
  });
  const expiresAt = new Date(Date.now() + (rememberMe ? REMEMBER_ME_MS : DEFAULT_MS));
  return {
    accessToken,
    refreshToken,
    sessionId,
    expiresAt
  };
};
exports.verifyAccess = async (req, res, next) => {
  try {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return res.status(401).json({
      message: 'No token'
    });
    const token = auth.split(' ')[1];
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = await User.findById(payload.id).select('-password -refreshToken');
    if (!req.user || req.user.status === 'inactive') return res.status(401).json({
      message: 'Unauthorized'
    });
    next();
  } catch (err) {
    return res.status(401).json({
      message: 'Token invalid or expired'
    });
  }
};
exports.requireAdmin = (req, res, next) => {
  if (!['admin', 'super_admin'].includes(req.user?.role)) {
    return res.status(403).json({
      message: 'Admin access required'
    });
  }
  next();
};
exports.requireSuperAdmin = (req, res, next) => {
  if (req.user?.role !== 'super_admin') {
    return res.status(403).json({
      message: 'Super Admin access required'
    });
  }
  next();
};
exports.requirePermission = (moduleKey, action = 'access') => (req, res, next) => {
  if (!hasPermission(req.user, moduleKey, action)) {
    return res.status(403).json({
      message: `You do not have permission to ${action === 'access' ? 'access' : action} this module.`
    });
  }
  next();
};
exports.requireTestPrepAccess = exports.requirePermission('testPreparation', 'access');
exports.requireInquiryAccess = exports.requirePermission('inquiry', 'access');
exports.requireFollowUpAccess = exports.requirePermission('followUp', 'access');
exports.requireDailyReportAccess = exports.requirePermission('dailyReport', 'access');
exports.requireTrashAccess = exports.requirePermission('trash', 'access');
exports.hasPermission = hasPermission;
exports.canManageTargetUser = (requester, targetUser) => {
  if (!requester || !targetUser) return false;
  if (requester.role === 'super_admin') return true;
  return targetUser.role === 'user';
};
exports.JWT_SECRET = JWT_SECRET;
exports.REFRESH_SECRET = REFRESH_SECRET;
