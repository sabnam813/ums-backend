const express = require('express');
const Inquiry = require('../models/Inquiry');
const { verifyAccess } = require('../middleware/auth');

const router = express.Router();
router.use(verifyAccess);

// All authenticated users (admin + regular users) can access inquiries.

router.get('/', async (req, res) => {
  try {
    const { search, stage, country, level, dateFrom, dateTo, limit = 500 } = req.query;
    const query = {};

    if (stage) query.stage = { $in: stage.split(',') };
    if (country) query.country = { $in: country.split(',') };
    if (level) query.level = { $in: level.split(',') };
    if (dateFrom || dateTo) {
      query.date = {};
      if (dateFrom) query.date.$gte = new Date(dateFrom);
      if (dateTo) query.date.$lte = new Date(dateTo);
    }
    if (search) {
      query.$or = [
        { applicantName: new RegExp(search, 'i') },
        { referredBy: new RegExp(search, 'i') },
        { country: new RegExp(search, 'i') },
        { remarks: new RegExp(search, 'i') },
      ];
    }

    const inquiries = await Inquiry.find(query)
      .sort({ date: -1 })
      .limit(Number(limit))
      .populate('createdBy', 'username name');

    res.json({ inquiries, total: inquiries.length });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch inquiries' });
  }
});

router.post('/', async (req, res) => {
  try {
    const inquiry = await Inquiry.create({
      ...req.body,
      createdBy: req.user._id,
      date: req.body.date || new Date(),
    });
    res.status(201).json({ inquiry });
  } catch (err) {
    res.status(500).json({ message: 'Failed to create inquiry' });
  }
});

router.post('/bulk/create', async (req, res) => {
  try {
    const { inquiries } = req.body;
    if (!inquiries || !Array.isArray(inquiries) || inquiries.length === 0) {
      return res.status(400).json({ message: 'No inquiries provided' });
    }

    const toCreate = inquiries.map(i => ({
      ...i,
      createdBy: req.user._id,
      date: i.date ? new Date(i.date) : new Date(),
    }));

    let created = [];
    let failedCount = 0;
    try {
      created = await Inquiry.insertMany(toCreate, { ordered: false });
    } catch (bulkErr) {
      if (bulkErr.name === 'MongoBulkWriteError' || bulkErr.writeErrors) {
        created = bulkErr.insertedDocs || [];
        failedCount = (bulkErr.writeErrors || []).length;
      } else {
        throw bulkErr;
      }
    }

    res.status(201).json({
      inquiries: created,
      created: created.length,
      ...(failedCount > 0 && { skipped: failedCount, warning: `${failedCount} row(s) skipped due to invalid data` }),
    });
  } catch (err) {
    console.error('Bulk create inquiry error:', err);
    res.status(500).json({ message: 'Failed to bulk create inquiries' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { _id, createdBy, ...safeBody } = req.body;
    const inquiry = await Inquiry.findByIdAndUpdate(
      req.params.id,
      safeBody,
      { new: true, runValidators: true }
    );
    if (!inquiry) return res.status(404).json({ message: 'Not found' });
    res.json({ inquiry });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update inquiry' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const inquiry = await Inquiry.findByIdAndDelete(req.params.id);
    if (!inquiry) return res.status(404).json({ message: 'Not found' });
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete inquiry' });
  }
});

router.put('/bulk/update', async (req, res) => {
  try {
    const { ids, updates } = req.body;
    if (!ids?.length) return res.status(400).json({ message: 'No IDs provided' });
    if (!updates || typeof updates !== 'object') return res.status(400).json({ message: 'No updates provided' });

    // Only allow known, editable fields through bulk update; strip anything else
    // (e.g. _id, createdBy) so callers can't tamper with protected data.
    const ALLOWED = ['referredBy', 'country', 'level', 'stage', 'mode', 'respondedBy', 'emailType', 'remarks', 'date'];
    const safeUpdates = {};
    Object.entries(updates).forEach(([k, v]) => {
      if (ALLOWED.includes(k) && v !== '' && v !== null && v !== undefined) {
        safeUpdates[k] = k === 'date' ? new Date(v) : v;
      }
    });
    if (Object.keys(safeUpdates).length === 0) {
      return res.status(400).json({ message: 'No valid fields to update' });
    }

    const result = await Inquiry.updateMany({ _id: { $in: ids } }, { $set: safeUpdates }, { runValidators: true });
    res.json({ updated: result.modifiedCount ?? result.nModified ?? 0 });
  } catch (err) {
    console.error('Bulk update inquiry error:', err);
    res.status(500).json({ message: 'Bulk update failed' });
  }
});

router.delete('/bulk/delete', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids?.length) return res.status(400).json({ message: 'No IDs provided' });
    const result = await Inquiry.deleteMany({ _id: { $in: ids } });
    res.json({ deleted: result.deletedCount });
  } catch (err) {
    res.status(500).json({ message: 'Bulk delete failed' });
  }
});

module.exports = router;
