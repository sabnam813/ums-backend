const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const {
  generateTokens,
  JWT_SECRET,
  REFRESH_SECRET,
  verifyAccess
} = require('../middleware/auth');
const {
  logActivity
} = require('../utils/auditLogger');
const router = express.Router();
const baseCookieOpts = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  path: '/'
};
const REMEMBER_ME_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
function decodeRememberFlag(token) {
  try {
    const decoded = jwt.decode(token);
    return !!decoded?.remember;
  } catch {
    return false;
  }
}
function cookieOptsFor(rememberMe) {
  return rememberMe ? {
    ...baseCookieOpts,
    maxAge: REMEMBER_ME_MAX_AGE
  } : {
    ...baseCookieOpts,
    maxAge: DEFAULT_MAX_AGE
  };
}
router.post('/login', async (req, res) => {
  try {
    const {
      username,
      password,
      rememberMe
    } = req.body;
    if (!username || !password) return res.status(400).json({
      message: 'Username and password required'
    });
    const user = await User.findOne({
      username: username.toLowerCase()
    });
    if (!user || !(await user.comparePassword(password))) {
      await logActivity(req, 'auth.login_failed', {
        message: `Failed login attempt for "${username}"`,
        meta: {
          username
        }
      });
      return res.status(401).json({
        message: 'Invalid credentials'
      });
    }
    if (user.status === 'inactive') return res.status(403).json({
      message: 'Account disabled'
    });
    const {
      accessToken,
      refreshToken,
      sessionId,
      expiresAt
    } = generateTokens(user, !!rememberMe);
    const validExisting = (user.sessions || []).filter(s => {
      try {
        jwt.verify(s.refreshToken, REFRESH_SECRET);
        return true;
      } catch {
        return false;
      }
    });
    user.sessions = [...validExisting, {
      tokenId: sessionId,
      refreshToken,
      ip: req.ip || req.headers['x-forwarded-for'] || '',
      userAgent: req.headers['user-agent'] || '',
      rememberMe: !!rememberMe,
      createdAt: new Date(),
      lastUsedAt: new Date(),
      expiresAt
    }];
    user.lastLogin = new Date();
    await user.save();
    res.cookie('refreshToken', refreshToken, cookieOptsFor(!!rememberMe));
    req.user = user;
    await logActivity(req, 'auth.login', {
      targetType: 'User',
      targetId: user._id,
      message: `${user.username} logged in`
    });
    res.json({
      accessToken,
      refreshToken,
      user: user.toSafeObject()
    });
  } catch (err) {
    res.status(500).json({
      message: 'Login failed'
    });
  }
});
router.post('/refresh', async (req, res) => {
  try {
    const token = req.body?.refreshToken || req.cookies?.refreshToken;
    if (!token) return res.status(401).json({
      message: 'No refresh token'
    });
    const payload = jwt.verify(token, REFRESH_SECRET);
    const user = await User.findById(payload.id);
    if (!user) return res.status(401).json({
      message: 'Invalid session'
    });
    const session = user.sessions?.find(s => s.refreshToken === token);
    if (!session) {
      const graceSession = user.sessions?.find(s => s.previousRefreshToken === token && s.previousTokenExpiresAt && s.previousTokenExpiresAt > new Date());
      if (graceSession) {
        const graceRememberMe = decodeRememberFlag(graceSession.refreshToken);
        res.cookie('refreshToken', graceSession.refreshToken, cookieOptsFor(graceRememberMe));
        return res.json({
          accessToken: jwt.sign({
            id: user._id,
            role: user.role
          }, JWT_SECRET, {
            expiresIn: '24h'
          }),
          refreshToken: graceSession.refreshToken,
          user: user.toSafeObject()
        });
      }
      return res.status(401).json({
        message: 'Invalid session'
      });
    }
    const rememberMe = decodeRememberFlag(token);
    const {
      accessToken,
      refreshToken,
      sessionId,
      expiresAt
    } = generateTokens(user, rememberMe);
    const graceWindowMs = 30 * 1000;
    user.sessions = user.sessions.map(s => s.refreshToken === token ? {
      ...s.toObject(),
      tokenId: sessionId,
      refreshToken,
      expiresAt,
      lastUsedAt: new Date(),
      previousRefreshToken: token,
      previousTokenExpiresAt: new Date(Date.now() + graceWindowMs)
    } : s);
    await user.save();
    res.cookie('refreshToken', refreshToken, cookieOptsFor(rememberMe));
    res.json({
      accessToken,
      refreshToken,
      user: user.toSafeObject()
    });
  } catch {
    res.status(401).json({
      message: 'Session expired'
    });
  }
});
router.post('/logout', verifyAccess, async (req, res) => {
  try {
    const token = req.body?.refreshToken || req.cookies?.refreshToken;
    const user = await User.findById(req.user._id);
    if (user) {
      user.sessions = (user.sessions || []).filter(s => s.refreshToken !== token);
      await user.save();
    }
    await logActivity(req, 'auth.logout', {
      targetType: 'User',
      targetId: req.user._id,
      message: `${req.user.username} logged out`
    });
    res.clearCookie('refreshToken', baseCookieOpts);
    res.json({
      message: 'Logged out'
    });
  } catch {
    res.status(500).json({
      message: 'Logout failed'
    });
  }
});
router.get('/me', verifyAccess, (req, res) => {
  res.json({
    user: req.user
  });
});
router.get('/sessions', verifyAccess, async (req, res) => {
  try {
    const currentToken = req.cookies?.refreshToken;
    const user = await User.findById(req.user._id).select('sessions');
    const sessions = (user?.sessions || []).filter(s => {
      try {
        jwt.verify(s.refreshToken, REFRESH_SECRET);
        return true;
      } catch {
        return false;
      }
    }).map(s => ({
      id: s.tokenId,
      ip: s.ip,
      userAgent: s.userAgent,
      rememberMe: s.rememberMe,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
      expiresAt: s.expiresAt,
      isCurrent: !!currentToken && s.refreshToken === currentToken
    })).sort((a, b) => new Date(b.lastUsedAt) - new Date(a.lastUsedAt));
    res.json({
      sessions
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to load sessions'
    });
  }
});
router.delete('/sessions/:id', verifyAccess, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({
      message: 'User not found'
    });
    const before = user.sessions.length;
    user.sessions = user.sessions.filter(s => s.tokenId !== req.params.id);
    if (user.sessions.length === before) {
      return res.status(404).json({
        message: 'Session not found'
      });
    }
    await user.save();
    await logActivity(req, 'auth.session_revoked', {
      targetType: 'User',
      targetId: user._id,
      message: `${user.username} revoked a session`
    });
    res.json({
      message: 'Session revoked'
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to revoke session'
    });
  }
});
router.delete('/sessions', verifyAccess, async (req, res) => {
  try {
    const currentToken = req.cookies?.refreshToken;
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({
      message: 'User not found'
    });
    user.sessions = currentToken ? user.sessions.filter(s => s.refreshToken === currentToken) : [];
    await user.save();
    await logActivity(req, 'auth.sessions_revoked_all', {
      targetType: 'User',
      targetId: user._id,
      message: `${user.username} signed out of all other sessions`
    });
    res.json({
      message: 'All other sessions signed out'
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to revoke sessions'
    });
  }
});
router.put('/me', verifyAccess, async (req, res) => {
  try {
    const {
      name
    } = req.body;
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({
      message: 'User not found'
    });
    if (name !== undefined) user.name = name.trim();
    await user.save();
    res.json({
      user: user.toSafeObject()
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to update profile'
    });
  }
});
router.post('/change-password-secure', verifyAccess, async (req, res) => {
  try {
    const {
      currentPassword,
      newPassword
    } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({
        message: 'Password must be at least 6 characters'
      });
    }
    const user = await User.findById(req.user._id);
    if (currentPassword) {
      const ok = await user.comparePassword(currentPassword);
      if (!ok) return res.status(401).json({
        message: 'Current password is incorrect'
      });
    }
    user.password = newPassword;
    user.mustChangePassword = false;
    await user.save();
    res.json({
      message: 'Password updated successfully'
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to update password'
    });
  }
});
router.post('/change-password', verifyAccess, async (req, res) => {
  try {
    const {
      newPassword
    } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({
        message: 'Password must be at least 6 characters'
      });
    }
    const user = await require('../models/User').findById(req.user._id);
    user.password = newPassword;
    user.mustChangePassword = false;
    await user.save();
    res.json({
      message: 'Password updated successfully'
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to update password'
    });
  }
});
module.exports = router;
