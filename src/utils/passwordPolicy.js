const MIN_LENGTH = 6;
const MAX_LENGTH = 72;

function checkPassword(value) {
  const text = String(value || '');
  if (text.length < MIN_LENGTH) return `Password must be at least ${MIN_LENGTH} characters`;
  if (text.length > MAX_LENGTH) return `Password must be at most ${MAX_LENGTH} characters`;
  return '';
}

async function applyPassword(doc, password, mustChange, keepToken) {
  const keep = keepToken
    ? (doc.sessions || []).filter(s => s.refreshToken === keepToken || s.previousRefreshToken === keepToken)
    : [];
  doc.password = password;
  doc.passwordChangedAt = new Date();
  doc.sessions = keep;
  if (mustChange !== undefined) doc.mustChangePassword = !!mustChange;
  await doc.save();
}

function revokeOtherSessions(req, userId) {
  try {
    req.app.get('io')?.to(`user:${userId}`).emit('auth:sessions-revoked');
  } catch (e) {}
}

module.exports = { revokeOtherSessions, checkPassword, applyPassword, MIN_LENGTH, MAX_LENGTH };
