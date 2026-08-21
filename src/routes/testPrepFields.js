const express = require('express');
const TestPrepFieldConfig = require('../models/TestPrepFieldConfig');
const {
  verifyAccess,
  requireAdmin,
  requireTestPrepAccess
} = require('../middleware/auth');
const {
  requireFeatureEnabled
} = require('../middleware/featureGate');
const {
  softDelete
} = require('../utils/trashHelper');
const router = express.Router();
router.use(verifyAccess);
router.use(requireFeatureEnabled('testPreparation'));
router.use(requireTestPrepAccess);
const EXTENDABLE_FIELDS = ['paymentStatus', 'module'];
const ALLOWED_CUSTOM_TYPES = ['text', 'date', 'dropdown'];
router.get('/', async (req, res) => {
  try {
    const configs = await TestPrepFieldConfig.find({
      active: true
    }).sort({
      kind: 1,
      order: 1,
      createdAt: 1
    });
    res.json({
      fields: configs
    });
  } catch {
    res.status(500).json({
      message: 'Failed to fetch field configuration'
    });
  }
});
router.post('/options', requireAdmin, async (req, res) => {
  try {
    const {
      fieldKey,
      option
    } = req.body;
    if (!fieldKey || !EXTENDABLE_FIELDS.includes(fieldKey)) {
      return res.status(400).json({
        message: 'Unknown or non-extendable field'
      });
    }
    if (!option || !option.trim()) return res.status(400).json({
      message: 'Option text is required'
    });
    const trimmed = option.trim();
    let config = await TestPrepFieldConfig.findOne({
      kind: 'options',
      fieldKey
    });
    if (!config) {
      config = await TestPrepFieldConfig.create({
        kind: 'options',
        fieldKey,
        label: fieldKey,
        options: [trimmed]
      });
    } else {
      const wasRemovedDefault = (config.removedDefaults || []).some(o => o.toLowerCase() === trimmed.toLowerCase());
      if (wasRemovedDefault) {
        config.removedDefaults = config.removedDefaults.filter(o => o.toLowerCase() !== trimmed.toLowerCase());
        await config.save();
        return res.status(201).json({
          field: config
        });
      }
      if (config.options.some(o => o.toLowerCase() === trimmed.toLowerCase())) {
        return res.status(409).json({
          message: 'That option already exists'
        });
      }
      config.options.push(trimmed);
      await config.save();
    }
    res.status(201).json({
      field: config
    });
  } catch {
    res.status(500).json({
      message: 'Failed to add option'
    });
  }
});
router.delete('/options', requireAdmin, async (req, res) => {
  try {
    const {
      fieldKey,
      option
    } = req.body;
    if (!fieldKey || !EXTENDABLE_FIELDS.includes(fieldKey)) {
      return res.status(400).json({
        message: 'Unknown or non-extendable field'
      });
    }
    if (!option) return res.status(400).json({
      message: 'Option is required'
    });
    let config = await TestPrepFieldConfig.findOne({
      kind: 'options',
      fieldKey
    });
    if (!config) {
      config = await TestPrepFieldConfig.create({
        kind: 'options',
        fieldKey,
        label: fieldKey,
        options: [],
        removedDefaults: [option]
      });
      return res.json({
        field: config
      });
    }
    const before = config.options.length;
    config.options = config.options.filter(o => o !== option);
    if (config.options.length === before) {
      const alreadyRemoved = (config.removedDefaults || []).some(o => o.toLowerCase() === option.toLowerCase());
      if (!alreadyRemoved) config.removedDefaults = [...(config.removedDefaults || []), option];
    }
    await config.save();
    res.json({
      field: config
    });
  } catch {
    res.status(500).json({
      message: 'Failed to remove option'
    });
  }
});
router.post('/custom', requireAdmin, async (req, res) => {
  try {
    const {
      key,
      label,
      type,
      options,
      required
    } = req.body;
    if (!label || !label.trim()) return res.status(400).json({
      message: 'Field label is required'
    });
    if (!type || !ALLOWED_CUSTOM_TYPES.includes(type)) {
      return res.status(400).json({
        message: 'Field type must be Text, Date, or Dropdown'
      });
    }
    const safeKey = key && key.trim() || label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!safeKey) return res.status(400).json({
      message: 'Could not derive a field key from that label'
    });
    const existing = await TestPrepFieldConfig.findOne({
      kind: 'custom',
      key: safeKey
    });
    if (existing) return res.status(409).json({
      message: 'A field with that key already exists'
    });
    const last = await TestPrepFieldConfig.findOne({
      kind: 'custom'
    }).sort({
      order: -1
    });
    const order = (last?.order ?? -1) + 1;
    const config = await TestPrepFieldConfig.create({
      kind: 'custom',
      key: safeKey,
      label: label.trim(),
      type,
      options: type === 'dropdown' ? (options || []).map(o => o.trim()).filter(Boolean) : [],
      required: !!required,
      order
    });
    res.status(201).json({
      field: config
    });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({
      message: 'A field with that key already exists'
    });
    res.status(500).json({
      message: 'Failed to create field'
    });
  }
});
router.put('/custom/:id', requireAdmin, async (req, res) => {
  try {
    const {
      label,
      options,
      required,
      active,
      type
    } = req.body;
    const update = {};
    if (label !== undefined) update.label = label.trim();
    if (type !== undefined) {
      if (!ALLOWED_CUSTOM_TYPES.includes(type)) {
        return res.status(400).json({
          message: 'Field type must be Text, Date, or Dropdown'
        });
      }
      update.type = type;
    }
    if (options !== undefined) update.options = options.map(o => o.trim()).filter(Boolean);
    if (required !== undefined) update.required = !!required;
    if (active !== undefined) update.active = !!active;
    const config = await TestPrepFieldConfig.findOneAndUpdate({
      _id: req.params.id,
      kind: 'custom'
    }, update, {
      new: true
    });
    if (!config) return res.status(404).json({
      message: 'Field not found'
    });
    res.json({
      field: config
    });
  } catch {
    res.status(500).json({
      message: 'Failed to update field'
    });
  }
});
router.put('/custom/reorder/all', requireAdmin, async (req, res) => {
  try {
    const {
      order
    } = req.body;
    if (!Array.isArray(order) || order.length === 0) {
      return res.status(400).json({
        message: 'An ordered list of field IDs is required'
      });
    }
    await Promise.all(order.map((id, idx) => TestPrepFieldConfig.updateOne({
      _id: id,
      kind: 'custom'
    }, {
      order: idx
    })));
    const configs = await TestPrepFieldConfig.find({
      kind: 'custom'
    }).sort({
      order: 1,
      createdAt: 1
    });
    res.json({
      fields: configs
    });
  } catch {
    res.status(500).json({
      message: 'Failed to reorder fields'
    });
  }
});
router.delete('/custom/:id', requireAdmin, async (req, res) => {
  try {
    const config = await TestPrepFieldConfig.findOne({
      _id: req.params.id,
      kind: 'custom'
    });
    if (!config) return res.status(404).json({
      message: 'Field not found'
    });
    await softDelete({
      modelName: 'TestPrepFieldConfig',
      doc: config,
      userId: req.user._id,
      userName: req.user.name || req.user.username,
      meta: {
        label: config.label,
        key: config.key
      }
    });
    res.json({
      message: 'Moved to trash',
      key: config.key
    });
  } catch {
    res.status(500).json({
      message: 'Failed to delete field'
    });
  }
});
module.exports = router;
