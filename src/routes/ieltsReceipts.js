const express = require('express');
const TestType = require('../models/TestType');
const TestPrepRecord = require('../models/TestPrepRecord');
const IeltsReceipt = require('../models/IeltsReceipt');
const IeltsDaySummary = require('../models/IeltsDaySummary');
const {
  verifyAccess,
  requireTestPrepAccess
} = require('../middleware/auth');
const {
  requireFeatureEnabled
} = require('../middleware/featureGate');
const router = express.Router();
router.use(verifyAccess);
router.use(requireFeatureEnabled('testPreparation'));
router.use(requireTestPrepAccess);
function dayRange(dateStr) {
  const start = new Date(dateStr);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return {
    start,
    end
  };
}
async function resolveTestType(slug, res) {
  const testType = await TestType.findOne({
    slug
  });
  if (!testType) {
    res.status(404).json({
      message: 'Test type not found'
    });
    return null;
  }
  return testType;
}
router.get('/status/:slug', async (req, res) => {
  try {
    const testType = await resolveTestType(req.params.slug, res);
    if (!testType) return;
    const receipts = await IeltsReceipt.find({
      testType: testType._id
    }, 'student');
    const map = {};
    receipts.forEach(r => {
      map[String(r.student)] = r._id;
    });
    res.json(map);
  } catch {
    res.status(500).json({
      message: 'Failed to load receipt status'
    });
  }
});
router.get('/by-date/:slug', async (req, res) => {
  try {
    const {
      examDate
    } = req.query;
    if (!examDate) return res.status(400).json({
      message: 'examDate is required'
    });
    const testType = await resolveTestType(req.params.slug, res);
    if (!testType) return;
    const {
      start,
      end
    } = dayRange(examDate);
    const students = await TestPrepRecord.find({
      testType: testType._id,
      examDate: {
        $gte: start,
        $lt: end
      }
    }).sort({
      candidateName: 1
    });
    const receipts = await IeltsReceipt.find({
      testType: testType._id,
      examDate: {
        $gte: start,
        $lt: end
      }
    });
    const receiptByStudent = {};
    receipts.forEach(r => {
      receiptByStudent[String(r.student)] = r;
    });
    const summary = await IeltsDaySummary.findOne({
      testType: testType._id,
      examDate: {
        $gte: start,
        $lt: end
      }
    });
    res.json({
      testType,
      students,
      receipts: receiptByStudent,
      summary: summary || null
    });
  } catch {
    res.status(500).json({
      message: 'Failed to load exam date data'
    });
  }
});
router.get('/student/:studentId', async (req, res) => {
  try {
    const receipt = await IeltsReceipt.findOne({
      student: req.params.studentId
    });
    if (!receipt) return res.status(404).json({
      message: 'No receipt for this student yet'
    });
    res.json(receipt);
  } catch {
    res.status(500).json({
      message: 'Failed to load receipt'
    });
  }
});
router.post('/', async (req, res) => {
  try {
    const {
      student,
      testType,
      candidateName,
      referenceNumber,
      passportNo,
      examDate,
      test,
      type,
      module: mod,
      place,
      quotedPrice,
      collectedPrice,
      associates,
      paidBy,
      remarks,
      receiptWrittenDate
    } = req.body;
    if (!student || !testType || !examDate) {
      return res.status(400).json({
        message: 'student, testType and examDate are required'
      });
    }
    const payload = {
      student,
      testType,
      candidateName,
      referenceNumber,
      passportNo,
      examDate,
      test,
      type,
      module: mod,
      place,
      quotedPrice: Number(quotedPrice) || 0,
      collectedPrice: Number(collectedPrice) || 0,
      associates,
      paidBy,
      remarks,
      receiptWrittenDate: receiptWrittenDate || new Date(),
      createdBy: req.user._id
    };
    const receipt = await IeltsReceipt.findOneAndUpdate({
      student
    }, payload, {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
      runValidators: true
    });
    res.status(201).json(receipt);
  } catch (err) {
    res.status(500).json({
      message: err.message || 'Failed to save receipt'
    });
  }
});
router.put('/:id', async (req, res) => {
  try {
    const {
      _id,
      student,
      testType,
      createdBy,
      ...safeBody
    } = req.body;
    if (safeBody.module === undefined && req.body.module !== undefined) safeBody.module = req.body.module;
    const receipt = await IeltsReceipt.findById(req.params.id);
    if (!receipt) return res.status(404).json({
      message: 'Receipt not found'
    });
    Object.assign(receipt, safeBody);
    await receipt.save();
    res.json(receipt);
  } catch (err) {
    res.status(500).json({
      message: err.message || 'Failed to update receipt'
    });
  }
});
router.delete('/:id', async (req, res) => {
  try {
    await IeltsReceipt.findByIdAndDelete(req.params.id);
    res.json({
      message: 'Receipt deleted'
    });
  } catch {
    res.status(500).json({
      message: 'Failed to delete receipt'
    });
  }
});
router.delete('/day-summary/:slug', async (req, res) => {
  try {
    const {
      examDate
    } = req.body;
    if (!examDate) return res.status(400).json({
      message: 'examDate is required'
    });
    const testType = await resolveTestType(req.params.slug, res);
    if (!testType) return;
    const {
      start,
      end
    } = dayRange(examDate);
    await IeltsDaySummary.deleteOne({
      testType: testType._id,
      examDate: {
        $gte: start,
        $lt: end
      }
    });
    res.json({
      success: true
    });
  } catch (err) {
    res.status(500).json({
      message: err.message || 'Failed to delete day summary'
    });
  }
});
router.put('/day-summary/:slug', async (req, res) => {
  try {
    const {
      examDate,
      paidOnDate,
      preparedBy,
      checkedBy,
      approvedBy
    } = req.body;
    if (!examDate) return res.status(400).json({
      message: 'examDate is required'
    });
    const testType = await resolveTestType(req.params.slug, res);
    if (!testType) return;
    const {
      start
    } = dayRange(examDate);
    const summary = await IeltsDaySummary.findOneAndUpdate({
      testType: testType._id,
      examDate: start
    }, {
      testType: testType._id,
      examDate: start,
      paidOnDate,
      preparedBy,
      checkedBy,
      approvedBy
    }, {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true
    });
    res.json(summary);
  } catch (err) {
    res.status(500).json({
      message: err.message || 'Failed to save day summary'
    });
  }
});
module.exports = router;
