const mongoose = require('mongoose');
const express = require('express');
const AssociateDetail = require('../models/AssociateDetail');
const { verifyAccess, requirePermission } = require('../middleware/auth');
const { softDelete, softDeleteMany } = require('../utils/trashHelper');
const { logActivity } = require('../utils/auditLogger');

const router = express.Router();
router.use(verifyAccess);

/* Text columns, in the same order as the Excel sheet (minus sno / date). */
const TEXT_FIELDS = [
  ['consultancyName', 300], ['ownerName', 200], ['designation', 150], ['oopStatus', 300],
  ['ownerContact', 120], ['email', 300], ['address', 600], ['location', 150],
  ['managerName', 200], ['managerEmail', 300], ['managerContact', 120], ['officialPhone', 120],
  ['emailAdmission', 300], ['emailTestRegistration', 300], ['emailOthers', 600],
  ['website', 300], ['referredBy', 200], ['association', 600]
];
const TEXT_KEYS = TEXT_FIELDS.map(([k]) => k);
const FILTER_KEYS = ['location', 'oopStatus', 'referredBy', 'designation'];

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === String(id);
}
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Any cell value -> trimmed single string (numbers, dates and "=123" text all safe). */
function cleanText(v, max) {
  if (v === undefined || v === null) return '';
  let s;
  if (v instanceof Date) s = v.toISOString().slice(0, 10);
  else if (typeof v === 'number') s = Number.isInteger(v) ? String(v) : String(v);
  else s = String(v);
  s = s.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s.slice(0, max);
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

/** Tolerant date reader: Date | ISO | "11-Sept-2024" | "9 0ct-2024" | "22/5/2023" | Excel serial. */
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
    const mon = MONTHS[m[2].toLowerCase().slice(0, 4)] ?? MONTHS[m[2].toLowerCase().slice(0, 3)];
    if (mon !== undefined) {
      const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
      return new Date(Date.UTC(y, mon, +m[1]));
    }
  }
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) {
    const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    return new Date(Date.UTC(y, +m[2] - 1, +m[1]));
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function cleanSno(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

async function nextSno() {
  const top = await AssociateDetail.findOne({ sno: { $ne: null } }).sort({ sno: -1 }).select('sno').lean();
  return (top?.sno || 0) + 1;
}

function buildClean(body) {
  const clean = {};
  TEXT_FIELDS.forEach(([k, max]) => { clean[k] = cleanText(body[k], max); });
  const parsed = parseLooseDate(body.dateOfOnboarding);
  clean.dateOfOnboarding = parsed;
  const rawDate = body.dateOfOnboarding;
  clean.dateOfOnboardingText = !parsed && rawDate ? cleanText(rawDate, 60) : '';
  return clean;
}

/* GET /options — name list for the Application "Referred By" and Test   */
/* Preparation "Associates" dropdowns. Any signed-in user may read the   */
/* names (they need them to fill those forms); nothing else is exposed.  */
router.get('/options', async (req, res) => {
  try {
    const rows = await AssociateDetail.find({ consultancyName: { $ne: '' } })
      .select('consultancyName location').sort({ consultancyName: 1 }).lean();
    res.json({
      associates: rows.map(r => ({ _id: r._id, name: r.consultancyName, location: r.location || '' }))
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to load associates' });
  }
});

/* GET /meta — distinct values for the filter dropdowns */
router.get('/meta', requirePermission('associateDetails', 'view'), async (req, res) => {
  try {
    const out = {};
    await Promise.all(FILTER_KEYS.map(async k => {
      const vals = await AssociateDetail.distinct(k);
      const seen = new Map();
      vals.forEach(v => {
        const t = String(v || '').trim().replace(/[,\s]+$/, '');
        if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
      });
      out[k] = [...seen.values()].sort((a, b) => a.localeCompare(b));
    }));
    res.json(out);
  } catch (err) {
    res.status(500).json({ message: 'Failed to load filter options' });
  }
});

/* GET / — list with search + filters */
router.get('/', requirePermission('associateDetails', 'view'), async (req, res) => {
  try {
    const { q, dateFrom, dateTo, limit = 5000 } = req.query;
    const clauses = [];

    FILTER_KEYS.forEach(k => {
      if (req.query[k]) {
        clauses.push({ [k]: new RegExp(`^\\s*${escapeRegex(String(req.query[k]).trim())}[,\\s]*$`, 'i') });
      }
    });
    if (dateFrom || dateTo) {
      const range = {};
      if (dateFrom) range.$gte = new Date(dateFrom);
      if (dateTo) { const t = new Date(dateTo); t.setUTCHours(23, 59, 59, 999); range.$lte = t; }
      clauses.push({ dateOfOnboarding: range });
    }
    if (q && String(q).trim()) {
      const rx = new RegExp(escapeRegex(String(q).trim()), 'i');
      clauses.push({ $or: TEXT_KEYS.map(k => ({ [k]: rx })).concat([{ dateOfOnboardingText: rx }]) });
    }

    const rows = await AssociateDetail.find(clauses.length ? { $and: clauses } : {})
      .sort({ sno: 1, consultancyName: 1 })
      .limit(Math.min(Number(limit) || 5000, 10000))
      .lean();
    res.json({ associates: rows, total: rows.length });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch associate details' });
  }
});

/* POST / — create */
router.post('/', requirePermission('associateDetails', 'create'), async (req, res) => {
  try {
    const clean = buildClean(req.body || {});
    if (!clean.consultancyName) return res.status(400).json({ message: 'Name of consultancy is required' });
    const dup = await AssociateDetail.findOne({
      consultancyName: new RegExp(`^${escapeRegex(clean.consultancyName)}$`, 'i')
    }).select('_id');
    if (dup) return res.status(409).json({ message: 'An associate with this consultancy name already exists' });

    const doc = await AssociateDetail.create({
      ...clean,
      sno: cleanSno(req.body.sno) || await nextSno(),
      createdBy: req.user._id,
      updatedBy: req.user._id
    });
    await logActivity(req, 'associate_detail_create', {
      targetType: 'AssociateDetail', targetId: doc._id, message: `Added associate "${doc.consultancyName}"`
    });
    res.status(201).json({ associate: doc });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Failed to create associate' });
  }
});

/* POST /bulk-import — registered before /:id routes. Upsert by consultancy name. */
router.post('/bulk-import', requirePermission('associateDetails', 'import'), async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (rows.length === 0) return res.status(400).json({ message: 'No rows to import' });
    if (rows.length > 5000) return res.status(400).json({ message: 'Too many rows in one import (max 5000)' });

    const existing = await AssociateDetail.find({}).select('consultancyName').lean();
    const byName = new Map(existing.map(d => [d.consultancyName.trim().toLowerCase(), d._id]));
    let sno = await nextSno();

    const failures = [];
    let created = 0;
    let updated = 0;
    const seenInFile = new Set();

    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx] || {};
      const clean = buildClean(row);
      if (!clean.consultancyName) {
        // Blank numbered rows are normal in the sheet — not an error worth listing loudly.
        if (TEXT_KEYS.some(k => clean[k])) failures.push({ row: idx + 1, name: '', reason: 'Missing name of consultancy' });
        continue;
      }
      const key = clean.consultancyName.toLowerCase();
      if (seenInFile.has(key)) {
        failures.push({ row: idx + 1, name: clean.consultancyName, reason: 'Duplicate name inside the file (first one kept)' });
        continue;
      }
      seenInFile.add(key);

      try {
        const existingId = byName.get(key);
        if (existingId) {
          // Re-import = refresh. Only overwrite with values that are actually filled in.
          const $set = { updatedBy: req.user._id };
          TEXT_KEYS.forEach(k => { if (clean[k]) $set[k] = clean[k]; });
          if (clean.dateOfOnboarding) { $set.dateOfOnboarding = clean.dateOfOnboarding; $set.dateOfOnboardingText = ''; }
          else if (clean.dateOfOnboardingText) $set.dateOfOnboardingText = clean.dateOfOnboardingText;
          const n = cleanSno(row.sno);
          if (n) $set.sno = n;
          await AssociateDetail.updateOne({ _id: existingId }, { $set });
          updated += 1;
        } else {
          const doc = await AssociateDetail.create({
            ...clean,
            sno: cleanSno(row.sno) || sno,
            createdBy: req.user._id,
            updatedBy: req.user._id
          });
          byName.set(key, doc._id);
          if (!cleanSno(row.sno)) sno += 1;
          created += 1;
        }
      } catch (e) {
        failures.push({ row: idx + 1, name: clean.consultancyName, reason: e.message || 'Database error' });
      }
    }

    await logActivity(req, 'associate_detail_bulk_import', {
      message: `Imported associates: ${created} added, ${updated} updated, ${failures.length} skipped`
    });
    res.json({ total: rows.length, created: created + updated, added: created, updated, failed: failures.length, failures });
  } catch (err) {
    res.status(500).json({ message: 'Failed to import associates' });
  }
});

/* POST /bulk-edit — same value on many rows (only fields sent are changed) */
router.post('/bulk-edit', requirePermission('associateDetails', 'bulkEdit'), async (req, res) => {
  try {
    const { ids, updates } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: 'No rows selected' });
    const validIds = ids.filter(isValidObjectId);
    if (validIds.length === 0) return res.status(400).json({ message: 'No valid ids provided' });

    const $set = {};
    TEXT_FIELDS.forEach(([k, max]) => {
      if (k === 'consultancyName') return; // a name must stay unique per row
      if (updates && updates[k] !== undefined) $set[k] = cleanText(updates[k], max);
    });
    if (updates && updates.dateOfOnboarding !== undefined) {
      const d = parseLooseDate(updates.dateOfOnboarding);
      if (d) { $set.dateOfOnboarding = d; $set.dateOfOnboardingText = ''; }
    }
    if (Object.keys($set).length === 0) return res.status(400).json({ message: 'No valid fields to update' });
    $set.updatedBy = req.user._id;

    const result = await AssociateDetail.updateMany({ _id: { $in: validIds } }, { $set });
    await logActivity(req, 'associate_detail_bulk_edit', {
      message: `Bulk-updated ${result.modifiedCount} associate(s)`, meta: { fields: Object.keys($set) }
    });
    res.json({ message: `Updated ${result.modifiedCount} row(s)`, modifiedCount: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ message: 'Failed to bulk update' });
  }
});

/* DELETE /bulk-delete — before /:id on purpose (route order) */
router.delete('/bulk-delete', requirePermission('associateDetails', 'delete'), async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: 'No rows selected' });
    const validIds = ids.filter(isValidObjectId);
    const docs = await AssociateDetail.find({ _id: { $in: validIds } });
    await softDeleteMany({
      modelName: 'AssociateDetail', docs, userId: req.user._id, userName: req.user.name || req.user.username,
      metaFor: d => ({ consultancyName: d.consultancyName })
    });
    await logActivity(req, 'associate_detail_bulk_delete', { message: `Bulk-moved ${docs.length} associate(s) to trash` });
    res.json({ deleted: docs.length });
  } catch (err) {
    res.status(500).json({ message: 'Failed to bulk delete' });
  }
});

/* PUT /:id */
router.put('/:id', requirePermission('associateDetails', 'edit'), async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid id' });
    const doc = await AssociateDetail.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Associate not found' });

    const clean = buildClean(req.body || {});
    if (!clean.consultancyName) return res.status(400).json({ message: 'Name of consultancy is required' });
    const dup = await AssociateDetail.findOne({
      _id: { $ne: doc._id },
      consultancyName: new RegExp(`^${escapeRegex(clean.consultancyName)}$`, 'i')
    }).select('_id');
    if (dup) return res.status(409).json({ message: 'Another associate already has this consultancy name' });

    Object.assign(doc, clean);
    const n = cleanSno(req.body.sno);
    if (n) doc.sno = n;
    doc.updatedBy = req.user._id;
    await doc.save();
    await logActivity(req, 'associate_detail_update', {
      targetType: 'AssociateDetail', targetId: doc._id, message: `Updated associate "${doc.consultancyName}"`
    });
    res.json({ associate: doc });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Failed to update associate' });
  }
});

/* DELETE /:id — soft delete (Trash) */
router.delete('/:id', requirePermission('associateDetails', 'delete'), async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid id' });
    const doc = await AssociateDetail.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Associate not found' });
    await softDelete({
      modelName: 'AssociateDetail', doc, userId: req.user._id, userName: req.user.name || req.user.username,
      meta: { consultancyName: doc.consultancyName }
    });
    await logActivity(req, 'associate_detail_delete', {
      targetType: 'AssociateDetail', targetId: doc._id, message: `Moved associate "${doc.consultancyName}" to trash`
    });
    res.json({ message: 'Moved to trash' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete associate' });
  }
});

module.exports = router;
module.exports._test = { buildClean, parseLooseDate, cleanText, cleanSno };
