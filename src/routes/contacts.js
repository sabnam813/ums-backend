const express = require('express');
const Contact = require('../models/Contact');
const ContactGroup = require('../models/ContactGroup');
const {
  verifyAccess,
  requirePermission
} = require('../middleware/auth');
const {
  softDelete
} = require('../utils/trashHelper');
const router = express.Router();
router.use(verifyAccess);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function buildContactData(fields, rawData = {}) {
  const data = {};
  const errors = [];
  for (const field of fields) {
    const raw = rawData ? rawData[field.key] : undefined;
    const value = raw === undefined || raw === null ? '' : String(raw).trim();
    if (field.required && !value) {
      errors.push(`${field.label} is required`);
      continue;
    }
    if (value && field.type === 'email' && !EMAIL_RE.test(value)) {
      errors.push(`${field.label} must be a valid email address`);
      continue;
    }
    if (value && field.type === 'number' && isNaN(Number(value))) {
      errors.push(`${field.label} must be a number`);
      continue;
    }
    if (value) data[field.key] = value;
  }
  return {
    data,
    errors
  };
}
router.get('/group/:groupId', requirePermission('contacts', 'view'), async (req, res) => {
  try {
    const group = await ContactGroup.findById(req.params.groupId);
    if (!group) return res.status(404).json({
      message: 'Contact group not found'
    });
    const contacts = await Contact.find({
      group: req.params.groupId
    }).sort({
      createdAt: -1
    });
    const {
      q
    } = req.query;
    let list = contacts;
    if (q && q.trim()) {
      const needle = q.trim().toLowerCase();
      list = contacts.filter(c => {
        const values = Array.from((c.data || new Map()).values());
        return values.some(v => String(v).toLowerCase().includes(needle));
      });
    }
    res.json({
      group,
      contacts: list
    });
  } catch {
    res.status(500).json({
      message: 'Failed to fetch contacts'
    });
  }
});
router.post('/', requirePermission('contacts', 'create'), async (req, res) => {
  try {
    const {
      group: groupId,
      data
    } = req.body;
    if (!groupId) return res.status(400).json({
      message: 'Contact group is required'
    });
    const group = await ContactGroup.findById(groupId);
    if (!group) return res.status(404).json({
      message: 'Contact group not found'
    });
    const {
      data: cleanData,
      errors
    } = buildContactData(group.fields, data);
    if (errors.length) return res.status(400).json({
      message: errors[0],
      errors
    });
    const contact = await Contact.create({
      group: groupId,
      data: cleanData,
      createdBy: req.user._id
    });
    res.status(201).json({
      contact
    });
  } catch {
    res.status(500).json({
      message: 'Failed to create contact'
    });
  }
});
router.put('/:id', requirePermission('contacts', 'edit'), async (req, res) => {
  try {
    const contact = await Contact.findById(req.params.id);
    if (!contact) return res.status(404).json({
      message: 'Contact not found'
    });
    const group = await ContactGroup.findById(contact.group);
    if (!group) return res.status(404).json({
      message: 'Contact group not found'
    });
    const {
      data: cleanData,
      errors
    } = buildContactData(group.fields, req.body.data);
    if (errors.length) return res.status(400).json({
      message: errors[0],
      errors
    });
    contact.data = cleanData;
    await contact.save();
    res.json({
      contact
    });
  } catch {
    res.status(500).json({
      message: 'Failed to update contact'
    });
  }
});
router.delete('/:id', requirePermission('contacts', 'delete'), async (req, res) => {
  try {
    const contact = await Contact.findById(req.params.id);
    if (!contact) return res.status(404).json({
      message: 'Contact not found'
    });
    await softDelete({
      modelName: 'Contact',
      doc: contact,
      userId: req.user._id,
      userName: req.user.name || req.user.username,
      meta: {
        group: contact.group.toString()
      }
    });
    res.json({
      message: 'Moved to trash'
    });
  } catch {
    res.status(500).json({
      message: 'Failed to delete contact'
    });
  }
});
router.get('/search', requirePermission('contacts', 'view'), async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    if (!q) return res.json({
      results: []
    });
    const groups = await ContactGroup.find();
    const groupsById = new Map(groups.map(g => [String(g._id), g]));
    const contacts = await Contact.find({
      group: {
        $in: groups.map(g => g._id)
      }
    }).sort({
      createdAt: -1
    });
    const results = contacts.filter(c => {
      const values = Array.from((c.data || new Map()).values());
      return values.some(v => String(v).toLowerCase().includes(q));
    }).map(c => ({
      contact: c,
      group: groupsById.get(String(c.group)) || null
    })).filter(r => r.group);
    res.json({
      results
    });
  } catch {
    res.status(500).json({
      message: 'Failed to search contacts'
    });
  }
});
module.exports = router;
