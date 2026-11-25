const express = require('express');
const mongoose = require('mongoose');
const Country = require('../models/Country');
const { verifyAccess } = require('../middleware/auth');
const { hasPermission, ACTIONS } = require('../config/rbac');
const {
  ENTITIES, FEATURES, SENSITIVE_FIELD, countryScope, escapeRegex
} = require('../utils/assistantRegistry');

const router = express.Router();
router.use(verifyAccess);

function isSuper(user) { return user.role === 'super_admin'; }

function canUseEntity(user, e) {
  if (isSuper(user)) return true;
  if (e.superAdminOnly) return false;
  if (!e.modules || e.modules.length === 0) return true;
  return e.modules.some(m => hasPermission(user, m, 'view'));
}

function canUseFeature(user, f) {
  if (isSuper(user)) return true;
  if (f.superAdminOnly) return false;
  if (f.open || !f.modules || f.modules.length === 0) return true;
  return f.modules.some(m => hasPermission(user, m, 'access'));
}

function featureActions(user, f) {
  if (!f.modules || f.modules.length === 0) return [];
  const out = new Set();
  f.modules.forEach(m => ACTIONS.forEach(a => { if (a !== 'access' && hasPermission(user, m, a)) out.add(a); }));
  return [...out];
}

const entityByKey = Object.fromEntries(ENTITIES.map(e => [e.key, e]));

function schemaInfo(entity) {
  if (entity._info) return entity._info;
  const Model = entity.model();
  const exclude = new Set(entity.exclude || []);
  const strings = [];
  const dates = [];
  const numbers = [];
  const arrays = [];
  const refs = [];
  Model.schema.eachPath((p, t) => {
    if (['_id', '__v'].includes(p) || SENSITIVE_FIELD.test(p) || exclude.has(p)) return;
    if (p.includes('.$*') || p.startsWith('customFields') || p.startsWith('visibility')) return;
    if (t.instance === 'String') strings.push(p);
    else if (t.instance === 'Date') dates.push(p);
    else if (t.instance === 'Number') numbers.push(p);
    else if (t.instance === 'Array' && t.caster && t.caster.instance === 'String') arrays.push(p);
    else if (t.instance === 'ObjectId') refs.push(p);
  });
  entity._info = { strings, dates, numbers, arrays, refs, all: new Set([...strings, ...dates, ...numbers, ...arrays, ...refs]) };
  return entity._info;
}

function humanize(key, entity) {
  if (entity.labels && entity.labels[key]) return entity.labels[key];
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
}

const NEPAL_OFFSET_MIN = 345;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function nepalToday() {
  const d = new Date(Date.now() + NEPAL_OFFSET_MIN * 60000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay() };
}
function dayStart(y, m, d, kind) {
  const t = Date.UTC(y, m, d);
  return new Date(kind === 'instant' ? t - NEPAL_OFFSET_MIN * 60000 : t);
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function isoDay(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null;
}

function resolveRange(key, kind, fromStr, toStr) {
  const now = nepalToday();
  const S = (y, m, d) => dayStart(y, m, d, kind);
  const k = String(key || 'allTime');
  const lower = k.toLowerCase();

  if (lower === 'alltime' || lower === 'all') return { from: null, to: null, label: 'all time' };
  if (lower === 'custom') {
    const a = isoDay(fromStr);
    const b = isoDay(toStr);
    if (!a && !b) return { from: null, to: null, label: 'all time' };
    const from = a ? S(a.y, a.m, a.d) : null;
    const to = b ? S(b.y, b.m, b.d + 1) : null;
    const label = a && b ? `${fromStr} to ${toStr}` : a ? `from ${fromStr}` : `until ${toStr}`;
    return { from, to, label };
  }
  if (lower === 'today') return { from: S(now.y, now.m, now.d), to: S(now.y, now.m, now.d + 1), label: 'today' };
  if (lower === 'yesterday') return { from: S(now.y, now.m, now.d - 1), to: S(now.y, now.m, now.d), label: 'yesterday' };
  if (lower === 'tomorrow') return { from: S(now.y, now.m, now.d + 1), to: S(now.y, now.m, now.d + 2), label: 'tomorrow' };
  if (lower === 'thisweek') return { from: S(now.y, now.m, now.d - now.dow), to: S(now.y, now.m, now.d - now.dow + 7), label: 'this week' };
  if (lower === 'lastweek') return { from: S(now.y, now.m, now.d - now.dow - 7), to: S(now.y, now.m, now.d - now.dow), label: 'last week' };
  if (lower === 'nextweek') return { from: S(now.y, now.m, now.d - now.dow + 7), to: S(now.y, now.m, now.d - now.dow + 14), label: 'next week' };
  if (lower === 'thismonth') return { from: S(now.y, now.m, 1), to: S(now.y, now.m + 1, 1), label: 'this month' };
  if (lower === 'lastmonth') return { from: S(now.y, now.m - 1, 1), to: S(now.y, now.m, 1), label: 'last month' };
  if (lower === 'nextmonth') return { from: S(now.y, now.m + 1, 1), to: S(now.y, now.m + 2, 1), label: 'next month' };
  if (lower === 'thisyear') return { from: S(now.y, 0, 1), to: S(now.y + 1, 0, 1), label: 'this year' };
  if (lower === 'lastyear') return { from: S(now.y - 1, 0, 1), to: S(now.y, 0, 1), label: 'last year' };
  if (lower === 'thisquarter' || lower === 'lastquarter') {
    const q = Math.floor(now.m / 3) - (lower === 'lastquarter' ? 1 : 0);
    return { from: S(now.y, q * 3, 1), to: S(now.y, q * 3 + 3, 1), label: lower === 'thisquarter' ? 'this quarter' : 'last quarter' };
  }
  let m = lower.match(/^last:(\d{1,3}):(days?|weeks?|months?)$/);
  if (m) {
    const n = +m[1];
    const unit = m[2].replace(/s$/, '');
    let from;
    if (unit === 'day') from = S(now.y, now.m, now.d - n + 1);
    else if (unit === 'week') from = S(now.y, now.m, now.d - n * 7 + 1);
    else from = S(now.y, now.m - n, now.d + 1);
    return { from, to: S(now.y, now.m, now.d + 1), label: `the last ${n} ${unit}${n === 1 ? '' : 's'}` };
  }
  m = lower.match(/^next:(\d{1,3}):(days?|weeks?|months?)$/);
  if (m) {
    const n = +m[1];
    const unit = m[2].replace(/s$/, '');
    const to = unit === 'day' ? S(now.y, now.m, now.d + n + 1) : unit === 'week' ? S(now.y, now.m, now.d + n * 7 + 1) : S(now.y, now.m + n, now.d + 1);
    return { from: S(now.y, now.m, now.d), to, label: `the next ${n} ${unit}${n === 1 ? '' : 's'}` };
  }
  m = lower.match(/^year:(\d{4})$/);
  if (m) return { from: S(+m[1], 0, 1), to: S(+m[1] + 1, 0, 1), label: m[1] };
  m = lower.match(/^(january|february|march|april|may|june|july|august|september|october|november|december)[-_ ]?(\d{4})?$/);
  if (m) {
    const mi = MONTHS.indexOf(m[1]);
    const y = m[2] ? +m[2] : now.y;
    return { from: S(y, mi, 1), to: S(y, mi + 1, 1), label: `${cap(m[1])} ${y}` };
  }
  return { from: null, to: null, label: 'all time' };
}

function ciExact(value) {
  return new RegExp(`^\\s*${escapeRegex(String(value).trim())}\\s*$`, 'i');
}

function resolveToken(value, kind) {
  if (value === '$today') { const n = nepalToday(); return dayStart(n.y, n.m, n.d, kind); }
  if (value === '$now') return new Date();
  return value;
}

function applyFilter(entity, info, f, kind) {
  const field = f.field;
  if (!field || !info.all.has(field)) return null;
  const op = f.op || 'eq';
  if (op === 'filled') return { [field]: { $exists: true, $nin: ['', null, 'No', 'no', 'NO', 'N/A', 'n/a', '-'] } };
  if (op === 'empty') return { $or: [{ [field]: { $exists: false } }, { [field]: { $in: ['', null] } }] };
  if (op === 'gte' || op === 'lt') {
    const v = resolveToken(f.value, kind);
    return { [field]: { [op === 'gte' ? '$gte' : '$lt']: v } };
  }
  if (f.value === undefined || f.value === null || String(f.value).trim() === '') return null;
  if (info.numbers.includes(field)) {
    const n = Number(f.value);
    return Number.isFinite(n) ? { [field]: n } : null;
  }
  if (op === 'regex') return { [field]: new RegExp(String(f.value), 'i') };
  if (op === 'contains') return { [field]: new RegExp(escapeRegex(String(f.value).trim()), 'i') };
  if (info.refs.includes(field)) return null;
  return { [field]: ciExact(f.value) };
}

function textClause(entity, info, text) {
  const rx = new RegExp(escapeRegex(String(text).trim()), 'i');
  const ors = info.strings.map(k => ({ [k]: rx }));
  info.arrays.forEach(k => ors.push({ [k]: rx }));
  if (entity.mapField) {
    ors.push({
      $expr: {
        $gt: [{
          $size: {
            $filter: {
              input: { $objectToArray: { $ifNull: [`$${entity.mapField}`, {}] } },
              cond: { $regexMatch: { input: { $toString: { $ifNull: ['$$this.v', ''] } }, regex: rx.source, options: 'i' } }
            }
          }
        }, 0]
      }
    });
  }
  return ors.length ? { $or: ors } : null;
}

async function resolveCountryName(name) {
  if (!name) return null;
  return Country.findOne({
    $or: [{ name: ciExact(name) }, { code: ciExact(name) }]
  }).select('name code flag').lean();
}

function dateFieldOf(entity, key) {
  const list = entity.dateFields || [];
  return list.find(d => d.key === key) || list.find(d => d.default) || list[0] || null;
}

async function buildFilter(user, entity, q) {
  const info = schemaInfo(entity);
  const and = [];
  const scope = entity.scope(user);
  if (scope && Object.keys(scope).length) and.push(scope);

  let countryDoc = null;
  if (q.country) {
    if (!entity.countryField) {
    } else {
      countryDoc = await resolveCountryName(q.country);
      if (!countryDoc) throw { status: 404, message: `I don't see a country called "${q.country}".` };
      const sc = countryScope(user);
      if (sc && !sc.$in.some(id => String(id) === String(countryDoc._id))) {
        throw { status: 403, message: `You don't have access to ${countryDoc.name}.` };
      }
      and.push({ [entity.countryField]: countryDoc._id });
    }
  }

  const presetKeys = Array.isArray(q.presets) ? q.presets : (q.preset ? [q.preset] : []);
  const presetDefs = presetKeys.map(k => (entity.presets || []).find(p => p.key === k)).filter(Boolean);
  let dateKey = q.dateField;
  let presetDateKey = null;
  presetDefs.forEach(p => {
    const dk = dateFieldOf(entity, p.filter.field);
    const frag = applyFilter(entity, info, p.filter, dk ? dk.kind : 'date');
    if (frag) and.push(frag);
    if (p.extra) {
      const ek = dateFieldOf(entity, p.extra.field);
      const ef = applyFilter(entity, info, p.extra, ek ? ek.kind : 'instant');
      if (ef) and.push(ef);
    }
    if (p.dateField && !dateKey) { dateKey = p.dateField; presetDateKey = p.dateField; }
  });

  (Array.isArray(q.filters) ? q.filters : []).slice(0, 12).forEach(f => {
    if (f && f.field === 'country' && entity.countryField) return;
    const dk = dateFieldOf(entity, f && f.field);
    const frag = applyFilter(entity, info, f || {}, dk ? dk.kind : 'date');
    if (frag) and.push(frag);
  });

  if (q.range && q.range !== 'allTime') {
    const df = dateFieldOf(entity, dateKey);
    if (df) {
      const r = resolveRange(q.range, df.kind, q.from, q.to);
      if (r.from || r.to) {
        const cond = {};
        if (r.from) cond.$gte = r.from;
        if (r.to) cond.$lt = r.to;
        const defKey = (dateFieldOf(entity, null) || {}).key;
        if (!q.dateField && presetDateKey && df.key === presetDateKey && defKey && defKey !== df.key) {
          and.push({ $or: [{ [df.key]: cond }, { [df.key]: null, [defKey]: cond }] });
        } else {
          and.push({ [df.key]: cond });
        }
      }
      q._rangeLabel = r.label;
      q._dateLabel = df.label;
    }
  }

  if (q.text && String(q.text).trim()) {
    const t = textClause(entity, info, q.text);
    if (t) and.push(t);
  }

  q._countryDoc = countryDoc;
  q._presetLabels = presetDefs.map(p => p.label);
  return and.length ? { $and: and } : {};
}

function fmtVal(v, dateKind) {
  if (v === undefined || v === null || v === '') return '';
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    if (dateKind === 'instant') return new Date(v.getTime() + NEPAL_OFFSET_MIN * 60000).toISOString().replace('T', ' ').slice(0, 16);
    return v.toISOString().slice(0, 10);
  }
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

function toItem(entity, d, countryMap) {
  const info = schemaInfo(entity);
  const fields = [];
  (entity.show || []).forEach(k => {
    if (!info.all.has(k) && !(k in d)) return;
    const dk = (entity.dateFields || []).find(x => x.key === k);
    const val = fmtVal(d[k], dk ? dk.kind : 'date');
    if (val) fields.push({ label: humanize(k, entity), value: val });
  });
  const cid = entity.countryField && d[entity.countryField] ? String(d[entity.countryField]) : '';
  const country = cid && countryMap[cid] ? countryMap[cid] : null;
  const df = dateFieldOf(entity, null);
  return {
    _id: String(d._id),
    entity: entity.key,
    title: String(entity.title(d) || '').trim() || '(no name)',
    subtitle: entity.subtitle ? entity.subtitle(d) : '',
    fields,
    date: df && d[df.key] ? fmtVal(d[df.key], df.kind) : '',
    country: country ? { _id: cid, name: country.name } : null,
    slug: (d.testType && d.testType.slug) || (d.group && d.group.slug) || '',
    intakeId: d.intake ? String(d.intake) : ''
  };
}

async function countryMapFor(docs, entity) {
  if (!entity.countryField) return {};
  const ids = [...new Set(docs.map(d => d[entity.countryField]).filter(Boolean).map(String))];
  if (!ids.length) return {};
  const cs = await Country.find({ _id: { $in: ids } }).select('name').lean();
  return Object.fromEntries(cs.map(c => [String(c._id), c]));
}

function selectFor(entity) {
  if (entity._select !== undefined) return entity._select;
  const hide = new Set(entity.exclude || []);
  entity.model().schema.eachPath(p => { if (SENSITIVE_FIELD.test(p)) hide.add(p); });
  entity._select = hide.size ? [...hide].map(h => `-${h}`).join(' ') : null;
  return entity._select;
}

const vocabCache = new Map();
const VOCAB_TTL = 45 * 1000;

async function vocabFor(user, entity) {
  const ck = `${user._id}:${entity.key}`;
  const hit = vocabCache.get(ck);
  if (hit && Date.now() - hit.at < VOCAB_TTL) return hit.data;
  const info = schemaInfo(entity);
  const scope = entity.scope(user) || {};
  const Model = entity.model();
  const data = {};
  await Promise.all((entity.vocab || []).filter(f => info.all.has(f)).map(async f => {
    try {
      const vals = await Model.distinct(f, scope);
      const clean = [];
      const seen = new Set();
      vals.forEach(v => {
        const t = String(v === null || v === undefined ? '' : v).trim().replace(/[,\s]+$/, '');
        if (t && t.length <= 80 && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); clean.push(t); }
      });
      if (clean.length > 0 && clean.length <= 1500) data[f] = clean.sort((a, b) => a.localeCompare(b));
    } catch (e) { }
  }));
  vocabCache.set(ck, { at: Date.now(), data });
  return data;
}

function entityMeta(user, e, vocab) {
  const info = schemaInfo(e);
  const fields = [...info.strings, ...info.numbers, ...info.dates, ...info.arrays].map(k => ({
    key: k, label: humanize(k, e),
    type: info.dates.includes(k) ? 'date' : info.numbers.includes(k) ? 'number' : 'text'
  }));
  const fieldWords = { ...(e.fieldWords || {}) };
  fields.forEach(f => {
    if (!fieldWords[f.key]) {
      const w = humanize(f.key, e).split(' ').filter(x => x.length > 3 && !['name', 'date'].includes(x));
      if (w.length) fieldWords[f.key] = w;
    }
  });
  return {
    key: e.key, label: e.label, singular: e.singular, aliases: e.aliases || [],
    countryBased: !!e.countryField, titleField: e.titleField || null,
    dateFields: (e.dateFields || []).map(d => ({ key: d.key, label: d.label, default: !!d.default })),
    fields, groupable: e.groupable || [], fieldWords,
    presets: (e.presets || []).map(p => ({ key: p.key, label: p.label, phrases: p.phrases, dateField: p.dateField || null })),
    vocab: vocab || {}
  };
}

router.get('/catalog', async (req, res) => {
  try {
    const user = req.user;
    const allowed = ENTITIES.filter(e => canUseEntity(user, e));
    const denied = ENTITIES.filter(e => !canUseEntity(user, e));
    const vocabs = await Promise.all(allowed.map(e => vocabFor(user, e)));

    const countryQuery = countryScope(user) ? { _id: countryScope(user) } : {};
    const countries = await Country.find(countryQuery).select('name code').sort({ name: 1 }).lean();

    const features = FEATURES.filter(f => canUseFeature(user, f)).map(f => ({
      key: f.key, label: f.label, path: f.path, exact: !!f.exact, aliases: f.aliases || [], desc: f.desc || '',
      keywords: f.keywords || '', userOpen: f.userOpen || null, actions: featureActions(user, f)
    }));
    const restricted = [
      ...denied.map(e => ({ key: e.key, label: e.label, aliases: e.aliases || [] })),
      ...FEATURES.filter(f => !canUseFeature(user, f)).map(f => ({ key: f.key, label: f.label, aliases: [f.label.toLowerCase(), ...(f.aliases || [])] }))
    ];

    res.json({
      me: { role: user.role, isSuperAdmin: isSuper(user), isAdmin: ['admin', 'super_admin'].includes(user.role), name: user.name || user.username },
      entities: allowed.map((e, i) => entityMeta(user, e, vocabs[i])),
      restricted,
      features,
      countries: countries.map(c => ({ _id: String(c._id), name: c.name, code: c.code || '' }))
    });
  } catch (err) {
    console.error('Assistant catalog error:', err);
    res.status(500).json({ message: 'Failed to load assistant data' });
  }
});

function guard(user, entity) {
  if (!entity) throw { status: 400, message: 'I could not tell which records you meant.' };
  if (!canUseEntity(user, entity)) {
    throw { status: 403, message: `You don't have access to ${entity.label.toLowerCase()}.` };
  }
}

const RESOLVE_GROUP = {
  country: { model: () => Country, field: 'name' },
  testType: { model: () => require('../models/TestType'), field: 'name' },
  group: { model: () => require('../models/ContactGroup'), field: 'name' }
};

router.post('/query', async (req, res) => {
  try {
    const user = req.user;
    const q = { ...(req.body || {}) };
    const entity = entityByKey[q.entity];
    guard(user, entity);
    const Model = entity.model();
    const info = schemaInfo(entity);
    const filter = await buildFilter(user, entity, q);
    const op = ['count', 'list', 'top', 'duplicates'].includes(q.op) ? q.op : 'count';

    const base = {
      entity: entity.key, entityLabel: entity.label, singular: entity.singular, op,
      presetLabels: q._presetLabels || [], range: q._rangeLabel || null, dateLabel: q._dateLabel || null,
      country: q._countryDoc ? q._countryDoc.name : null
    };

    if (op === 'count') {
      const count = await Model.countDocuments(filter);
      return res.json({ ...base, count });
    }

    if (op === 'list') {
      const limit = Math.min(Math.max(Number(q.limit) || 8, 1), 25);
      let cursor = Model.find(filter);
      const sel = selectFor(entity);
      if (sel) cursor = cursor.select(sel);
      const sortKey = (dateFieldOf(entity, q.dateField) || {}).key;
      cursor = cursor.sort(sortKey ? { [sortKey]: q.order === 'asc' ? 1 : -1, _id: -1 } : { _id: -1 }).limit(limit);
      (entity.populate || []).forEach(p => { cursor = cursor.populate(p); });
      const [docs, count] = await Promise.all([cursor.lean(), Model.countDocuments(filter)]);
      const cmap = await countryMapFor(docs, entity);
      return res.json({ ...base, count, items: docs.map(d => toItem(entity, d, cmap)) });
    }

    if (op === 'top') {
      const gf = String(q.groupBy || '');
      const allowedGroup = new Set([...(entity.groupable || []), ...info.strings]);
      if (!gf || !allowedGroup.has(gf) || SENSITIVE_FIELD.test(gf)) {
        return res.status(400).json({ message: "I can't group that by that field." });
      }
      const limit = Math.min(Math.max(Number(q.limit) || 10, 1), 30);
      const pipeline = [{ $match: filter }];
      const isArray = info.arrays.includes(gf);
      if (isArray) pipeline.push({ $unwind: `$${gf}` });
      const idExpr = info.refs.includes(gf) ? `$${gf}` : { $trim: { input: { $toString: { $ifNull: [`$${gf}`, ''] } } } };
      pipeline.push({ $group: { _id: idExpr, count: { $sum: 1 } } });
      pipeline.push({ $match: { _id: { $nin: ['', null] } } });
      pipeline.push({ $sort: { count: q.order === 'asc' ? 1 : -1, _id: 1 } });
      pipeline.push({ $limit: limit });
      const rows = await Model.aggregate(pipeline);
      let groups = rows.map(r => ({ name: String(r._id), count: r.count }));
      if (RESOLVE_GROUP[gf] && info.refs.includes(gf)) {
        const R = RESOLVE_GROUP[gf];
        const docs = await R.model().find({ _id: { $in: rows.map(r => r._id) } }).select(R.field).lean();
        const nm = Object.fromEntries(docs.map(d => [String(d._id), d[R.field]]));
        groups = rows.map(r => ({ name: nm[String(r._id)] || 'Unknown', count: r.count }));
      }
      const total = await Model.countDocuments(filter);
      return res.json({ ...base, groupBy: gf, groupLabel: humanize(gf, entity), groups, count: total });
    }

    if (!entity.titleField) return res.status(400).json({ message: "Duplicate checks aren't available for that." });
    const keyExpr = { t: { $toLower: { $trim: { input: { $toString: { $ifNull: [`$${entity.titleField}`, ''] } } } } } };
    if (entity.countryField) keyExpr.c = `$${entity.countryField}`;
    const rows = await Model.aggregate([
      { $match: filter },
      { $group: { _id: keyExpr, count: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { count: { $gt: 1 }, '_id.t': { $ne: '' } } },
      { $sort: { count: -1 } }, { $limit: 15 }
    ]);
    const cmap = {};
    if (entity.countryField) {
      const cs = await Country.find({ _id: { $in: rows.map(r => r._id.c).filter(Boolean) } }).select('name').lean();
      cs.forEach(c => { cmap[String(c._id)] = c.name; });
    }
    return res.json({
      ...base,
      duplicates: rows.map(r => ({ name: r._id.t, country: r._id.c ? cmap[String(r._id.c)] || '' : '', count: r.count, id: String(r.ids[0]) })),
      count: rows.length
    });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ message: err.message });
    console.error('Assistant query error:', err);
    res.status(500).json({ message: 'I could not work that out right now.' });
  }
});

router.get('/search', async (req, res) => {
  try {
    const user = req.user;
    const text = String(req.query.q || '').trim();
    if (text.length < 2) return res.status(400).json({ message: 'Type at least 2 characters to search.' });
    const only = req.query.entity ? String(req.query.entity).split(',') : null;
    const entities = ENTITIES.filter(e => canUseEntity(user, e) && (!only || only.includes(e.key)));
    const rx = new RegExp(escapeRegex(text), 'i');

    const results = [];
    const run = async (phase) => {
      await Promise.all(entities.map(async e => {
        if (phase === 1 && !e.titleField && !e.mapField) return;
        if (phase === 2 && results.some(r => r.entity === e.key)) return;
        const Model = e.model();
        const info = schemaInfo(e);
        const scope = e.scope(user) || {};
        let match;
        if (phase === 1) {
          match = e.titleField ? { [e.titleField]: rx } : textClause(e, info, text);
          if (e.key === 'users') match = { $or: [{ name: rx }, { username: rx }] };
        } else {
          match = textClause(e, info, text);
        }
        if (!match) return;
        const filter = Object.keys(scope).length ? { $and: [scope, match] } : match;
        let cursor = Model.find(filter);
        const sel = selectFor(e);
        if (sel) cursor = cursor.select(sel);
        (e.populate || []).forEach(p => { cursor = cursor.populate(p); });
        const [docs, total] = await Promise.all([cursor.sort({ _id: -1 }).limit(6).lean(), Model.countDocuments(filter)]);
        if (!docs.length) return;
        const cmap = await countryMapFor(docs, e);
        results.push({ entity: e.key, entityLabel: e.label, total, items: docs.map(d => toItem(e, d, cmap)) });
      }));
    };
    await run(1);
    if (results.length === 0) await run(2);

    const needle = text.toLowerCase();
    results.sort((a, b) => {
      const ax = a.items.some(i => i.title.toLowerCase() === needle) ? 0 : 1;
      const bx = b.items.some(i => i.title.toLowerCase() === needle) ? 0 : 1;
      return ax - bx || b.total - a.total;
    });
    res.json({ query: text, results });
  } catch (err) {
    console.error('Assistant search error:', err);
    res.status(500).json({ message: 'Search failed.' });
  }
});

module.exports = router;
module.exports._test = { resolveRange, ciExact, nepalToday, dayStart, buildFilter, schemaInfo, selectFor, entityMeta, toItem, canUseEntity, canUseFeature };
