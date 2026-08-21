const express = require('express');
const mongoose = require('mongoose');
const ContactGroup = require('../models/ContactGroup');
const Contact = require('../models/Contact');
const {
  verifyAccess,
  requireAdmin
} = require('../middleware/auth');
const {
  softDelete
} = require('../utils/trashHelper');
const router = express.Router();
router.use(verifyAccess);
function slugify(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
function fieldKeyFrom(label) {
  return String(label || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
const FIELD_TYPES = ['text', 'number', 'email'];
async function withCounts(groups) {
  return Promise.all(groups.map(async g => {
    const obj = g.toObject ? g.toObject() : g;
    const total = await Contact.countDocuments({
      group: g._id
    });
    return {
      ...obj,
      total
    };
  }));
}
router.get('/', async (req, res) => {
  try {
    let groups = await ContactGroup.find().sort({
      order: 1,
      name: 1
    });
    groups = await withCounts(groups);
    res.json({
      groups
    });
  } catch {
    res.status(500).json({
      message: 'Failed to fetch contact groups'
    });
  }
});
router.get('/:id', async (req, res) => {
  try {
    const group = await ContactGroup.findById(req.params.id);
    if (!group) return res.status(404).json({
      message: 'Contact group not found'
    });
    res.json({
      group
    });
  } catch {
    res.status(500).json({
      message: 'Failed to fetch contact group'
    });
  }
});
router.post('/', requireAdmin, async (req, res) => {
  try {
    const {
      name,
      description,
      order
    } = req.body;
    if (!name || !name.trim()) return res.status(400).json({
      message: 'Group name is required'
    });
    const slug = slugify(name);
    if (!slug) return res.status(400).json({
      message: 'Group name is invalid'
    });
    const existing = await ContactGroup.findOne({
      slug
    });
    if (existing) return res.status(400).json({
      message: 'A contact group with this name already exists'
    });
    const count = await ContactGroup.countDocuments();
    const group = await ContactGroup.create({
      name: name.trim(),
      slug,
      description: (description || '').trim(),
      order: Number.isFinite(order) ? order : count,
      fields: []
    });
    res.status(201).json({
      group
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to create contact group'
    });
  }
});
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const {
      name,
      description,
      order
    } = req.body;
    const update = {};
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({
        message: 'Group name is required'
      });
      const slug = slugify(name);
      const clash = await ContactGroup.findOne({
        slug,
        _id: {
          $ne: req.params.id
        }
      });
      if (clash) return res.status(400).json({
        message: 'A contact group with this name already exists'
      });
      update.name = name.trim();
      update.slug = slug;
    }
    if (description !== undefined) update.description = description;
    if (order !== undefined) update.order = order;
    const group = await ContactGroup.findByIdAndUpdate(req.params.id, update, {
      new: true
    });
    if (!group) return res.status(404).json({
      message: 'Contact group not found'
    });
    res.json({
      group
    });
  } catch {
    res.status(500).json({
      message: 'Failed to update contact group'
    });
  }
});
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const group = await ContactGroup.findById(req.params.id);
    if (!group) return res.status(404).json({
      message: 'Contact group not found'
    });
    const contacts = await Contact.find({
      group: group._id
    });
    for (const contact of contacts) {
      await softDelete({
        modelName: 'Contact',
        doc: contact,
        userId: req.user._id,
        userName: req.user.name || req.user.username,
        meta: {
          group: group._id.toString(),
          groupName: group.name,
          cascadeFromGroup: true
        }
      });
    }
    await softDelete({
      modelName: 'ContactGroup',
      doc: group,
      userId: req.user._id,
      userName: req.user.name || req.user.username,
      meta: {
        name: group.name,
        cascadedContacts: contacts.length
      }
    });
    res.json({
      message: 'Moved to trash',
      cascadedContacts: contacts.length
    });
  } catch {
    res.status(500).json({
      message: 'Failed to delete contact group'
    });
  }
});
router.post('/:id/fields', requireAdmin, async (req, res) => {
  try {
    const {
      label,
      type,
      required
    } = req.body;
    if (!label || !label.trim()) return res.status(400).json({
      message: 'Field label is required'
    });
    const resolvedType = FIELD_TYPES.includes(type) ? type : 'text';
    const group = await ContactGroup.findById(req.params.id);
    if (!group) return res.status(404).json({
      message: 'Contact group not found'
    });
    const key = fieldKeyFrom(label);
    if (!key) return res.status(400).json({
      message: 'Could not derive a field key from that label'
    });
    if (group.fields.some(f => f.key === key)) {
      return res.status(409).json({
        message: 'A field with that name already exists in this group'
      });
    }
    const order = group.fields.length ? Math.max(...group.fields.map(f => f.order ?? 0)) + 1 : 0;
    group.fields.push({
      key,
      label: label.trim(),
      type: resolvedType,
      required: !!required,
      order
    });
    await group.save();
    res.status(201).json({
      group
    });
  } catch {
    res.status(500).json({
      message: 'Failed to add field'
    });
  }
});
router.put('/:id/fields/:fieldId', requireAdmin, async (req, res) => {
  try {
    const {
      label,
      type,
      required,
      order
    } = req.body;
    const group = await ContactGroup.findById(req.params.id);
    if (!group) return res.status(404).json({
      message: 'Contact group not found'
    });
    const field = group.fields.id(req.params.fieldId);
    if (!field) return res.status(404).json({
      message: 'Field not found'
    });
    if (label !== undefined) {
      if (!label.trim()) return res.status(400).json({
        message: 'Field label is required'
      });
      field.label = label.trim();
    }
    if (type !== undefined && FIELD_TYPES.includes(type)) field.type = type;
    if (required !== undefined) field.required = !!required;
    if (order !== undefined) field.order = order;
    await group.save();
    res.json({
      group
    });
  } catch {
    res.status(500).json({
      message: 'Failed to update field'
    });
  }
});
router.delete('/:id/fields/:fieldId', requireAdmin, async (req, res) => {
  try {
    const group = await ContactGroup.findById(req.params.id);
    if (!group) return res.status(404).json({
      message: 'Contact group not found'
    });
    const field = group.fields.id(req.params.fieldId);
    if (!field) return res.status(404).json({
      message: 'Field not found'
    });
    const removedKey = field.key;
    field.deleteOne();
    await group.save();
    res.json({
      group,
      removedKey
    });
  } catch {
    res.status(500).json({
      message: 'Failed to delete field'
    });
  }
});
router.put('/:id/fields-reorder', requireAdmin, async (req, res) => {
  try {
    const {
      orderedFieldIds
    } = req.body;
    if (!Array.isArray(orderedFieldIds)) return res.status(400).json({
      message: 'orderedFieldIds must be an array'
    });
    const group = await ContactGroup.findById(req.params.id);
    if (!group) return res.status(404).json({
      message: 'Contact group not found'
    });
    orderedFieldIds.forEach((fieldId, idx) => {
      const field = group.fields.id(fieldId);
      if (field) field.order = idx;
    });
    await group.save();
    res.json({
      group
    });
  } catch {
    res.status(500).json({
      message: 'Failed to reorder fields'
    });
  }
});
module.exports = router;
