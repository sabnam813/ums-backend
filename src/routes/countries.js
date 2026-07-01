const express = require('express');
const Country = require('../models/Country');
const User = require('../models/User');
const Application = require('../models/Application');
const { verifyAccess, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(verifyAccess);

async function withCounts(countries) {
  const results = await Promise.all(
    countries.map(async (c) => {
      const obj = c.toObject ? c.toObject() : c;
      const [total, offered, paid] = await Promise.all([
        Application.countDocuments({ country: c._id }),
        Application.countDocuments({ country: c._id, offerLetter: 'Received' }),
        Application.countDocuments({ country: c._id, payment: 'Complete' }),
      ]);
      return { ...obj, count: total, total, offered, paid };
    })
  );
  return results;
}

router.get('/', async (req, res) => {
  try {
    let countries;
    if (req.user.role === 'admin') {
      countries = await Country.find();
    } else {
      countries = await Country.find({ _id: { $in: req.user.countries } });
    }
    countries = await withCounts(countries);
    res.json({ countries });
  } catch {
    res.status(500).json({ message: 'Failed to fetch countries' });
  }
});

router.get('/mine', async (req, res) => {
  try {
    let countries = await Country.find({ _id: { $in: req.user.countries } });
    countries = await withCounts(countries);
    res.json({ countries });
  } catch {
    res.status(500).json({ message: 'Failed' });
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
    const { name, flag, flagImage } = req.body;
    if (!name) return res.status(400).json({ message: 'Country name required' });
    if (!validFlagImage(flagImage)) return res.status(400).json({ message: 'Flag image is invalid or too large (max ~1.5MB)' });
    const country = await Country.create({ name, flag: flag || '', flagImage: flagImage || '' });
    res.status(201).json({ country });
  } catch (err) {
    res.status(500).json({ message: 'Failed to create country' });
  }
});

router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { name, flag, flagImage } = req.body;
    if (!validFlagImage(flagImage)) return res.status(400).json({ message: 'Flag image is invalid or too large (max ~1.5MB)' });
    const update = { name, flag };
    
    if (flagImage !== undefined) update.flagImage = flagImage;
    const country = await Country.findByIdAndUpdate(
      req.params.id, update, { new: true }
    );
    if (!country) return res.status(404).json({ message: 'Country not found' });
    res.json({ country });
  } catch {
    res.status(500).json({ message: 'Failed to update country' });
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const country = await Country.findByIdAndDelete(req.params.id);
    if (!country) return res.status(404).json({ message: 'Not found' });
    
    await User.updateMany({ countries: country._id }, { $pull: { countries: country._id } });
    await Application.deleteMany({ country: country._id });
    res.json({ message: 'Deleted' });
  } catch {
    res.status(500).json({ message: 'Failed to delete' });
  }
});

module.exports = router;
