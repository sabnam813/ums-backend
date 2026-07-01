const express = require('express');
const FieldConfig = require('../models/FieldConfig');
const { verifyAccess, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(verifyAccess);

const EXTENDABLE_FIELDS = [
  'level', 'gsSubmission',
  'olRequest', 'offerLetter', 'withdraw',
  'payment', 'coeCas', 'savisFee', 'refund',
  'visaOutcome', 'visaWithdraw',
];

router.get('/', async (req, res) => {
  try {
    const configs = await FieldConfig.find({ active: true }).sort({ kind: 1, order: 1, createdAt: 1 });
    res.json({ fields: configs });
  } catch {
    res.status(500).json({ message: 'Failed to fetch field configuration' });
  }
});

router.post('/options', requireAdmin, async (req, res) => {
  try {
    const { fieldKey, option } = req.body;
    if (!fieldKey || !EXTENDABLE_FIELDS.includes(fieldKey))
      return res.status(400).json({ message: 'Unknown or non-extendable field' });
    if (!option || !option.trim())
      return res.status(400).json({ message: 'Option text is required' });
    const trimmed = option.trim();

    let config = await FieldConfig.findOne({ kind: 'options', fieldKey });
    if (!config) {
      config = await FieldConfig.create({ kind: 'options', fieldKey, label: fieldKey, options: [trimmed] });
    } else {
      if (config.options.some(o => o.toLowerCase() === trimmed.toLowerCase()))
        return res.status(409).json({ message: 'That option already exists' });
      config.options.push(trimmed);
      await config.save();
    }
    res.status(201).json({ field: config });
  } catch (err) {
    res.status(500).json({ message: 'Failed to add option' });
  }
});

router.delete('/options', requireAdmin, async (req, res) => {
  try {
    const { fieldKey, option } = req.body;
    const config = await FieldConfig.findOne({ kind: 'options', fieldKey });
    if (!config) return res.status(404).json({ message: 'Not found' });
    const before = config.options.length;
    config.options = config.options.filter(o => o !== option);
    if (config.options.length === before)
      return res.status(404).json({ message: 'Option not found' });
    await config.save();
    res.json({ field: config });
  } catch {
    res.status(500).json({ message: 'Failed to remove option' });
  }
});

router.post('/custom', requireAdmin, async (req, res) => {
  try {
    const { key, label, type, options, required, section, validationType, position, afterFieldId } = req.body;
    if (!label || !label.trim()) return res.status(400).json({ message: 'Field label is required' });

    const safeKey = (key && key.trim()) ||
      label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!safeKey) return res.status(400).json({ message: 'Could not derive a field key from that label' });

    const existing = await FieldConfig.findOne({ kind: 'custom', key: safeKey });
    if (existing) return res.status(409).json({ message: 'A field with that key already exists' });

    const resolvedSection = section || 'Additional Information';
    const last = await FieldConfig.findOne({ kind: 'custom' }).sort({ order: -1 });
    let order = (last?.order ?? -1) + 1;
    let slotKey = 'last';

    if (position === 'first') {
      const firstInSection = await FieldConfig.findOne({ kind: 'custom', section: resolvedSection }).sort({ order: 1 });
      order = firstInSection ? firstInSection.order - 1 : order;
      slotKey = 'first';
    } else if (position === 'after' && afterFieldId) {
      slotKey = afterFieldId;
      // If afterFieldId refers to an existing custom field (not a built-in slot key),
      // place this field's order right after it for correct ordering within the section.
      const afterField = await FieldConfig.findOne({ kind: 'custom', _id: afterFieldId }).catch(() => null);
      if (afterField) {
        order = afterField.order + 0.5;
      }
    }
    // position === 'last' (or unspecified) falls through to appending at the end

    const config = await FieldConfig.create({
      kind: 'custom',
      key: safeKey,
      label: label.trim(),
      type: type || 'text',
      options: type === 'dropdown' ? (options || []).map(o => o.trim()).filter(Boolean) : [],
      required: !!required,
      section: resolvedSection,
      order,
      afterFieldId: slotKey,
      validationType: validationType || null,
    });

    // Renormalize order values to clean integers so future inserts stay simple
    const all = await FieldConfig.find({ kind: 'custom' }).sort({ order: 1, createdAt: 1 });
    await Promise.all(all.map((f, idx) => f.order === idx ? null : FieldConfig.updateOne({ _id: f._id }, { order: idx })));

    res.status(201).json({ field: config });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'A field with that key already exists' });
    res.status(500).json({ message: 'Failed to create field' });
  }
});

router.put('/custom/:id', requireAdmin, async (req, res) => {
  try {
    const { label, options, required, section, active, validationType } = req.body;
    const update = {};
    if (label !== undefined) update.label = label.trim();
    if (options !== undefined) update.options = options.map(o => o.trim()).filter(Boolean);
    if (required !== undefined) update.required = !!required;
    if (section !== undefined) update.section = section;
    if (active !== undefined) update.active = !!active;
    if (validationType !== undefined) update.validationType = validationType;

    const config = await FieldConfig.findOneAndUpdate(
      { _id: req.params.id, kind: 'custom' }, update, { new: true }
    );
    if (!config) return res.status(404).json({ message: 'Field not found' });
    res.json({ field: config });
  } catch {
    res.status(500).json({ message: 'Failed to update field' });
  }
});

router.delete('/custom/:id', requireAdmin, async (req, res) => {
  try {
    const config = await FieldConfig.findOneAndDelete({ _id: req.params.id, kind: 'custom' });
    if (!config) return res.status(404).json({ message: 'Field not found' });
    res.json({ message: 'Deleted', key: config.key });
  } catch {
    res.status(500).json({ message: 'Failed to delete field' });
  }
});

module.exports = router;
