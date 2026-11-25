const express = require('express');
const mongoose = require('mongoose');
const TestPrepAchievementTarget = require('../models/TestPrepAchievementTarget');
const TestType = require('../models/TestType');
const TestPrepRecord = require('../models/TestPrepRecord');
const {
  verifyAccess,
  requirePermission
} = require('../middleware/auth');
const {
  getAuthoritativeMonthRange
} = require('../utils/nepaliMonthDates');
const router = express.Router();

router.use(verifyAccess);
router.use(requirePermission('tpAchievements', 'access'));

const NEPALI_MONTHS = TestPrepAchievementTarget.NEPALI_MONTHS;

const QUARTER_MAP = {
  Shrawan: 'Q1',
  Bhadra: 'Q1',
  Ashoj: 'Q1',
  Kartik: 'Q2',
  Mangsir: 'Q2',
  Poush: 'Q2',
  Magh: 'Q3',
  Falgun: 'Q3',
  Chaitra: 'Q3',
  Baishakh: 'Q4',
  Jestha: 'Q4',
  Ashadh: 'Q4'
};
const QUARTER_MONTHS = {
  Q1: ['Shrawan', 'Bhadra', 'Ashoj'],
  Q2: ['Kartik', 'Mangsir', 'Poush'],
  Q3: ['Magh', 'Falgun', 'Chaitra'],
  Q4: ['Baishakh', 'Jestha', 'Ashadh']
};
function computeQuarter(nepaliMonth) {
  return QUARTER_MAP[nepaliMonth] || null;
}

function computeWeekRanges(fromStr, toStr) {
  const from = new Date(fromStr);
  const to = new Date(toStr);
  const totalDays = Math.round((to - from) / (1000 * 60 * 60 * 24)) + 1;
  const weeks = [];
  let cursor = new Date(from);
  let weekNumber = 1;
  let daysLeft = totalDays;
  while (daysLeft > 0 && weekNumber <= 5) {
    const isLastWeek = weekNumber === 5 || daysLeft <= 7;
    const span = isLastWeek ? daysLeft : 7;
    const weekFrom = new Date(cursor);
    const weekTo = new Date(cursor);
    weekTo.setDate(weekTo.getDate() + span - 1);
    weeks.push({
      weekNumber,
      from: weekFrom,
      to: weekTo
    });
    cursor.setDate(cursor.getDate() + span);
    daysLeft -= span;
    weekNumber++;
  }
  return weeks;
}

function pct(achieved, target) {
  return target > 0 ? Math.round((achieved / target) * 100) : 0;
}

async function computeAchieved(testTypeId, fromDate, toDate) {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  to.setHours(23, 59, 59, 999);
  return TestPrepRecord.countDocuments({
    testType: testTypeId,
    bookingDate: {
      $gte: from,
      $lte: to
    }
  });
}

function serializeRow(doc, achieved) {
  const target = Number(doc.target) || 0;
  return {
    ...(doc.toObject ? doc.toObject() : doc),
    target,
    achieved,
    pctAchieved: pct(achieved, target),
    quarter: computeQuarter(doc.nepaliMonth)
  };
}

router.get('/test-types', async (req, res) => {
  try {
    const testTypes = await TestType.find({
      status: 'active'
    }).sort({
      order: 1,
      name: 1
    });
    res.json({
      testTypes
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to fetch test types'
    });
  }
});

router.get('/week-ranges', (req, res) => {
  const {
    fiscalYear,
    nepaliMonth
  } = req.query;
  if (!fiscalYear || !nepaliMonth) {
    return res.status(400).json({
      message: 'fiscalYear and nepaliMonth are required'
    });
  }
  const range = getAuthoritativeMonthRange(fiscalYear, nepaliMonth);
  if (!range) {
    return res.status(404).json({
      message: 'No date range configured for this fiscal year / month'
    });
  }
  const weeks = computeWeekRanges(range.from, range.to);
  res.json({
    weeks
  });
});

router.get('/', async (req, res) => {
  try {
    const {
      periodType = 'monthly',
      fiscalYear,
      quarter,
      nepaliMonth
    } = req.query;
    const filter = {
      periodType
    };
    if (fiscalYear) filter.fiscalYear = fiscalYear;
    if (periodType === 'weekly') {
      if (!nepaliMonth) {
        return res.status(400).json({
          message: 'nepaliMonth is required for weekly view'
        });
      }
      filter.nepaliMonth = nepaliMonth;
    } else if (quarter && QUARTER_MONTHS[quarter]) {
      filter.nepaliMonth = {
        $in: QUARTER_MONTHS[quarter]
      };
    }
    const targets = await TestPrepAchievementTarget.find(filter).populate('testType', 'name slug status order').populate('createdBy', 'name username').sort({
      nepaliMonth: 1,
      weekNumber: 1
    });
    const results = await Promise.all(targets.map(async t => {
      if (!t.testType) return null;
      const achieved = await computeAchieved(t.testType._id, t.fromDate, t.toDate);
      return serializeRow(t, achieved);
    }));
    res.json(results.filter(Boolean));
  } catch (err) {
    console.error('GET /tp-achievements error:', err);
    res.status(500).json({
      message: err.message
    });
  }
});

router.post('/', requirePermission('tpAchievements', 'create'), async (req, res) => {
  try {
    const {
      periodType = 'monthly',
      fiscalYear,
      nepaliMonth,
      weekNumber,
      fromDate,
      toDate,
      testType,
      target
    } = req.body;
    if (!fiscalYear || !nepaliMonth || !fromDate || !toDate || !testType) {
      return res.status(400).json({
        message: 'fiscalYear, nepaliMonth, fromDate, toDate and testType are required.'
      });
    }
    if (!NEPALI_MONTHS.includes(nepaliMonth)) {
      return res.status(400).json({
        message: 'Invalid nepaliMonth.'
      });
    }
    if (!mongoose.isValidObjectId(testType)) {
      return res.status(400).json({
        message: 'Invalid testType id.'
      });
    }
    if (periodType === 'weekly' && !weekNumber) {
      return res.status(400).json({
        message: 'weekNumber is required for weekly targets.'
      });
    }
    const key = {
      fiscalYear,
      nepaliMonth,
      testType,
      periodType,
      weekNumber: periodType === 'weekly' ? Number(weekNumber) : null
    };
    let doc = await TestPrepAchievementTarget.findOne(key);
    if (doc) {
      doc.fromDate = fromDate;
      doc.toDate = toDate;
      doc.target = Number(target) || 0;
      doc.createdBy = req.user._id;
      await doc.save();
    } else {
      doc = await TestPrepAchievementTarget.create({
        ...key,
        fromDate,
        toDate,
        target: Number(target) || 0,
        createdBy: req.user._id
      });
    }
    await doc.populate('testType', 'name slug status order');
    const achieved = await computeAchieved(testType, doc.fromDate, doc.toDate);
    res.status(201).json(serializeRow(doc, achieved));
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        message: 'A target for this period/test type already exists.'
      });
    }
    console.error('POST /tp-achievements error:', err);
    res.status(500).json({
      message: err.message
    });
  }
});

router.put('/:id', requirePermission('tpAchievements', 'edit'), async (req, res) => {
  try {
    const {
      target,
      fromDate,
      toDate
    } = req.body;
    const doc = await TestPrepAchievementTarget.findById(req.params.id);
    if (!doc) return res.status(404).json({
      message: 'Not found.'
    });
    if (target !== undefined) doc.target = Number(target) || 0;
    if (fromDate !== undefined) doc.fromDate = fromDate;
    if (toDate !== undefined) doc.toDate = toDate;
    await doc.save();
    await doc.populate('testType', 'name slug status order');
    const achieved = await computeAchieved(doc.testType._id, doc.fromDate, doc.toDate);
    res.json(serializeRow(doc, achieved));
  } catch (err) {
    console.error('PUT /tp-achievements/:id error:', err);
    res.status(500).json({
      message: err.message
    });
  }
});

router.delete('/week', requirePermission('tpAchievements', 'delete'), async (req, res) => {
  try {
    const {
      fiscalYear,
      nepaliMonth,
      weekNumber
    } = req.query;
    if (!fiscalYear || !nepaliMonth || !weekNumber) {
      return res.status(400).json({
        message: 'fiscalYear, nepaliMonth and weekNumber are required'
      });
    }
    const result = await TestPrepAchievementTarget.deleteMany({
      periodType: 'weekly',
      fiscalYear,
      nepaliMonth,
      weekNumber: Number(weekNumber)
    });
    res.json({
      message: 'Week deleted.',
      deletedCount: result.deletedCount
    });
  } catch (err) {
    console.error('DELETE /tp-achievements/week error:', err);
    res.status(500).json({
      message: err.message
    });
  }
});

router.delete('/:id', requirePermission('tpAchievements', 'delete'), async (req, res) => {
  try {
    const doc = await TestPrepAchievementTarget.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({
      message: 'Not found.'
    });
    res.json({
      message: 'Deleted.'
    });
  } catch (err) {
    console.error('DELETE /tp-achievements/:id error:', err);
    res.status(500).json({
      message: err.message
    });
  }
});

module.exports = router;
