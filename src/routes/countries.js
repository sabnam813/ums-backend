const express = require('express');
const Country = require('../models/Country');
const CountryGroup = require('../models/CountryGroup');
const User = require('../models/User');
const Application = require('../models/Application');
const Inquiry = require('../models/Inquiry');
const {
  verifyAccess,
  requireAdmin
} = require('../middleware/auth');
const {
  softDelete
} = require('../utils/trashHelper');
const {
  getOrCreateUnassignedGroup
} = require('./countryGroups');
const router = express.Router();
router.use(verifyAccess);
async function withCounts(countries, dateFilter = {}) {
  const results = await Promise.all(countries.map(async c => {
    const obj = c.toObject ? c.toObject() : c;
    const [total, offered, paid, visaGranted] = await Promise.all([Application.countDocuments({
      country: c._id,
      ...dateFilter
    }), Application.countDocuments({
      country: c._id,
      ...dateFilter,
      offerLetter: 'Received'
    }), Application.countDocuments({
      country: c._id,
      ...dateFilter,
      payment: 'Complete'
    }), Application.countDocuments({
      country: c._id,
      ...dateFilter,
      visaOutcome: 'Grant'
    })]);
    return {
      ...obj,
      count: total,
      total,
      offered,
      paid,
      visaGranted
    };
  }));
  return results;
}
function buildDateFilter(req) {
  const {
    dateFrom,
    dateTo
  } = req.query;
  const dateFilter = {};
  if (dateFrom || dateTo) {
    dateFilter.date = {};
    if (dateFrom) dateFilter.date.$gte = new Date(dateFrom);
    if (dateTo) dateFilter.date.$lte = new Date(dateTo);
  }
  return dateFilter;
}

async function renameCountryEverywhere(oldName, newName) {
  if (!oldName || !newName || oldName === newName) return;
  await Inquiry.updateMany(
    { country: oldName },
    { $set: { 'country.$[elem]': newName } },
    { arrayFilters: [{ elem: oldName }] }
  );
  await Inquiry.updateMany({}, [{ $set: { country: { $setUnion: ['$country', []] } } }]);
}
router.get('/', async (req, res) => {
  try {
    let countries;
    if (['admin', 'super_admin'].includes(req.user.role)) {
      countries = await Country.find();
    } else {
      countries = await Country.find({
        _id: {
          $in: req.user.countries
        }
      });
    }
    countries = await withCounts(countries, buildDateFilter(req));
    res.json({
      countries
    });
  } catch {
    res.status(500).json({
      message: 'Failed to fetch countries'
    });
  }
});
router.get('/mine', async (req, res) => {
  try {
    let countries = await Country.find({
      _id: {
        $in: req.user.countries
      }
    });
    countries = await withCounts(countries, buildDateFilter(req));
    res.json({
      countries
    });
  } catch {
    res.status(500).json({
      message: 'Failed'
    });
  }
});
router.get('/names', async (req, res) => {
  try {
    const countries = await Country.find().select('name flag flagImage').sort({
      name: 1
    });
    res.json({
      countries
    });
  } catch {
    res.status(500).json({
      message: 'Failed to fetch countries'
    });
  }
});
const MAX_FLAG_IMAGE_LENGTH = 1.5 * 1024 * 1024;
function validFlagImage(flagImage) {
  if (!flagImage) return true;
  if (typeof flagImage !== 'string') return false;
  if (!flagImage.startsWith('data:image/')) return false;
  return flagImage.length <= MAX_FLAG_IMAGE_LENGTH;
}
router.post('/', requireAdmin, async (req, res) => {
  try {
    const {
      name,
      flag,
      flagImage,
      group
    } = req.body;
    if (!name) return res.status(400).json({
      message: 'Country name required'
    });
    if (!validFlagImage(flagImage)) return res.status(400).json({
      message: 'Flag image is invalid or too large (max ~1.5MB)'
    });
    let groupId = group || null;
    if (groupId) {
      const exists = await CountryGroup.findById(groupId);
      if (!exists) return res.status(404).json({
        message: 'Country group not found'
      });
    } else {
      const fallback = await getOrCreateUnassignedGroup();
      groupId = fallback._id;
    }
    const order = await Country.countDocuments({
      group: groupId
    });
    const country = await Country.create({
      name,
      flag: flag || '',
      flagImage: flagImage || '',
      group: groupId,
      order
    });
    res.status(201).json({
      country
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to create country'
    });
  }
});
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const {
      name,
      flag,
      flagImage,
      group,
      order
    } = req.body;
    if (!validFlagImage(flagImage)) return res.status(400).json({
      message: 'Flag image is invalid or too large (max ~1.5MB)'
    });
    const existing = await Country.findById(req.params.id);
    if (!existing) return res.status(404).json({
      message: 'Country not found'
    });
    const oldName = existing.name;
    const update = {
      name,
      flag
    };
    if (flagImage !== undefined) update.flagImage = flagImage;
    if (group !== undefined) {
      const exists = await CountryGroup.findById(group);
      if (!exists) return res.status(404).json({
        message: 'Country group not found'
      });
      update.group = group;
    }
    if (order !== undefined) update.order = order;
    const country = await Country.findByIdAndUpdate(req.params.id, update, {
      new: true
    });
    if (!country) return res.status(404).json({
      message: 'Country not found'
    });
    if (name !== undefined && country.name !== oldName) {
      await renameCountryEverywhere(oldName, country.name);
    }
    res.json({
      country
    });
  } catch {
    res.status(500).json({
      message: 'Failed to update country'
    });
  }
});
router.put('/:id/move', requireAdmin, async (req, res) => {
  try {
    const {
      groupId
    } = req.body;
    if (!groupId) return res.status(400).json({
      message: 'groupId is required'
    });
    const [country, group] = await Promise.all([Country.findById(req.params.id), CountryGroup.findById(groupId)]);
    if (!country) return res.status(404).json({
      message: 'Country not found'
    });
    if (!group) return res.status(404).json({
      message: 'Country group not found'
    });
    const order = await Country.countDocuments({
      group: groupId
    });
    country.group = groupId;
    country.order = order;
    await country.save();
    res.json({
      country
    });
  } catch {
    res.status(500).json({
      message: 'Failed to move country'
    });
  }
});
router.put('/group/:groupId/reorder', requireAdmin, async (req, res) => {
  try {
    const {
      orderedCountryIds
    } = req.body;
    if (!Array.isArray(orderedCountryIds)) return res.status(400).json({
      message: 'orderedCountryIds must be an array'
    });
    await Promise.all(orderedCountryIds.map((id, idx) => Country.findOneAndUpdate({
      _id: id,
      group: req.params.groupId
    }, {
      order: idx
    })));
    const countries = await Country.find({
      group: req.params.groupId
    }).sort({
      order: 1,
      name: 1
    });
    res.json({
      countries
    });
  } catch {
    res.status(500).json({
      message: 'Failed to reorder countries'
    });
  }
});
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const country = await Country.findById(req.params.id);
    if (!country) return res.status(404).json({
      message: 'Not found'
    });
    const affectedUsers = await User.find({
      countries: country._id
    }, '_id');
    const affectedUserIds = affectedUsers.map(u => u._id.toString());
    const apps = await Application.find({
      country: country._id
    });
    for (const app of apps) {
      await softDelete({
        modelName: 'Application',
        doc: app,
        userId: req.user._id,
        userName: req.user.name || req.user.username,
        meta: {
          name: app.name,
          country: country._id.toString(),
          cascadeFromCountry: true
        }
      });
    }
    await User.updateMany({
      countries: country._id
    }, {
      $pull: {
        countries: country._id
      }
    });
    await softDelete({
      modelName: 'Country',
      doc: country,
      userId: req.user._id,
      userName: req.user.name || req.user.username,
      meta: {
        name: country.name,
        affectedUserIds,
        cascadedApplications: apps.length
      }
    });
    res.json({
      message: 'Moved to trash',
      cascadedApplications: apps.length
    });
  } catch {
    res.status(500).json({
      message: 'Failed to delete'
    });
  }
});
module.exports = router;
