const express = require('express');
const AuditLog = require('../models/AuditLog');
const {
  verifyAccess,
  requireSuperAdmin
} = require('../middleware/auth');
const router = express.Router();
router.use(verifyAccess, requireSuperAdmin);
router.get('/', async (req, res) => {
  try {
    const {
      action,
      username,
      targetType,
      dateFrom,
      dateTo,
      limit = 200,
      page = 1
    } = req.query;
    const query = {};
    if (action) query.action = action;
    if (username) query['actor.username'] = new RegExp(username, 'i');
    if (targetType) query.targetType = targetType;
    if (dateFrom || dateTo) {
      query.createdAt = {};
      if (dateFrom) query.createdAt.$gte = new Date(dateFrom);
      if (dateTo) query.createdAt.$lte = new Date(dateTo);
    }
    const pageSize = Math.min(Number(limit) || 200, 500);
    const skip = (Math.max(Number(page), 1) - 1) * pageSize;
    const [logs, total, distinctActions] = await Promise.all([AuditLog.find(query).sort({
      createdAt: -1
    }).skip(skip).limit(pageSize), AuditLog.countDocuments(query), AuditLog.distinct('action')]);
    res.json({
      logs,
      total,
      page: Number(page),
      pageSize,
      actions: distinctActions
    });
  } catch (err) {
    console.error('Fetch logs error:', err);
    res.status(500).json({
      message: 'Failed to fetch activity logs'
    });
  }
});
router.delete('/clear', async (req, res) => {
  try {
    const {
      olderThanDays
    } = req.query;
    const query = {};
    if (olderThanDays) {
      query.createdAt = {
        $lt: new Date(Date.now() - Number(olderThanDays) * 24 * 60 * 60 * 1000)
      };
    }
    const result = await AuditLog.deleteMany(query);
    res.json({
      message: 'Logs cleared',
      deleted: result.deletedCount
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to clear logs'
    });
  }
});
module.exports = router;
