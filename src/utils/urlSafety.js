const ALLOWED_PROTOCOLS = ['http:', 'https:'];

/**
 * Only allow http(s) links. Blocks javascript:, data:, vbscript:, file:, etc,
 * which is what stops a malicious "site link" from turning into stored XSS /
 * a self-XSS trap when a staff member clicks it from the datatable.
 */
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
  return isSafeUrl(trimmed) ? trimmed : null; // null = rejected, '' = empty/ok-to-clear
}

module.exports = { isSafeUrl, sanitizeUrl, ALLOWED_PROTOCOLS };
