const express = require('express');
const TestType = require('../models/TestType');
const TestPrepRecord = require('../models/TestPrepRecord');
const TestPrepFieldConfig = require('../models/TestPrepFieldConfig');
const {
  verifyAccess,
  requireTestPrepAccess,
  requirePermission
} = require('../middleware/auth');
const {
  requireFeatureEnabled
} = require('../middleware/featureGate');
const {
  softDelete
} = require('../utils/trashHelper');
const {
  bulkInsertWithReport
} = require('../utils/bulkImportHelper');
const router = express.Router();
router.use(verifyAccess);
router.use(requireFeatureEnabled('testPreparation'));
router.use(requireTestPrepAccess);
async function findMissingRequiredCustomFields(customFields = {}) {
  const requiredDefs = await TestPrepFieldConfig.find({
    kind: 'custom',
    active: true,
    required: true
  });
  return requiredDefs.filter(def => {
    const val = customFields ? customFields[def.key] : undefined;
    return val === undefined || val === null || String(val).trim() === '';
  }).map(def => def.label);
}
async function resolveTestType(req, res) {
  const {
    slug
  } = req.params;
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
router.get('/:slug', requirePermission('testPreparation', 'view'), async (req, res) => {
  try {
    const testType = await resolveTestType(req, res);
    if (!testType) return;
    const records = await TestPrepRecord.find({
      testType: testType._id
    }).sort({
      examDate: -1,
      createdAt: -1
    });
    res.json({
      testType,
      records,
      total: records.length
    });
  } catch {
    res.status(500).json({
      message: 'Failed to fetch records'
    });
  }
});
router.post('/:slug', requirePermission('testPreparation', 'create'), async (req, res) => {
  try {
    const testType = await resolveTestType(req, res);
    if (!testType) return;
    if (!req.body.candidateName || !req.body.candidateName.trim()) {
      return res.status(400).json({
        message: 'Candidate name is required'
      });
    }
    const missing = await findMissingRequiredCustomFields(req.body.customFields);
    if (missing.length) {
      return res.status(400).json({
        message: `${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} required`
      });
    }
    const {
      _id,
      testType: _t,
      createdBy,
      ...safeBody
    } = req.body;
    const record = await TestPrepRecord.create({
      ...safeBody,
      date: safeBody.date || new Date(),
      testType: testType._id,
      createdBy: req.user._id
    });
    res.status(201).json({
      record
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to create record'
    });
  }
});
router.put('/:slug/:id', requirePermission('testPreparation', 'edit'), async (req, res) => {
  try {
    const testType = await resolveTestType(req, res);
    if (!testType) return;
    const {
      _id,
      testType: _t,
      createdBy,
      ...safeBody
    } = req.body;
    const record = await TestPrepRecord.findOneAndUpdate({
      _id: req.params.id,
      testType: testType._id
    }, safeBody, {
      new: true,
      runValidators: true
    });
    if (!record) return res.status(404).json({
      message: 'Not found'
    });
    res.json({
      record
    });
  } catch {
    res.status(500).json({
      message: 'Failed to update record'
    });
  }
});
router.put('/:slug/bulk/update', requirePermission('testPreparation', 'bulkEdit'), async (req, res) => {
  try {
    const testType = await resolveTestType(req, res);
    if (!testType) return;
    const {
      ids,
      updates
    } = req.body;
    if (!ids?.length) return res.status(400).json({
      message: 'No IDs provided'
    });
    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({
        message: 'No updates provided'
      });
    }
    const allowedFields = ['date', 'associates', 'module', 'place', 'bookingDate', 'examDate', 'paymentStatus', 'paymentMadeBy', 'paymentDate', 'paymentAmount', 'margin', 'paymentDateToBC', 'paidAmountToBC', 'remarks', 'referenceNumber', 'receivedAmount', 'cost', 'voucher', 'expiryDate', 'duolingoVoucher'];
    const safeUpdates = {};
    allowedFields.forEach(f => {
      if (updates[f] !== undefined && updates[f] !== '') safeUpdates[f] = updates[f];
    });
    if (updates.customFields && typeof updates.customFields === 'object') {
      Object.entries(updates.customFields).forEach(([k, v]) => {
        if (v !== '' && v !== null && v !== undefined) safeUpdates[`customFields.${k}`] = v;
      });
    }
    if (Object.keys(safeUpdates).length === 0) {
      return res.status(400).json({
        message: 'No valid fields to update'
      });
    }
    const result = await TestPrepRecord.updateMany({
      _id: {
        $in: ids
      },
      testType: testType._id
    }, safeUpdates);
    res.json({
      updated: result.modifiedCount
    });
  } catch {
    res.status(500).json({
      message: 'Bulk update failed'
    });
  }
});
router.post('/:slug/bulk/create', requirePermission('testPreparation', 'import'), async (req, res) => {
  try {
    const testType = await resolveTestType(req, res);
    if (!testType) return;
    const {
      records
    } = req.body;
    if (!records || !Array.isArray(records) || records.length === 0) {
      return res.status(400).json({
        message: 'No records provided'
      });
    }
    const requiredDefs = await TestPrepFieldConfig.find({
      kind: 'custom',
      active: true,
      required: true
    });
    const preFailures = [];
    const recordsToCreate = [];
    records.forEach(({
      _id,
      testType: _t,
      createdBy,
      ...safe
    }, idx) => {
      const missingLabels = requiredDefs.filter(def => {
        const val = safe.customFields ? safe.customFields[def.key] : undefined;
        return val === undefined || val === null || String(val).trim() === '';
      }).map(def => def.label);
      if (missingLabels.length) {
        preFailures.push({
          row: idx + 1,
          reason: `Missing required field(s): ${missingLabels.join(', ')}`
        });
        return;
      }
      recordsToCreate.push({
        ...safe,
        date: safe.date || new Date(),
        testType: testType._id,
        createdBy: req.user._id,
        __originalRow: idx + 1
      });
    });
    const rowMap = recordsToCreate.map(r => r.__originalRow);
    recordsToCreate.forEach(r => {
      delete r.__originalRow;
    });
    const {
      insertedDocs,
      failures,
      totalRows,
      successCount,
      failedCount
    } = await bulkInsertWithReport(TestPrepRecord, recordsToCreate);
    const remappedFailures = failures.map(f => ({
      ...f,
      row: rowMap[f.row - 1] ?? f.row
    }));
    const allFailures = [...preFailures, ...remappedFailures].sort((a, b) => a.row - b.row);
    const namedFailures = allFailures.map(f => ({
      ...f,
      name: records[f.row - 1]?.candidateName || '(no name provided)'
    }));
    const total = records.length;
    const failed = failedCount + preFailures.length;
    res.status(201).json({
      records: insertedDocs,
      total,
      created: successCount,
      failed,
      failures: namedFailures,
      ...(failed > 0 && {
        warning: `${failed} of ${total} row(s) skipped, see 'failures'`
      })
    });
  } catch (err) {
    console.error('Test prep bulk create error:', err);
    res.status(500).json({
      message: 'Failed to bulk create records'
    });
  }
});
router.delete('/:slug/:id', requirePermission('testPreparation', 'delete'), async (req, res) => {
  try {
    const testType = await resolveTestType(req, res);
    if (!testType) return;
    const record = await TestPrepRecord.findOne({
      _id: req.params.id,
      testType: testType._id
    });
    if (!record) return res.status(404).json({
      message: 'Not found'
    });
    await softDelete({
      modelName: 'TestPrepRecord',
      doc: record,
      userId: req.user._id,
      userName: req.user.name || req.user.username,
      meta: {
        candidateName: record.candidateName,
        testType: testType._id.toString()
      }
    });
    res.json({
      message: 'Moved to trash'
    });
  } catch {
    res.status(500).json({
      message: 'Failed to delete record'
    });
  }
});
router.delete('/:slug/bulk/delete', requirePermission('testPreparation', 'delete'), async (req, res) => {
  try {
    const testType = await resolveTestType(req, res);
    if (!testType) return;
    const {
      ids
    } = req.body;
    if (!ids?.length) return res.status(400).json({
      message: 'No IDs provided'
    });
    const records = await TestPrepRecord.find({
      _id: {
        $in: ids
      },
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
          testType: testType._id.toString()
        }
      });
    }
    res.json({
      deleted: records.length
    });
  } catch {
    res.status(500).json({
      message: 'Bulk delete failed'
    });
  }
});
module.exports = router;
