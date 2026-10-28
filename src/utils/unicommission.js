const Application = require('../models/Application');
const Unicommission = require('../models/Unicommission');
const UnicommissionSkip = require('../models/UnicommissionSkip');
const UnicommissionSetting = require('../models/UnicommissionSetting');

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

const GRANT_RX = /^\s*grant(ed)?\s*$/i;

function cleanText(v, max = 300) {
  if (v === undefined || v === null) return '';
  let s;
  if (v instanceof Date) s = v.toISOString().slice(0, 10);
  else s = String(v);
  s = s.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s.slice(0, max);
}

function monthIndex(name) {
  const k = String(name || '').toLowerCase();
  return MONTHS[k.slice(0, 4)] ?? MONTHS[k.slice(0, 3)];
}

function parseLooseDate(v) {
  if (v === undefined || v === null || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') {
    if (v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400 * 1000));
    return null;
  }
  const s = String(v).trim().replace(/0ct/i, 'Oct');
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = s.match(/^(\d{1,2})[\s\-./]+([A-Za-z]{3,9})\.?[\s\-./,]+(\d{2,4})$/);
  if (m) {
    const mon = monthIndex(m[2]);
    if (mon !== undefined) {
      const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
      return new Date(Date.UTC(y, mon, +m[1]));
    }
    return null;
  }
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) {
    const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    const d = new Date(Date.UTC(y, +m[2] - 1, +m[1]));
    return isNaN(d.getTime()) ? null : d;
  }
  if (/^\d{4}$/.test(s)) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function normalizeIntake(v) {
  if (v === undefined || v === null || v === '') return '';
  let d = null;
  if (v instanceof Date || typeof v === 'number') d = parseLooseDate(v);
  if (d) return `${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  const s = String(v).trim();
  if (!s) return '';
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${MON[+m[2] - 1] || m[2]} ${m[1]}`;
  m = s.match(/^([A-Za-z]{3,9})\.?[\s\-,]*(\d{2,4})$/);
  if (m) {
    const mon = monthIndex(m[1]);
    if (mon !== undefined) return `${MON[mon]} ${+m[2] < 100 ? 2000 + +m[2] : m[2]}`;
  }
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) return `${MON[+m[2] - 1] || m[2]} ${+m[3] < 100 ? 2000 + +m[3] : m[3]}`;
  return s.slice(0, 40);
}

const KNOWN_CURRENCIES = new Set(['USD', 'GBP', 'AUD', 'CAD', 'NZD', 'EUR', 'NPR', 'INR', 'AED', 'SGD', 'JPY', 'CHF', 'MYR', 'HKD', 'CNY', 'SEK', 'NOK', 'DKK', 'KRW', 'PLN', 'HUF', 'CZK', 'TRY', 'RUB', 'ZAR', 'QAR', 'SAR']);
const SYMBOLS = [[/A\$/, 'AUD'], [/C\$/, 'CAD'], [/NZ\$/, 'NZD'], [/US\$/, 'USD'], [/£/, 'GBP'], [/€/, 'EUR']];

function parseFee(v) {
  if (v === undefined || v === null || v === '') return { amount: null, currency: '' };
  if (typeof v === 'number') return { amount: Number.isFinite(v) ? Math.round(v * 100) / 100 : null, currency: '' };
  const s = String(v).trim();
  if (!s || s.startsWith('=')) return { amount: null, currency: '' };
  let currency = '';
  for (const [rx, code] of SYMBOLS) { if (rx.test(s)) { currency = code; break; } }
  if (!currency) {
    const words = s.match(/[A-Za-z]{3}/g) || [];
    const hit = words.map(w => w.toUpperCase()).find(w => KNOWN_CURRENCIES.has(w));
    if (hit) currency = hit;
  }
  const num = s.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  const amount = num ? Number(num[0]) : null;
  return { amount: Number.isFinite(amount) ? Math.round(amount * 100) / 100 : null, currency: amount === null ? '' : currency };
}

function parseNumber(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function normStatus(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/partial/i.test(s)) return 'Partial';
  if (/receiv|paid|done|complete/i.test(s)) return 'Received';
  return 'Pending';
}

function normType(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/percent|%/i.test(s)) return 'percentage';
  if (/fix|flat|amount|lump/i.test(s)) return 'fixed';
  return '';
}

function normCurrency(v) {
  const s = String(v || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
  return s.length >= 2 && s.length <= 6 ? s : '';
}

function nameKey(v) {
  return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const round2 = n => Math.round(n * 100) / 100;

function effective(row, setting) {
  const s = setting || {};
  const type = row.commissionType || s.commissionType || 'percentage';
  const value = row.commissionType
    ? (row.commissionValue ?? null)
    : (row.commissionValue ?? s.commissionValue ?? null);
  const currency = row.currency || s.currency || '';
  let amount = null;
  if (value !== null && value !== undefined) {
    if (type === 'percentage') {
      if (row.feeAmount !== null && row.feeAmount !== undefined) amount = round2(row.feeAmount * value / 100);
    } else {
      amount = round2(value);
    }
  }
  return { commissionTypeEff: type, commissionValueEff: value, currencyEff: currency, commissionAmount: amount };
}

function decorate(row, setting) {
  const plain = row.toObject ? row.toObject() : row;
  return { ...plain, ...effective(plain, setting), isManual: !plain.application };
}

async function getSetting(countryId) {
  const s = await UnicommissionSetting.findOne({ country: countryId }).lean();
  return s || { country: countryId, currency: '', commissionType: 'percentage', commissionValue: null };
}

const SOURCED = ['studentName', 'associate', 'intake', 'university', 'level', 'course', 'visaGrantedDate'];

function sourceValues(app) {
  const primary = Array.isArray(app.universities) && app.universities.length ? app.universities[0] : {};
  return {
    studentName: cleanText(app.name, 200),
    associate: cleanText(app.referredBy, 200),
    intake: normalizeIntake(app.deferredIntake || app.initialIntake),
    university: cleanText(app.providerName || primary.providerName, 300),
    level: cleanText(app.level || primary.level, 60),
    course: cleanText(app.course || primary.course, 300),
    visaGrantedDate: app.visaLodgement || null
  };
}

function sameValue(a, b) {
  if (a instanceof Date || b instanceof Date) {
    const ta = a ? new Date(a).getTime() : null;
    const tb = b ? new Date(b).getTime() : null;
    return ta === tb;
  }
  return (a ?? '') === (b ?? '');
}

async function syncApplications({ country } = {}) {
  const scope = country ? { country } : {};
  const apps = await Application.find({ ...scope, visaOutcome: GRANT_RX })
    .select('country name referredBy level course providerName universities initialIntake deferredIntake visaLodgement')
    .lean();
  const rows = await Unicommission.find({ ...scope, application: { $exists: true, $ne: null } })
    .select('application manualFields sourceFlag studentName associate intake university level course visaGrantedDate')
    .lean();

  const rowByApp = new Map(rows.map(r => [String(r.application), r]));
  const grantIds = new Set(apps.map(a => String(a._id)));

  const needNew = apps.filter(a => !rowByApp.has(String(a._id)));
  const skipped = needNew.length
    ? new Set((await UnicommissionSkip.find({ application: { $in: needNew.map(a => a._id) } }).select('application').lean())
      .map(s => String(s.application)))
    : new Set();

  const ops = [];
  let created = 0;
  let refreshed = 0;
  let flagged = 0;

  apps.forEach(app => {
    const id = String(app._id);
    const vals = sourceValues(app);
    const row = rowByApp.get(id);
    if (!row) {
      if (skipped.has(id) || !vals.studentName) return;
      ops.push({ insertOne: { document: { country: app.country, application: app._id, ...vals, paymentStatus: 'Pending', manualFields: [], sourceFlag: '' } } });
      created += 1;
      return;
    }
    const $set = {};
    SOURCED.forEach(k => {
      if ((row.manualFields || []).includes(k)) return;
      if (!sameValue(row[k], vals[k])) $set[k] = vals[k];
    });
    if (row.sourceFlag) $set.sourceFlag = '';
    if (Object.keys($set).length) {
      ops.push({ updateOne: { filter: { _id: row._id }, update: { $set } } });
      refreshed += 1;
    }
  });

  const stale = rows.filter(r => !grantIds.has(String(r.application)));
  if (stale.length) {
    const stillThere = new Set((await Application.find({ _id: { $in: stale.map(r => r.application) } }).select('_id').lean())
      .map(a => String(a._id)));
    stale.forEach(r => {
      const flag = stillThere.has(String(r.application)) ? 'not_granted' : 'application_deleted';
      if (r.sourceFlag !== flag) {
        ops.push({ updateOne: { filter: { _id: r._id }, update: { $set: { sourceFlag: flag } } } });
        flagged += 1;
      }
    });
  }

  if (ops.length) {
    try {
      await Unicommission.bulkWrite(ops, { ordered: false });
    } catch (err) {
      const writeErrors = err.writeErrors || [];
      const onlyDuplicates = err.code === 11000 || (writeErrors.length > 0 && writeErrors.every(w => (w.err?.code ?? w.code) === 11000));
      if (!onlyDuplicates) throw err;
    }
  }
  return { grants: apps.length, created, refreshed, flagged };
}

function triggerSync(countryId) {
  syncApplications(countryId ? { country: countryId } : {}).catch(err => {
    console.warn('Unicommission sync failed:', err.message);
  });
}

module.exports = {
  SOURCED,
  GRANT_RX,
  cleanText,
  parseLooseDate,
  normalizeIntake,
  parseFee,
  parseNumber,
  normStatus,
  normType,
  normCurrency,
  nameKey,
  effective,
  decorate,
  getSetting,
  syncApplications,
  triggerSync
};
