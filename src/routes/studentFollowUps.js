const mongoose = require('mongoose');
const express = require('express');
const StudentFollowUp = require('../models/StudentFollowUp');
const Application = require('../models/Application');
const {
  verifyAccess,
  requirePermission,
  requireSuperAdmin
} = require('../middleware/auth');
const {
  logActivity
} = require('../utils/auditLogger');
const {
  softDelete
} = require('../utils/trashHelper');

const router = express.Router();
router.use(verifyAccess, requirePermission('studentFollowUp', 'access'));

const POPULATE = [
  { path: 'application', select: 'name referredBy providerName course level country' },
  { path: 'country', select: 'name flag code' },
  { path: 'assignedTo', select: 'username name' },
  { path: 'completedBy', select: 'username name' },
  { path: 'createdBy', select: 'username name' }
];

/**
 * Country scoping.
 *
 * super_admin and admin see every country. A regular user sees only the
 * countries assigned to them (or all of them when `allCountries` is set).
 * Returns null when no restriction applies, otherwise a mongo filter fragment.
 */
function countryScope(user) {
  if (['admin', 'super_admin'].includes(user.role)) return null;
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

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

/**
 * Shared by GET / and GET /grouped so the two never drift apart.
 * Throws a small { status, message } object on a bad/forbidden country so
 * the caller can respond consistently.
 */
function buildFilterQuery(req) {
  const {
    tab = 'all',
    search,
    country,
    status,
    method,
    assignedTo,
    dateFrom,
    dateTo
  } = req.query;

  const scope = countryScope(req.user);
  const query = scope ? { ...scope } : {};
  const now = new Date();

  if (country) {
    if (!mongoose.Types.ObjectId.isValid(country)) {
      throw { status: 400, message: 'Invalid country id' };
    }
    if (!canSeeCountry(req.user, country)) {
      throw { status: 403, message: 'Access denied to this country' };
    }
    query.country = new mongoose.Types.ObjectId(country);
  }

  if (tab === 'overdue') {
    query.status = 'pending';
    query.scheduledAt = { $lt: now };
  } else if (tab === 'today') {
    query.status = 'pending';
    query.scheduledAt = { $gte: startOfDay(now), $lte: endOfDay(now) };
  } else if (tab === 'upcoming') {
    query.status = 'pending';
    query.scheduledAt = { $gt: endOfDay(now) };
  } else if (tab === 'completed') {
    query.status = { $in: ['completed', 'no_response'] };
  }

  if (status) {
    query.status = { $in: String(status).split(',') };
  }
  if (method) {
    query.method = { $in: String(method).split(',') };
  }
  if (assignedTo && mongoose.Types.ObjectId.isValid(assignedTo)) {
    query.assignedTo = new mongoose.Types.ObjectId(assignedTo);
  }

  if (dateFrom || dateTo) {
    const range = query.scheduledAt && typeof query.scheduledAt === 'object' ? { ...query.scheduledAt } : {};
    if (dateFrom) range.$gte = startOfDay(new Date(dateFrom));
    if (dateTo) range.$lte = endOfDay(new Date(dateTo));
    query.scheduledAt = range;
  }

  if (search) {
    const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [
      { studentName: rx },
      { referredBy: rx },
      { providerName: rx },
      { notes: rx },
      { plannedNotes: rx }
    ];
  }

  return query;
}

function decorate(doc) {
  const o = doc.toObject ? doc.toObject() : doc;
  const app = o.application && typeof o.application === 'object' ? o.application : null;
  return {
    ...o,
    // Live values win; the stored snapshot is only a fallback for deleted apps.
    studentName: app?.name || o.studentName || '',
    referredBy: app?.referredBy || o.referredBy || '',
    providerName: app?.providerName || o.providerName || '',
    isOverdue: o.status === 'pending' && o.scheduledAt && new Date(o.scheduledAt) < new Date()
  };
}

/* Stats — sidebar badge + dashboard tab counts                        */
router.get('/stats', requirePermission('studentFollowUp', 'view'), async (req, res) => {
  try {
    const scope = countryScope(req.user) || {};
    const now = new Date();
    const todayEnd = endOfDay(now);
    const weekEnd = endOfDay(new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000));

    const [overdue, today, upcoming, pending, completed, total] = await Promise.all([
      StudentFollowUp.countDocuments({ ...scope, status: 'pending', scheduledAt: { $lt: now } }),
      StudentFollowUp.countDocuments({ ...scope, status: 'pending', scheduledAt: { $gte: now, $lte: todayEnd } }),
      StudentFollowUp.countDocuments({ ...scope, status: 'pending', scheduledAt: { $gt: todayEnd, $lte: weekEnd } }),
      StudentFollowUp.countDocuments({ ...scope, status: 'pending' }),
      StudentFollowUp.countDocuments({ ...scope, status: 'completed' }),
      StudentFollowUp.countDocuments({ ...scope })
    ]);

    res.json({ stats: { overdue, today, upcoming, pending, completed, total } });
  } catch (err) {
    console.error('Failed to fetch student follow-up stats:', err);
    res.status(500).json({ message: 'Failed to fetch stats' });
  }
});

/**
 * Super Admin overview — a dashboard, not a nag. Super Admin manages the
 * system rather than being personally assigned follow-ups, so instead of the
 * banner they get totals plus a who/when/where activity feed.
 */
router.get('/admin-summary', requireSuperAdmin, async (req, res) => {
  try {
    const now = new Date();
    const todayEnd = endOfDay(now);

    const [total, pending, completed, cancelled, today, overdue] = await Promise.all([
      StudentFollowUp.countDocuments({}),
      StudentFollowUp.countDocuments({ status: 'pending' }),
      StudentFollowUp.countDocuments({ status: 'completed' }),
      StudentFollowUp.countDocuments({ status: 'cancelled' }),
      StudentFollowUp.countDocuments({ status: 'pending', scheduledAt: { $gte: now, $lte: todayEnd } }),
      StudentFollowUp.countDocuments({ status: 'pending', scheduledAt: { $lt: now } })
    ]);

    const recent = await StudentFollowUp.find({})
      .sort({ updatedAt: -1 })
      .limit(25)
      .populate('country', 'name flag')
      .populate('assignedTo', 'username name')
      .populate('completedBy', 'username name')
      .lean();

    const activity = recent.map(r => ({
      id: r._id,
      studentName: r.studentName,
      country: r.country ? { name: r.country.name, flag: r.country.flag } : null,
      status: r.status,
      who: (r.status === 'pending' ? r.assignedTo : r.completedBy)?.name
        || (r.status === 'pending' ? r.assignedTo : r.completedBy)?.username || '—',
      when: r.status === 'pending' ? r.scheduledAt : (r.completedAt || r.updatedAt)
    }));

    res.json({
      totals: { total, pending, completed, cancelled, today, overdue },
      activity
    });
  } catch (err) {
    console.error('Failed to fetch student follow-up admin summary:', err);
    res.status(500).json({ message: 'Failed to fetch summary' });
  }
});

/* Notifications — polled by the bell, mirrored over socket.io         */
router.get('/notifications', requirePermission('studentFollowUp', 'view'), async (req, res) => {
  try {
    const scope = countryScope(req.user) || {};
    const now = new Date();
    const soon = new Date(now.getTime() + 30 * 60 * 1000);
    // Banner/red warning covers the present day only (Nepal calendar day);
    // older overdue items stay on the Student Follow-up page, not the banner.
    const todayNp = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kathmandu' });
    const startOfToday = new Date(`${todayNp}T00:00:00+05:45`);

    const docs = await StudentFollowUp.find({
      ...scope,
      status: 'pending',
      scheduledAt: { $gte: startOfToday, $lte: soon }
    })
      .sort({ scheduledAt: 1 })
      .limit(25)
      .populate(POPULATE);

    const notifications = docs.map(d => {
      const o = decorate(d);
      return {
        id: `sfu-${o._id}`,
        followUpId: String(o._id),
        studentName: o.studentName,
        countryName: o.country?.name || '',
        isOverdue: o.isOverdue,
        type: o.isOverdue ? 'warning' : 'info',
        title: o.isOverdue ? 'Follow-up overdue' : 'Follow-up starting soon',
        message: `${o.studentName || 'Student'} — ${o.country?.name || ''}`.trim(),
        time: o.scheduledAt,
        link: `/student-follow-up?focus=${o._id}`
      };
    });

    res.json({ notifications, total: notifications.length });
  } catch (err) {
    console.error('Failed to fetch student follow-up notifications:', err);
    res.status(500).json({ message: 'Failed to fetch notifications' });
  }
});

/* Timeline for one application                                        */
router.get('/application/:applicationId', requirePermission('studentFollowUp', 'view'), async (req, res) => {
  try {
    const { applicationId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(applicationId)) {
      return res.status(400).json({ message: 'Invalid application id' });
    }
    const application = await Application.findById(applicationId).populate('country', 'name flag code');
    if (!application) return res.status(404).json({ message: 'Application not found' });

    const countryId = application.country?._id || application.country;
    if (!canSeeCountry(req.user, countryId)) {
      return res.status(403).json({ message: 'Access denied to this country' });
    }

    const docs = await StudentFollowUp.find({ application: applicationId })
      .sort({ scheduledAt: -1, createdAt: -1 })
      .populate(POPULATE);

    res.json({
      followUps: docs.map(decorate),
      application: {
        _id: application._id,
        name: application.name,
        referredBy: application.referredBy || '',
        providerName: application.providerName || '',
        course: application.course || '',
        level: application.level || '',
        country: application.country
      }
    });
  } catch (err) {
    console.error('Failed to fetch student timeline:', err);
    res.status(500).json({ message: 'Failed to fetch follow-up history' });
  }
});

/* Pending-per-application map (status pills in the country table)     */
router.get('/pending-map/:countryId', requirePermission('studentFollowUp', 'view'), async (req, res) => {
  try {
    const { countryId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(countryId)) {
      return res.status(400).json({ message: 'Invalid country id' });
    }
    if (!canSeeCountry(req.user, countryId)) {
      return res.status(403).json({ message: 'Access denied to this country' });
    }
    const docs = await StudentFollowUp.find({ country: countryId, status: 'pending' })
      .select('application scheduledAt')
      .sort({ scheduledAt: 1 })
      .lean();

    const map = {};
    docs.forEach(d => {
      const key = String(d.application);
      if (!map[key]) {
        map[key] = { earliest: d.scheduledAt, count: 1 };
      } else {
        map[key].count += 1;
      }
    });
    res.json({ pending: map });
  } catch (err) {
    console.error('Failed to fetch pending map:', err);
    res.status(500).json({ message: 'Failed to fetch pending follow-ups' });
  }
});

/* List                                                                */
router.get('/', requirePermission('studentFollowUp', 'view'), async (req, res) => {
  try {
    const { limit = 500 } = req.query;
    const tab = req.query.tab || 'all';
    let query;
    try {
      query = buildFilterQuery(req);
    } catch (e) {
      return res.status(e.status || 500).json({ message: e.message || 'Invalid filter' });
    }

    const docs = await StudentFollowUp.find(query)
      .sort({ scheduledAt: tab === 'completed' ? -1 : 1, createdAt: -1 })
      .limit(Math.min(Number(limit) || 500, 2000))
      .populate(POPULATE);

    const totalInDB = await StudentFollowUp.countDocuments(query);

    res.json({
      followUps: docs.map(decorate),
      total: docs.length,
      returned: docs.length,
      totalInDB
    });
  } catch (err) {
    console.error('Failed to fetch student follow-ups:', err);
    res.status(500).json({ message: 'Failed to fetch follow-ups' });
  }
});

/* Grouped by student — nested dashboard view                          */
/*                                                                      */
/* The tab/filters decide WHICH students appear (any student with at   */
/* least one matching entry), but every matching student's FULL        */
/* history — every entry, past and pending — comes back so the nested  */
/* row never needs a second fetch to show old remarks.                 */
/**
 * Groups an application-linked entry by its application id, and a standalone
 * entry by its chain root (or its own id, if it IS the root) — so a chain of
 * standalone follow-ups (created via Complete & Schedule Next) still nests
 * into one row the way application-linked follow-ups do.
 */
function groupKeyOf(doc) {
  const appId = doc.application && (doc.application._id || doc.application);
  if (appId) return `app:${String(appId)}`;
  const rootId = doc.chainRoot && (doc.chainRoot._id || doc.chainRoot);
  return `standalone:${String(rootId || doc._id)}`;
}

router.get('/grouped', requirePermission('studentFollowUp', 'view'), async (req, res) => {
  try {
    const { limit = 200 } = req.query;
    let matchQuery;
    try {
      matchQuery = buildFilterQuery(req);
    } catch (e) {
      return res.status(e.status || 500).json({ message: e.message || 'Invalid filter' });
    }

    const matchDocs = await StudentFollowUp.find(matchQuery).select('application chainRoot').lean();
    const allKeys = [...new Set(matchDocs.map(groupKeyOf))];
    const pageKeys = allKeys.slice(0, Math.min(Number(limit) || 200, 500));

    if (pageKeys.length === 0) {
      return res.json({ students: [], totalStudents: 0, totalMatchingStudents: allKeys.length });
    }

    const appIds = [];
    const standaloneRootIds = [];
    pageKeys.forEach(k => {
      const [type, id] = k.split(':');
      if (type === 'app') appIds.push(new mongoose.Types.ObjectId(id));
      else standaloneRootIds.push(new mongoose.Types.ObjectId(id));
    });

    const orClauses = [];
    if (appIds.length) orClauses.push({ application: { $in: appIds } });
    if (standaloneRootIds.length) {
      orClauses.push({ _id: { $in: standaloneRootIds } });
      orClauses.push({ chainRoot: { $in: standaloneRootIds } });
    }

    const entries = await StudentFollowUp.find({ $or: orClauses })
      .sort({ scheduledAt: -1 })
      .populate(POPULATE);

    const grouped = {};
    entries.forEach(doc => {
      const o = decorate(doc);
      const key = groupKeyOf(doc);
      if (!grouped[key]) {
        grouped[key] = {
          groupKey: key,
          applicationId: doc.application ? String(doc.application._id || doc.application) : null,
          isStandalone: !doc.application,
          studentName: o.studentName,
          referredBy: o.referredBy,
          providerName: o.providerName,
          country: o.country,
          entries: []
        };
      }
      grouped[key].entries.push(o);
    });

    const students = Object.values(grouped).map(g => {
      // Pending first (soonest first), then everything else newest-first —
      // matches how staff scan a timeline: what's coming up, then what happened.
      g.entries.sort((a, b) => {
        if (a.status === 'pending' && b.status !== 'pending') return -1;
        if (a.status !== 'pending' && b.status === 'pending') return 1;
        if (a.status === 'pending') return new Date(a.scheduledAt) - new Date(b.scheduledAt);
        return new Date(b.scheduledAt) - new Date(a.scheduledAt);
      });
      const pending = g.entries.filter(e => e.status === 'pending');
      const overdueCount = pending.filter(e => e.isOverdue).length;
      const nextScheduledAt = pending.length
        ? pending.slice().sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))[0].scheduledAt
        : null;
      return {
        ...g,
        pendingCount: pending.length,
        overdueCount,
        nextScheduledAt
      };
    });

    // Soonest next follow-up first; students with none go last.
    students.sort((a, b) => {
      if (!a.nextScheduledAt && !b.nextScheduledAt) return 0;
      if (!a.nextScheduledAt) return 1;
      if (!b.nextScheduledAt) return -1;
      return new Date(a.nextScheduledAt) - new Date(b.nextScheduledAt);
    });

    res.json({
      students,
      totalStudents: students.length,
      totalMatchingStudents: allKeys.length
    });
  } catch (err) {
    console.error('Failed to fetch grouped student follow-ups:', err);
    res.status(500).json({ message: 'Failed to fetch follow-ups' });
  }
});

/* Create                                                              */
router.post('/', requirePermission('studentFollowUp', 'create'), async (req, res) => {
  try {
    const {
      application: applicationId,
      scheduledAt,
      method,
      status,
      notes,
      plannedNotes,
      assignedTo,
      // Standalone-only fields — used when no applicationId is provided.
      studentName,
      country: standaloneCountryId,
      referredBy,
      providerName
    } = req.body;

    if (!scheduledAt) {
      return res.status(400).json({ message: 'Follow-up date and time are required' });
    }

    // Two creation paths: linked to an existing application (original
    // behaviour), or a standalone follow-up for a student who isn't in the
    // application pipeline yet — the user just needs a name and a country.
    if (applicationId) {
      if (!mongoose.Types.ObjectId.isValid(applicationId)) {
        return res.status(400).json({ message: 'A valid application is required' });
      }
      const application = await Application.findById(applicationId);
      if (!application) return res.status(404).json({ message: 'Application not found' });

      const countryId = application.country;
      if (!canSeeCountry(req.user, countryId)) {
        return res.status(403).json({ message: 'Access denied to this country' });
      }

      const created = await StudentFollowUp.create({
        application: application._id,
        country: countryId,
        studentName: application.name || '',
        referredBy: application.referredBy || '',
        providerName: application.providerName || '',
        scheduledAt: new Date(scheduledAt),
        method: method || 'call',
        status: status || 'pending',
        notes: notes || '',
        plannedNotes: plannedNotes || '',
        assignedTo: assignedTo && mongoose.Types.ObjectId.isValid(assignedTo) ? assignedTo : req.user._id,
        completedAt: status && status !== 'pending' ? new Date() : null,
        completedBy: status && status !== 'pending' ? req.user._id : null,
        createdBy: req.user._id
      });

      const populated = await StudentFollowUp.findById(created._id).populate(POPULATE);
      await logActivity(req, 'student_followup_create', {
        targetType: 'StudentFollowUp',
        targetId: created._id,
        message: `Created follow-up for ${application.name}`
      });

      return res.status(201).json({ followUp: decorate(populated) });
    }

    // Standalone path — no application at all.
    if (!studentName || !String(studentName).trim()) {
      return res.status(400).json({ message: 'Student name is required' });
    }
    if (!standaloneCountryId || !mongoose.Types.ObjectId.isValid(standaloneCountryId)) {
      return res.status(400).json({ message: 'A valid country is required' });
    }
    if (!canSeeCountry(req.user, standaloneCountryId)) {
      return res.status(403).json({ message: 'Access denied to this country' });
    }

    const created = await StudentFollowUp.create({
      application: null,
      isStandalone: true,
      chainRoot: null,
      country: standaloneCountryId,
      studentName: String(studentName).trim(),
      referredBy: referredBy || '',
      providerName: providerName || '',
      scheduledAt: new Date(scheduledAt),
      method: method || 'call',
      status: status || 'pending',
      notes: notes || '',
      plannedNotes: plannedNotes || '',
      assignedTo: assignedTo && mongoose.Types.ObjectId.isValid(assignedTo) ? assignedTo : req.user._id,
      completedAt: status && status !== 'pending' ? new Date() : null,
      completedBy: status && status !== 'pending' ? req.user._id : null,
      createdBy: req.user._id
    });

    const populated = await StudentFollowUp.findById(created._id).populate(POPULATE);
    await logActivity(req, 'student_followup_create', {
      targetType: 'StudentFollowUp',
      targetId: created._id,
      message: `Created standalone follow-up for ${created.studentName}`
    });

    res.status(201).json({ followUp: decorate(populated) });
  } catch (err) {
    console.error('Failed to create student follow-up:', err);
    res.status(500).json({ message: 'Failed to create follow-up' });
  }
});

/* Complete & schedule next                                            */
router.post('/:id/complete', requirePermission('studentFollowUp', 'edit'), async (req, res) => {
  try {
    const current = await StudentFollowUp.findById(req.params.id);
    if (!current) return res.status(404).json({ message: 'Follow-up not found' });
    if (!canSeeCountry(req.user, current.country)) {
      return res.status(403).json({ message: 'Access denied to this country' });
    }

    const {
      method,
      outcome,
      notes,
      scheduleNext,
      nextScheduledAt,
      nextNotes,
      nextMethod,
      nextAssignedTo
    } = req.body;

    const finalStatus = ['completed', 'no_response', 'cancelled'].includes(outcome) ? outcome : 'completed';

    current.status = finalStatus;
    current.notes = notes !== undefined ? notes : current.notes;
    if (method) current.method = method;
    current.completedAt = new Date();
    current.completedBy = req.user._id;

    let next = null;
    if (scheduleNext) {
      if (!nextScheduledAt) {
        return res.status(400).json({ message: 'Next follow-up date and time are required' });
      }
      next = await StudentFollowUp.create({
        application: current.application,
        isStandalone: current.isStandalone,
        chainRoot: current.isStandalone ? (current.chainRoot || current._id) : null,
        country: current.country,
        studentName: current.studentName,
        referredBy: current.referredBy,
        providerName: current.providerName,
        scheduledAt: new Date(nextScheduledAt),
        method: nextMethod || current.method || 'call',
        status: 'pending',
        plannedNotes: nextNotes || '',
        assignedTo: nextAssignedTo && mongoose.Types.ObjectId.isValid(nextAssignedTo)
          ? nextAssignedTo
          : (current.assignedTo || req.user._id),
        previousFollowUp: current._id,
        createdBy: req.user._id
      });
      current.nextFollowUp = next._id;
    }

    await current.save();

    const [populatedCurrent, populatedNext] = await Promise.all([
      StudentFollowUp.findById(current._id).populate(POPULATE),
      next ? StudentFollowUp.findById(next._id).populate(POPULATE) : Promise.resolve(null)
    ]);

    await logActivity(req, 'student_followup_complete', {
      targetType: 'StudentFollowUp',
      targetId: current._id,
      message: `Completed follow-up for ${current.studentName}${next ? ' and scheduled the next one' : ''}`
    });

    res.json({
      followUp: decorate(populatedCurrent),
      next: populatedNext ? decorate(populatedNext) : null
    });
  } catch (err) {
    console.error('Failed to complete student follow-up:', err);
    res.status(500).json({ message: 'Failed to complete follow-up' });
  }
});

/**
 * Quick Cancel — distinct from Complete. "Complete" implies the follow-up
 * happened (with an outcome, notes, optional next one). "Cancel" means it's
 * being scrapped outright — no outcome form, just an optional reason. Used
 * by the quick action button and the reminder banner.
 */
router.post('/:id/cancel', requirePermission('studentFollowUp', 'edit'), async (req, res) => {
  try {
    const current = await StudentFollowUp.findById(req.params.id);
    if (!current) return res.status(404).json({ message: 'Follow-up not found' });
    if (!canSeeCountry(req.user, current.country)) {
      return res.status(403).json({ message: 'Access denied to this country' });
    }
    if (current.status !== 'pending') {
      return res.status(400).json({ message: 'Only a pending follow-up can be cancelled' });
    }

    const { reason } = req.body;
    current.status = 'cancelled';
    current.completedAt = new Date();
    current.completedBy = req.user._id;
    if (reason) current.notes = current.notes ? `${current.notes}\nCancelled: ${reason}` : `Cancelled: ${reason}`;
    await current.save();

    const populated = await StudentFollowUp.findById(current._id).populate(POPULATE);
    await logActivity(req, 'student_followup_cancel', {
      targetType: 'StudentFollowUp',
      targetId: current._id,
      message: `Cancelled follow-up for ${current.studentName}`
    });

    res.json({ followUp: decorate(populated) });
  } catch (err) {
    console.error('Failed to cancel student follow-up:', err);
    res.status(500).json({ message: 'Failed to cancel follow-up' });
  }
});

/* Update                                                              */
router.put('/:id', requirePermission('studentFollowUp', 'edit'), async (req, res) => {
  try {
    const doc = await StudentFollowUp.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Follow-up not found' });
    if (!canSeeCountry(req.user, doc.country)) {
      return res.status(403).json({ message: 'Access denied to this country' });
    }

    const { scheduledAt, method, status, notes, plannedNotes, assignedTo } = req.body;

    if (scheduledAt !== undefined) doc.scheduledAt = new Date(scheduledAt);
    if (method !== undefined) doc.method = method;
    if (notes !== undefined) doc.notes = notes;
    if (plannedNotes !== undefined) doc.plannedNotes = plannedNotes;
    if (assignedTo !== undefined) {
      doc.assignedTo = assignedTo && mongoose.Types.ObjectId.isValid(assignedTo) ? assignedTo : null;
    }
    if (status !== undefined) {
      doc.status = status;
      if (status === 'pending') {
        doc.completedAt = null;
        doc.completedBy = null;
      } else if (!doc.completedAt) {
        doc.completedAt = new Date();
        doc.completedBy = req.user._id;
      }
    }
    // Rescheduling must re-arm the reminder.
    if (scheduledAt !== undefined) doc.reminderSentAt = null;

    await doc.save();
    const populated = await StudentFollowUp.findById(doc._id).populate(POPULATE);

    await logActivity(req, 'student_followup_update', {
      targetType: 'StudentFollowUp',
      targetId: doc._id,
      message: `Updated follow-up for ${doc.studentName}`
    });

    res.json({ followUp: decorate(populated) });
  } catch (err) {
    console.error('Failed to update student follow-up:', err);
    res.status(500).json({ message: 'Failed to update follow-up' });
  }
});

/* Delete (soft, via Trash)                                            */
router.delete('/:id', requirePermission('studentFollowUp', 'delete'), async (req, res) => {
  try {
    const doc = await StudentFollowUp.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Follow-up not found' });
    if (!canSeeCountry(req.user, doc.country)) {
      return res.status(403).json({ message: 'Access denied to this country' });
    }

    // Unlink from the chain so history stays navigable.
    if (doc.previousFollowUp) {
      await StudentFollowUp.updateOne({ _id: doc.previousFollowUp }, { $set: { nextFollowUp: doc.nextFollowUp || null } });
    }
    if (doc.nextFollowUp) {
      await StudentFollowUp.updateOne({ _id: doc.nextFollowUp }, { $set: { previousFollowUp: doc.previousFollowUp || null } });
    }

    await softDelete({
      modelName: 'StudentFollowUp',
      doc,
      userId: req.user._id,
      userName: req.user.name || req.user.username,
      meta: { studentName: doc.studentName || '', scheduledAt: doc.scheduledAt }
    });

    await logActivity(req, 'student_followup_delete', {
      targetType: 'StudentFollowUp',
      targetId: doc._id,
      message: `Deleted follow-up for ${doc.studentName}`
    });

    res.json({ message: 'Follow-up moved to trash' });
  } catch (err) {
    console.error('Failed to delete student follow-up:', err);
    res.status(500).json({ message: 'Failed to delete follow-up' });
  }
});

module.exports = router;
