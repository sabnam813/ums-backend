const mongoose = require('mongoose');
const express = require('express');
const Portal = require('../models/Portal');
const {
  verifyAccess,
  requirePermission,
  requireSuperAdmin
} = require('../middleware/auth');
const {
  softDelete
} = require('../utils/trashHelper');
const {
  logActivity
} = require('../utils/auditLogger');
const { isSafeUrl } = require('../utils/urlSafety');

const router = express.Router();
router.use(verifyAccess);

const MAX_NOTE_LEN = 1000;
const MAX_TEXT_LEN = 200;

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === String(id);
}

function clampStr(v, max = MAX_TEXT_LEN) {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, max);
}

function userDepartments(user) {
  if (user.departments && user.departments.length) return user.departments;
  if (user.department) return [user.department];
  return [];
}

// Row-level (department) visibility filter — separate from module-level RBAC.
function visibilityFilter(user) {
  if (['admin', 'super_admin'].includes(user.role)) return {};
  const depts = userDepartments(user);
  return { $or: [{ allDepartments: true }, { departments: { $in: depts } }] };
}

function canSeePortal(user, portal) {
  if (['admin', 'super_admin'].includes(user.role)) return true;
  if (portal.allDepartments) return true;
  const depts = userDepartments(user);
  return (portal.departments || []).some(d => depts.includes(d));
}

function normalizeDepartments(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map(d => clampStr(d, 100)).filter(Boolean))];
}

function validatePayload(body) {
  const errors = [];
  const name = clampStr(body.name, 150);
  if (!name) errors.push('Portal name is required');

  let url = clampStr(body.url, 2000);
  if (url && !isSafeUrl(url)) {
    errors.push('Site link must be a valid http:// or https:// URL');
    url = '';
  }

  const status = ['active', 'inactive'].includes(body.status) ? body.status : 'active';
  const allDepartments = body.allDepartments === true;
  const departments = allDepartments ? [] : normalizeDepartments(body.departments);

  return {
    errors,
    clean: {
      name,
      username: clampStr(body.username, 200),
      url,
      category: clampStr(body.category, 100),
      notes: clampStr(body.notes, MAX_NOTE_LEN),
      departments,
      allDepartments,
      status
    }
  };
}

// ---- Simple in-memory rate limiter for credential reveal (defense against
// scripted/bulk credential scraping even by an otherwise-authorized user). ----
const revealHits = new Map(); // userId -> [timestamps]
const REVEAL_WINDOW_MS = 5 * 60 * 1000;
const REVEAL_MAX = 30;

function rateLimitReveal(userId) {
  const now = Date.now();
  const key = String(userId);
  const hits = (revealHits.get(key) || []).filter(t => now - t < REVEAL_WINDOW_MS);
  if (hits.length >= REVEAL_MAX) return false;
  hits.push(now);
  revealHits.set(key, hits);
  return true;
}

// GET / — list (never includes credentials)
router.get('/', requirePermission('portal', 'view'), async (req, res) => {
  try {
    const { q, department, status } = req.query;
    const filter = { ...visibilityFilter(req.user) };

    if (status && ['active', 'inactive'].includes(status)) {
      filter.status = status;
    }
    if (department && typeof department === 'string') {
      const dept = clampStr(department, 100);
      filter.$and = (filter.$and || []).concat([{ $or: [{ allDepartments: true }, { departments: dept }] }]);
    }

    const portals = await Portal.find(filter).sort({ name: 1 }).lean();
    let list = portals.map(p => {
      const { passwordEncrypted, ...rest } = p;
      return { ...rest, hasPassword: !!passwordEncrypted };
    });

    if (q && String(q).trim()) {
      const needle = String(q).trim().toLowerCase();
      list = list.filter(p =>
        (p.name || '').toLowerCase().includes(needle) ||
        (p.username || '').toLowerCase().includes(needle) ||
        (p.url || '').toLowerCase().includes(needle) ||
        (p.category || '').toLowerCase().includes(needle)
      );
    }

    res.json({ portals: list });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch portals' });
  }
});

// POST / — create (super_admin only)
router.post('/', requireSuperAdmin, async (req, res) => {
  try {
    const { errors, clean } = validatePayload(req.body || {});
    if (errors.length) return res.status(400).json({ message: errors[0], errors });

    const portal = new Portal({
      ...clean,
      createdBy: req.user._id,
      updatedBy: req.user._id
    });
    if (req.body.password !== undefined && req.body.password !== '') {
      portal.setPassword(String(req.body.password).slice(0, 500));
    }
    await portal.save();
    await logActivity(req, 'portal_create', { targetType: 'Portal', targetId: portal._id, message: `Created portal "${portal.name}"` });
    res.status(201).json({ portal: portal.toSafeObject() });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Failed to create portal' });
  }
});

// PUT /:id — edit (super_admin only)
router.put('/:id', requireSuperAdmin, async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid portal id' });
    const portal = await Portal.findOne({ _id: req.params.id, ...visibilityFilter(req.user) });
    if (!portal) return res.status(404).json({ message: 'Portal not found' });

    const { errors, clean } = validatePayload(req.body || {});
    if (errors.length) return res.status(400).json({ message: errors[0], errors });

    Object.assign(portal, clean);
    portal.updatedBy = req.user._id;
    if (req.body.password !== undefined) {
      // Empty string explicitly clears the stored credential; omit the field to leave it unchanged.
      portal.setPassword(req.body.password ? String(req.body.password).slice(0, 500) : '');
    }
    await portal.save();
    await logActivity(req, 'portal_update', { targetType: 'Portal', targetId: portal._id, message: `Updated portal "${portal.name}"` });
    res.json({ portal: portal.toSafeObject() });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Failed to update portal' });
  }
});

// DELETE /:id — soft delete (trash) (super_admin only)
router.delete('/:id', requireSuperAdmin, async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid portal id' });
    const portal = await Portal.findOne({ _id: req.params.id, ...visibilityFilter(req.user) });
    if (!portal) return res.status(404).json({ message: 'Portal not found' });

    await softDelete({
      modelName: 'Portal',
      doc: portal,
      userId: req.user._id,
      userName: req.user.name || req.user.username
    });
    await logActivity(req, 'portal_delete', { targetType: 'Portal', targetId: portal._id, message: `Moved portal "${portal.name}" to trash` });
    res.json({ message: 'Moved to trash' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete portal' });
  }
});

// POST /:id/reveal — decrypt & return password (view permission + rate limited + audited)
router.post('/:id/reveal', requirePermission('portal', 'view'), async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid portal id' });
    if (!rateLimitReveal(req.user._id)) {
      return res.status(429).json({ message: 'Too many credential reveals. Please wait a few minutes and try again.' });
    }
    const portal = await Portal.findOne({ _id: req.params.id, ...visibilityFilter(req.user) });
    if (!portal) return res.status(404).json({ message: 'Portal not found' });

    const password = portal.getPassword();
    await logActivity(req, 'portal_reveal_password', { targetType: 'Portal', targetId: portal._id, message: `Viewed credentials for portal "${portal.name}"` });
    res.json({ username: portal.username, password });
  } catch (err) {
    res.status(500).json({ message: 'Failed to reveal credentials' });
  }
});

// POST /bulk-edit — department/status/category only (never bulk-overwrites credentials) (super_admin only)
router.post('/bulk-edit', requireSuperAdmin, async (req, res) => {
  try {
    const { ids, updates } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: 'No portals selected' });
    const validIds = ids.filter(isValidObjectId);
    if (validIds.length === 0) return res.status(400).json({ message: 'No valid portal ids provided' });

    const allowed = {};
    if (updates && typeof updates === 'object') {
      if (updates.status && ['active', 'inactive'].includes(updates.status)) allowed.status = updates.status;
      if (updates.category !== undefined) allowed.category = clampStr(updates.category, 100);
      if (updates.allDepartments !== undefined) {
        allowed.allDepartments = updates.allDepartments === true;
        allowed.departments = allowed.allDepartments ? [] : normalizeDepartments(updates.departments);
      } else if (updates.departments !== undefined) {
        allowed.departments = normalizeDepartments(updates.departments);
        allowed.allDepartments = false;
      }
    }
    if (Object.keys(allowed).length === 0) {
      return res.status(400).json({ message: 'No valid fields to update' });
    }
    allowed.updatedBy = req.user._id;

    const filter = { _id: { $in: validIds }, ...visibilityFilter(req.user) };
    const result = await Portal.updateMany(filter, { $set: allowed });
    await logActivity(req, 'portal_bulk_edit', { message: `Bulk-updated ${result.modifiedCount} portal(s)`, meta: { fields: Object.keys(allowed) } });
    res.json({ message: `Updated ${result.modifiedCount} portal(s)`, modifiedCount: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ message: 'Failed to bulk update portals' });
  }
});

// POST /bulk-import — array of rows (super_admin only)
router.post('/bulk-import', requireSuperAdmin, async (req, res) => {
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
      const doc = new Portal({
        ...clean,
        createdBy: req.user._id,
        updatedBy: req.user._id
      });
      if (row.password) doc.setPassword(String(row.password).slice(0, 500));
      toInsert.push(doc);
    });

    let inserted = [];
    if (toInsert.length) {
      try {
        inserted = await Portal.insertMany(toInsert, { ordered: false });
      } catch (bulkErr) {
        inserted = bulkErr.insertedDocs || [];
        (bulkErr.writeErrors || []).forEach(we => {
          failures.push({ row: '?', name: '', reason: we.errmsg || 'Database write error' });
        });
      }
    }

    await logActivity(req, 'portal_bulk_import', { message: `Bulk-imported ${inserted.length} portal(s), ${failures.length} failed` });
    res.json({
      total: rows.length,
      created: inserted.length,
      failed: failures.length,
      failures
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to bulk import portals' });
  }
});

module.exports = router;
