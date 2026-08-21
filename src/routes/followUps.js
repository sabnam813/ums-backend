const express = require('express');
const FollowUp = require('../models/FollowUp');
const {
  verifyAccess,
  requireFollowUpAccess,
  requirePermission
} = require('../middleware/auth');
const {
  logActivity
} = require('../utils/auditLogger');
const router = express.Router();
router.use(verifyAccess, requireFollowUpAccess);
router.get('/', requirePermission('followUp', 'view'), async (req, res) => {
  try {
    const {
      dateFrom,
      dateTo,
      search,
      limit = 500
    } = req.query;
    const query = {};
    const isPrivileged = ['admin', 'super_admin'].includes(req.user.role);
    if (!isPrivileged) {
      query.createdBy = req.user._id;
    }
    if (dateFrom || dateTo) {
      query.date = {};
      if (dateFrom) query.date.$gte = new Date(dateFrom);
      if (dateTo) {
        const to = new Date(dateTo);
        to.setHours(23, 59, 59, 999);
        query.date.$lte = to;
      }
    }
    if (search) {
      query.$or = [{
        companyName: new RegExp(search, 'i')
      }, {
        talkedTo: new RegExp(search, 'i')
      }, {
        remarks: new RegExp(search, 'i')
      }];
    }
    const followUps = await FollowUp.find(query).sort({
      date: -1,
      createdAt: -1
    }).limit(Number(limit)).populate('createdBy', 'username name');
    res.json({
      followUps,
      total: followUps.length
    });
  } catch (err) {
    console.error('Failed to fetch follow-ups:', err);
    res.status(500).json({
      message: 'Failed to fetch follow-ups'
    });
  }
});
router.post('/', requirePermission('followUp', 'create'), async (req, res) => {
  try {
    const {
      date,
      companyName,
      talkedTo,
      remarks
    } = req.body;
    const followUp = await FollowUp.create({
      date: date ? new Date(date) : new Date(),
      companyName: companyName || '',
      talkedTo: talkedTo || '',
      remarks: remarks || '',
      createdBy: req.user._id
    });
    const populated = await FollowUp.findById(followUp._id).populate('createdBy', 'username name');
    res.status(201).json({
      followUp: populated
    });
  } catch (err) {
    console.error('Failed to create follow-up:', err);
    res.status(500).json({
      message: 'Failed to create follow-up'
    });
  }
});
router.put('/:id', requirePermission('followUp', 'edit'), async (req, res) => {
  try {
    const followUp = await FollowUp.findById(req.params.id);
    if (!followUp) return res.status(404).json({
      message: 'Not found'
    });
    const isPrivileged = ['admin', 'super_admin'].includes(req.user.role);
    if (!isPrivileged && String(followUp.createdBy) !== String(req.user._id)) {
      return res.status(403).json({
        message: 'You can only edit your own follow-ups'
      });
    }
    const {
      date,
      companyName,
      talkedTo,
      remarks
    } = req.body;
    const update = {};
    if (date !== undefined) update.date = new Date(date);
    if (companyName !== undefined) update.companyName = companyName;
    if (talkedTo !== undefined) update.talkedTo = talkedTo;
    if (remarks !== undefined) update.remarks = remarks;
    const updated = await FollowUp.findByIdAndUpdate(req.params.id, update, {
      new: true,
      runValidators: true
    }).populate('createdBy', 'username name');
    res.json({
      followUp: updated
    });
  } catch (err) {
    console.error('Failed to update follow-up:', err);
    res.status(500).json({
      message: 'Failed to update follow-up'
    });
  }
});
router.delete('/:id', requirePermission('followUp', 'delete'), async (req, res) => {
  try {
    const followUp = await FollowUp.findById(req.params.id);
    if (!followUp) return res.status(404).json({
      message: 'Not found'
    });
    const isPrivileged = ['admin', 'super_admin'].includes(req.user.role);
    if (!isPrivileged && String(followUp.createdBy) !== String(req.user._id)) {
      return res.status(403).json({
        message: 'You can only delete your own follow-ups'
      });
    }
    await FollowUp.findByIdAndDelete(req.params.id);
    res.json({
      message: 'Deleted successfully'
    });
  } catch (err) {
    console.error('Failed to delete follow-up:', err);
    res.status(500).json({
      message: 'Failed to delete follow-up'
    });
  }
});
module.exports = router;
