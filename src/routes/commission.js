const mongoose = require('mongoose');
const express = require('express');
const CommissionIntake = require('../models/CommissionIntake');
const CommissionRate = require('../models/CommissionRate');
const CommissionDepartment = require('../models/CommissionDepartment');
const CommissionNote = require('../models/CommissionNote');
const Country = require('../models/Country');
const {
  verifyAccess,
  requireSuperAdmin
} = require('../middleware/auth');
const { hasPermission } = require('../config/rbac');
const { logActivity } = require('../utils/auditLogger');
const { pinUnlocked, verifyPin, loadPinState, needsPin, PIN_RE } = require('../utils/commissionPin');
const { softDelete, softDeleteMany } = require('../utils/trashHelper');

const router = express.Router();
router.use(verifyAccess);

const SECTIONS = ['associate', 'shareholder', 'department'];
const SECTION_MODULE = {
  associate: 'commissionAssociate',
  shareholder: 'commissionShareholder',
  department: 'commissionDepartment'
};

function sectionModel(section) {
  return section === 'department' ? CommissionDepartment : CommissionRate;
}

function clampStr(v, max) {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, max);
}

function countryScope(user) {
  if (user.role === 'super_admin') return null;
  if (user.allCountries) return null;
  const ids = (user.countries || [])
    .map(c => (c && c._id ? c._id : c))
    .filter(Boolean)
    .map(String)
    .filter(mongoose.Types.ObjectId.isValid)
    .map(id => new mongoose.Types.ObjectId(id));
  return { country: { $in: ids } };
}

function canSeeCountry(user, countryId) {
  const scope = countryScope(user);
  if (!scope) return true;
  return scope.country.$in.some(id => String(id) === String(countryId));
}

function hasAnyCommissionPermission(user, action = 'access') {
  return SECTIONS.some(s => hasPermission(user, SECTION_MODULE[s], action));
}

function requireSectionPermission(action) {
  return async (req, res, next) => {
    const section = req.query.section || req.body.section;
    if (!SECTIONS.includes(section)) {
      return res.status(400).json({ message: 'A valid section (associate, shareholder or department) is required' });
    }
    if (!hasPermission(req.user, SECTION_MODULE[section], action)) {
      return res.status(403).json({ message: `You do not have permission to ${action} this section.` });
    }
    try {
      if (!(await pinUnlocked(req, section))) {
        return res.status(403).json({ message: 'PIN required', code: 'PIN_REQUIRED' });
      }
    } catch (err) {
      return res.status(500).json({ message: 'PIN check failed' });
    }
    req.commissionSection = section;
    next();
  };
}

router.get('/pin/status', async (req, res) => {
  try {
    const section = req.query.section;
    if (!SECTIONS.includes(section)) return res.status(400).json({ message: 'Invalid section' });
    if (!needsPin(req.user, section)) return res.json({ required: false, unlocked: true, isSet: true });
    const state = await loadPinState();
    res.json({ required: true, isSet: !!state.hash, unlocked: await pinUnlocked(req, section) });
  } catch (err) {
    res.status(500).json({ message: 'PIN check failed' });
  }
});

router.post('/pin/verify', async (req, res) => {
  try {
    if (!hasPermission(req.user, 'commissionAssociate', 'view') && !hasPermission(req.user, 'commissionShareholder', 'view')) {
      return res.status(403).json({ message: 'Access denied' });
    }
    const pin = String(req.body.pin || '');
    if (!PIN_RE.test(pin)) return res.status(400).json({ message: 'Enter a valid PIN' });
    const result = await verifyPin(req.user, pin);
    if (result.locked) return res.status(429).json({ message: `Too many attempts. Try again in ${result.wait}s` });
    if (result.notSet) return res.status(409).json({ message: 'PIN is not set. Contact super admin' });
    if (!result.ok) return res.status(401).json({ message: 'Incorrect PIN' });
    res.json({ token: result.token });
  } catch (err) {
    res.status(500).json({ message: 'PIN check failed' });
  }
});

router.get('/intakes', async (req, res) => {
  try {
    if (!hasAnyCommissionPermission(req.user, 'access')) {
      return res.status(403).json({ message: 'You do not have permission to access Commission.' });
    }
    const intakes = await CommissionIntake.find().sort({ createdAt: -1 });
    res.json({ intakes });
  } catch (err) {
    console.error('Failed to fetch commission intakes:', err);
    res.status(500).json({ message: 'Failed to fetch intakes' });
  }
});

router.post('/intakes', async (req, res) => {
  try {
    if (!hasAnyCommissionPermission(req.user, 'create')) {
      return res.status(403).json({ message: 'You do not have permission to create an intake.' });
    }
    const name = clampStr(req.body.name, 150);
    if (!name) return res.status(400).json({ message: 'Intake name is required' });

    const existing = await CommissionIntake.findOne({ name }).collation({ locale: 'en', strength: 2 });
    if (existing) return res.status(409).json({ message: 'An intake with this name already exists' });

    const intake = await CommissionIntake.create({ name, createdBy: req.user._id });
    await logActivity(req, 'commission_intake_create', { message: `Created commission intake "${name}"` });
    res.status(201).json({ intake });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'An intake with this name already exists' });
    console.error('Failed to create commission intake:', err);
    res.status(500).json({ message: 'Failed to create intake' });
  }
});

router.delete('/intakes/:id', requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid intake id' });
    const intake = await CommissionIntake.findById(id);
    if (!intake) return res.status(404).json({ message: 'Intake not found' });

    const [ratesDeleted, deptDeleted, notesDeleted] = await Promise.all([
      CommissionRate.deleteMany({ intake: id }),
      CommissionDepartment.deleteMany({ intake: id }),
      CommissionNote.deleteMany({ intake: id })
    ]);
    await intake.deleteOne();

    await logActivity(req, 'commission_intake_delete', {
      message: `Deleted commission intake "${intake.name}" (${ratesDeleted.deletedCount} rate rows, ${deptDeleted.deletedCount} department rows, ${notesDeleted.deletedCount} notes)`
    });
    res.json({ message: 'Intake deleted' });
  } catch (err) {
    console.error('Failed to delete commission intake:', err);
    res.status(500).json({ message: 'Failed to delete intake' });
  }
});

router.get('/countries', async (req, res) => {
  try {
    if (!hasAnyCommissionPermission(req.user, 'access')) {
      return res.status(403).json({ message: 'You do not have permission to access Commission.' });
    }
    const scope = countryScope(req.user);
    const query = scope ? { _id: scope.country } : {};
    const countries = await Country.find(query).select('name flag flagImage code').sort({ name: 1 });

    const sectionAccess = {
      associate: hasPermission(req.user, 'commissionAssociate', 'view'),
      shareholder: hasPermission(req.user, 'commissionShareholder', 'view'),
      department: hasPermission(req.user, 'commissionDepartment', 'view')
    };

    const countryIds = countries.map(c => c._id);
    if (!mongoose.Types.ObjectId.isValid(req.query.intake)) {
      return res.status(400).json({ message: 'Invalid intake id' });
    }
    const [rateCounts, deptCounts] = await Promise.all([
      CommissionRate.aggregate([
        { $match: { intake: new mongoose.Types.ObjectId(req.query.intake), country: { $in: countryIds } } },
        { $group: { _id: { country: '$country', section: '$section' }, count: { $sum: 1 } } }
      ]),
      CommissionDepartment.aggregate([
        { $match: { intake: new mongoose.Types.ObjectId(req.query.intake), country: { $in: countryIds } } },
        { $group: { _id: '$country', count: { $sum: 1 } } }
      ])
    ]);

    const countMap = {};
    rateCounts.forEach(r => {
      const key = String(r._id.country);
      if (!countMap[key]) countMap[key] = {};
      countMap[key][r._id.section] = r.count;
    });
    deptCounts.forEach(r => {
      const key = String(r._id);
      if (!countMap[key]) countMap[key] = {};
      countMap[key].department = r.count;
    });

    const result = countries.map(c => {
      const counts = countMap[String(c._id)] || {};
      return {
        _id: c._id,
        name: c.name,
        flag: c.flag,
        flagImage: c.flagImage,
        code: c.code,
        sections: {
          associate: { visible: sectionAccess.associate, count: sectionAccess.associate ? (counts.associate || 0) : 0 },
          shareholder: { visible: sectionAccess.shareholder, count: sectionAccess.shareholder ? (counts.shareholder || 0) : 0 },
          department: { visible: sectionAccess.department, count: sectionAccess.department ? (counts.department || 0) : 0 }
        }
      };
    });

    res.json({ countries: result });
  } catch (err) {
    console.error('Failed to fetch commission countries:', err);
    res.status(500).json({ message: 'Failed to fetch countries' });
  }
});

router.get('/notes', requireSectionPermission('view'), async (req, res) => {
  try {
    const { intake, country, section } = req.query;
    if (!mongoose.Types.ObjectId.isValid(intake) || !mongoose.Types.ObjectId.isValid(country)) {
      return res.status(400).json({ message: 'Invalid intake or country id' });
    }
    if (!canSeeCountry(req.user, country)) {
      return res.status(403).json({ message: 'Access denied to this country' });
    }
    const note = await CommissionNote.findOne({ intake, country, section });
    res.json({ note: note || { headerNote: '', footerNote: '' } });
  } catch (err) {
    console.error('Failed to fetch commission note:', err);
    res.status(500).json({ message: 'Failed to fetch note' });
  }
});

router.put('/notes', requireSectionPermission('edit'), async (req, res) => {
  try {
    const { intake, country, section } = req.body;
    if (!mongoose.Types.ObjectId.isValid(intake) || !mongoose.Types.ObjectId.isValid(country)) {
      return res.status(400).json({ message: 'Invalid intake or country id' });
    }
    if (!canSeeCountry(req.user, country)) {
      return res.status(403).json({ message: 'Access denied to this country' });
    }
    const headerNote = clampStr(req.body.headerNote, 4000);
    const footerNote = clampStr(req.body.footerNote, 4000);

    const note = await CommissionNote.findOneAndUpdate(
      { intake, country, section },
      { headerNote, footerNote, updatedBy: req.user._id },
      { new: true, upsert: true }
    );
    await logActivity(req, 'commission_note_update', { message: `Updated ${section} note` });
    res.json({ note });
  } catch (err) {
    console.error('Failed to update commission note:', err);
    res.status(500).json({ message: 'Failed to update note' });
  }
});

router.get('/rows', requireSectionPermission('view'), async (req, res) => {
  try {
    const { intake, country, search } = req.query;
    const section = req.commissionSection;
    if (!mongoose.Types.ObjectId.isValid(intake) || !mongoose.Types.ObjectId.isValid(country)) {
      return res.status(400).json({ message: 'Invalid intake or country id' });
    }
    if (!canSeeCountry(req.user, country)) {
      return res.status(403).json({ message: 'Access denied to this country' });
    }

    const Model = sectionModel(section);
    const query = section === 'department'
      ? { intake, country }
      : { intake, country, section };

    if (search) {
      const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = section === 'department'
        ? [{ university: rx }, { channelPartner: rx }]
        : section === 'shareholder'
          ? [{ university: rx }, { partner: rx }, { undergraduate: rx }, { postgraduate: rx }, { remarks: rx }]
          : [{ university: rx }, { undergraduate: rx }, { postgraduate: rx }, { remarks: rx }];
    }

    const rows = await Model.find(query).sort({ order: 1, createdAt: 1 }).limit(3000);
    res.json({ rows, total: rows.length });
  } catch (err) {
    console.error('Failed to fetch commission rows:', err);
    res.status(500).json({ message: 'Failed to fetch rows' });
  }
});

router.post('/rows', requireSectionPermission('create'), async (req, res) => {
  try {
    const section = req.commissionSection;
    const { intake, country } = req.body;
    if (!mongoose.Types.ObjectId.isValid(intake) || !mongoose.Types.ObjectId.isValid(country)) {
      return res.status(400).json({ message: 'Invalid intake or country id' });
    }
    if (!canSeeCountry(req.user, country)) {
      return res.status(403).json({ message: 'Access denied to this country' });
    }
    const university = clampStr(req.body.university, 300);
    if (!university) return res.status(400).json({ message: 'Name is required' });

    const Model = sectionModel(section);
    const matchQuery = section === 'department' ? { intake, country } : { intake, country, section };
    const maxOrderDoc = await Model.findOne(matchQuery).sort({ order: -1 }).select('order');
    const order = (maxOrderDoc?.order || 0) + 1;

    let doc;
    if (section === 'department') {
      const directIndirect = ['Direct', 'Indirect'].includes(req.body.directIndirect) ? req.body.directIndirect : 'Direct';
      doc = await CommissionDepartment.create({
        intake, country, university,
        channelPartner: clampStr(req.body.channelPartner, 200),
        directIndirect,
        order,
        createdBy: req.user._id,
        updatedBy: req.user._id
      });
    } else {
      doc = await CommissionRate.create({
        intake, country, section, university,
        partner: section === 'shareholder' ? clampStr(req.body.partner, 300) : '',
        undergraduate: clampStr(req.body.undergraduate, 2000),
        postgraduate: clampStr(req.body.postgraduate, 2000),
        remarks: clampStr(req.body.remarks, 1000),
        order,
        createdBy: req.user._id,
        updatedBy: req.user._id
      });
    }

    await logActivity(req, 'commission_row_create', { message: `Added ${university} to ${section}` });
    res.status(201).json({ row: doc });
  } catch (err) {
    console.error('Failed to create commission row:', err);
    res.status(500).json({ message: 'Failed to create row' });
  }
});

router.put('/rows/:id', requireSectionPermission('edit'), async (req, res) => {
  try {
    const section = req.commissionSection;
    const Model = sectionModel(section);
    const doc = await Model.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Row not found' });
    if (section !== 'department' && doc.section !== section) {
      return res.status(400).json({ message: 'Section mismatch' });
    }
    if (!canSeeCountry(req.user, doc.country)) {
      return res.status(403).json({ message: 'Access denied to this country' });
    }

    if (req.body.university !== undefined) doc.university = clampStr(req.body.university, 300);

    if (section === 'department') {
      if (req.body.channelPartner !== undefined) doc.channelPartner = clampStr(req.body.channelPartner, 200);
      if (req.body.directIndirect !== undefined && ['Direct', 'Indirect'].includes(req.body.directIndirect)) {
        doc.directIndirect = req.body.directIndirect;
      }
    } else {
      if (section === 'shareholder' && req.body.partner !== undefined) doc.partner = clampStr(req.body.partner, 300);
      if (req.body.undergraduate !== undefined) doc.undergraduate = clampStr(req.body.undergraduate, 2000);
      if (req.body.postgraduate !== undefined) doc.postgraduate = clampStr(req.body.postgraduate, 2000);
      if (req.body.remarks !== undefined) doc.remarks = clampStr(req.body.remarks, 1000);
    }
    doc.updatedBy = req.user._id;
    await doc.save();

    await logActivity(req, 'commission_row_update', { message: `Updated ${doc.university} in ${section}` });
    res.json({ row: doc });
  } catch (err) {
    console.error('Failed to update commission row:', err);
    res.status(500).json({ message: 'Failed to update row' });
  }
});

router.post('/rows/bulk-edit', requireSectionPermission('edit'), async (req, res) => {
  try {
    const section = req.commissionSection;
    const { ids, updates } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: 'No rows selected' });
    const validIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));
    if (validIds.length === 0) return res.status(400).json({ message: 'No valid row ids provided' });

    const Model = sectionModel(section);
    const docs = await Model.find({ _id: { $in: validIds } });
    const forbidden = docs.some(d => !canSeeCountry(req.user, d.country) || (section !== 'department' && d.section !== section));
    if (forbidden) return res.status(403).json({ message: 'Access denied to one or more selected rows' });
    const safeIds = docs.map(d => d._id);
    if (safeIds.length === 0) return res.status(404).json({ message: 'Rows not found' });

    const allowed = {};
    if (updates && typeof updates === 'object') {
      if (section === 'department') {
        if (updates.channelPartner !== undefined) allowed.channelPartner = clampStr(updates.channelPartner, 200);
        if (updates.directIndirect && ['Direct', 'Indirect'].includes(updates.directIndirect)) {
          allowed.directIndirect = updates.directIndirect;
        }
      } else {
        if (section === 'shareholder' && updates.partner !== undefined) allowed.partner = clampStr(updates.partner, 300);
        if (updates.undergraduate !== undefined) allowed.undergraduate = clampStr(updates.undergraduate, 2000);
        if (updates.postgraduate !== undefined) allowed.postgraduate = clampStr(updates.postgraduate, 2000);
        if (updates.remarks !== undefined) allowed.remarks = clampStr(updates.remarks, 1000);
      }
    }
    if (Object.keys(allowed).length === 0) return res.status(400).json({ message: 'No valid fields to update' });
    allowed.updatedBy = req.user._id;

    const result = await Model.updateMany({ _id: { $in: safeIds } }, { $set: allowed });
    await logActivity(req, 'commission_bulk_edit', { message: `Bulk-edited ${result.modifiedCount} ${section} row(s)` });
    res.json({ updated: result.modifiedCount });
  } catch (err) {
    console.error('Failed to bulk edit commission rows:', err);
    res.status(500).json({ message: 'Failed to bulk edit rows' });
  }
});

router.post('/rows/bulk-delete', requireSectionPermission('delete'), async (req, res) => {
  try {
    const section = req.commissionSection;
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: 'No rows selected' });
    const validIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));
    if (validIds.length === 0) return res.status(400).json({ message: 'No valid row ids provided' });

    const Model = sectionModel(section);
    const modelName = section === 'department' ? 'CommissionDepartment' : 'CommissionRate';
    const docs = await Model.find({ _id: { $in: validIds } });
    const forbidden = docs.some(d => !canSeeCountry(req.user, d.country) || (section !== 'department' && d.section !== section));
    if (forbidden) return res.status(403).json({ message: 'Access denied to one or more selected rows' });

    await softDeleteMany({
      modelName,
      docs,
      userId: req.user._id,
      userName: req.user.name || req.user.username,
      metaFor: doc => ({ university: doc.university, section })
    });

    await logActivity(req, 'commission_bulk_delete', { message: `Bulk-deleted ${docs.length} ${section} row(s)` });
    res.json({ deleted: docs.length });
  } catch (err) {
    console.error('Failed to bulk delete commission rows:', err);
    res.status(500).json({ message: 'Failed to bulk delete rows' });
  }
});

router.post('/rows/bulk-import', requireSectionPermission('import'), async (req, res) => {
  try {
    const section = req.commissionSection;
    const { intake, country, rows } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(intake) || !mongoose.Types.ObjectId.isValid(country)) {
      return res.status(400).json({ message: 'Invalid intake or country id' });
    }
    if (!canSeeCountry(req.user, country)) {
      return res.status(403).json({ message: 'Access denied to this country' });
    }
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ message: 'No rows to import' });
    if (rows.length > 2000) return res.status(400).json({ message: 'Too many rows in a single import (max 2000)' });

    const Model = sectionModel(section);
    const matchQuery = section === 'department' ? { intake, country } : { intake, country, section };
    const maxOrderDoc = await Model.findOne(matchQuery).sort({ order: -1 }).select('order');
    let nextOrder = (maxOrderDoc?.order || 0) + 1;

    const existing = await Model.find(matchQuery).select('university');
    const existingByName = new Map(existing.map(d => [d.university.trim().toLowerCase(), d._id]));

    const failures = [];
    let created = 0;
    let updated = 0;
    const seenInFile = new Set();

    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx] || {};
      const rowNo = Number(row._row) > 0 ? Number(row._row) : idx + 1;
      const university = clampStr(row.university, 300);
      if (!university) {
        failures.push({ row: rowNo, reason: 'Missing name' });
        continue;
      }
      const key = university.toLowerCase();
      const repeatedInFile = seenInFile.has(key);
      seenInFile.add(key);
      const existingId = repeatedInFile ? null : existingByName.get(key);

      let payload;
      if (section === 'department') {
        const directIndirect = ['Direct', 'Indirect'].includes(row.directIndirect) ? row.directIndirect : 'Direct';
        payload = {
          university,
          channelPartner: clampStr(row.channelPartner, 200),
          directIndirect,
          updatedBy: req.user._id
        };
      } else {
        payload = {
          university,
          ...(section === 'shareholder' ? { partner: clampStr(row.partner, 300) } : {}),
          undergraduate: clampStr(row.undergraduate, 2000),
          postgraduate: clampStr(row.postgraduate, 2000),
          remarks: clampStr(row.remarks, 1000),
          updatedBy: req.user._id
        };
      }

      if (existingId) {
        await Model.updateOne({ _id: existingId }, { $set: payload });
        updated += 1;
      } else {
        await Model.create({
          intake, country, ...(section !== 'department' ? { section } : {}),
          ...payload,
          order: nextOrder,
          createdBy: req.user._id
        });
        nextOrder += 1;
        created += 1;
        if (!existingByName.has(key)) existingByName.set(key, true);
      }
    }

    await logActivity(req, 'commission_bulk_import', {
      message: `Imported ${section}: ${created} created, ${updated} updated, ${failures.length} failed`
    });
    res.json({ created, updated, failed: failures.length, failures });
  } catch (err) {
    console.error('Failed to bulk import commission rows:', err);
    res.status(500).json({ message: 'Failed to bulk import rows' });
  }
});

router.delete('/rows/:id', requireSectionPermission('delete'), async (req, res) => {
  try {
    const section = req.commissionSection;
    const Model = sectionModel(section);
    const modelName = section === 'department' ? 'CommissionDepartment' : 'CommissionRate';
    const doc = await Model.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Row not found' });
    if (section !== 'department' && doc.section !== section) {
      return res.status(400).json({ message: 'Section mismatch' });
    }
    if (!canSeeCountry(req.user, doc.country)) {
      return res.status(403).json({ message: 'Access denied to this country' });
    }

    await softDelete({
      modelName,
      doc,
      userId: req.user._id,
      userName: req.user.name || req.user.username,
      meta: { university: doc.university, section }
    });

    await logActivity(req, 'commission_row_delete', { message: `Deleted ${doc.university} from ${section}` });
    res.json({ message: 'Row moved to trash' });
  } catch (err) {
    console.error('Failed to delete commission row:', err);
    res.status(500).json({ message: 'Failed to delete row' });
  }
});

router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ results: [] });
    if (!hasAnyCommissionPermission(req.user, 'view')) {
      return res.json({ results: [] });
    }

    const scope = countryScope(req.user);
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const results = [];

    for (const section of SECTIONS) {
      if (!hasPermission(req.user, SECTION_MODULE[section], 'view')) continue;
      if (!(await pinUnlocked(req, section))) continue;
      const Model = sectionModel(section);
      const baseQuery = scope ? { ...scope } : {};
      const orClause = section === 'department'
        ? [{ university: rx }, { channelPartner: rx }]
        : section === 'shareholder'
          ? [{ university: rx }, { partner: rx }, { remarks: rx }]
          : [{ university: rx }, { remarks: rx }];
      if (section !== 'department') baseQuery.section = section;
      baseQuery.$or = orClause;

      const docs = await Model.find(baseQuery)
        .populate('intake', 'name')
        .populate('country', 'name flag flagImage')
        .limit(25);

      docs.forEach(d => {
        results.push({
          _id: d._id,
          section,
          university: d.university,
          preview: section === 'department' ? d.channelPartner : (d.undergraduate || d.postgraduate || d.remarks || ''),
          intake: d.intake,
          country: d.country
        });
      });
    }

    res.json({ results: results.slice(0, 60) });
  } catch (err) {
    console.error('Commission search failed:', err);
    res.status(500).json({ message: 'Search failed' });
  }
});

module.exports = router;
