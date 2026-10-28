const mongoose = require('mongoose');
const express = require('express');
const TrainingSchedule = require('../models/TrainingSchedule');
const Department = require('../models/Department');
const {
  verifyAccess,
  requirePermission,
  requireSuperAdmin
} = require('../middleware/auth');
const {
  softDelete,
  softDeleteMany
} = require('../utils/trashHelper');
const {
  logActivity
} = require('../utils/auditLogger');

const router = express.Router();
router.use(verifyAccess);

const STATUS_VALUES = ['scheduled', 'completed', 'cancelled'];
const MODE_VALUES = ['physical', 'online', 'hybrid'];

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === String(id);
}

function clampStr(v, max = 200) {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, max);
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeTime(raw) {
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw === 'number' && isFinite(raw)) {
    const frac = raw >= 1 ? raw - Math.floor(raw) : raw;
    const mins = Math.round(frac * 24 * 60) % (24 * 60);
    return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  }
  const s = String(raw).trim().toLowerCase();
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/.exec(s);
  if (!m) return '';
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return '';
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function toMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function normalizeMode(v) {
  const s = String(v || '').trim().toLowerCase();
  return MODE_VALUES.includes(s) ? s : 'physical';
}

function normalizeStatus(v) {
  const s = String(v || '').trim().toLowerCase();
  return STATUS_VALUES.includes(s) ? s : 'scheduled';
}

async function resolveDepartmentId(value) {
  if (value === undefined || value === null || String(value).trim() === '') return { id: null, ok: true };
  const raw = String(value).trim();
  if (/^(all|all departments|everyone)$/i.test(raw)) return { id: null, ok: true };
  if (isValidObjectId(raw)) {
    const byId = await Department.findById(raw).select('_id');
    if (byId) return { id: String(byId._id), ok: true };
  }
  const byName = await Department.findOne({ name: new RegExp(`^${escapeRegex(raw)}$`, 'i') }).select('_id');
  return byName ? { id: String(byName._id), ok: true } : { id: null, ok: false };
}

function validatePayload(body) {
  const errors = [];
  const title = clampStr(body.title, 200);
  if (!title) errors.push('Title is required');

  const date = body.date ? new Date(body.date) : null;
  if (!date || isNaN(date.getTime())) errors.push('A valid date is required');

  const startTime = normalizeTime(body.startTime);
  const endTime = normalizeTime(body.endTime);
  if (startTime && endTime && toMinutes(endTime) <= toMinutes(startTime)) {
    errors.push('End time must be after start time');
  }

  return {
    errors,
    clean: {
      title,
      type: clampStr(body.type, 60) || 'Meeting',
      date,
      startTime,
      endTime,
      venue: clampStr(body.venue, 150),
      host: clampStr(body.host, 150),
      participants: clampStr(body.participants, 300),
      mode: normalizeMode(body.mode),
      meetingLink: clampStr(body.meetingLink, 500),
      agenda: clampStr(body.agenda, 1500),
      status: normalizeStatus(body.status)
    }
  };
}

function dayRange(date) {
  const start = new Date(date);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

async function findClashes(doc) {
  if (!doc.department || !doc.startTime || !doc.endTime || doc.status === 'cancelled') return [];
  const { start, end } = dayRange(doc.date);
  const others = await TrainingSchedule.find({
    _id: { $ne: doc._id },
    department: doc.department,
    status: { $ne: 'cancelled' },
    date: { $gte: start, $lt: end },
    startTime: { $ne: '' },
    endTime: { $ne: '' }
  }).select('title startTime endTime').lean();
  const s = toMinutes(doc.startTime);
  const e = toMinutes(doc.endTime);
  return others
    .filter(o => toMinutes(o.startTime) < e && s < toMinutes(o.endTime))
    .map(o => `${o.title} (${o.startTime}-${o.endTime})`);
}

router.get('/departments', requirePermission('trainingSchedule', 'view'), async (req, res) => {
  try {
    const departments = await Department.find().select('name').sort({ name: 1 }).lean();
    res.json({ departments });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch departments' });
  }
});

router.get('/', requirePermission('trainingSchedule', 'view'), async (req, res) => {
  try {
    const { q, department, type, status, mode, dateFrom, dateTo, limit = 2000 } = req.query;
    const clauses = [];

    if (department) {
      const ids = String(department).split(',').filter(Boolean);
      const wantsAll = ids.includes('all');
      const valid = ids.filter(isValidObjectId);
      const or = [];
      if (valid.length) or.push({ department: { $in: valid } });
      if (wantsAll) or.push({ department: null });
      if (or.length) clauses.push({ $or: or });
    }
    if (type) clauses.push({ type: new RegExp(`^${escapeRegex(String(type).trim())}$`, 'i') });
    if (status && STATUS_VALUES.includes(status)) clauses.push({ status });
    if (mode && MODE_VALUES.includes(mode)) clauses.push({ mode });

    if (dateFrom || dateTo) {
      const range = {};
      if (dateFrom) {
        const from = new Date(dateFrom);
        from.setUTCHours(0, 0, 0, 0);
        range.$gte = from;
      }
      if (dateTo) {
        const to = new Date(dateTo);
        to.setUTCHours(23, 59, 59, 999);
        range.$lte = to;
      }
      clauses.push({ date: range });
    }

    const query = clauses.length ? { $and: clauses } : {};

    let list = await TrainingSchedule.find(query)
      .sort({ date: -1, startTime: 1, createdAt: -1 })
      .limit(Number(limit))
      .populate('department', 'name')
      .populate('createdBy', 'username name')
      .lean();

    if (q && String(q).trim()) {
      const needle = String(q).trim().toLowerCase();
      list = list.filter(s =>
        (s.title || '').toLowerCase().includes(needle) ||
        (s.type || '').toLowerCase().includes(needle) ||
        (s.venue || '').toLowerCase().includes(needle) ||
        (s.host || '').toLowerCase().includes(needle) ||
        (s.participants || '').toLowerCase().includes(needle) ||
        (s.agenda || '').toLowerCase().includes(needle) ||
        (s.department?.name || 'all departments').toLowerCase().includes(needle)
      );
    }

    res.json({ schedules: list, total: list.length });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch training schedules' });
  }
});

router.post('/', requirePermission('trainingSchedule', 'create'), async (req, res) => {
  try {
    const { errors, clean } = validatePayload(req.body || {});
    if (errors.length) return res.status(400).json({ message: errors[0], errors });

    const dept = await resolveDepartmentId(req.body.department);
    if (!dept.ok) return res.status(400).json({ message: 'Department not found' });

    const schedule = await TrainingSchedule.create({
      ...clean,
      department: dept.id,
      createdBy: req.user._id,
      updatedBy: req.user._id
    });
    await schedule.populate('department', 'name');
    const clashes = await findClashes(schedule);
    await logActivity(req, 'trainingschedule_create', {
      targetType: 'TrainingSchedule',
      targetId: schedule._id,
      message: `Scheduled "${schedule.title}" for ${new Date(schedule.date).toLocaleDateString()}`
    });
    res.status(201).json({ schedule, clashes });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Failed to create training schedule' });
  }
});

router.put('/:id', requirePermission('trainingSchedule', 'edit'), async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid schedule id' });
    const schedule = await TrainingSchedule.findById(req.params.id);
    if (!schedule) return res.status(404).json({ message: 'Training schedule not found' });

    const { errors, clean } = validatePayload(req.body || {});
    if (errors.length) return res.status(400).json({ message: errors[0], errors });

    const dept = await resolveDepartmentId(req.body.department);
    if (!dept.ok) return res.status(400).json({ message: 'Department not found' });

    Object.assign(schedule, clean);
    schedule.department = dept.id;
    schedule.updatedBy = req.user._id;
    await schedule.save();
    await schedule.populate('department', 'name');
    const clashes = await findClashes(schedule);
    await logActivity(req, 'trainingschedule_update', {
      targetType: 'TrainingSchedule',
      targetId: schedule._id,
      message: `Updated training schedule "${schedule.title}"`
    });
    res.json({ schedule, clashes });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Failed to update training schedule' });
  }
});

router.delete('/bulk-delete', requireSuperAdmin, async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: 'No schedules selected' });
    const validIds = ids.filter(isValidObjectId);
    if (validIds.length === 0) return res.status(400).json({ message: 'No valid ids provided' });

    const docs = await TrainingSchedule.find({ _id: { $in: validIds } });
    await softDeleteMany({
      modelName: 'TrainingSchedule',
      docs,
      userId: req.user._id,
      userName: req.user.name || req.user.username
    });
    await logActivity(req, 'trainingschedule_bulk_delete', { message: `Bulk-moved ${docs.length} training schedule(s) to trash` });
    res.json({ deleted: docs.length });
  } catch (err) {
    res.status(500).json({ message: 'Failed to bulk delete training schedules' });
  }
});

router.delete('/:id', requireSuperAdmin, async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid schedule id' });
    const schedule = await TrainingSchedule.findById(req.params.id);
    if (!schedule) return res.status(404).json({ message: 'Training schedule not found' });

    await softDelete({
      modelName: 'TrainingSchedule',
      doc: schedule,
      userId: req.user._id,
      userName: req.user.name || req.user.username
    });
    await logActivity(req, 'trainingschedule_delete', {
      targetType: 'TrainingSchedule',
      targetId: schedule._id,
      message: `Moved training schedule "${schedule.title}" to trash`
    });
    res.json({ message: 'Moved to trash' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete training schedule' });
  }
});

router.post('/bulk-edit', requirePermission('trainingSchedule', 'bulkEdit'), async (req, res) => {
  try {
    const { ids, updates } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: 'No schedules selected' });
    const validIds = ids.filter(isValidObjectId);
    if (validIds.length === 0) return res.status(400).json({ message: 'No valid ids provided' });

    const allowed = {};
    if (updates && typeof updates === 'object') {
      if (updates.department !== undefined) {
        const dept = await resolveDepartmentId(updates.department);
        if (!dept.ok) return res.status(400).json({ message: 'Department not found' });
        allowed.department = dept.id;
      }
      if (updates.type !== undefined) allowed.type = clampStr(updates.type, 60) || 'Meeting';
      if (updates.venue !== undefined) allowed.venue = clampStr(updates.venue, 150);
      if (updates.host !== undefined) allowed.host = clampStr(updates.host, 150);
      if (updates.mode && MODE_VALUES.includes(updates.mode)) allowed.mode = updates.mode;
      if (updates.status && STATUS_VALUES.includes(updates.status)) allowed.status = updates.status;
      if (updates.agenda !== undefined) allowed.agenda = clampStr(updates.agenda, 1500);
    }
    if (Object.keys(allowed).length === 0) {
      return res.status(400).json({ message: 'No valid fields to update' });
    }
    allowed.updatedBy = req.user._id;

    const result = await TrainingSchedule.updateMany({ _id: { $in: validIds } }, { $set: allowed });
    await logActivity(req, 'trainingschedule_bulk_edit', {
      message: `Bulk-updated ${result.modifiedCount} training schedule(s)`,
      meta: { fields: Object.keys(allowed) }
    });
    res.json({ message: `Updated ${result.modifiedCount} schedule(s)`, modifiedCount: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ message: 'Failed to bulk update training schedules' });
  }
});

router.post('/bulk-import', requirePermission('trainingSchedule', 'import'), async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (rows.length === 0) return res.status(400).json({ message: 'No rows to import' });
    if (rows.length > 2000) return res.status(400).json({ message: 'Too many rows in a single import (max 2000)' });

    const failures = [];
    const prepared = [];
    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx] || {};
      const dept = await resolveDepartmentId(row.department);
      if (!dept.ok) {
        failures.push({ row: idx + 1, name: row.title || '', reason: `Department "${row.department}" not found` });
        continue;
      }
      const { errors, clean } = validatePayload(row);
      if (errors.length) {
        failures.push({ row: idx + 1, name: row.title || '', reason: errors[0] });
        continue;
      }
      prepared.push({ idx, doc: { ...clean, department: dept.id } });
    }

    const keyOf = d => [
      String(d.title).toLowerCase(),
      new Date(d.date).toISOString().slice(0, 10),
      d.startTime || '',
      d.department ? String(d.department) : ''
    ].join('|');

    const seen = new Set();
    if (prepared.length) {
      const times = prepared.map(p => new Date(p.doc.date).getTime());
      const existing = await TrainingSchedule.find({
        date: { $gte: new Date(Math.min(...times) - 86400000), $lte: new Date(Math.max(...times) + 86400000) }
      }).select('title date startTime department').lean();
      existing.forEach(e => seen.add(keyOf(e)));
    }

    const toInsert = [];
    prepared.forEach(({ idx, doc }) => {
      const key = keyOf(doc);
      if (seen.has(key)) {
        failures.push({ row: idx + 1, name: doc.title, reason: 'Duplicate (same title, date, start time and department)' });
        return;
      }
      seen.add(key);
      toInsert.push(new TrainingSchedule({
        ...doc,
        createdBy: req.user._id,
        updatedBy: req.user._id
      }));
    });

    let inserted = [];
    if (toInsert.length) {
      try {
        inserted = await TrainingSchedule.insertMany(toInsert, { ordered: false });
      } catch (bulkErr) {
        inserted = bulkErr.insertedDocs || [];
        (bulkErr.writeErrors || []).forEach(we => {
          failures.push({ row: '?', name: '', reason: we.errmsg || 'Database write error' });
        });
      }
    }

    await logActivity(req, 'trainingschedule_bulk_import', { message: `Bulk-imported ${inserted.length} training schedule(s), ${failures.length} skipped` });
    res.json({
      total: rows.length,
      created: inserted.length,
      failed: failures.length,
      failures
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to bulk import training schedules' });
  }
});

module.exports = router;
