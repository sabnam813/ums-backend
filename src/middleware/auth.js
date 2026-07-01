const jwt = require('jsonwebtoken');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET || 'ums_jwt_secret_change_in_production';
const REFRESH_SECRET = process.env.REFRESH_SECRET || 'ums_refresh_secret_change_in_production';

exports.generateTokens = (user) => {
  const accessToken = jwt.sign(
    { id: user._id, role: user.role },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
  const refreshToken = jwt.sign(
    { id: user._id },
    REFRESH_SECRET,
    { expiresIn: '7d' }
  );
  return { accessToken, refreshToken };
};

exports.verifyAccess = async (req, res, next) => {
  try {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return res.status(401).json({ message: 'No token' });
    const token = auth.split(' ')[1];
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = await User.findById(payload.id).select('-password -refreshToken');
    if (!req.user || req.user.status === 'inactive') return res.status(401).json({ message: 'Unauthorized' });
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Token invalid or expired' });
  }
};

exports.requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ message: 'Admin access required' });
  next();
};

exports.JWT_SECRET = JWT_SECRET;
exports.REFRESH_SECRET = REFRESH_SECRET;
