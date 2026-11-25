const mongoose = require('mongoose');
const express = require('express');
const TestType = require('../models/TestType');
const TestPrepRecord = require('../models/TestPrepRecord');
const IeltsDailyReceipt = require('../models/IeltsDailyReceipt');
const { verifyAccess, hasPermission } = require('../middleware/auth');
const { requireFeatureEnabled } = require('../middleware/featureGate');
const { classifyPaymentStatus } = require('../utils/paymentStatusHelper');
const { logActivity } = require('../utils/auditLogger');

const router = express.Router();
router.use(verifyAccess);
router.use(requireFeatureEnabled('testPreparation'));

const BC_KEYS = ['name', 'referenceNumber', 'passportNo', 'examDate', 'test', 'type', 'module', 'place', 'payable', 'excluded'];
const ACC_KEYS = ['quotedPrice', 'collectedPrice', 'margin', 'associates', 'paidBy', 'collectionDate', 'remarks'];
const NUM_KEYS = ['payable', 'quotedPrice', 'collectedPrice', 'margin'];
const BOOL_KEYS = ['excluded'];
const ACTIONS = ['view', 'create', 'edit', 'delete', 'exportExcel', 'exportPdf', 'print'];

function perms(user) {
  const out = { bc: {}, acc: {} };
  ACTIONS.forEach(a => {
    out.bc[a] = hasPermission(user, 'dailyReceiptBC', a);
    out.acc[a] = hasPermission(user, 'dailyReceiptAccounts', a);
  });
  return out;
}

function anyAccess(p) {
  return p.bc.view || p.acc.view;
}

function canWrite(side) {
  return side.create || side.edit;
}

function validDay(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

function dayBounds(s) {
  const start = new Date(`${s}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

function clampStr(v, max = 200) {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, max);
}

function cleanValue(key, v) {
  if (NUM_KEYS.includes(key)) {
    if (v === '' || v === null || v === undefined) return '';
    const n = Number(String(v).replace(/[^\d.\-]/g, ''));
    return Number.isFinite(n) ? n : '';
  }
  if (BOOL_KEYS.includes(key)) return v === true;
  return clampStr(v, key === 'remarks' ? 500 : 200);
}

function pickClean(src, keys) {
  const out = {};
  keys.forEach(k => {
    if (src && src[k] !== undefined) out[k] = cleanValue(k, src[k]);
  });
  return out;
}

function pickFrom(src, keys) {
  const out = {};
  keys.forEach(k => {
    if (src && src[k] !== undefined) out[k] = src[k];
  });
  return out;
}

function stripAcc(doc) {
  const o = { ...doc };
  const ov = {};
  Object.entries(doc.overrides || {}).forEach(([id, row]) => { ov[id] = pickFrom(row, BC_KEYS); });
  o.overrides = ov;
  o.manualRows = (doc.manualRows || []).map(r => ({ rid: r.rid, ...pickFrom(r, BC_KEYS) }));
  o.summaryRows = {};
  o.summaryExtra = [];
  o.difference = '';
  o.paidOn = null;
  o.preparedBy = '';
  o.checkedBy = '';
  o.approvedBy = '';
  return o;
}

function stripBc(doc) {
  const o = { ...doc };
  const ov = {};
  Object.entries(doc.overrides || {}).forEach(([id, row]) => { ov[id] = pickFrom(row, [...ACC_KEYS, 'excluded', 'name', 'referenceNumber', 'type', 'module']); });
  o.overrides = ov;
  o.manualRows = (doc.manualRows || []).map(r => ({ rid: r.rid, ...pickFrom(r, [...ACC_KEYS, ...BC_KEYS]) }));
  return o;
}

async function ieltsType() {
  const types = await TestType.find({}).lean();
  return types.find(t => /^ielts$/i.test(String(t.name || '').trim())) || types.find(t => /ielts/i.test(String(t.name || ''))) || null;
}

async function resolveType(slug) {
  if (slug === 'ielts') return ieltsType();
  return TestType.findOne({ slug }).lean();
}

router.get('/meta', async (req, res) => {
  try {
    const p = perms(req.user);
    if (!anyAccess(p)) return res.status(403).json({ message: 'Access denied' });
    const t = await ieltsType();
    if (!t) return res.status(404).json({ message: 'IELTS test type not found' });
    res.json({ testType: t, perms: p });
  } catch (err) {
    res.status(500).json({ message: 'Failed to load receipt settings' });
  }
});

router.get('/:slug/history', async (req, res) => {
  try {
    const p = perms(req.user);
    if (!anyAccess(p)) return res.status(403).json({ message: 'Access denied' });
    const t = await resolveType(req.params.slug);
    if (!t) return res.status(404).json({ message: 'Test type not found' });
    const rows = await TestPrepRecord.aggregate([
      { $match: { testType: t._id, accountsDate: { $type: 'date' } } },
      { $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$accountsDate', timezone: 'UTC' } },
        count: { $sum: 1 },
        total: { $sum: { $ifNull: ['$paymentAmount', 0] } }
      } }
    ]);
    const docs = await IeltsDailyReceipt.find({ testType: t._id }).select('receiptDate manualRows updatedAt').lean();
    const map = new Map(rows.map(r => [r._id, { date: r._id, count: r.count, total: r.total, manual: 0, saved: false }]));
    docs.forEach(d => {
      const key = new Date(d.receiptDate).toISOString().slice(0, 10);
      const e = map.get(key) || { date: key, count: 0, total: 0, manual: 0, saved: false };
      e.manual = (d.manualRows || []).length;
      e.saved = true;
      map.set(key, e);
    });
    const list = [...map.values()].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 500);
    if (!p.acc.view) list.forEach(r => { r.total = 0; });
    res.json({ history: list });
  } catch (err) {
    res.status(500).json({ message: 'Failed to load history' });
  }
});

router.get('/:slug/:date', async (req, res) => {
  try {
    const p = perms(req.user);
    if (!anyAccess(p)) return res.status(403).json({ message: 'Access denied' });
    if (!validDay(req.params.date)) return res.status(400).json({ message: 'Invalid date' });
    const t = await resolveType(req.params.slug);
    if (!t) return res.status(404).json({ message: 'Test type not found' });
    const { start, end } = dayBounds(req.params.date);
    let records = await TestPrepRecord.find({ testType: t._id, accountsDate: { $gte: start, $lt: end } })
      .select('candidateName referenceNumber passportNo examDate module ieltsModule place paymentAmount margin associates paymentMadeBy paymentStatus accountsDate remarks')
      .sort({ candidateName: 1 }).lean();
    records = records.filter(r => classifyPaymentStatus(r.paymentStatus) !== 'cancelled');
    if (!p.acc.view) {
      records = records.map(r => { const { associates, paymentMadeBy, margin, paymentStatus, remarks, ...rest } = r; return rest; });
    }
    let doc = await IeltsDailyReceipt.findOne({ testType: t._id, receiptDate: start }).lean();
    if (!doc) doc = { overrides: {}, manualRows: [], summaryRows: {}, summaryExtra: [], difference: '', paidOn: null, preparedBy: '', checkedBy: '', approvedBy: '' };
    if (!p.acc.view) doc = stripAcc(doc);
    else if (!p.bc.view) doc = stripBc(doc);
    res.json({ testType: t, date: req.params.date, records, doc, perms: p });
  } catch (err) {
    res.status(500).json({ message: 'Failed to load receipts' });
  }
});

router.put('/:slug/:date', async (req, res) => {
  try {
    const p = perms(req.user);
    const writeBc = p.bc.view && canWrite(p.bc);
    const writeAcc = p.acc.view && canWrite(p.acc);
    if (!writeBc && !writeAcc) return res.status(403).json({ message: 'Access denied' });
    if (!validDay(req.params.date)) return res.status(400).json({ message: 'Invalid date' });
    const t = await resolveType(req.params.slug);
    if (!t) return res.status(404).json({ message: 'Test type not found' });
    const { start } = dayBounds(req.params.date);
    const existing = (await IeltsDailyReceipt.findOne({ testType: t._id, receiptDate: start }).lean()) || {};
    const body = req.body || {};
    const prevOv = existing.overrides || {};
    const prevManual = new Map((existing.manualRows || []).map(r => [r.rid, r]));

    const overrides = {};
    const incomingOv = body.overrides && typeof body.overrides === 'object' ? body.overrides : {};
    const ovIds = new Set([...Object.keys(prevOv), ...Object.keys(incomingOv)]);
    ovIds.forEach(id => {
      if (!mongoose.Types.ObjectId.isValid(id)) return;
      const prev = prevOv[id] || {};
      const inc = incomingOv[id];
      const row = {};
      BC_KEYS.forEach(k => {
        if (writeBc) { if (inc && inc[k] !== undefined) row[k] = cleanValue(k, inc[k]); }
        else if (prev[k] !== undefined) row[k] = prev[k];
      });
      ACC_KEYS.forEach(k => {
        if (writeAcc) { if (inc && inc[k] !== undefined) row[k] = cleanValue(k, inc[k]); }
        else if (prev[k] !== undefined) row[k] = prev[k];
      });
      if (Object.keys(row).length) overrides[id] = row;
    });

    const manualRows = [];
    const incomingRows = Array.isArray(body.manualRows) ? body.manualRows.slice(0, 500) : [];
    const keepIds = new Set(incomingRows.map(r => clampStr(r && r.rid, 60)));
    incomingRows.forEach((r, i) => {
      const rid = clampStr(r && r.rid, 60) || `m${Date.now()}${i}`;
      const prev = prevManual.get(rid) || {};
      const row = { rid };
      BC_KEYS.forEach(k => {
        if (writeBc) { if (r[k] !== undefined) row[k] = cleanValue(k, r[k]); }
        else if (prev[k] !== undefined) row[k] = prev[k];
      });
      ACC_KEYS.forEach(k => {
        if (writeAcc) { if (r[k] !== undefined) row[k] = cleanValue(k, r[k]); }
        else if (prev[k] !== undefined) row[k] = prev[k];
      });
      if (writeBc || prevManual.has(rid)) manualRows.push(row);
    });
    if (!writeBc) prevManual.forEach((r, rid) => { if (!keepIds.has(rid) && !manualRows.find(m => m.rid === rid)) manualRows.push(r); });

    const update = { testType: t._id, receiptDate: start, overrides, manualRows, updatedBy: req.user._id };
    if (writeAcc) {
      const sr = {};
      const incSr = body.summaryRows && typeof body.summaryRows === 'object' ? body.summaryRows : {};
      Object.keys(incSr).slice(0, 200).forEach(k => {
        const v = incSr[k] || {};
        sr[clampStr(k, 200)] = {
          amount: cleanValue('payable', v.amount), receivable: cleanValue('payable', v.receivable),
          payableAssociates: cleanValue('payable', v.payableAssociates), marginExpected: cleanValue('payable', v.marginExpected),
          remarks: clampStr(v.remarks, 300)
        };
      });
      update.summaryRows = sr;
      update.summaryExtra = (Array.isArray(body.summaryExtra) ? body.summaryExtra.slice(0, 100) : []).map(v => ({
        rid: clampStr(v && v.rid, 60), test: clampStr(v && v.test, 100), type: clampStr(v && v.type, 100), module: clampStr(v && v.module, 100),
        amount: cleanValue('payable', v && v.amount), receivable: cleanValue('payable', v && v.receivable),
        payableAssociates: cleanValue('payable', v && v.payableAssociates), marginExpected: cleanValue('payable', v && v.marginExpected),
        count: cleanValue('payable', v && v.count), total: cleanValue('payable', v && v.total), remarks: clampStr(v && v.remarks, 300)
      }));
      update.difference = clampStr(body.difference, 40);
      const po = body.paidOn ? new Date(body.paidOn) : null;
      update.paidOn = po && !isNaN(po.getTime()) ? po : null;
      update.preparedBy = clampStr(body.preparedBy, 120);
      update.checkedBy = clampStr(body.checkedBy, 120);
      update.approvedBy = clampStr(body.approvedBy, 120);
    }
    const doc = await IeltsDailyReceipt.findOneAndUpdate(
      { testType: t._id, receiptDate: start }, update, { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();
    await logActivity(req, 'daily_receipt_save', { message: `Saved daily receipt for ${req.params.date}` });
    res.json({ doc });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Failed to save receipts' });
  }
});

router.delete('/:slug/:date', async (req, res) => {
  try {
    const p = perms(req.user);
    if (!(p.bc.view && p.bc.delete) && !(p.acc.view && p.acc.delete)) return res.status(403).json({ message: 'Access denied' });
    if (!validDay(req.params.date)) return res.status(400).json({ message: 'Invalid date' });
    const t = await resolveType(req.params.slug);
    if (!t) return res.status(404).json({ message: 'Test type not found' });
    const { start } = dayBounds(req.params.date);
    const { end } = dayBounds(req.params.date);
    await IeltsDailyReceipt.deleteOne({ testType: t._id, receiptDate: start });
    if (req.query.full === 'true') {
      await TestPrepRecord.updateMany({ testType: t._id, accountsDate: { $gte: start, $lt: end } }, { $unset: { accountsDate: 1 } });
      await logActivity(req, 'daily_receipt_delete', { message: `Deleted daily receipt for ${req.params.date}` });
      return res.json({ message: 'Receipt deleted' });
    }
    await logActivity(req, 'daily_receipt_reset', { message: `Reset saved daily receipt edits for ${req.params.date}` });
    res.json({ message: 'Saved edits cleared' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to clear saved edits' });
  }
});

module.exports = router;
