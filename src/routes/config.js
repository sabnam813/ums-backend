const express = require('express');
const AppConfig = require('../models/AppConfig');
const FieldConfig = require('../models/FieldConfig');
const Application = require('../models/Application');
const { verifyAccess, requireSuperAdmin } = require('../middleware/auth');
const { logActivity } = require('../utils/auditLogger');
const { MODULES } = require('../config/rbac');
const { LISTS, LEVEL_DEFAULTS } = require('../utils/configRegistry');

const router = express.Router();
router.use(verifyAccess);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function loadConfig() {
  return (await AppConfig.findOne({ key: 'main' }).lean()) || { lists: {}, modules: {}, fiscalYears: null };
}

function listValues(cfg, key) {
  const stored = cfg.lists && cfg.lists[key];
  return Array.isArray(stored) && stored.length ? stored : LISTS[key].defaults;
}

function cleanValues(key, input) {
  const def = LISTS[key];
  const seen = new Set();
  const out = [];
  (Array.isArray(input) ? input : []).forEach(v => {
    let t = String(v == null ? '' : v).trim().slice(0, def.maxLen);
    if (def.upper) t = t.toUpperCase();
    if (!t || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    out.push(t);
  });
  return out;
}

async function currentLevels() {
  const doc = await FieldConfig.findOne({ kind: 'options', fieldKey: 'level' }).lean();
  const removed = (doc?.removedDefaults || []).map(s => s.toLowerCase());
  const base = LEVEL_DEFAULTS.filter(d => !removed.includes(d.toLowerCase()));
  const extra = (doc?.options || []).filter(o => !LEVEL_DEFAULTS.some(d => d.toLowerCase() === o.toLowerCase()));
  return [...base, ...extra];
}

router.get('/public', async (req, res) => {
  try {
    const cfg = await loadConfig();
    const lists = {};
    Object.keys(LISTS).forEach(k => { lists[k] = listValues(cfg, k); });
    const modules = {};
    Object.entries(cfg.modules || {}).forEach(([k, v]) => {
      if (v && (v.label || v.hidden)) modules[k] = { label: v.label || '', hidden: !!v.hidden };
    });
    res.json({ lists, modules, fiscalYears: cfg.fiscalYears && cfg.fiscalYears.length ? cfg.fiscalYears : null });
  } catch (err) {
    res.status(500).json({ message: 'Failed to load configuration' });
  }
});

router.get('/admin', requireSuperAdmin, async (req, res) => {
  try {
    const cfg = await loadConfig();
    const lists = [];
    for (const [key, def] of Object.entries(LISTS)) {
      const values = listValues(cfg, key);
      const usage = {};
      for (const t of def.targets) {
        const rows = await t.model.aggregate([{ $group: { _id: `$${t.field}`, n: { $sum: 1 } } }]);
        rows.forEach(r => { if (r._id) usage[r._id] = (usage[r._id] || 0) + r.n; });
      }
      lists.push({
        key, label: def.label, note: def.note, values, defaults: def.defaults,
        custom: !!(cfg.lists && cfg.lists[key]), maxLen: def.maxLen, usage
      });
    }
    const levels = await currentLevels();
    const levelUsage = {};
    const rows = await Application.aggregate([{ $group: { _id: '$level', n: { $sum: 1 } } }]);
    rows.forEach(r => { if (r._id) levelUsage[r._id] = r.n; });
    const modules = MODULES.map(m => ({
      key: m.key,
      defaultLabel: m.label,
      label: cfg.modules?.[m.key]?.label || '',
      hidden: !!cfg.modules?.[m.key]?.hidden
    }));
    res.json({ lists, level: { values: levels, usage: levelUsage }, modules, fiscalYears: cfg.fiscalYears || null });
  } catch (err) {
    res.status(500).json({ message: 'Failed to load configuration' });
  }
});

router.put('/lists/:key', requireSuperAdmin, async (req, res) => {
  try {
    const { key } = req.params;
    if (!LISTS[key]) return res.status(404).json({ message: 'Unknown list' });
    const values = cleanValues(key, req.body.values);
    if (!values.length) return res.status(400).json({ message: 'At least one value is required' });
    await AppConfig.updateOne({ key: 'main' }, { $set: { [`lists.${key}`]: values, updatedBy: req.user._id } }, { upsert: true });
    await logActivity(req, 'config.list.update', { targetType: 'AppConfig', targetId: key, message: `${LISTS[key].label} list updated`, meta: { values } });
    res.json({ key, values });
  } catch (err) {
    res.status(500).json({ message: 'Failed to save list' });
  }
});

router.post('/lists/:key/rename', requireSuperAdmin, async (req, res) => {
  try {
    const { key } = req.params;
    const def = LISTS[key];
    if (!def) return res.status(404).json({ message: 'Unknown list' });
    const cfg = await loadConfig();
    const values = listValues(cfg, key);
    const from = String(req.body.from || '').trim();
    let to = String(req.body.to || '').trim().slice(0, def.maxLen);
    if (def.upper) to = to.toUpperCase();
    if (!from || !to) return res.status(400).json({ message: 'Both names are required' });
    if (!values.includes(from)) return res.status(404).json({ message: 'Value not found in list' });
    if (from !== to && values.some(v => v.toLowerCase() === to.toLowerCase())) return res.status(409).json({ message: 'That name already exists' });
    let updated = 0;
    if (from !== to) {
      for (const t of def.targets) {
        const r = await t.model.updateMany({ [t.field]: from }, { $set: { [t.field]: to } });
        updated += r.modifiedCount || 0;
      }
    }
    const next = values.map(v => (v === from ? to : v));
    await AppConfig.updateOne({ key: 'main' }, { $set: { [`lists.${key}`]: next, updatedBy: req.user._id } }, { upsert: true });
    await logActivity(req, 'config.list.rename', { targetType: 'AppConfig', targetId: key, message: `${def.label}: "${from}" renamed to "${to}" (${updated} records)`, meta: { from, to, updated } });
    res.json({ key, values: next, updated });
  } catch (err) {
    res.status(500).json({ message: 'Failed to rename value' });
  }
});

router.post('/lists/:key/reset', requireSuperAdmin, async (req, res) => {
  try {
    const { key } = req.params;
    if (!LISTS[key]) return res.status(404).json({ message: 'Unknown list' });
    await AppConfig.updateOne({ key: 'main' }, { $unset: { [`lists.${key}`]: '' }, $set: { updatedBy: req.user._id } }, { upsert: true });
    await logActivity(req, 'config.list.reset', { targetType: 'AppConfig', targetId: key, message: `${LISTS[key].label} list reset to default` });
    res.json({ key, values: LISTS[key].defaults });
  } catch (err) {
    res.status(500).json({ message: 'Failed to reset list' });
  }
});

router.post('/level/rename', requireSuperAdmin, async (req, res) => {
  try {
    const from = String(req.body.from || '').trim();
    const to = String(req.body.to || '').trim().slice(0, 60);
    if (!from || !to) return res.status(400).json({ message: 'Both names are required' });
    const levels = await currentLevels();
    const match = levels.find(l => l === from);
    if (!match) return res.status(404).json({ message: 'Level not found' });
    if (from !== to && levels.some(l => l.toLowerCase() === to.toLowerCase())) return res.status(409).json({ message: 'That level already exists' });
    if (from === to) return res.json({ updated: 0 });

    let doc = await FieldConfig.findOne({ kind: 'options', fieldKey: 'level' });
    if (!doc) doc = new FieldConfig({ kind: 'options', fieldKey: 'level', label: 'level', options: [], removedDefaults: [] });
    const isDefault = LEVEL_DEFAULTS.some(d => d.toLowerCase() === from.toLowerCase());
    const toIsDefault = LEVEL_DEFAULTS.find(d => d.toLowerCase() === to.toLowerCase());
    if (isDefault) doc.removedDefaults = [...(doc.removedDefaults || []), from];
    else doc.options = (doc.options || []).filter(o => o !== from);
    if (toIsDefault) doc.removedDefaults = (doc.removedDefaults || []).filter(o => o.toLowerCase() !== to.toLowerCase());
    else doc.options = [...(doc.options || []), to];
    await doc.save();

    let updated = 0;
    const Inquiry = require('../models/Inquiry');
    const Unicommission = require('../models/Unicommission');
    const a = await Application.updateMany({ level: from }, { $set: { level: to } });
    const b = await Application.updateMany({ 'universities.level': from }, { $set: { 'universities.$[u].level': to } }, { arrayFilters: [{ 'u.level': from }] });
    const c = await Inquiry.updateMany({ level: from }, { $set: { level: to } });
    const d = await Unicommission.updateMany({ level: from }, { $set: { level: to } });
    updated = (a.modifiedCount || 0) + (b.modifiedCount || 0) + (c.modifiedCount || 0) + (d.modifiedCount || 0);
    await logActivity(req, 'config.level.rename', { targetType: 'FieldConfig', targetId: 'level', message: `Level "${from}" renamed to "${to}" (${updated} records)`, meta: { from, to, updated } });
    res.json({ updated });
  } catch (err) {
    res.status(500).json({ message: 'Failed to rename level' });
  }
});

router.put('/fiscal-years', requireSuperAdmin, async (req, res) => {
  try {
    const input = Array.isArray(req.body.fiscalYears) ? req.body.fiscalYears : [];
    if (!input.length) {
      await AppConfig.updateOne({ key: 'main' }, { $unset: { fiscalYears: '' }, $set: { updatedBy: req.user._id } }, { upsert: true });
      await logActivity(req, 'config.fiscalYears.reset', { targetType: 'AppConfig', targetId: 'fiscalYears', message: 'Fiscal years reset to default' });
      return res.json({ fiscalYears: null });
    }
    const seen = new Set();
    const out = [];
    for (const fy of input) {
      const label = String(fy.label || '').trim().slice(0, 20);
      const from = String(fy.from || '').trim();
      const to = String(fy.to || '').trim();
      if (!label || !DATE_RE.test(from) || !DATE_RE.test(to) || from > to) {
        return res.status(400).json({ message: `Invalid fiscal year "${label || '(blank)'}"` });
      }
      if (seen.has(label)) return res.status(400).json({ message: `Duplicate fiscal year "${label}"` });
      seen.add(label);
      out.push({ label, from, to });
    }
    out.sort((a, b) => a.from.localeCompare(b.from));
    await AppConfig.updateOne({ key: 'main' }, { $set: { fiscalYears: out, updatedBy: req.user._id } }, { upsert: true });
    await logActivity(req, 'config.fiscalYears.update', { targetType: 'AppConfig', targetId: 'fiscalYears', message: `Fiscal years updated (${out.length})` });
    res.json({ fiscalYears: out });
  } catch (err) {
    res.status(500).json({ message: 'Failed to save fiscal years' });
  }
});

router.put('/modules', requireSuperAdmin, async (req, res) => {
  try {
    const input = req.body.modules && typeof req.body.modules === 'object' ? req.body.modules : {};
    const valid = new Set(MODULES.map(m => m.key));
    const out = {};
    Object.entries(input).forEach(([k, v]) => {
      if (!valid.has(k) || !v) return;
      const label = String(v.label || '').trim().slice(0, 40);
      const hidden = !!v.hidden;
      if (label || hidden) out[k] = { label, hidden };
    });
    await AppConfig.updateOne({ key: 'main' }, { $set: { modules: out, updatedBy: req.user._id } }, { upsert: true });
    await logActivity(req, 'config.modules.update', { targetType: 'AppConfig', targetId: 'modules', message: 'Sidebar modules updated', meta: { modules: out } });
    res.json({ modules: out });
  } catch (err) {
    res.status(500).json({ message: 'Failed to save modules' });
  }
});

module.exports = router;
