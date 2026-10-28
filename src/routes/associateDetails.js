const mongoose = require('mongoose');
const express = require('express');
const AssociateDetail = require('../models/AssociateDetail');
const { verifyAccess, requirePermission } = require('../middleware/auth');
const { softDelete, softDeleteMany } = require('../utils/trashHelper');
const Application = require('../models/Application');
const { logActivity } = require('../utils/auditLogger');

const router = express.Router();
router.use(verifyAccess);

const TEXT_FIELDS = [
  ['consultancyName', 300], ['ownerName', 2000], ['designation', 1500],
  ['ownerContact', 1500], ['email', 300], ['address', 600], ['location', 150],
  ['managerName', 200], ['managerEmail', 300], ['managerContact', 120], ['officialPhone', 120],
  ['emailAdmission', 300], ['emailTestRegistration', 300], ['emailOthers', 600],
  ['website', 300], ['referredBy', 200], ['association', 600]
];
const TEXT_KEYS = TEXT_FIELDS.map(([k]) => k);
const FILTER_KEYS = ['location', 'referredBy', 'designation'];

function normName(v) {
  return String(v || '').toLowerCase().replace(/[\s,.]+/g, ' ').trim();
}
const STATUS_LIST = ['Shareholder', 'Associate', 'Terminated', 'Closed'];
function cleanStatus(v) {
  const s = String(v || '').trim().toLowerCase();
  const hit = STATUS_LIST.find(o => o.toLowerCase() === s);
  if (hit) return hit;
  if (s === 'active') return 'Associate';
  if (s === 'inactive') return 'Closed';
  return '';
}
function cleanAliases(v) {
  let list = [];
  if (Array.isArray(v)) list = v;
  else if (typeof v === 'string') list = v.split(/[\n,;|]+/);
  const seen = new Set();
  const out = [];
  list.forEach(a => {
    const t = String(a || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const k = normName(t);
    if (t && k && !seen.has(k)) { seen.add(k); out.push(t); }
  });
  return out.slice(0, 40);
}
function flexRegex(name) {
  const words = String(name || '').trim().split(/\s+/).map(escapeRegex);
  return new RegExp(`^\\s*${words.join('\\s+')}\\s*$`, 'i');
}
function initials(name) {
  return String(name || '').split(/[\s,.\-/&]+/).filter(w => w && !/^(and|of|the|for|pvt|ltd|private|limited)$/i.test(w)).map(w => w[0]).join('').toLowerCase();
}
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}
function suggestScore(oldName, assoc) {
  const o = normName(oldName);
  if (!o) return 0;
  let best = 0;
  const names = [assoc.consultancyName, ...(assoc.aliases || [])];
  names.forEach(n => {
    const k = normName(n);
    if (!k) return;
    if (k === o) best = Math.max(best, 100);
    else if (k.startsWith(o) || o.startsWith(k)) best = Math.max(best, 85);
    else if (k.includes(o) || o.includes(k)) best = Math.max(best, 70);
    const dist = editDistance(o, k);
    const sim = 1 - dist / Math.max(o.length, k.length);
    if (sim >= 0.6) best = Math.max(best, Math.round(sim * 80));
    const ot = new Set(o.split(' ').filter(w => w.length > 1));
    const kt = k.split(' ').filter(w => w.length > 1);
    if (ot.size && kt.length) {
      const hit = kt.filter(w => ot.has(w)).length;
      if (hit) best = Math.max(best, Math.round(40 + 40 * hit / Math.max(ot.size, kt.length)));
    }
  });
  const ini = initials(assoc.consultancyName);
  const flat = o.replace(/\s/g, '');
  if (ini.length >= 2 && (flat === ini || o === ini)) best = Math.max(best, 75);
  return best;
}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === String(id);
}
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

function splitMulti(v) {
  return String(v === undefined || v === null ? '' : v).split(/\r?\n|;/).map(s => s.trim());
}

function cleanOwners(body) {
  let list = [];
  if (Array.isArray(body.owners)) {
    list = body.owners.map(o => ({
      name: cleanText(o && o.name, 200),
      designation: cleanText(o && o.designation, 150),
      contact: cleanText(o && o.contact, 120)
    }));
  } else {
    const n = splitMulti(body.ownerName);
    const multi = n.filter(Boolean).length > 1;
    const d = multi ? splitMulti(body.designation) : [cleanText(body.designation, 150)];
    const c = multi ? splitMulti(body.ownerContact) : [cleanText(body.ownerContact, 120)];
    const names = multi ? n : [cleanText(body.ownerName, 200)];
    const len = Math.max(names.length, d.length, c.length);
    for (let i = 0; i < len; i++) {
      list.push({
        name: cleanText(names[i], 200),
        designation: cleanText(d[i], 150),
        contact: cleanText(c[i], 120)
      });
    }
  }
  return list.filter(o => o.name || o.designation || o.contact).slice(0, 20);
}

function buildClean(body) {
  const clean = {};
  TEXT_FIELDS.forEach(([k, max]) => { clean[k] = cleanText(body[k], max); });
  clean.owners = cleanOwners(body);
  clean.ownerName = clean.owners.map(o => o.name).join('\n');
  clean.designation = clean.owners.map(o => o.designation).join('\n');
  clean.ownerContact = clean.owners.map(o => o.contact).join('\n');
  if (!clean.owners.some(o => o.designation)) clean.designation = '';
  if (!clean.owners.some(o => o.contact)) clean.ownerContact = '';
  const parsed = parseLooseDate(body.dateOfOnboarding);
  clean.dateOfOnboarding = parsed;
  const rawDate = body.dateOfOnboarding;
  clean.dateOfOnboardingText = !parsed && rawDate ? cleanText(rawDate, 60) : '';
  clean.status = cleanStatus(body.status) || 'Associate';
  clean.aliases = cleanAliases(body.aliases);
  return clean;
}

router.get('/options', async (req, res) => {
  try {
    const rows = await AssociateDetail.find({ consultancyName: { $ne: '' } })
      .select('consultancyName location status aliases').sort({ consultancyName: 1 }).lean();
    res.json({
      associates: rows.map(r => ({ _id: r._id, name: r.consultancyName, location: r.location || '', status: cleanStatus(r.status) || 'Associate', aliases: r.aliases || [] }))
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to load associates' });
  }
});

router.get('/meta', requirePermission('associateDetails', 'view'), async (req, res) => {
  try {
    const out = {};
    await Promise.all(FILTER_KEYS.map(async k => {
      const vals = await AssociateDetail.distinct(k);
      const seen = new Map();
      vals.forEach(v => {
        String(v || '').split(/\r?\n/).forEach(part => {
          const t = part.trim().replace(/[,\s]+$/, '');
          if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
        });
      });
      out[k] = [...seen.values()].sort((a, b) => a.localeCompare(b));
    }));
    res.json(out);
  } catch (err) {
    res.status(500).json({ message: 'Failed to load filter options' });
  }
});

router.get('/', requirePermission('associateDetails', 'view'), async (req, res) => {
  try {
    const { q, dateFrom, dateTo, limit = 5000 } = req.query;
    const clauses = [];

    FILTER_KEYS.forEach(k => {
      if (req.query[k]) {
        clauses.push({ [k]: new RegExp(`^\\s*${escapeRegex(String(req.query[k]).trim())}[,\\s]*$`, k === 'designation' ? 'im' : 'i') });
      }
    });
    const st = cleanStatus(req.query.status);
    if (st === 'Associate') clauses.push({ status: { $in: ['Associate', 'Active', null, ''] } });
    else if (st === 'Closed') clauses.push({ status: { $in: ['Closed', 'Inactive'] } });
    else if (st) clauses.push({ status: st });
    if (dateFrom || dateTo) {
      const range = {};
      if (dateFrom) range.$gte = new Date(dateFrom);
      if (dateTo) { const t = new Date(dateTo); t.setUTCHours(23, 59, 59, 999); range.$lte = t; }
      clauses.push({ dateOfOnboarding: range });
    }
    if (q && String(q).trim()) {
      const rx = new RegExp(escapeRegex(String(q).trim()), 'i');
      clauses.push({ $or: TEXT_KEYS.map(k => ({ [k]: rx })).concat([{ dateOfOnboardingText: rx }, { aliases: rx }]) });
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
      sno: await nextSno(),
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
          const $set = { updatedBy: req.user._id };
          TEXT_KEYS.forEach(k => { if (clean[k]) $set[k] = clean[k]; });
          if (clean.owners.length) {
            $set.owners = clean.owners;
            $set.ownerName = clean.ownerName;
            $set.designation = clean.designation;
            $set.ownerContact = clean.ownerContact;
          }
          if (clean.dateOfOnboarding) { $set.dateOfOnboarding = clean.dateOfOnboarding; $set.dateOfOnboardingText = ''; }
          else if (clean.dateOfOnboardingText) $set.dateOfOnboardingText = clean.dateOfOnboardingText;
          if (cleanStatus(row.status)) $set.status = cleanStatus(row.status);
          else delete $set.status;
          const al = cleanAliases(row.aliases);
          const upd = { $set };
          if (al.length) upd.$addToSet = { aliases: { $each: al } };
          await AssociateDetail.updateOne({ _id: existingId }, upd);
          updated += 1;
        } else {
          const doc = await AssociateDetail.create({
            ...clean,
            sno,
            createdBy: req.user._id,
            updatedBy: req.user._id
          });
          byName.set(key, doc._id);
          sno += 1;
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

router.post('/bulk-edit', requirePermission('associateDetails', 'bulkEdit'), async (req, res) => {
  try {
    const { ids, updates } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: 'No rows selected' });
    const validIds = ids.filter(isValidObjectId);
    if (validIds.length === 0) return res.status(400).json({ message: 'No valid ids provided' });

    const $set = {};
    TEXT_FIELDS.forEach(([k, max]) => {
      if (k === 'consultancyName') return;
      if (updates && updates[k] !== undefined) $set[k] = cleanText(updates[k], max);
    });
    if (updates && cleanStatus(updates.status)) $set.status = cleanStatus(updates.status);
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

router.get('/unmapped', requirePermission('associateDetails', 'edit'), async (req, res) => {
  try {
    const [assocs, groups] = await Promise.all([
      AssociateDetail.find({ consultancyName: { $ne: '' } }).select('consultancyName aliases status').lean(),
      Application.aggregate([
        { $match: { referredBy: { $type: 'string', $ne: '' } } },
        { $group: { _id: '$referredBy', count: { $sum: 1 } } }
      ])
    ]);
    const known = new Set();
    assocs.forEach(a => {
      known.add(normName(a.consultancyName));
      (a.aliases || []).forEach(x => known.add(normName(x)));
    });
    const byKey = new Map();
    groups.forEach(g => {
      const raw = String(g._id || '').replace(/\s+/g, ' ').trim();
      const key = normName(raw);
      if (!key || known.has(key)) return;
      const e = byKey.get(key) || { key, name: raw, top: 0, count: 0, variants: [] };
      e.count += g.count;
      e.variants.push(raw);
      if (g.count > e.top) { e.top = g.count; e.name = raw; }
      byKey.set(key, e);
    });
    const items = [...byKey.values()].map(e => {
      const sugg = assocs.map(a => ({ id: a._id, name: a.consultancyName, score: suggestScore(e.name, a) }))
        .filter(x => x.score >= 45).sort((a, b) => b.score - a.score).slice(0, 3);
      return { name: e.name, count: e.count, variants: [...new Set(e.variants)], suggestions: sugg };
    }).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    res.json({
      items,
      totalApplications: items.reduce((s, i) => s + i.count, 0),
      associates: assocs.map(a => ({ _id: a._id, name: a.consultancyName, status: cleanStatus(a.status) || 'Associate' })).sort((a, b) => a.name.localeCompare(b.name))
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to load unmapped names' });
  }
});

router.post('/map', requirePermission('associateDetails', 'edit'), async (req, res) => {
  try {
    const { oldName, associateId } = req.body || {};
    const variants = Array.isArray(req.body?.variants) ? req.body.variants : [];
    if (!isValidObjectId(associateId)) return res.status(400).json({ message: 'Pick an associate' });
    const raw = String(oldName || '').replace(/\s+/g, ' ').trim();
    if (!raw) return res.status(400).json({ message: 'Old name is required' });
    const doc = await AssociateDetail.findById(associateId);
    if (!doc) return res.status(404).json({ message: 'Associate not found' });

    const names = [...new Set([raw, ...variants.map(v => String(v || '').replace(/\s+/g, ' ').trim())].filter(Boolean))];
    const keys = new Set(names.map(normName));

    const others = await AssociateDetail.find({ _id: { $ne: doc._id } }).select('consultancyName aliases').lean();
    const clash = others.find(o => keys.has(normName(o.consultancyName)) || (o.aliases || []).some(a => keys.has(normName(a))));
    if (clash) return res.status(409).json({ message: `Already used by ${clash.consultancyName}` });

    const have = new Set([normName(doc.consultancyName), ...(doc.aliases || []).map(normName)]);
    const add = [];
    names.forEach(n => {
      const k = normName(n);
      if (!have.has(k)) { have.add(k); add.push(n); }
    });
    if (add.length) {
      doc.aliases = [...(doc.aliases || []), ...add].slice(0, 80);
      doc.updatedBy = req.user._id;
      await doc.save();
    }

    let linked = 0;
    for (const n of names) {
      const r = await Application.updateMany({ referredBy: flexRegex(n) }, { $set: { referredBy: doc.consultancyName } });
      linked += r.modifiedCount || 0;
    }
    await logActivity(req, 'associate_detail_map_alias', {
      targetType: 'AssociateDetail', targetId: doc._id, message: `Mapped "${raw}" to "${doc.consultancyName}" (${linked} application(s))`
    });
    res.json({ message: 'Mapped', linked, aliases: doc.aliases });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Failed to map name' });
  }
});

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
module.exports._test = { buildClean, parseLooseDate, cleanText, cleanSno, cleanAliases, normName, suggestScore };
