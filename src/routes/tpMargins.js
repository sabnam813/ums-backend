const mongoose = require('mongoose');
const express = require('express');
const TPMargin = require('../models/TPMargin');
const TestType = require('../models/TestType');
const { verifyAccess, requirePermission } = require('../middleware/auth');
const { softDelete, softDeleteMany } = require('../utils/trashHelper');
const { logActivity } = require('../utils/auditLogger');

const router = express.Router();
router.use(verifyAccess);

let migrated = null;
function migrateOnce() {
  if (!migrated) {
    migrated = TPMargin.collection.updateMany(
      { totalMargin: { $exists: false }, priceMargin: { $exists: true } },
      { $rename: { priceMargin: 'totalMargin' } }
    ).catch(() => null);
  }
  return migrated;
}
router.use(async (req, res, next) => { await migrateOnce(); next(); });

function calcUca(total, assoc) {
  return Math.round(((Number(total) || 0) - (Number(assoc) || 0)) * 100) / 100;
}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === String(id);
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanNum(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  const n = Number(String(v).replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

function parseDate(v) {
  if (v === undefined || v === null || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') {
    if (v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400 * 1000));
    return null;
  }
  const s = String(v).trim();
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

async function particularNames() {
  const types = await TestType.find({}).select('name status order').sort({ order: 1, name: 1 }).lean();
  const names = types.filter(t => t.status !== 'inactive').map(t => t.name);
  return names;
}

async function matchParticular(raw, names) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const hit = names.find(n => n.toLowerCase() === s.toLowerCase());
  return hit || s.slice(0, 120);
}

function buildClean(body, names, partial) {
  const errors = [];
  const out = {};
  const date = parseDate(body.date);
  if (!partial || body.date !== undefined) {
    if (!date) errors.push('A valid date is required');
    else out.date = date;
  }
  if (!partial || body.particular !== undefined) {
    const p = String(body.particular || '').trim();
    if (!p) errors.push('Particulars is required');
    else {
      const hit = names.find(n => n.toLowerCase() === p.toLowerCase());
      out.particular = (hit || p).slice(0, 120);
    }
  }
  const price = cleanNum(body.price);
  const total = cleanNum(body.totalMargin);
  const assoc = cleanNum(body.associateMargin);
  out.price = price === null ? 0 : price;
  out.totalMargin = total === null ? 0 : total;
  out.associateMargin = assoc === null ? 0 : assoc;
  out.ucaMargin = calcUca(out.totalMargin, out.associateMargin);
  if (!partial || body.remarks !== undefined) out.remarks = String(body.remarks || '').trim().slice(0, 500);
  return { errors, clean: out };
}

router.get('/particulars', requirePermission('tpMargin', 'view'), async (req, res) => {
  try {
    const names = await particularNames();
    const used = await TPMargin.distinct('particular');
    const seen = new Set(names.map(n => n.toLowerCase()));
    const extra = used.filter(u => u && !seen.has(String(u).toLowerCase()));
    res.json({ particulars: [...names, ...extra] });
  } catch (err) {
    res.status(500).json({ message: 'Failed to load particulars' });
  }
});

router.get('/', requirePermission('tpMargin', 'view'), async (req, res) => {
  try {
    const { q, particular, dateFrom, dateTo, limit = 10000 } = req.query;
    const clauses = [];
    if (particular) clauses.push({ particular: new RegExp(`^${escapeRegex(String(particular).trim())}$`, 'i') });
    if (dateFrom || dateTo) {
      const range = {};
      if (dateFrom) { const f = new Date(dateFrom); f.setUTCHours(0, 0, 0, 0); range.$gte = f; }
      if (dateTo) { const t = new Date(dateTo); t.setUTCHours(23, 59, 59, 999); range.$lte = t; }
      clauses.push({ date: range });
    }
    if (q && String(q).trim()) {
      const rx = new RegExp(escapeRegex(String(q).trim()), 'i');
      clauses.push({ $or: [{ particular: rx }, { remarks: rx }] });
    }
    const rows = await TPMargin.find(clauses.length ? { $and: clauses } : {})
      .sort({ date: 1, createdAt: 1 })
      .limit(Math.min(Number(limit) || 10000, 20000))
      .lean();
    res.json({ rows, total: rows.length });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch TP margins' });
  }
});

router.post('/', requirePermission('tpMargin', 'create'), async (req, res) => {
  try {
    const names = await particularNames();
    const { errors, clean } = buildClean(req.body || {}, names, false);
    if (errors.length) return res.status(400).json({ message: errors[0], errors });
    const doc = await TPMargin.create({ ...clean, createdBy: req.user._id, updatedBy: req.user._id });
    await logActivity(req, 'tpmargin_create', {
      targetType: 'TPMargin', targetId: doc._id, message: `Added TP margin for ${doc.particular}`
    });
    res.status(201).json({ row: doc });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Failed to create TP margin' });
  }
});

router.post('/bulk-import', requirePermission('tpMargin', 'import'), async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (rows.length === 0) return res.status(400).json({ message: 'No rows to import' });
    if (rows.length > 5000) return res.status(400).json({ message: 'Too many rows in one import (max 5000)' });
    const names = await particularNames();
    const failures = [];
    const docs = [];
    rows.forEach((row, idx) => {
      const { errors, clean } = buildClean(row || {}, names, false);
      if (errors.length) {
        failures.push({ row: idx + 1, name: String((row && row.particular) || ''), reason: errors[0] });
        return;
      }
      docs.push({ ...clean, createdBy: req.user._id, updatedBy: req.user._id });
    });
    let inserted = 0;
    if (docs.length) {
      try {
        const res2 = await TPMargin.insertMany(docs, { ordered: false });
        inserted = res2.length;
      } catch (bulkErr) {
        inserted = (bulkErr.insertedDocs || []).length;
        (bulkErr.writeErrors || []).forEach(we => failures.push({ row: '?', name: '', reason: we.errmsg || 'Database write error' }));
      }
    }
    await logActivity(req, 'tpmargin_bulk_import', { message: `Imported ${inserted} TP margin row(s), ${failures.length} skipped` });
    res.json({ total: rows.length, created: inserted, failed: failures.length, failures });
  } catch (err) {
    res.status(500).json({ message: 'Failed to import TP margins' });
  }
});

router.post('/bulk-edit', requirePermission('tpMargin', 'bulkEdit'), async (req, res) => {
  try {
    const { ids, updates } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: 'No rows selected' });
    const validIds = ids.filter(isValidObjectId);
    if (validIds.length === 0) return res.status(400).json({ message: 'No valid ids provided' });
    const names = await particularNames();
    const $set = {};
    if (updates && updates.particular) $set.particular = await matchParticular(updates.particular, names);
    if (updates && updates.date) {
      const d = parseDate(updates.date);
      if (d) $set.date = d;
    }
    ['price', 'totalMargin', 'associateMargin'].forEach(k => {
      if (updates && updates[k] !== undefined && updates[k] !== '') {
        const n = cleanNum(updates[k]);
        if (n !== null) $set[k] = n;
      }
    });
    if (updates && updates.remarks !== undefined && String(updates.remarks).trim() !== '') $set.remarks = String(updates.remarks).trim().slice(0, 500);
    if (Object.keys($set).length === 0) return res.status(400).json({ message: 'No valid fields to update' });
    $set.updatedBy = req.user._id;
    const stage = {};
    Object.keys($set).forEach(k => { stage[k] = { $literal: $set[k] }; });
    stage.ucaMargin = {
      $round: [{ $subtract: [
        { $ifNull: [stage.totalMargin || '$totalMargin', 0] },
        { $ifNull: [stage.associateMargin || '$associateMargin', 0] }
      ] }, 2]
    };
    const result = await TPMargin.updateMany({ _id: { $in: validIds } }, [{ $set: stage }]);
    await logActivity(req, 'tpmargin_bulk_edit', {
      message: `Bulk-updated ${result.modifiedCount} TP margin row(s)`, meta: { fields: Object.keys($set) }
    });
    res.json({ message: `Updated ${result.modifiedCount} row(s)`, modifiedCount: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ message: 'Failed to bulk update' });
  }
});

router.delete('/bulk-delete', requirePermission('tpMargin', 'delete'), async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: 'No rows selected' });
    const validIds = ids.filter(isValidObjectId);
    if (validIds.length === 0) return res.status(400).json({ message: 'No valid ids provided' });
    const docs = await TPMargin.find({ _id: { $in: validIds } });
    await softDeleteMany({
      modelName: 'TPMargin', docs, userId: req.user._id, userName: req.user.name || req.user.username,
      metaFor: d => ({ particular: d.particular })
    });
    await logActivity(req, 'tpmargin_bulk_delete', { message: `Bulk-moved ${docs.length} TP margin row(s) to trash` });
    res.json({ deleted: docs.length });
  } catch (err) {
    res.status(500).json({ message: 'Failed to bulk delete' });
  }
});

router.put('/:id', requirePermission('tpMargin', 'edit'), async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid id' });
    const doc = await TPMargin.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Row not found' });
    const names = await particularNames();
    const { errors, clean } = buildClean(req.body || {}, names, false);
    if (errors.length) return res.status(400).json({ message: errors[0], errors });
    Object.assign(doc, clean);
    doc.updatedBy = req.user._id;
    await doc.save();
    await logActivity(req, 'tpmargin_update', {
      targetType: 'TPMargin', targetId: doc._id, message: `Updated TP margin for ${doc.particular}`
    });
    res.json({ row: doc });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Failed to update TP margin' });
  }
});

router.delete('/:id', requirePermission('tpMargin', 'delete'), async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid id' });
    const doc = await TPMargin.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Row not found' });
    await softDelete({
      modelName: 'TPMargin', doc, userId: req.user._id, userName: req.user.name || req.user.username,
      meta: { particular: doc.particular }
    });
    await logActivity(req, 'tpmargin_delete', {
      targetType: 'TPMargin', targetId: doc._id, message: `Moved TP margin for ${doc.particular} to trash`
    });
    res.json({ message: 'Moved to trash' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete TP margin' });
  }
});

module.exports = router;
