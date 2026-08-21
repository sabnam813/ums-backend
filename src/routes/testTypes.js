const express = require('express');
const TestType = require('../models/TestType');
const TestPrepRecord = require('../models/TestPrepRecord');
const {
  verifyAccess,
  requireAdmin,
  requireTestPrepAccess
} = require('../middleware/auth');
const {
  softDelete
} = require('../utils/trashHelper');
const {
  classifyPaymentStatus
} = require('../utils/paymentStatusHelper');
const router = express.Router();
router.use(verifyAccess);
router.use(requireTestPrepAccess);
function slugify(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
function buildRecordMatch(testTypeId, dateFrom, dateTo) {
  const match = {
    testType: testTypeId
  };
  if (dateFrom || dateTo) {
    const dateClause = {};
    if (dateFrom) dateClause.$gte = new Date(dateFrom);
    if (dateTo) {
      const to = new Date(dateTo);
      to.setHours(23, 59, 59, 999);
      dateClause.$lte = to;
    }
    match.$or = [{
      date: dateClause
    }, {
      date: {
        $exists: false
      }
    }, {
      date: null
    }];
  }
  return match;
}
async function withCounts(testTypes, {
  dateFrom,
  dateTo
} = {}) {
  return Promise.all(testTypes.map(async t => {
    const obj = t.toObject ? t.toObject() : t;
    const statuses = await TestPrepRecord.find(buildRecordMatch(t._id, dateFrom, dateTo), {
      paymentStatus: 1
    }).lean();
    const total = statuses.length;
    let paid = 0,
      directPaid = 0,
      notPaid = 0,
      pending = 0;
    statuses.forEach(s => {
      const bucket = classifyPaymentStatus(s.paymentStatus);
      if (bucket === 'paid') paid++;else if (bucket === 'directPaid') directPaid++;else if (bucket === 'notPaid') notPaid++;else pending++;
    });
    return {
      ...obj,
      total,
      pending,
      paid,
      directPaid,
      notPaid
    };
  }));
}
router.get('/', async (req, res) => {
  try {
    const {
      dateFrom,
      dateTo
    } = req.query;
    let testTypes = await TestType.find().sort({
      order: 1,
      name: 1
    });
    testTypes = await withCounts(testTypes, {
      dateFrom,
      dateTo
    });
    res.json({
      testTypes
    });
  } catch {
    res.status(500).json({
      message: 'Failed to fetch test types'
    });
  }
});
router.post('/', requireAdmin, async (req, res) => {
  try {
    const {
      name,
      order
    } = req.body;
    if (!name || !name.trim()) return res.status(400).json({
      message: 'Test name required'
    });
    const slug = slugify(name);
    if (!slug) return res.status(400).json({
      message: 'Test name is invalid'
    });
    const existing = await TestType.findOne({
      slug
    });
    if (existing) return res.status(400).json({
      message: 'A test type with this name already exists'
    });
    const count = await TestType.countDocuments();
    const testType = await TestType.create({
      name: name.trim(),
      slug,
      order: Number.isFinite(order) ? order : count
    });
    res.status(201).json({
      testType
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to create test type'
    });
  }
});
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const {
      name,
      order,
      status
    } = req.body;
    const update = {};
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({
        message: 'Test name required'
      });
      const slug = slugify(name);
      const clash = await TestType.findOne({
        slug,
        _id: {
          $ne: req.params.id
        }
      });
      if (clash) return res.status(400).json({
        message: 'A test type with this name already exists'
      });
      update.name = name.trim();
      update.slug = slug;
    }
    if (order !== undefined) update.order = order;
    if (status !== undefined) update.status = status;
    const testType = await TestType.findByIdAndUpdate(req.params.id, update, {
      new: true
    });
    if (!testType) return res.status(404).json({
      message: 'Test type not found'
    });
    res.json({
      testType
    });
  } catch {
    res.status(500).json({
      message: 'Failed to update test type'
    });
  }
});
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const testType = await TestType.findById(req.params.id);
    if (!testType) return res.status(404).json({
      message: 'Not found'
    });
    const records = await TestPrepRecord.find({
      testType: testType._id
    });
    for (const record of records) {
      await softDelete({
        modelName: 'TestPrepRecord',
        doc: record,
        userId: req.user._id,
        userName: req.user.name || req.user.username,
        meta: {
          candidateName: record.candidateName,
          testType: testType._id.toString(),
          cascadeFromTestType: true
        }
      });
    }
    await softDelete({
      modelName: 'TestType',
      doc: testType,
      userId: req.user._id,
      userName: req.user.name || req.user.username,
      meta: {
        name: testType.name,
        cascadedRecords: records.length
      }
    });
    res.json({
      message: 'Moved to trash',
      cascadedRecords: records.length
    });
  } catch {
    res.status(500).json({
      message: 'Failed to delete'
    });
  }
});
module.exports = router;
