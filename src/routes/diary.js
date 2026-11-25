const mongoose = require('mongoose');
const express = require('express');
const Diary = require('../models/Diary');
const {
  verifyAccess,
  requireSuperAdmin
} = require('../middleware/auth');
const {
  softDelete
} = require('../utils/trashHelper');
const {
  logActivity
} = require('../utils/auditLogger');

const router = express.Router();
router.use(verifyAccess);
router.use(requireSuperAdmin);

const MAX_TEXT_LEN = 150;
const MAX_REMARKS_LEN = 2000;

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === String(id);
}

function clampStr(v, max = MAX_TEXT_LEN) {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, max);
}

function validatePayload(body) {
  const errors = [];
  const name = clampStr(body.name, 150);
  if (!name) errors.push('Name is required');

  return {
    errors,
    clean: {
      name,
      post: clampStr(body.post, 150),
      mobile: clampStr(body.mobile, 40),
      remarks: clampStr(body.remarks, MAX_REMARKS_LEN)
    }
  };
}

router.get('/', async (req, res) => {
  try {
    const { q } = req.query;
    let list = await Diary.find({}).sort({ name: 1 }).lean();

    if (q && String(q).trim()) {
      const needle = String(q).trim().toLowerCase();
      list = list.filter(d =>
        (d.name || '').toLowerCase().includes(needle) ||
        (d.post || '').toLowerCase().includes(needle) ||
        (d.mobile || '').toLowerCase().includes(needle) ||
        (d.remarks || '').toLowerCase().includes(needle)
      );
    }

    res.json({ entries: list, total: list.length });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch diary entries' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { errors, clean } = validatePayload(req.body || {});
    if (errors.length) return res.status(400).json({ message: errors[0], errors });

    const entry = await Diary.create({
      ...clean,
      createdBy: req.user._id,
      updatedBy: req.user._id
    });
    await logActivity(req, 'diary_create', {
      targetType: 'Diary',
      targetId: entry._id,
      message: `Created diary entry "${entry.name}"`
    });
    res.status(201).json({ entry });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Failed to create diary entry' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid diary id' });
    const entry = await Diary.findById(req.params.id);
    if (!entry) return res.status(404).json({ message: 'Diary entry not found' });

    const { errors, clean } = validatePayload(req.body || {});
    if (errors.length) return res.status(400).json({ message: errors[0], errors });

    Object.assign(entry, clean);
    entry.updatedBy = req.user._id;
    await entry.save();
    await logActivity(req, 'diary_update', {
      targetType: 'Diary',
      targetId: entry._id,
      message: `Updated diary entry "${entry.name}"`
    });
    res.json({ entry });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Failed to update diary entry' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid diary id' });
    const entry = await Diary.findById(req.params.id);
    if (!entry) return res.status(404).json({ message: 'Diary entry not found' });

    await softDelete({
      modelName: 'Diary',
      doc: entry,
      userId: req.user._id,
      userName: req.user.name || req.user.username
    });
    await logActivity(req, 'diary_delete', {
      targetType: 'Diary',
      targetId: entry._id,
      message: `Moved diary entry "${entry.name}" to trash`
    });
    res.json({ message: 'Moved to trash' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete diary entry' });
  }
});

router.post('/bulk-edit', async (req, res) => {
  try {
    const { ids, updates } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: 'No diary entries selected' });
    const validIds = ids.filter(isValidObjectId);
    if (validIds.length === 0) return res.status(400).json({ message: 'No valid diary ids provided' });

    const allowed = {};
    if (updates && typeof updates === 'object') {
      if (updates.post !== undefined) allowed.post = clampStr(updates.post, 150);
      if (updates.remarks !== undefined) allowed.remarks = clampStr(updates.remarks, MAX_REMARKS_LEN);
    }
    if (Object.keys(allowed).length === 0) {
      return res.status(400).json({ message: 'No valid fields to update' });
    }
    allowed.updatedBy = req.user._id;

    const result = await Diary.updateMany({ _id: { $in: validIds } }, { $set: allowed });
    await logActivity(req, 'diary_bulk_edit', {
      message: `Bulk-updated ${result.modifiedCount} diary entr${result.modifiedCount === 1 ? 'y' : 'ies'}`,
      meta: { fields: Object.keys(allowed) }
    });
    res.json({ message: `Updated ${result.modifiedCount} entr${result.modifiedCount === 1 ? 'y' : 'ies'}`, modifiedCount: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ message: 'Failed to bulk update diary entries' });
  }
});

router.delete('/bulk-delete', async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: 'No diary entries selected' });
    const validIds = ids.filter(isValidObjectId);
    if (validIds.length === 0) return res.status(400).json({ message: 'No valid diary ids provided' });

    const entries = await Diary.find({ _id: { $in: validIds } });
    for (const entry of entries) {
      await softDelete({
        modelName: 'Diary',
        doc: entry,
        userId: req.user._id,
        userName: req.user.name || req.user.username
      });
    }
    await logActivity(req, 'diary_bulk_delete', { message: `Bulk-moved ${entries.length} diary entr${entries.length === 1 ? 'y' : 'ies'} to trash` });
    res.json({ deleted: entries.length });
  } catch (err) {
    res.status(500).json({ message: 'Failed to bulk delete diary entries' });
  }
});

router.post('/bulk-import', async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (rows.length === 0) return res.status(400).json({ message: 'No rows to import' });
    if (rows.length > 2000) return res.status(400).json({ message: 'Too many rows in a single import (max 2000)' });

    const failures = [];
    const toInsert = [];
    rows.forEach((row, idx) => {
      const { errors, clean } = validatePayload(row || {});
      if (errors.length) {
        failures.push({ row: idx + 1, name: row?.name || '', reason: errors[0] });
        return;
      }
      toInsert.push(new Diary({
        ...clean,
        createdBy: req.user._id,
        updatedBy: req.user._id
      }));
    });

    let inserted = [];
    if (toInsert.length) {
      try {
        inserted = await Diary.insertMany(toInsert, { ordered: false });
      } catch (bulkErr) {
        inserted = bulkErr.insertedDocs || [];
        (bulkErr.writeErrors || []).forEach(we => {
          failures.push({ row: '?', name: '', reason: we.errmsg || 'Database write error' });
        });
      }
    }

    await logActivity(req, 'diary_bulk_import', { message: `Bulk-imported ${inserted.length} diary entr${inserted.length === 1 ? 'y' : 'ies'}, ${failures.length} failed` });
    res.json({
      total: rows.length,
      created: inserted.length,
      failed: failures.length,
      failures
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to bulk import diary entries' });
  }
});

module.exports = router;
