const mongoose = require('mongoose');
const express = require('express');
const HallBooking = require('../models/HallBooking');
const Country = require('../models/Country');
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

const MAX_TEXT_LEN = 200;
const MAX_REMARKS_LEN = 1000;
const STATUS_VALUES = ['scheduled', 'completed', 'cancelled'];
const EVENT_TYPES = ['country', 'general'];
const VISIBILITY_MODES = ['everyone', 'specific', 'private'];

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === String(id);
}

function clampStr(v, max = MAX_TEXT_LEN) {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, max);
}

/**
 * Builds { mode, allowedUsers } from whatever shape the client sent
 * (nested object or flat visibilityMode/visibilityUsers fields), defaulting
 * to the old always-visible behaviour when nothing is provided.
 */
function parseVisibility(body) {
  const raw = body.visibility || {};
  const mode = VISIBILITY_MODES.includes(raw.mode || body.visibilityMode)
    ? (raw.mode || body.visibilityMode)
    : 'everyone';
  const rawUsers = Array.isArray(raw.allowedUsers) ? raw.allowedUsers
    : Array.isArray(body.visibilityUsers) ? body.visibilityUsers
    : [];
  const allowedUsers = mode === 'specific' ? rawUsers.filter(isValidObjectId) : [];
  return { mode, allowedUsers };
}

/**
 * A booking is visible to req.user when: they're super_admin, they created
 * it, visibility is 'everyone' (or unset, for bookings created before this
 * feature existed), or visibility is 'specific' and they're in the list.
 * 'private' bookings are visible only to their creator and super_admin.
 */
function visibilityFilter(user) {
  if (user.role === 'super_admin') return null;
  return {
    $or: [
      { 'visibility.mode': { $exists: false } },
      { 'visibility.mode': 'everyone' },
      { createdBy: user._id },
      { 'visibility.mode': 'specific', 'visibility.allowedUsers': user._id }
    ]
  };
}

async function resolveCountryId(value) {
  if (!value) return null;
  if (isValidObjectId(value)) {
    const byId = await Country.findById(value).select('_id');
    if (byId) return String(byId._id);
  }
  const byName = await Country.findOne({ name: new RegExp(`^${String(value).trim()}$`, 'i') }).select('_id');
  return byName ? String(byName._id) : null;
}

function validatePayload(body) {
  const errors = [];
  const hall = clampStr(body.hall, 100);
  if (!hall) errors.push('Hall / room is required');

  let date = body.date ? new Date(body.date) : null;
  if (!date || isNaN(date.getTime())) errors.push('A valid date is required');

  const status = STATUS_VALUES.includes(body.status) ? body.status : 'scheduled';
  const eventType = EVENT_TYPES.includes(body.eventType) ? body.eventType : 'country';
  const eventTitle = clampStr(body.eventTitle, 200);
  if (eventType === 'general' && !eventTitle) errors.push('Event title is required for a general event');

  return {
    errors,
    clean: {
      date,
      hall,
      time: clampStr(body.time, 100),
      institution: clampStr(body.institution, 200),
      representativeName: clampStr(body.representativeName, 150),
      designation: clampStr(body.designation, 150),
      remarks: clampStr(body.remarks, MAX_REMARKS_LEN),
      status,
      eventType,
      eventTitle,
      visibility: parseVisibility(body)
    }
  };
}

// GET /countries — every country in the system, gated only by hallBooking
// access (not by the requester's own assigned countries). This module is
// permission-only: once granted, a user sees and books against every
// country, the same as a super admin would.
router.get('/countries', requirePermission('hallBooking', 'view'), async (req, res) => {
  try {
    const countries = await Country.find().select('name flag code').sort({ name: 1 });
    res.json({ countries });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch countries' });
  }
});

// GET / — list every hall booking (no country restriction; permission-gated,
// then narrowed by visibility so a private/specific booking only shows to
// who it's meant for; super_admin always sees everything)
router.get('/', requirePermission('hallBooking', 'view'), async (req, res) => {
  try {
    const { q, country, hall, status, dateFrom, dateTo, eventType, limit = 1000 } = req.query;
    const clauses = [];

    if (country) {
      const requested = String(country).split(',').filter(Boolean);
      if (requested.length) clauses.push({ country: { $in: requested } });
    }

    if (hall) clauses.push({ hall: new RegExp(String(hall).trim(), 'i') });
    if (status && STATUS_VALUES.includes(status)) clauses.push({ status });
    if (eventType && EVENT_TYPES.includes(eventType)) clauses.push({ eventType });

    if (dateFrom || dateTo) {
      const range = {};
      if (dateFrom) range.$gte = new Date(dateFrom);
      if (dateTo) range.$lte = new Date(dateTo);
      clauses.push({ date: range });
    }

    const vFilter = visibilityFilter(req.user);
    if (vFilter) clauses.push(vFilter);

    const query = clauses.length ? { $and: clauses } : {};

    let list = await HallBooking.find(query)
      .sort({ date: -1, createdAt: -1 })
      .limit(Number(limit))
      .populate('country', 'name flag code')
      .populate('visibility.allowedUsers', 'username name')
      .populate('createdBy', 'username name')
      .lean();

    if (q && String(q).trim()) {
      const needle = String(q).trim().toLowerCase();
      list = list.filter(b =>
        (b.hall || '').toLowerCase().includes(needle) ||
        (b.institution || '').toLowerCase().includes(needle) ||
        (b.representativeName || '').toLowerCase().includes(needle) ||
        (b.designation || '').toLowerCase().includes(needle) ||
        (b.eventTitle || '').toLowerCase().includes(needle) ||
        (b.remarks || '').toLowerCase().includes(needle) ||
        (b.country?.name || '').toLowerCase().includes(needle)
      );
    }

    res.json({ bookings: list, total: list.length });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch hall bookings' });
  }
});

// POST / — create. Country is required for a 'country' event, optional
// (and ignored) for a 'general' one.
router.post('/', requirePermission('hallBooking', 'create'), async (req, res) => {
  try {
    const eventType = EVENT_TYPES.includes(req.body.eventType) ? req.body.eventType : 'country';
    let countryId = null;
    if (eventType === 'country') {
      countryId = await resolveCountryId(req.body.country || req.body.countryId);
      if (!countryId) return res.status(400).json({ message: 'A valid country is required' });
    }

    const { errors, clean } = validatePayload(req.body || {});
    if (errors.length) return res.status(400).json({ message: errors[0], errors });

    const booking = await HallBooking.create({
      ...clean,
      country: countryId,
      createdBy: req.user._id,
      updatedBy: req.user._id
    });
    await booking.populate('country', 'name flag code');
    await booking.populate('visibility.allowedUsers', 'username name');
    await logActivity(req, 'hallbooking_create', {
      targetType: 'HallBooking',
      targetId: booking._id,
      message: `Booked "${booking.hall}" for ${new Date(booking.date).toLocaleDateString()}`
    });
    res.status(201).json({ booking });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Failed to create hall booking' });
  }
});

// PUT /:id — edit
router.put('/:id', requirePermission('hallBooking', 'edit'), async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid booking id' });
    const booking = await HallBooking.findById(req.params.id);
    if (!booking) return res.status(404).json({ message: 'Hall booking not found' });

    const { errors, clean } = validatePayload(req.body || {});
    if (errors.length) return res.status(400).json({ message: errors[0], errors });

    let countryId = booking.country ? String(booking.country) : null;
    if (clean.eventType === 'general') {
      countryId = null;
    } else if (req.body.country || req.body.countryId) {
      const resolved = await resolveCountryId(req.body.country || req.body.countryId);
      if (!resolved) return res.status(400).json({ message: 'A valid country is required' });
      countryId = resolved;
    } else if (!countryId) {
      return res.status(400).json({ message: 'A valid country is required' });
    }

    Object.assign(booking, clean);
    booking.country = countryId;
    booking.updatedBy = req.user._id;
    await booking.save();
    await booking.populate('country', 'name flag code');
    await booking.populate('visibility.allowedUsers', 'username name');
    await logActivity(req, 'hallbooking_update', {
      targetType: 'HallBooking',
      targetId: booking._id,
      message: `Updated hall booking "${booking.hall}"`
    });
    res.json({ booking });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Failed to update hall booking' });
  }
});

// DELETE /bulk-delete — Super Admin only. Registered BEFORE the /:id route
// below on purpose: Express matches routes in registration order, and /:id
// would otherwise swallow this request (treating "bulk-delete" as the id).
router.delete('/bulk-delete', requireSuperAdmin, async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: 'No bookings selected' });
    const validIds = ids.filter(isValidObjectId);
    if (validIds.length === 0) return res.status(400).json({ message: 'No valid booking ids provided' });

    const bookings = await HallBooking.find({ _id: { $in: validIds } });
    await softDeleteMany({
      modelName: 'HallBooking',
      docs: bookings,
      userId: req.user._id,
      userName: req.user.name || req.user.username
    });
    await logActivity(req, 'hallbooking_bulk_delete', { message: `Bulk-moved ${bookings.length} hall booking(s) to trash` });
    res.json({ deleted: bookings.length });
  } catch (err) {
    res.status(500).json({ message: 'Failed to bulk delete hall bookings' });
  }
});

// DELETE /:id — soft delete (trash); Super Admin only, regardless of any
// hallBooking.delete permission that may be stored — this module intentionally
// never lets a granted permission enable deletion.
router.delete('/:id', requireSuperAdmin, async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid booking id' });
    const booking = await HallBooking.findById(req.params.id);
    if (!booking) return res.status(404).json({ message: 'Hall booking not found' });

    await softDelete({
      modelName: 'HallBooking',
      doc: booking,
      userId: req.user._id,
      userName: req.user.name || req.user.username
    });
    await logActivity(req, 'hallbooking_delete', {
      targetType: 'HallBooking',
      targetId: booking._id,
      message: `Moved hall booking "${booking.hall}" to trash`
    });
    res.json({ message: 'Moved to trash' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete hall booking' });
  }
});

// POST /bulk-edit — hall/time/status/remarks only (country & date left untouched)
router.post('/bulk-edit', requirePermission('hallBooking', 'bulkEdit'), async (req, res) => {
  try {
    const { ids, updates } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: 'No bookings selected' });
    const validIds = ids.filter(isValidObjectId);
    if (validIds.length === 0) return res.status(400).json({ message: 'No valid booking ids provided' });

    const allowed = {};
    if (updates && typeof updates === 'object') {
      if (updates.hall !== undefined) allowed.hall = clampStr(updates.hall, 100);
      if (updates.time !== undefined) allowed.time = clampStr(updates.time, 100);
      if (updates.status && STATUS_VALUES.includes(updates.status)) allowed.status = updates.status;
      if (updates.remarks !== undefined) allowed.remarks = clampStr(updates.remarks, MAX_REMARKS_LEN);
    }
    if (Object.keys(allowed).length === 0) {
      return res.status(400).json({ message: 'No valid fields to update' });
    }
    allowed.updatedBy = req.user._id;

    const result = await HallBooking.updateMany({ _id: { $in: validIds } }, { $set: allowed });
    await logActivity(req, 'hallbooking_bulk_edit', {
      message: `Bulk-updated ${result.modifiedCount} hall booking(s)`,
      meta: { fields: Object.keys(allowed) }
    });
    res.json({ message: `Updated ${result.modifiedCount} booking(s)`, modifiedCount: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ message: 'Failed to bulk update hall bookings' });
  }
});

// POST /bulk-import — array of rows, country resolved by name/code
router.post('/bulk-import', requirePermission('hallBooking', 'import'), async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (rows.length === 0) return res.status(400).json({ message: 'No rows to import' });
    if (rows.length > 2000) return res.status(400).json({ message: 'Too many rows in a single import (max 2000)' });

    const failures = [];
    const toInsert = [];
    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx] || {};
      const countryId = await resolveCountryId(row.country || row.countryId);
      if (!countryId) {
        failures.push({ row: idx + 1, name: row?.hall || '', reason: `Country "${row.country || ''}" not found` });
        continue;
      }
      const { errors, clean } = validatePayload(row);
      if (errors.length) {
        failures.push({ row: idx + 1, name: row?.hall || '', reason: errors[0] });
        continue;
      }
      toInsert.push(new HallBooking({
        ...clean,
        country: countryId,
        createdBy: req.user._id,
        updatedBy: req.user._id
      }));
    }

    let inserted = [];
    if (toInsert.length) {
      try {
        inserted = await HallBooking.insertMany(toInsert, { ordered: false });
      } catch (bulkErr) {
        inserted = bulkErr.insertedDocs || [];
        (bulkErr.writeErrors || []).forEach(we => {
          failures.push({ row: '?', name: '', reason: we.errmsg || 'Database write error' });
        });
      }
    }

    await logActivity(req, 'hallbooking_bulk_import', { message: `Bulk-imported ${inserted.length} hall booking(s), ${failures.length} failed` });
    res.json({
      total: rows.length,
      created: inserted.length,
      failed: failures.length,
      failures
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to bulk import hall bookings' });
  }
});

module.exports = router;
