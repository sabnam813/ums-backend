const express = require('express');
const FeatureFlag = require('../models/FeatureFlag');
const {
  verifyAccess,
  requireSuperAdmin
} = require('../middleware/auth');
const {
  logActivity
} = require('../utils/auditLogger');
const router = express.Router();
const DEFAULT_FLAGS = [{
  key: 'chat',
  label: 'Internal Chat',
  description: 'Messaging between staff/admin accounts.'
}, {
  key: 'inquiries',
  label: 'Inquiries',
  description: 'Prospective-student inquiry tracking.'
}, {
  key: 'testPreparation',
  label: 'Test Preparation',
  description: 'IELTS/PTE/Duolingo test-prep module.'
}, {
  key: 'notifications',
  label: 'Notifications',
  description: 'Bell/notification feed for application updates.'
}];
async function ensureDefaults() {
  for (const f of DEFAULT_FLAGS) {
    await FeatureFlag.updateOne({
      key: f.key
    }, {
      $setOnInsert: {
        ...f,
        enabled: true
      }
    }, {
      upsert: true
    });
  }
}
router.get('/', verifyAccess, async (req, res) => {
  try {
    await ensureDefaults();
    const flags = await FeatureFlag.find().sort({
      label: 1
    });
    res.json({
      flags
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to fetch feature flags'
    });
  }
});
router.put('/:key', verifyAccess, requireSuperAdmin, async (req, res) => {
  try {
    const {
      enabled
    } = req.body;
    const flag = await FeatureFlag.findOneAndUpdate({
      key: req.params.key
    }, {
      enabled: !!enabled,
      updatedBy: req.user._id
    }, {
      new: true
    });
    if (!flag) return res.status(404).json({
      message: 'Feature flag not found'
    });
    await logActivity(req, enabled ? 'feature.enabled' : 'feature.disabled', {
      targetType: 'FeatureFlag',
      targetId: flag.key,
      message: `${flag.label} was ${enabled ? 'enabled' : 'disabled'}`
    });
    res.json({
      flag
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to update feature flag'
    });
  }
});
module.exports = router;
