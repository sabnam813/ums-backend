function isPaidStatus(value) {
  if (value === null || value === undefined) return false;
  const v = String(value).trim().toLowerCase();
  if (!v) return false;
  if (/\b(not|un|non)[\s-]*paid\b/.test(v)) return false;
  if (v.includes('pending') || v.includes('due') || v.includes('unpaid')) return false;
  return /\bpaid\b/.test(v);
}
function classifyPaymentStatus(value) {
  if (value === null || value === undefined) return 'pending';
  const v = String(value).trim().toLowerCase();
  if (!v) return 'pending';
  if (/\b(not|un|non)[\s-]*paid\b/.test(v)) return 'notPaid';
  if (v.includes('pending') || v.includes('due')) return 'pending';
  if (!/\bpaid\b/.test(v)) return 'pending';
  return /\bdirect(ly)?\b/.test(v) ? 'directPaid' : 'paid';
}
module.exports = {
  isPaidStatus,
  classifyPaymentStatus
};
