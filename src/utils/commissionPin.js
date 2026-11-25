const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const AppConfig = require('../models/AppConfig');
const { JWT_SECRET } = require('../middleware/auth');

const PIN_RE = /^\d{4,8}$/;
const TOKEN_TTL = '30m';
const MAX_ATTEMPTS = 5;
const LOCK_MS = 5 * 60 * 1000;
const attempts = new Map();

function isPinSection(section) {
  return section === 'associate' || section === 'shareholder';
}

function needsPin(user, section) {
  return isPinSection(section) && user.role !== 'super_admin';
}

async function loadPinState() {
  const cfg = await AppConfig.findOne({ key: 'main' }).select('+commissionPinHash commissionPinVersion commissionPinUpdatedAt').lean();
  return {
    hash: (cfg && cfg.commissionPinHash) || '',
    version: (cfg && cfg.commissionPinVersion) || 0,
    updatedAt: (cfg && cfg.commissionPinUpdatedAt) || null
  };
}

async function setPin(pin, userId) {
  const hash = await bcrypt.hash(String(pin), 10);
  const current = await loadPinState();
  await AppConfig.findOneAndUpdate(
    { key: 'main' },
    { $set: { commissionPinHash: hash, commissionPinVersion: current.version + 1, commissionPinUpdatedAt: new Date(), updatedBy: userId } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  attempts.clear();
}

async function verifyPin(user, pin) {
  const key = String(user._id);
  const entry = attempts.get(key) || { count: 0, until: 0 };
  if (entry.until > Date.now()) {
    return { ok: false, locked: true, wait: Math.ceil((entry.until - Date.now()) / 1000) };
  }
  const state = await loadPinState();
  if (!state.hash) return { ok: false, notSet: true };
  const match = await bcrypt.compare(String(pin || ''), state.hash);
  if (!match) {
    entry.count += 1;
    if (entry.count >= MAX_ATTEMPTS) {
      entry.count = 0;
      entry.until = Date.now() + LOCK_MS;
    }
    attempts.set(key, entry);
    return { ok: false };
  }
  attempts.delete(key);
  const token = jwt.sign({ uid: key, purpose: 'commissionPin', pv: state.version }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  return { ok: true, token };
}

async function tokenValid(user, token) {
  if (!token) return false;
  try {
    const payload = jwt.verify(String(token), JWT_SECRET);
    if (payload.purpose !== 'commissionPin' || payload.uid !== String(user._id)) return false;
    const state = await loadPinState();
    return !!state.hash && payload.pv === state.version;
  } catch (e) {
    return false;
  }
}

async function pinUnlocked(req, section) {
  if (!needsPin(req.user, section)) return true;
  return tokenValid(req.user, req.headers['x-commission-pin']);
}

module.exports = { PIN_RE, isPinSection, needsPin, loadPinState, setPin, verifyPin, tokenValid, pinUnlocked };
