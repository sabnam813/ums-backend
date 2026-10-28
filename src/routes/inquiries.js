const express = require('express');
const Inquiry = require('../models/Inquiry');
const {
  verifyAccess,
  requireInquiryAccess,
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
function normalizeCountries(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map(c => String(c || '').trim()).filter(Boolean))];
  }
  if (typeof value === 'string') {
    return [...new Set(value.split(',').map(c => c.trim()).filter(Boolean))];
  }
  return [];
}
router.use(verifyAccess, requireFeatureEnabled('inquiries'), requireInquiryAccess);
router.get('/', requirePermission('inquiry', 'view'), async (req, res) => {
  try {
    const {
      search,
      stage,
      country,
      level,
      dateFrom,
      dateTo,
      limit = 500
    } = req.query;
    const query = {};
    if (stage) query.stage = {
      $in: stage.split(',')
    };
    if (country) query.country = {
      $in: country.split(',')
    };
    if (level) query.level = {
      $in: level.split(',')
    };
    if (dateFrom || dateTo) {
      const dateClause = {};
      if (dateFrom) dateClause.$gte = new Date(dateFrom);
      if (dateTo) dateClause.$lte = new Date(dateTo);
      query.$or = [{
        date: dateClause
      }, {
        date: {
          $exists: false
        }
      }, {
        date: null
      }];
    }
    if (search) {
      query.$or = [{
        applicantName: new RegExp(search, 'i')
      }, {
        referredBy: new RegExp(search, 'i')
      }, {
        country: new RegExp(search, 'i')
      }, {
        remarks: new RegExp(search, 'i')
      }];
    }
    const [inquiries, totalCount] = await Promise.all([Inquiry.find(query).sort({
      date: -1,
      createdAt: -1
    }).limit(Number(limit)).populate('createdBy', 'username name'), Inquiry.countDocuments(query)]);
    res.json({
      inquiries,
      total: inquiries.length,
      totalCount,
      totalInDB: totalCount,
      returned: inquiries.length
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to fetch inquiries'
    });
  }
});
router.post('/', requirePermission('inquiry', 'create'), async (req, res) => {
  try {
    const inquiry = await Inquiry.create({
      ...req.body,
      country: normalizeCountries(req.body.country),
      createdBy: req.user._id,
      date: req.body.date || new Date()
    });
    res.status(201).json({
      inquiry
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to create inquiry'
    });
  }
});
router.post('/bulk/create', requirePermission('inquiry', 'import'), async (req, res) => {
  try {
    const {
      inquiries
    } = req.body;
    if (!inquiries || !Array.isArray(inquiries) || inquiries.length === 0) {
      return res.status(400).json({
        message: 'No inquiries provided'
      });
    }
    const toCreate = inquiries.map(i => ({
      ...i,
      country: normalizeCountries(i.country),
      createdBy: req.user._id,
      date: i.date ? new Date(i.date) : new Date()
    }));
    const {
      insertedDocs,
      failures,
      totalRows,
      successCount,
      failedCount
    } = await bulkInsertWithReport(Inquiry, toCreate);
    const namedFailures = failures.map(f => ({
      ...f,
      name: inquiries[f.row - 1]?.applicantName || '(no name provided)'
    }));
    res.status(201).json({
      inquiries: insertedDocs,
      total: totalRows,
      created: successCount,
      failed: failedCount,
      failures: namedFailures,
      ...(failedCount > 0 && {
        skipped: failedCount,
        warning: `${failedCount} of ${totalRows} row(s) skipped, see 'failures'`
      })
    });
  } catch (err) {
    console.error('Bulk create inquiry error:', err);
    res.status(500).json({
      message: 'Failed to bulk create inquiries'
    });
  }
});
router.put('/:id', requirePermission('inquiry', 'edit'), async (req, res) => {
  try {
    const {
      _id,
      createdBy,
      ...safeBody
    } = req.body;
    if (safeBody.country !== undefined) safeBody.country = normalizeCountries(safeBody.country);
    const inquiry = await Inquiry.findByIdAndUpdate(req.params.id, safeBody, {
      new: true,
      runValidators: true
    });
    if (!inquiry) return res.status(404).json({
      message: 'Not found'
    });
    res.json({
      inquiry
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to update inquiry'
    });
  }
});
router.delete('/:id', requirePermission('inquiry', 'delete'), async (req, res) => {
  try {
    const inquiry = await Inquiry.findById(req.params.id);
    if (!inquiry) return res.status(404).json({
      message: 'Not found'
    });
    await softDelete({
      modelName: 'Inquiry',
      doc: inquiry,
      userId: req.user._id,
      userName: req.user.name || req.user.username,
      meta: {
        applicantName: inquiry.applicantName
      }
    });
    res.json({
      message: 'Moved to trash'
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to delete inquiry'
    });
  }
});
router.put('/bulk/update', requirePermission('inquiry', 'bulkEdit'), async (req, res) => {
  try {
    const {
      ids,
      updates
    } = req.body;
    if (!ids?.length) return res.status(400).json({
      message: 'No IDs provided'
    });
    if (!updates || typeof updates !== 'object') return res.status(400).json({
      message: 'No updates provided'
    });
    const ALLOWED = ['referredBy', 'country', 'level', 'stage', 'mode', 'respondedBy', 'emailType', 'remarks', 'date'];
    const safeUpdates = {};
    Object.entries(updates).forEach(([k, v]) => {
      if (ALLOWED.includes(k) && v !== '' && v !== null && v !== undefined) {
        if (k === 'country') {
          const normalized = normalizeCountries(v);
          if (normalized.length) safeUpdates.country = normalized;
        } else {
          safeUpdates[k] = k === 'date' ? new Date(v) : v;
        }
      }
    });
    if (Object.keys(safeUpdates).length === 0) {
      return res.status(400).json({
        message: 'No valid fields to update'
      });
    }
    const result = await Inquiry.updateMany({
      _id: {
        $in: ids
      }
    }, {
      $set: safeUpdates
    }, {
      runValidators: true
    });
    res.json({
      updated: result.modifiedCount ?? result.nModified ?? 0
    });
  } catch (err) {
    console.error('Bulk update inquiry error:', err);
    res.status(500).json({
      message: 'Bulk update failed'
    });
  }
});
router.delete('/bulk/delete', requirePermission('inquiry', 'delete'), async (req, res) => {
  try {
    const {
      ids
    } = req.body;
    if (!ids?.length) return res.status(400).json({
      message: 'No IDs provided'
    });
    const inquiries = await Inquiry.find({
      _id: {
        $in: ids
      }
    });
    for (const inquiry of inquiries) {
      await softDelete({
        modelName: 'Inquiry',
        doc: inquiry,
        userId: req.user._id,
        userName: req.user.name || req.user.username,
        meta: {
          applicantName: inquiry.applicantName
        }
      });
    }
    res.json({
      deleted: inquiries.length
    });
  } catch (err) {
    res.status(500).json({
      message: 'Bulk delete failed'
    });
  }
});
module.exports = router;
