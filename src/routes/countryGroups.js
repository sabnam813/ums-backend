const express = require('express');
const CountryGroup = require('../models/CountryGroup');
const Country = require('../models/Country');
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
async function getOrCreateUnassignedGroup() {
  let group = await CountryGroup.findOne({
    isDefault: true
  });
  if (group) return group;
  const count = await CountryGroup.countDocuments();
  group = await CountryGroup.create({
    name: 'Unassigned',
    slug: 'unassigned',
    order: count,
    isDefault: true
  });
  return group;
}
async function withCounts(groups) {
  return Promise.all(groups.map(async g => {
    const obj = g.toObject ? g.toObject() : g;
    const total = await Country.countDocuments({
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
    let groups = await CountryGroup.find().sort({
      order: 1,
      name: 1
    });
    groups = await withCounts(groups);
    res.json({
      groups
    });
  } catch {
    res.status(500).json({
      message: 'Failed to fetch country groups'
    });
  }
});
router.get('/:id', async (req, res) => {
  try {
    const group = await CountryGroup.findById(req.params.id);
    if (!group) return res.status(404).json({
      message: 'Country group not found'
    });
    const countries = await Country.find({
      group: group._id
    }).sort({
      order: 1,
      name: 1
    });
    res.json({
      group,
      countries
    });
  } catch {
    res.status(500).json({
      message: 'Failed to fetch country group'
    });
  }
});
router.post('/', requireAdmin, async (req, res) => {
  try {
    const {
      name,
      order
    } = req.body;
    if (!name || !name.trim()) return res.status(400).json({
      message: 'Group name is required'
    });
    const slug = slugify(name);
    if (!slug) return res.status(400).json({
      message: 'Group name is invalid'
    });
    const existing = await CountryGroup.findOne({
      slug
    });
    if (existing) return res.status(400).json({
      message: 'A group with this name already exists'
    });
    const count = await CountryGroup.countDocuments();
    const group = await CountryGroup.create({
      name: name.trim(),
      slug,
      order: Number.isFinite(order) ? order : count
    });
    res.status(201).json({
      group
    });
  } catch {
    res.status(500).json({
      message: 'Failed to create country group'
    });
  }
});
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const {
      name,
      order
    } = req.body;
    const update = {};
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({
        message: 'Group name is required'
      });
      const slug = slugify(name);
      const clash = await CountryGroup.findOne({
        slug,
        _id: {
          $ne: req.params.id
        }
      });
      if (clash) return res.status(400).json({
        message: 'A group with this name already exists'
      });
      update.name = name.trim();
      update.slug = slug;
    }
    if (order !== undefined) update.order = order;
    const group = await CountryGroup.findByIdAndUpdate(req.params.id, update, {
      new: true
    });
    if (!group) return res.status(404).json({
      message: 'Country group not found'
    });
    res.json({
      group
    });
  } catch {
    res.status(500).json({
      message: 'Failed to update country group'
    });
  }
});
router.put('/reorder/bulk', requireAdmin, async (req, res) => {
  try {
    const {
      orderedGroupIds
    } = req.body;
    if (!Array.isArray(orderedGroupIds)) return res.status(400).json({
      message: 'orderedGroupIds must be an array'
    });
    await Promise.all(orderedGroupIds.map((id, idx) => CountryGroup.findByIdAndUpdate(id, {
      order: idx
    })));
    const groups = await withCounts(await CountryGroup.find().sort({
      order: 1,
      name: 1
    }));
    res.json({
      groups
    });
  } catch {
    res.status(500).json({
      message: 'Failed to reorder country groups'
    });
  }
});
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const group = await CountryGroup.findById(req.params.id);
    if (!group) return res.status(404).json({
      message: 'Country group not found'
    });
    if (group.isDefault) {
      return res.status(400).json({
        message: 'The Unassigned group cannot be deleted'
      });
    }
    const fallback = await getOrCreateUnassignedGroup();
    const countries = await Country.find({
      group: group._id
    });
    if (countries.length) {
      const startOrder = await Country.countDocuments({
        group: fallback._id
      });
      await Promise.all(countries.map((c, idx) => Country.findByIdAndUpdate(c._id, {
        group: fallback._id,
        order: startOrder + idx
      })));
    }
    await softDelete({
      modelName: 'CountryGroup',
      doc: group,
      userId: req.user._id,
      userName: req.user.name || req.user.username,
      meta: {
        name: group.name,
        movedCountries: countries.length,
        movedTo: fallback._id.toString()
      }
    });
    res.json({
      message: 'Moved to trash',
      movedCountries: countries.length
    });
  } catch {
    res.status(500).json({
      message: 'Failed to delete country group'
    });
  }
});
module.exports = router;
module.exports.getOrCreateUnassignedGroup = getOrCreateUnassignedGroup;
