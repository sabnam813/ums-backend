const mongoose = require('mongoose');
const express = require('express');
const Unicommission = require('../models/Unicommission');
const UnicommissionSetting = require('../models/UnicommissionSetting');
const UnicommissionSkip = require('../models/UnicommissionSkip');
const AssociateDetail = require('../models/AssociateDetail');
const Country = require('../models/Country');
const { verifyAccess, requirePermission } = require('../middleware/auth');
const { softDelete, softDeleteMany } = require('../utils/trashHelper');
const { logActivity } = require('../utils/auditLogger');
const U = require('../utils/unicommission');

const router = express.Router();
router.use(verifyAccess);

const MOD = 'unicommission';
const TEXT_FIELDS = [
  ['studentName', 200], ['associate', 200], ['university', 300], ['level', 60], ['course', 300],
  ['commissionProvider', 200], ['studentIdNo', 100], ['remarks', 1000]
];
const FILTER_META = ['intake', 'university', 'associate', 'commissionProvider', 'level'];

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === String(id);
}
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function exactRx(v) {
  return new RegExp(`^\\s*${escapeRegex(String(v).trim())}\\s*$`, 'i');
}

function cleanFields(body, { partial = false } = {}) {
  const has = k => body[k] !== undefined;
  const out = {};
  TEXT_FIELDS.forEach(([k, max]) => { if (!partial || has(k)) out[k] = U.cleanText(body[k], max); });
  if (!partial || has('intake')) out.intake = U.normalizeIntake(body.intake);

  if (!partial || has('visaGrantedDate')) {
    const raw = body.visaGrantedDate;
    const d = U.parseLooseDate(raw);
    out.visaGrantedDate = d;
    out.visaGrantedDateText = !d && raw !== undefined && raw !== null && String(raw).trim() ? U.cleanText(raw, 60) : '';
  }

  if (!partial || has('feeAmount')) {
    const fee = U.parseFee(body.feeAmount);
    out.feeAmount = fee.amount;
    if (fee.currency && !has('currency')) out.currency = fee.currency;
  }
  if (!partial || has('currency')) {
    if (has('currency')) out.currency = U.normCurrency(body.currency);
    else if (out.currency === undefined) out.currency = '';
  }
  if (!partial || has('commissionType')) out.commissionType = U.normType(body.commissionType);
  if (!partial || has('commissionValue')) out.commissionValue = U.parseNumber(body.commissionValue);
  if (!partial || has('paymentStatus')) {
    const st = U.normStatus(body.paymentStatus);
    if (st) out.paymentStatus = st;
    else if (!partial) out.paymentStatus = 'Pending';
  }
  return out;
}

async function requireCountry(req, res, id) {
  if (!id || !isValidObjectId(id)) { res.status(400).json({ message: 'A valid country is required' }); return null; }
  const country = await Country.findById(id).select('name flag flagImage code').lean();
  if (!country) { res.status(404).json({ message: 'Country not found' }); return null; }
  return country;
}

router.get('/countries', requirePermission(MOD, 'access'), async (req, res) => {
  try {
    try { await U.syncApplications(); } catch (e) { console.warn('Unicommission sync failed:', e.message); }
    const [countries, settings, counts] = await Promise.all([
      Country.find({}).select('name flag flagImage code status').sort({ name: 1 }).lean(),
      UnicommissionSetting.find({}).lean(),
      Unicommission.aggregate([{ $group: { _id: '$country', count: { $sum: 1 } } }])
    ]);
    const settingBy = new Map(settings.map(s => [String(s.country), s]));
    const countBy = new Map(counts.map(c => [String(c._id), c.count]));
    res.json({
      countries: countries.map(c => {
        const s = settingBy.get(String(c._id));
        return {
          _id: c._id, name: c.name, flag: c.flag, flagImage: c.flagImage, code: c.code,
          count: countBy.get(String(c._id)) || 0,
          setting: s
            ? { currency: s.currency || '', commissionType: s.commissionType, commissionValue: s.commissionValue ?? null }
            : { currency: '', commissionType: 'percentage', commissionValue: null }
        };
      })
    });
  } catch (err) {
    console.error('Unicommission countries failed:', err);
    res.status(500).json({ message: 'Failed to load countries' });
  }
});

router.post('/sync', requirePermission(MOD, 'edit'), async (req, res) => {
  try {
    const country = req.body?.country;
    if (country && !isValidObjectId(country)) return res.status(400).json({ message: 'Invalid country' });
    const result = await U.syncApplications(country ? { country } : {});
    res.json({ ...result, message: `${result.created} new, ${result.refreshed} refreshed, ${result.flagged} flagged` });
  } catch (err) {
    console.error('Unicommission manual sync failed:', err);
    res.status(500).json({ message: 'Sync failed' });
  }
});

router.put('/settings/:countryId', requirePermission(MOD, 'settings'), async (req, res) => {
  try {
    const country = await requireCountry(req, res, req.params.countryId);
    if (!country) return;
    const type = req.body?.commissionType === 'fixed' ? 'fixed' : 'percentage';
    const value = U.parseNumber(req.body?.commissionValue);
    if (value !== null && value < 0) return res.status(400).json({ message: 'Commission value cannot be negative' });
    if (type === 'percentage' && value !== null && value > 100) return res.status(400).json({ message: 'A percentage cannot be more than 100' });
    const setting = await UnicommissionSetting.findOneAndUpdate(
      { country: country._id },
      { $set: { currency: U.normCurrency(req.body?.currency), commissionType: type, commissionValue: value, updatedBy: req.user._id } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();
    await logActivity(req, 'unicommission_settings', {
      targetType: 'UnicommissionSetting', targetId: setting._id,
      message: `Updated Unicommission settings for ${country.name}`
    });
    res.json({ setting });
  } catch (err) {
    res.status(500).json({ message: 'Failed to save settings' });
  }
});

router.get('/rows', requirePermission(MOD, 'view'), async (req, res) => {
  try {
    const country = await requireCountry(req, res, req.query.country);
    if (!country) return;
    try { await U.syncApplications({ country: country._id }); } catch (e) { console.warn('Unicommission sync failed:', e.message); }

    const {
      q, intake, university, associate, provider, level, status, source, missing, visaFrom, visaTo, limit = 10000
    } = req.query;
    const clauses = [{ country: country._id }];
    const exact = { intake, university, associate, commissionProvider: provider, level, paymentStatus: status };
    Object.entries(exact).forEach(([k, v]) => { if (v) clauses.push({ [k]: exactRx(v) }); });

    if (source === 'manual') clauses.push({ $or: [{ application: { $exists: false } }, { application: null }] });
    else if (source === 'application') clauses.push({ application: { $ne: null } });
    else if (source === 'flagged') clauses.push({ sourceFlag: { $ne: '' } });

    if (missing === 'fee') clauses.push({ $or: [{ feeAmount: null }, { feeAmount: { $exists: false } }] });
    else if (missing === 'studentId') clauses.push({ studentIdNo: '' });
    else if (missing === 'provider') clauses.push({ commissionProvider: '' });
    else if (missing === 'visaDate') clauses.push({ visaGrantedDate: null });

    if (visaFrom || visaTo) {
      const range = {};
      if (visaFrom) range.$gte = new Date(visaFrom);
      if (visaTo) { const t = new Date(visaTo); t.setUTCHours(23, 59, 59, 999); range.$lte = t; }
      clauses.push({ visaGrantedDate: range });
    }
    if (q && String(q).trim()) {
      const rx = new RegExp(escapeRegex(String(q).trim()), 'i');
      const keys = ['studentName', 'associate', 'intake', 'university', 'level', 'course', 'commissionProvider', 'studentIdNo', 'remarks', 'visaGrantedDateText', 'paymentStatus'];
      clauses.push({ $or: keys.map(k => ({ [k]: rx })) });
    }

    const [setting, rows, metaDocs] = await Promise.all([
      U.getSetting(country._id),
      Unicommission.find({ $and: clauses }).sort({ createdAt: 1, _id: 1 }).limit(Math.min(Number(limit) || 10000, 20000)).lean(),
      Promise.all(FILTER_META.map(k => Unicommission.distinct(k, { country: country._id })))
    ]);

    const meta = {};
    FILTER_META.forEach((k, i) => {
      const seen = new Map();
      metaDocs[i].forEach(v => {
        const t = String(v || '').trim();
        if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
      });
      meta[k] = [...seen.values()].sort((a, b) => a.localeCompare(b));
    });

    res.json({
      country,
      setting: { currency: setting.currency || '', commissionType: setting.commissionType, commissionValue: setting.commissionValue ?? null },
      rows: rows.map(r => U.decorate(r, setting)),
      total: rows.length,
      meta
    });
  } catch (err) {
    console.error('Unicommission rows failed:', err);
    res.status(500).json({ message: 'Failed to load Unicommission records' });
  }
});

router.post('/rows', requirePermission(MOD, 'create'), async (req, res) => {
  try {
    const country = await requireCountry(req, res, req.body?.country);
    if (!country) return;
    const clean = cleanFields(req.body || {});
    if (!clean.studentName) return res.status(400).json({ message: 'Student name is required' });
    const doc = await Unicommission.create({ ...clean, country: country._id, createdBy: req.user._id, updatedBy: req.user._id });
    await logActivity(req, 'unicommission_create', {
      targetType: 'Unicommission', targetId: doc._id, message: `Added Unicommission record "${doc.studentName}" (${country.name})`
    });
    const setting = await U.getSetting(country._id);
    res.status(201).json({ row: U.decorate(doc, setting) });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Failed to create record' });
  }
});

router.post('/rows/bulk-import', requirePermission(MOD, 'import'), async (req, res) => {
  try {
    const country = await requireCountry(req, res, req.body?.country);
    if (!country) return;
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (rows.length === 0) return res.status(400).json({ message: 'No rows to import' });
    if (rows.length > 5000) return res.status(400).json({ message: 'Too many rows in one import (max 5000)' });

    try { await U.syncApplications({ country: country._id }); } catch (e) { console.warn('Unicommission sync failed:', e.message); }

    const assocNames = await AssociateDetail.find({ consultancyName: { $ne: '' } }).select('consultancyName').lean();
    const assocByKey = new Map(assocNames.map(a => [U.nameKey(a.consultancyName), a.consultancyName]));
    const unmatched = new Set();

    const existing = await Unicommission.find({ country: country._id }).lean();
    const byFull = new Map();
    const byNameIntake = new Map();
    const byName = new Map();
    const push = (map, key, doc) => { if (!map.has(key)) map.set(key, []); map.get(key).push(doc); };
    const index = doc => {
      const n = U.nameKey(doc.studentName);
      push(byFull, `${n}|${U.nameKey(doc.university)}|${U.nameKey(doc.intake)}`, doc);
      push(byNameIntake, `${n}|${U.nameKey(doc.intake)}`, doc);
      push(byName, n, doc);
    };
    existing.forEach(index);
    const only = list => (list && list.length === 1 ? list[0] : null);

    const failures = [];
    const seenInFile = new Set();
    let added = 0;
    let updated = 0;

    for (let i = 0; i < rows.length; i += 1) {
      const raw = rows[i] || {};
      const clean = cleanFields(raw, { partial: true });
      const filled = Object.values(raw).filter(v => v !== undefined && v !== null && String(v).trim() !== '').length;
      if (!clean.studentName) {
        if (filled >= 3) failures.push({ row: i + 1, name: '', reason: 'Missing student name' });
        continue;
      }
      if (clean.associate) {
        const canon = assocByKey.get(U.nameKey(clean.associate));
        if (canon) clean.associate = canon; else unmatched.add(clean.associate);
      }

      const n = U.nameKey(clean.studentName);
      const fullKey = `${n}|${U.nameKey(clean.university)}|${U.nameKey(clean.intake)}`;
      if (seenInFile.has(fullKey)) {
        failures.push({ row: i + 1, name: clean.studentName, reason: 'Duplicate of an earlier row in the file (first one kept)' });
        continue;
      }
      seenInFile.add(fullKey);

      let match = only(byFull.get(fullKey)) || only(byNameIntake.get(`${n}|${U.nameKey(clean.intake)}`));
      if (!match) {
        const cand = only(byName.get(n));
        if (cand && (!clean.intake || !cand.intake)) match = cand;
      }

      try {
        if (match) {
          const linked = !!match.application;
          const $set = { updatedBy: req.user._id };
          ['commissionProvider', 'studentIdNo', 'remarks'].forEach(k => { if (clean[k]) $set[k] = clean[k]; });
          if (clean.feeAmount !== undefined && clean.feeAmount !== null) $set.feeAmount = clean.feeAmount;
          if (clean.currency) $set.currency = clean.currency;
          if (clean.commissionType) $set.commissionType = clean.commissionType;
          if (clean.commissionValue !== undefined && clean.commissionValue !== null) $set.commissionValue = clean.commissionValue;
          if (clean.paymentStatus) $set.paymentStatus = clean.paymentStatus;
          ['associate', 'university', 'level', 'course', 'intake'].forEach(k => {
            if (clean[k] && (!linked || !match[k])) $set[k] = clean[k];
          });
          if (clean.visaGrantedDate && (!linked || !match.visaGrantedDate)) { $set.visaGrantedDate = clean.visaGrantedDate; $set.visaGrantedDateText = ''; }
          else if (clean.visaGrantedDateText && !match.visaGrantedDate && !match.visaGrantedDateText) $set.visaGrantedDateText = clean.visaGrantedDateText;
          await Unicommission.updateOne({ _id: match._id }, { $set });
          Object.assign(match, $set);
          updated += 1;
        } else {
          const doc = await Unicommission.create({
            paymentStatus: 'Pending', ...clean, country: country._id, createdBy: req.user._id, updatedBy: req.user._id
          });
          index(doc.toObject());
          added += 1;
        }
      } catch (e) {
        failures.push({ row: i + 1, name: clean.studentName, reason: e.message || 'Database error' });
      }
    }

    await logActivity(req, 'unicommission_bulk_import', {
      message: `Imported Unicommission (${country.name}): ${added} added, ${updated} updated, ${failures.length} skipped`
    });
    res.json({
      total: rows.length, created: added + updated, added, updated, failed: failures.length, failures,
      unmatchedAssociates: [...unmatched].slice(0, 50)
    });
  } catch (err) {
    console.error('Unicommission import failed:', err);
    res.status(500).json({ message: 'Failed to import' });
  }
});

router.post('/rows/bulk-edit', requirePermission(MOD, 'bulkEdit'), async (req, res) => {
  try {
    const { ids, updates } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: 'No rows selected' });
    const validIds = ids.filter(isValidObjectId);
    if (validIds.length === 0) return res.status(400).json({ message: 'No valid ids provided' });

    const clean = cleanFields(updates || {}, { partial: true });
    delete clean.studentName;
    const sent = new Set(Object.keys(updates || {}));
    const $set = {};
    Object.entries(clean).forEach(([k, v]) => {
      if (k === 'visaGrantedDateText') return;
      if (!sent.has(k) && !(k === 'currency' && sent.has('feeAmount'))) return;
      $set[k] = v;
    });
    if ($set.visaGrantedDate !== undefined) $set.visaGrantedDateText = clean.visaGrantedDateText || '';
    if (Object.keys($set).length === 0) return res.status(400).json({ message: 'No valid fields to update' });
    $set.updatedBy = req.user._id;

    const update = { $set };
    const sourcedEdited = U.SOURCED.filter(k => k !== 'studentName' && $set[k] !== undefined);
    if (sourcedEdited.length) update.$addToSet = { manualFields: { $each: sourcedEdited } };

    const result = await Unicommission.updateMany({ _id: { $in: validIds } }, update);
    await logActivity(req, 'unicommission_bulk_edit', {
      message: `Bulk-updated ${result.modifiedCount} Unicommission record(s)`, meta: { fields: Object.keys($set) }
    });
    res.json({ message: `Updated ${result.modifiedCount} row(s)`, modifiedCount: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ message: 'Failed to bulk update' });
  }
});

async function rememberDeleted(docs) {
  const linked = docs.filter(d => d.application);
  if (!linked.length) return;
  await UnicommissionSkip.bulkWrite(linked.map(d => ({
    updateOne: { filter: { application: d.application }, update: { $setOnInsert: { application: d.application, country: d.country } }, upsert: true }
  })), { ordered: false });
}

router.delete('/rows/bulk-delete', requirePermission(MOD, 'delete'), async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: 'No rows selected' });
    const docs = await Unicommission.find({ _id: { $in: ids.filter(isValidObjectId) } });
    await rememberDeleted(docs);
    await softDeleteMany({
      modelName: 'Unicommission', docs, userId: req.user._id, userName: req.user.name || req.user.username,
      metaFor: d => ({ studentName: d.studentName, country: String(d.country) })
    });
    await logActivity(req, 'unicommission_bulk_delete', { message: `Bulk-moved ${docs.length} Unicommission record(s) to trash` });
    res.json({ deleted: docs.length });
  } catch (err) {
    res.status(500).json({ message: 'Failed to bulk delete' });
  }
});

router.put('/rows/:id', requirePermission(MOD, 'edit'), async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid id' });
    const doc = await Unicommission.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Record not found' });

    const clean = cleanFields(req.body || {});
    if (!clean.studentName) return res.status(400).json({ message: 'Student name is required' });

    if (doc.application) {
      const manual = new Set(doc.manualFields || []);
      U.SOURCED.forEach(k => {
        const before = doc[k];
        const after = clean[k];
        if (after === undefined) return;
        const same = k === 'visaGrantedDate'
          ? (before ? new Date(before).getTime() : null) === (after ? new Date(after).getTime() : null)
          : (before ?? '') === (after ?? '');
        if (!same) manual.add(k);
      });
      doc.manualFields = [...manual];
    }
    Object.assign(doc, clean);
    doc.updatedBy = req.user._id;
    await doc.save();
    await logActivity(req, 'unicommission_update', {
      targetType: 'Unicommission', targetId: doc._id, message: `Updated Unicommission record "${doc.studentName}"`
    });
    const setting = await U.getSetting(doc.country);
    res.json({ row: U.decorate(doc, setting) });
  } catch (err) {
    res.status(400).json({ message: err.message || 'Failed to update record' });
  }
});

router.delete('/rows/:id', requirePermission(MOD, 'delete'), async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid id' });
    const doc = await Unicommission.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Record not found' });
    await rememberDeleted([doc]);
    await softDelete({
      modelName: 'Unicommission', doc, userId: req.user._id, userName: req.user.name || req.user.username,
      meta: { studentName: doc.studentName, country: String(doc.country) }
    });
    await logActivity(req, 'unicommission_delete', {
      targetType: 'Unicommission', targetId: doc._id, message: `Moved Unicommission record "${doc.studentName}" to trash`
    });
    res.json({ message: 'Moved to trash' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete record' });
  }
});

module.exports = router;
module.exports._test = { cleanFields };
