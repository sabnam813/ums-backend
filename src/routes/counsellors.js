const mongoose = require('mongoose');
const express = require('express');
const Counsellor = require('../models/Counsellor');
const AssociateDetail = require('../models/AssociateDetail');
const { verifyAccess, requirePermission } = require('../middleware/auth');
const { softDelete, softDeleteMany } = require('../utils/trashHelper');
const { logActivity } = require('../utils/auditLogger');

const router = express.Router();
router.use(verifyAccess);

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === String(id);
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clamp(v, max) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/\s+/g, ' ').trim().slice(0, max);
}

function normName(v) {
  return String(v || '').toLowerCase().replace(/[\s,.]+/g, ' ').trim();
}

async function knownAssociateKeys() {
  const docs = await AssociateDetail.find({}).select('consultancyName aliases').lean();
  const set = new Set();
  docs.forEach(d => {
    set.add(normName(d.consultancyName));
    (d.aliases || []).forEach(a => set.add(normName(a)));
  });
  return set;
}

function buildClean(body, partial) {
  const errors = [];
  const out = {};
  if (!partial || body.associate !== undefined) {
    const a = clamp(body.associate, 300);
    if (!a) errors.push('Associate is required');
    else out.associate = a;
  }
  if (!partial || body.counsellorName !== undefined) {
    const n = clamp(body.counsellorName, 200);
    if (!n) errors.push('Counsellor name is required');
    else out.counsellorName = n;
  }
  if (!partial || body.phone !== undefined) out.phone = clamp(body.phone, 120);
  if (!partial || body.email !== undefined) out.email = clamp(body.email, 300);
  return { errors, clean: out };
}

router.get('/', requirePermission('counsellorDetails', 'view'), async (req, res) => {
  try {
    const { q, associate, limit = 10000 } = req.query;
    const clauses = [];
    if (associate) clauses.push({ associate: new RegExp(`^\\s*${escapeRegex(String(associate).trim())}\\s*$`, 'i') });
    if (q && String(q).trim()) {
      const rx = new RegExp(escapeRegex(String(q).trim()), 'i');
      clauses.push({ $or: [{ associate: rx }, { counsellorName: rx }, { phone: rx }, { email: rx }] });
    }
    const rows = await Counsellor.find(clauses.length ? { $and: clauses } : {})
      .sort({ associate: 1, counsellorName: 1 })
      .limit(Math.min(Number(limit) || 10000, 20000))
      .lean();
    const known = await knownAssociateKeys();
    const out = rows.map(r => ({ ...r, notInAssociateDetails: !known.has(normName(r.associate)) }));
    res.json({ rows: out, total: out.length });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch counsellors' });
  }
});

router.post('/', requirePermission('counsellorDetails', 'create'), async (req, res) => {
  try {
    const { errors, clean } = buildClean(req.body || {}, false);
    if (errors.length) return res.status(400).json({ message: errors[0], errors });
    const doc = await Counsellor.create({ ...clean, createdBy: req.user._id, updatedBy: req.user._id });
    const known = await knownAssociateKeys();
    await logActivity(req, 'counsellor_create', {
      targetType: 'Counsellor', targetId: doc._id, message: `Added counsellor "${doc.counsellorName}" for ${doc.associate}`
    });
    res.status(201).json({ row: doc, notInAssociateDetails: !known.has(normName(doc.associate)) });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Failed to create counsellor' });
  }
});

router.post('/bulk-import', requirePermission('counsellorDetails', 'import'), async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (rows.length === 0) return res.status(400).json({ message: 'No rows to import' });
    if (rows.length > 5000) return res.status(400).json({ message: 'Too many rows in one import (max 5000)' });
    const known = await knownAssociateKeys();
    const failures = [];
    const docs = [];
    const unknown = new Set();
    rows.forEach((row, idx) => {
      const { errors, clean } = buildClean(row || {}, false);
      if (errors.length) {
        failures.push({ row: idx + 1, name: clamp(row && row.counsellorName, 200), reason: errors[0] });
        return;
      }
      if (!known.has(normName(clean.associate))) unknown.add(clean.associate);
      docs.push({ ...clean, createdBy: req.user._id, updatedBy: req.user._id });
    });
    let inserted = 0;
    if (docs.length) {
      try {
        const out = await Counsellor.insertMany(docs, { ordered: false });
        inserted = out.length;
      } catch (bulkErr) {
        inserted = (bulkErr.insertedDocs || []).length;
        (bulkErr.writeErrors || []).forEach(we => failures.push({ row: '?', name: '', reason: we.errmsg || 'Database write error' }));
      }
    }
    await logActivity(req, 'counsellor_bulk_import', { message: `Imported ${inserted} counsellor(s), ${failures.length} skipped` });
    res.json({
      total: rows.length, created: inserted, failed: failures.length, failures,
      warnings: unknown.size ? [`Not in Associate Details: ${[...unknown].slice(0, 20).join(', ')}${unknown.size > 20 ? '…' : ''}`] : []
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to import counsellors' });
  }
});

router.post('/bulk-edit', requirePermission('counsellorDetails', 'bulkEdit'), async (req, res) => {
  try {
    const { ids, updates } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: 'No rows selected' });
    const validIds = ids.filter(isValidObjectId);
    if (validIds.length === 0) return res.status(400).json({ message: 'No valid ids provided' });
    const $set = {};
    if (updates && clamp(updates.associate, 300)) $set.associate = clamp(updates.associate, 300);
    if (updates && clamp(updates.phone, 120)) $set.phone = clamp(updates.phone, 120);
    if (updates && clamp(updates.email, 300)) $set.email = clamp(updates.email, 300);
    if (Object.keys($set).length === 0) return res.status(400).json({ message: 'No valid fields to update' });
    $set.updatedBy = req.user._id;
    const result = await Counsellor.updateMany({ _id: { $in: validIds } }, { $set });
    await logActivity(req, 'counsellor_bulk_edit', {
      message: `Bulk-updated ${result.modifiedCount} counsellor(s)`, meta: { fields: Object.keys($set) }
    });
    res.json({ message: `Updated ${result.modifiedCount} row(s)`, modifiedCount: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ message: 'Failed to bulk update' });
  }
});

router.delete('/bulk-delete', requirePermission('counsellorDetails', 'delete'), async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: 'No rows selected' });
    const validIds = ids.filter(isValidObjectId);
    if (validIds.length === 0) return res.status(400).json({ message: 'No valid ids provided' });
    const docs = await Counsellor.find({ _id: { $in: validIds } });
    await softDeleteMany({
      modelName: 'Counsellor', docs, userId: req.user._id, userName: req.user.name || req.user.username,
      metaFor: d => ({ counsellorName: d.counsellorName })
    });
    await logActivity(req, 'counsellor_bulk_delete', { message: `Bulk-moved ${docs.length} counsellor(s) to trash` });
    res.json({ deleted: docs.length });
  } catch (err) {
    res.status(500).json({ message: 'Failed to bulk delete' });
  }
});

router.put('/:id', requirePermission('counsellorDetails', 'edit'), async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid id' });
    const doc = await Counsellor.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Row not found' });
    const { errors, clean } = buildClean(req.body || {}, false);
    if (errors.length) return res.status(400).json({ message: errors[0], errors });
    Object.assign(doc, clean);
    doc.updatedBy = req.user._id;
    await doc.save();
    const known = await knownAssociateKeys();
    await logActivity(req, 'counsellor_update', {
      targetType: 'Counsellor', targetId: doc._id, message: `Updated counsellor "${doc.counsellorName}"`
    });
    res.json({ row: doc, notInAssociateDetails: !known.has(normName(doc.associate)) });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Failed to update counsellor' });
  }
});

router.delete('/:id', requirePermission('counsellorDetails', 'delete'), async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid id' });
    const doc = await Counsellor.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Row not found' });
    await softDelete({
      modelName: 'Counsellor', doc, userId: req.user._id, userName: req.user.name || req.user.username,
      meta: { counsellorName: doc.counsellorName }
    });
    await logActivity(req, 'counsellor_delete', {
      targetType: 'Counsellor', targetId: doc._id, message: `Moved counsellor "${doc.counsellorName}" to trash`
    });
    res.json({ message: 'Moved to trash' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete counsellor' });
  }
});

module.exports = router;
