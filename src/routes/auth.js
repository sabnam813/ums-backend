const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { generateTokens, REFRESH_SECRET, verifyAccess } = require('../middleware/auth');

const router = express.Router();

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: '/',
};

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: 'Username and password required' });

    const user = await User.findOne({ username: username.toLowerCase() });
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    if (user.status === 'inactive') return res.status(403).json({ message: 'Account disabled' });

    const { accessToken, refreshToken } = generateTokens(user);

    // Keep a rolling list of valid refresh tokens so logging in on another
    // device/browser doesn't invalidate an existing session elsewhere.
    const validExisting = (user.refreshTokens || []).filter(t => {
      try { jwt.verify(t, REFRESH_SECRET); return true; } catch { return false; }
    });
    user.refreshTokens = [...validExisting, refreshToken];
    user.refreshToken = refreshToken; // kept for backward compatibility
    user.lastLogin = new Date();
    await user.save();

    res.cookie('refreshToken', refreshToken, COOKIE_OPTS);
    res.json({ accessToken, user: user.toSafeObject() });
  } catch (err) {
    res.status(500).json({ message: 'Login failed' });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const token = req.cookies?.refreshToken;
    if (!token) return res.status(401).json({ message: 'No refresh token' });

    const payload = jwt.verify(token, REFRESH_SECRET);
    const user = await User.findById(payload.id);

    const knownTokens = user?.refreshTokens?.length ? user.refreshTokens : (user?.refreshToken ? [user.refreshToken] : []);
    if (!user || !knownTokens.includes(token)) {
      return res.status(401).json({ message: 'Invalid session' });
    }

    const { accessToken, refreshToken } = generateTokens(user);
    // Replace this session's token in place, keep other active sessions untouched.
    user.refreshTokens = knownTokens.filter(t => t !== token).concat(refreshToken);
    user.refreshToken = refreshToken;
    await user.save();

    res.cookie('refreshToken', refreshToken, COOKIE_OPTS);
    res.json({ accessToken, user: user.toSafeObject() });
  } catch {
    res.status(401).json({ message: 'Session expired' });
  }
});

router.post('/logout', verifyAccess, async (req, res) => {
  try {
    const token = req.cookies?.refreshToken;
    const user = await User.findById(req.user._id);
    if (user) {
      user.refreshTokens = (user.refreshTokens || []).filter(t => t !== token);
      if (user.refreshToken === token) user.refreshToken = null;
      await user.save();
    }
    res.clearCookie('refreshToken', COOKIE_OPTS);
    res.json({ message: 'Logged out' });
  } catch {
    res.status(500).json({ message: 'Logout failed' });
  }
});

router.get('/me', verifyAccess, (req, res) => {
  res.json({ user: req.user });
});

router.put('/me', verifyAccess, async (req, res) => {
  try {
    const { name } = req.body;
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (name !== undefined) user.name = name.trim();
    await user.save();
    res.json({ user: user.toSafeObject() });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update profile' });
  }
});

router.post('/change-password-secure', verifyAccess, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }
    const user = await User.findById(req.user._id);
    if (currentPassword) {
      const ok = await user.comparePassword(currentPassword);
      if (!ok) return res.status(401).json({ message: 'Current password is incorrect' });
    }
    user.password = newPassword;
    user.mustChangePassword = false;
    await user.save();
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update password' });
  }
});

router.post('/change-password', verifyAccess, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }
    const user = await require('../models/User').findById(req.user._id);
    user.password = newPassword;
    user.mustChangePassword = false;
    await user.save();
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update password' });
  }
});

module.exports = router;
