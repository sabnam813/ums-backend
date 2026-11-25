const express = require('express');
const HallBooking = require('../models/HallBooking');
const TrainingSchedule = require('../models/TrainingSchedule');
const { verifyAccess, hasPermission } = require('../middleware/auth');
const { countryScopeClause } = require('./trainingSchedules');

const router = express.Router();
router.use(verifyAccess);

function nepalDayRange() {
  const key = new Date(Date.now() + (5 * 60 + 45) * 60 * 1000).toISOString().slice(0, 10);
  const start = new Date(`${key}T00:00:00.000Z`);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

function hallVisibility(user) {
  if (user.role === 'super_admin') return null;
  return {
    $or: [
      { 'visibility.mode': { $exists: false } },
      { 'visibility.mode': 'everyone' },
      { createdBy: user._id },
      { 'visibility.mode': 'specific', 'visibility.allowedUsers': user._id }
    ]
  };
}

router.get('/', async (req, res) => {
  try {
    const { start, end } = nepalDayRange();
    const out = { trainingSchedule: 0, hallBooking: 0 };
    const jobs = [];

    if (hasPermission(req.user, 'trainingSchedule', 'view')) {
      const clauses = [{ date: { $gte: start, $lt: end } }, { status: { $ne: 'cancelled' } }];
      const scope = countryScopeClause(req.user);
      if (scope) clauses.push(scope);
      jobs.push(TrainingSchedule.countDocuments({ $and: clauses }).then(n => { out.trainingSchedule = n; }));
    }

    if (hasPermission(req.user, 'hallBooking', 'view')) {
      const clauses = [{ date: { $gte: start, $lt: end } }, { status: { $ne: 'cancelled' } }];
      const vis = hallVisibility(req.user);
      if (vis) clauses.push(vis);
      jobs.push(HallBooking.countDocuments({ $and: clauses }).then(n => { out.hallBooking = n; }));
    }

    await Promise.all(jobs);
    res.json(out);
  } catch (err) {
    res.status(500).json({ message: 'Failed to load badge counts' });
  }
});

module.exports = router;
