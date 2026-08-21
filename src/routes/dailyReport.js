const express = require('express');
const DailyReport = require('../models/DailyReport');
const User = require('../models/User');
const {
  verifyAccess,
  requireDailyReportAccess
} = require('../middleware/auth');
const {
  logActivity
} = require('../utils/auditLogger');
const router = express.Router();
router.use(verifyAccess, requireDailyReportAccess);
// Regular staff ("user" role) may only add or edit a report dated within this many
// days before today (inclusive of today). Super Admin is exempt — see PUT/:id below.
const EDIT_GRACE_DAYS = 2;
function todayStartOfDay() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function isWithinEditWindow(dateStr, graceDays = EDIT_GRACE_DAYS) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const target = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(target.getTime())) return false;
  const diffDays = Math.floor((todayStartOfDay() - target) / (24 * 60 * 60 * 1000));
  return diffDays <= graceDays;
}
function editWindowMessage() {
  return `You can only add or edit reports for today and the last ${EDIT_GRACE_DAYS} day${EDIT_GRACE_DAYS === 1 ? '' : 's'}. Please ask a Super Admin to update older entries.`;
}
function isPrivileged(role) {
  return role === 'admin' || role === 'super_admin';
}
function isWriter(user) {
  return user.role === 'user';
}
router.get('/users', async (req, res) => {
  try {
    if (!isPrivileged(req.user.role)) {
      return res.json({
        users: [{
          _id: req.user._id,
          username: req.user.username,
          name: req.user.name
        }]
      });
    }
    const users = await User.find({
      role: 'user'
    }).select('username name department status').sort({
      name: 1,
      username: 1
    });
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
    const privileged = isPrivileged(req.user.role);
    if (!privileged) requestedUserId = String(req.user._id);
    const filter = {};
    if (requestedUserId) filter.user = requestedUserId;
    if (department) filter.department = new RegExp(department, 'i');
    if (dateFrom || dateTo) {
      filter.date = {};
      if (dateFrom) filter.date.$gte = dateFrom;
      if (dateTo) filter.date.$lte = dateTo;
    }
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
    if (!isWriter(req.user)) {
      return res.status(403).json({
        message: 'Admins and Super Admins cannot write daily reports'
      });
    }
    const {
      date,
      points
    } = req.body;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({
        message: 'Valid date (YYYY-MM-DD) is required'
      });
    }
    if (!isWithinEditWindow(date)) {
      return res.status(403).json({
        message: editWindowMessage()
      });
    }
    const cleanPoints = Array.isArray(points) ? points.map(p => (p || '').trim()).filter(p => p.length > 0) : [];
    if (cleanPoints.length === 0) {
      return res.status(400).json({
        message: 'At least one description point is required'
      });
    }
    const department = req.user.department || '';
    const entry = await DailyReport.findOneAndUpdate({
      user: req.user._id,
      date
    }, {
      $set: {
        points: cleanPoints,
        department
      }
    }, {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true
    }).populate('user', 'username name department').populate('feedbackBy', 'username name');
    await logActivity(req, 'dailyReport.saved', {
      targetType: 'DailyReport',
      targetId: entry._id,
      message: `Saved daily report for ${date}`
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
    if (req.user.role === 'user' && String(entry.user) !== String(req.user._id)) {
      return res.status(403).json({
        message: 'You can only edit your own reports'
      });
    }
    if (req.user.role === 'admin') {
      return res.status(403).json({
        message: 'Admins cannot edit daily reports'
      });
    }
    const {
      date,
      points
    } = req.body;
    if (req.user.role === 'user') {
      const requestedDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : entry.date;
      if (!isWithinEditWindow(requestedDate)) {
        return res.status(403).json({
          message: editWindowMessage()
        });
      }
    }
    const update = {};
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) update.date = date;
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
    if (req.user.role === 'user' && String(entry.user) !== String(req.user._id)) {
      return res.status(403).json({
        message: 'You can only delete your own reports'
      });
    }
    if (req.user.role === 'admin') {
      return res.status(403).json({
        message: 'Admins cannot delete daily reports'
      });
    }
    if (req.user.role === 'user' && !isWithinEditWindow(entry.date)) {
      return res.status(403).json({
        message: editWindowMessage()
      });
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
