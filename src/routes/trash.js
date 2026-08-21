const express = require('express');
const Trash = require('../models/Trash');
const User = require('../models/User');
const {
  restoreFromTrash,
  permanentDelete
} = require('../utils/trashHelper');
const {
  verifyAccess,
  requireTrashAccess
} = require('../middleware/auth');
const {
  hasPermission
} = require('../config/rbac');
const router = express.Router();
router.use(verifyAccess, requireTrashAccess);
function canManageItem(user) {
  return user.role === 'super_admin';
}
function isCountryScopedModel(model) {
  return model === 'Application' || model === 'Inquiry';
}
router.get('/', async (req, res) => {
  try {
    const {
      model
    } = req.query;
    const isSuperAdmin = req.user.role === 'super_admin';
    if (isSuperAdmin) {
      const query = {};
      if (model) query.model = model;
      const items = await Trash.find(query).sort({
        createdAt: -1
      }).limit(500).lean();
      return res.json({
        items,
        total: items.length
      });
    }
    const userCountries = (req.user.countries || []).map(c => String(c._id || c));
    const query = {
      model: {
        $in: ['Application', 'Inquiry']
      }
    };
    if (model && isCountryScopedModel(model)) query.model = model;else if (model) {
      return res.json({
        items: [],
        total: 0
      });
    }
    let items = await Trash.find(query).sort({
      createdAt: -1
    }).limit(500).lean();
    items = items.filter(item => {
      const countryId = String(item.data?.country || item.meta?.country || '');
      return userCountries.includes(countryId);
    });
    res.json({
      items,
      total: items.length
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to fetch trash'
    });
  }
});
router.post('/:id/restore', async (req, res) => {
  try {
    if (!canManageItem(req.user)) {
      return res.status(403).json({
        message: 'Only Super Admins can restore items from trash'
      });
    }
    const trashDoc = await Trash.findById(req.params.id);
    if (!trashDoc) return res.status(404).json({
      message: 'Not found'
    });
    const wasCountry = trashDoc.model === 'Country';
    const affectedUserIds = wasCountry ? trashDoc.meta?.affectedUserIds || [] : [];
    const restored = await restoreFromTrash(req.params.id);
    if (wasCountry && affectedUserIds.length) {
      await User.updateMany({
        _id: {
          $in: affectedUserIds
        }
      }, {
        $addToSet: {
          countries: restored._id
        }
      });
    }
    res.json({
      message: wasCountry ? `Restored successfully. Its applications are still in trash and can be restored separately.` : 'Restored successfully',
      item: restored
    });
  } catch (err) {
    res.status(400).json({
      message: err.message || 'Failed to restore'
    });
  }
});
router.delete('/:id', async (req, res) => {
  try {
    if (!canManageItem(req.user)) {
      return res.status(403).json({
        message: 'Only Super Admins can permanently delete items'
      });
    }
    const trashDoc = await Trash.findById(req.params.id);
    if (!trashDoc) return res.status(404).json({
      message: 'Not found'
    });
    await permanentDelete(req.params.id);
    res.json({
      message: 'Permanently deleted'
    });
  } catch (err) {
    res.status(400).json({
      message: err.message || 'Failed to permanently delete'
    });
  }
});
router.post('/bulk/restore', async (req, res) => {
  try {
    if (!canManageItem(req.user)) {
      return res.status(403).json({
        message: 'Only Super Admins can restore items from trash'
      });
    }
    const {
      ids
    } = req.body;
    if (!ids?.length) return res.status(400).json({
      message: 'No IDs provided'
    });
    let restored = 0;
    const errors = [];
    for (const id of ids) {
      try {
        await restoreFromTrash(id);
        restored++;
      } catch (e) {
        errors.push(id);
      }
    }
    res.json({
      restored,
      failed: errors.length
    });
  } catch (err) {
    res.status(500).json({
      message: 'Bulk restore failed'
    });
  }
});
router.delete('/bulk/delete', async (req, res) => {
  try {
    if (!canManageItem(req.user)) {
      return res.status(403).json({
        message: 'Only Super Admins can permanently delete items'
      });
    }
    const {
      ids
    } = req.body;
    if (!ids?.length) return res.status(400).json({
      message: 'No IDs provided'
    });
    let deleted = 0;
    const errors = [];
    for (const id of ids) {
      try {
        await permanentDelete(id);
        deleted++;
      } catch (e) {
        errors.push(id);
      }
    }
    res.json({
      deleted,
      failed: errors.length
    });
  } catch (err) {
    res.status(500).json({
      message: 'Bulk permanent delete failed'
    });
  }
});
router.delete('/admin/empty-all', async (req, res) => {
  try {
    if (req.user.role !== 'super_admin') {
      return res.status(403).json({
        message: 'Only Super Admins can empty all trash'
      });
    }
    const result = await Trash.deleteMany({});
    res.json({
      message: 'Trash emptied',
      deleted: result.deletedCount
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to empty trash'
    });
  }
});
module.exports = router;
