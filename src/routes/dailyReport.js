const express = require('express');
const DailyReport = require('../models/DailyReport');
const DailyReportSettings = require('../models/DailyReportSettings');
const DailyReportUnlock = require('../models/DailyReportUnlock');
const User = require('../models/User');
const {
  verifyAccess,
  requireDailyReportAccess,
  requireSuperAdmin
} = require('../middleware/auth');
const {
  logActivity
} = require('../utils/auditLogger');
const router = express.Router();
router.use(verifyAccess, requireDailyReportAccess);

const DEFAULT_WINDOW_DAYS = 2;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kathmandu' });
}
function daysBetween(dateStr, refStr) {
  return Math.round((Date.parse(`${refStr}T00:00:00Z`) - Date.parse(`${dateStr}T00:00:00Z`)) / 86400000);
}
async function getWindowDays() {
  const doc = await DailyReportSettings.findOne({ key: 'default' }).lean();
  return doc && Number.isFinite(doc.editWindowDays) ? doc.editWindowDays : DEFAULT_WINDOW_DAYS;
}
async function isEditable(userId, dateStr) {
  if (!DATE_RE.test(dateStr || '')) return false;
  const windowDays = await getWindowDays();
  if (daysBetween(dateStr, todayStr()) <= windowDays) return true;
  return !!(await DailyReportUnlock.exists({ user: userId, date: dateStr }));
}
async function editWindowMessage() {
  const n = await getWindowDays();
  return `You can only add or edit reports for today and the last ${n} day${n === 1 ? '' : 's'}. Please ask a Super Admin to unlock an older date.`;
}
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function reportMode(user) {
  if (user.role === 'super_admin') return 'view';
  if (['write', 'view', 'both'].includes(user.dailyReportMode)) return user.dailyReportMode;
  if (user.role === 'user') return user.dailyReportViewOnly ? 'view' : 'write';
  return 'view';
}
function canViewAll(user) {
  const m = reportMode(user);
  return user.role === 'super_admin' || m === 'view' || m === 'both';
}
function canWrite(user) {
  const m = reportMode(user);
  return user.role !== 'super_admin' && (m === 'write' || m === 'both');
}
function departmentScope(user) {
  if (user.role === 'super_admin' || !canViewAll(user)) return null;
  const depts = Array.isArray(user.dailyReportDepartments) ? user.dailyReportDepartments.filter(Boolean) : [];
  return depts.length > 0 ? depts : null;
}

router.get('/config', async (req, res) => {
  try {
    const unlocks = await DailyReportUnlock.find({ user: req.user._id }).select('date').lean();
    res.json({
      editWindowDays: await getWindowDays(),
      today: todayStr(),
      canWrite: canWrite(req.user),
      canViewAll: canViewAll(req.user),
      unlockedDates: unlocks.map(u => u.date)
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to load daily report config' });
  }
});

router.get('/settings', requireSuperAdmin, async (req, res) => {
  try {
    const unlocks = await DailyReportUnlock.find({}).populate('user', 'username name').sort({ date: -1 }).limit(200).lean();
    res.json({ editWindowDays: await getWindowDays(), unlocks });
  } catch (err) {
    res.status(500).json({ message: 'Failed to load settings' });
  }
});

router.put('/settings', requireSuperAdmin, async (req, res) => {
  try {
    const days = Number(req.body.editWindowDays);
    if (!Number.isInteger(days) || days < 0 || days > 90) {
      return res.status(400).json({ message: 'Edit window must be a whole number between 0 and 90 days' });
    }
    await DailyReportSettings.findOneAndUpdate({ key: 'default' }, { $set: { editWindowDays: days } }, { upsert: true, new: true });
    await logActivity(req, 'dailyReport.settings', { message: `Set Daily Report edit window to ${days} day(s)` });
    res.json({ editWindowDays: days });
  } catch (err) {
    res.status(500).json({ message: 'Failed to save settings' });
  }
});

router.post('/unlock', requireSuperAdmin, async (req, res) => {
  try {
    const { user, date } = req.body;
    if (!user || !DATE_RE.test(date || '')) return res.status(400).json({ message: 'A staff member and a valid date are required' });
    const target = await User.findById(user).select('username name');
    if (!target) return res.status(404).json({ message: 'User not found' });
    const unlock = await DailyReportUnlock.findOneAndUpdate(
      { user: target._id, date },
      { $set: { grantedBy: req.user._id } },
      { upsert: true, new: true }
    ).populate('user', 'username name');
    await logActivity(req, 'dailyReport.unlock', { message: `Unlocked ${date} for ${target.username}` });
    res.status(201).json({ unlock });
  } catch (err) {
    res.status(500).json({ message: 'Failed to unlock date' });
  }
});

router.delete('/unlock/:id', requireSuperAdmin, async (req, res) => {
  try {
    await DailyReportUnlock.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: 'Failed to remove unlock' });
  }
});

router.get('/users', async (req, res) => {
  try {
    if (!canViewAll(req.user)) {
      return res.json({
        users: [{
          _id: req.user._id,
          username: req.user.username,
          name: req.user.name
        }]
      });
    }
    const scope = departmentScope(req.user);
    const filter = {
      role: 'user'
    };
    if (scope) {
      filter.$or = [{
        department: {
          $in: scope
        }
      }, {
        departments: {
          $in: scope
        }
      }];
    }
    let users = await User.find(filter).select('username name department status').sort({
      name: 1,
      username: 1
    });
    if (canWrite(req.user) && !users.some(u => String(u._id) === String(req.user._id))) {
      users = [{ _id: req.user._id, username: req.user.username, name: req.user.name, department: req.user.department }, ...users];
    }
    res.json({
      users
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to load users'
    });
  }
});
router.get('/', async (req, res) => {
  try {
    const {
      dateFrom,
      dateTo,
      department
    } = req.query;
    let {
      user: requestedUserId
    } = req.query;
    const viewAll = canViewAll(req.user);
    if (!viewAll) requestedUserId = String(req.user._id);
    const clauses = [];
    if (requestedUserId) clauses.push({ user: requestedUserId });
    const scope = viewAll ? departmentScope(req.user) : null;
    if (scope) {
      const inScope = department
        ? (scope.some(d => d.toLowerCase() === String(department).trim().toLowerCase())
          ? { department: new RegExp(`^${escapeRegex(department)}$`, 'i') }
          : { department: { $in: [] } })
        : { department: { $in: scope.map(d => new RegExp(`^${escapeRegex(d)}$`, 'i')) } };
      clauses.push(canWrite(req.user) ? { $or: [inScope, { user: req.user._id }] } : inScope);
    } else if (department) {
      clauses.push({ department: new RegExp(department, 'i') });
    }
    if (dateFrom || dateTo) {
      const range = {};
      if (dateFrom) range.$gte = dateFrom;
      if (dateTo) range.$lte = dateTo;
      clauses.push({ date: range });
    }
    const filter = clauses.length ? { $and: clauses } : {};
    const entries = await DailyReport.find(filter).populate('user', 'username name department').populate('feedbackBy', 'username name').sort({
      date: -1,
      updatedAt: -1
    });
    res.json({
      entries,
      filters: {
        dateFrom: dateFrom || null,
        dateTo: dateTo || null,
        user: requestedUserId || null,
        department: department || null
      }
    });
  } catch (err) {
    console.error('Daily report list error:', err);
    res.status(500).json({
      message: 'Failed to load daily reports'
    });
  }
});
router.post('/', async (req, res) => {
  try {
    const {
      date,
      points,
      userId
    } = req.body;
    const onBehalf = req.user.role === 'super_admin';
    if (!onBehalf && !canWrite(req.user)) {
      return res.status(403).json({
        message: 'You have view-only access to daily reports'
      });
    }
    if (!date || !DATE_RE.test(date)) {
      return res.status(400).json({
        message: 'Valid date (YYYY-MM-DD) is required'
      });
    }
    let owner = req.user;
    if (onBehalf) {
      if (!userId) return res.status(400).json({ message: 'Choose the staff member this report is for' });
      owner = await User.findById(userId).select('username name department');
      if (!owner) return res.status(404).json({ message: 'Staff member not found' });
    } else if (!(await isEditable(req.user._id, date))) {
      return res.status(403).json({
        message: await editWindowMessage()
      });
    }
    const cleanPoints = Array.isArray(points) ? points.map(p => (p || '').trim()).filter(p => p.length > 0) : [];
    if (cleanPoints.length === 0) {
      return res.status(400).json({
        message: 'At least one description point is required'
      });
    }
    const entry = await DailyReport.findOneAndUpdate({
      user: owner._id,
      date
    }, {
      $set: {
        points: cleanPoints,
        department: owner.department || ''
      }
    }, {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true
    }).populate('user', 'username name department').populate('feedbackBy', 'username name');
    await logActivity(req, 'dailyReport.saved', {
      targetType: 'DailyReport',
      targetId: entry._id,
      message: onBehalf ? `Saved daily report for ${date} on behalf of ${owner.username}` : `Saved daily report for ${date}`
    });
    res.json({
      entry
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        message: 'A report for this date already exists. Use PUT to update it.'
      });
    }
    console.error('Save daily report error:', err);
    res.status(500).json({
      message: 'Failed to save daily report'
    });
  }
});
router.put('/:id', async (req, res) => {
  try {
    const entry = await DailyReport.findById(req.params.id);
    if (!entry) return res.status(404).json({
      message: 'Daily report not found'
    });
    const isSuper = req.user.role === 'super_admin';
    if (!isSuper) {
      if (String(entry.user) !== String(req.user._id)) {
        return res.status(403).json({
          message: 'You can only edit your own reports'
        });
      }
      if (!canWrite(req.user)) {
        return res.status(403).json({
          message: 'You have view-only access to daily reports'
        });
      }
    }
    const {
      date,
      points
    } = req.body;
    if (!isSuper) {
      const requestedDate = date && DATE_RE.test(date) ? date : entry.date;
      if (!(await isEditable(req.user._id, requestedDate)) || !(await isEditable(req.user._id, entry.date))) {
        return res.status(403).json({
          message: await editWindowMessage()
        });
      }
    }
    const update = {};
    if (date && DATE_RE.test(date)) update.date = date;
    if (Array.isArray(points)) {
      update.points = points.map(p => (p || '').trim()).filter(p => p.length > 0);
    }
    const updated = await DailyReport.findByIdAndUpdate(req.params.id, {
      $set: update
    }, {
      new: true
    }).populate('user', 'username name department').populate('feedbackBy', 'username name');
    await logActivity(req, 'dailyReport.edited', {
      targetType: 'DailyReport',
      targetId: entry._id,
      message: `Edited daily report for ${updated.date}`
    });
    res.json({
      entry: updated
    });
  } catch (err) {
    console.error('Edit daily report error:', err);
    res.status(500).json({
      message: 'Failed to edit daily report'
    });
  }
});
router.delete('/:id', async (req, res) => {
  try {
    const entry = await DailyReport.findById(req.params.id);
    if (!entry) return res.status(404).json({
      message: 'Daily report not found'
    });
    if (req.user.role !== 'super_admin') {
      if (String(entry.user) !== String(req.user._id)) {
        return res.status(403).json({
          message: 'You can only delete your own reports'
        });
      }
      if (!canWrite(req.user)) {
        return res.status(403).json({
          message: 'You have view-only access to daily reports'
        });
      }
      if (!(await isEditable(req.user._id, entry.date))) {
        return res.status(403).json({
          message: await editWindowMessage()
        });
      }
    }
    await DailyReport.findByIdAndDelete(req.params.id);
    await logActivity(req, 'dailyReport.deleted', {
      targetType: 'DailyReport',
      targetId: entry._id,
      message: `Deleted daily report for ${entry.date}`
    });
    res.json({
      success: true
    });
  } catch (err) {
    console.error('Delete daily report error:', err);
    res.status(500).json({
      message: 'Failed to delete daily report'
    });
  }
});
router.put('/:id/feedback', async (req, res) => {
  try {
    if (req.user.role !== 'super_admin') {
      return res.status(403).json({
        message: 'Only Super Admins can leave feedback'
      });
    }
    const feedback = (req.body.feedback || '').trim();
    if (feedback.length > 4000) {
      return res.status(400).json({
        message: 'Feedback is too long (max 4000 characters)'
      });
    }
    const entry = await DailyReport.findByIdAndUpdate(req.params.id, {
      $set: {
        feedback,
        feedbackBy: req.user._id,
        feedbackAt: new Date()
      }
    }, {
      new: true
    }).populate('user', 'username name department').populate('feedbackBy', 'username name');
    if (!entry) return res.status(404).json({
      message: 'Daily report not found'
    });
    await logActivity(req, 'dailyReport.feedback', {
      targetType: 'DailyReport',
      targetId: entry._id,
      message: `Left feedback on daily report for ${entry.date} (user: ${entry.user?.username})`
    });
    res.json({
      entry
    });
  } catch (err) {
    console.error('Daily report feedback error:', err);
    res.status(500).json({
      message: 'Failed to save feedback'
    });
  }
});
module.exports = router;
