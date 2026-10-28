const ALLOWED_PROTOCOLS = ['http:', 'https:'];

function isSafeUrl(raw) {
  if (!raw || typeof raw !== 'string') return false;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  return ALLOWED_PROTOCOLS.includes(url.protocol);
}

function sanitizeUrl(raw) {
  if (!raw) return '';
  const trimmed = String(raw).trim();
  if (!trimmed) return '';
  return isSafeUrl(trimmed) ? trimmed : null;
}

module.exports = { isSafeUrl, sanitizeUrl, ALLOWED_PROTOCOLS };
