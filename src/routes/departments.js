const express = require('express');
const Department = require('../models/Department');
const User = require('../models/User');
const Portal = require('../models/Portal');
const DailyReport = require('../models/DailyReport');
const {
  verifyAccess,
  requireSuperAdmin
} = require('../middleware/auth');
const {
  normalizePermissions,
  MODULE_KEYS,
  ACTIONS
} = require('../config/rbac');
const {
  logActivity
} = require('../utils/auditLogger');
const router = express.Router();
router.use(verifyAccess);
function normalizeDeptPermissions(raw) {
  return normalizePermissions(raw);
}

async function renameDepartmentEverywhere(oldName, newName) {
  if (!oldName || !newName || oldName === newName) return;

  await User.updateMany({ department: oldName }, { $set: { department: newName } });
  await User.updateMany(
    { departments: oldName },
    { $set: { 'departments.$[elem]': newName } },
    { arrayFilters: [{ elem: oldName }] }
  );
  await User.updateMany({}, [{ $set: { departments: { $setUnion: ['$departments', []] } } }]);

  await Portal.updateMany(
    { departments: oldName },
    { $set: { 'departments.$[elem]': newName } },
    { arrayFilters: [{ elem: oldName }] }
  );
  await Portal.updateMany({}, [{ $set: { departments: { $setUnion: ['$departments', []] } } }]);

  await DailyReport.updateMany({ department: oldName }, { $set: { department: newName } });
}
router.get('/', async (req, res) => {
  try {
    const depts = await Department.find({}).populate('countries', 'name flag').sort({
      name: 1
    });
    res.json({
      departments: depts
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to fetch departments'
    });
  }
});
router.get('/:id', async (req, res) => {
  try {
    const dept = await Department.findById(req.params.id).populate('countries', 'name flag');
    if (!dept) return res.status(404).json({
      message: 'Department not found'
    });
    res.json({
      department: dept
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to fetch department'
    });
  }
});
router.post('/', requireSuperAdmin, async (req, res) => {
  try {
    const {
      name,
      permissions,
      countries,
      allCountries
    } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({
        message: 'Department name is required'
      });
    }
    const normalizedPerms = normalizeDeptPermissions(permissions);
    const dept = await Department.create({
      name: name.trim(),
      permissions: normalizedPerms,
      countries: countries || [],
      allCountries: !!allCountries
    });
    const populated = await Department.findById(dept._id).populate('countries', 'name flag');
    await logActivity(req, 'department.created', {
      targetType: 'Department',
      targetId: dept._id,
      message: `Created department "${dept.name}"`
    });
    res.status(201).json({
      department: populated
    });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({
      message: 'Department name already exists'
    });
    res.status(500).json({
      message: 'Failed to create department'
    });
  }
});
router.put('/:id', requireSuperAdmin, async (req, res) => {
  try {
    const {
      name,
      permissions,
      countries,
      allCountries
    } = req.body;
    const existing = await Department.findById(req.params.id);
    if (!existing) return res.status(404).json({
      message: 'Department not found'
    });
    const oldName = existing.name;
    const update = {};
    if (name !== undefined) update.name = name.trim();
    if (permissions !== undefined) update.permissions = normalizeDeptPermissions(permissions);
    if (countries !== undefined) update.countries = countries;
    if (allCountries !== undefined) update.allCountries = !!allCountries;
    const dept = await Department.findByIdAndUpdate(req.params.id, update, {
      new: true
    }).populate('countries', 'name flag');
    if (!dept) return res.status(404).json({
      message: 'Department not found'
    });
    if (name !== undefined && dept.name !== oldName) {
      await renameDepartmentEverywhere(oldName, dept.name);
    }
    if (permissions !== undefined) {
      const deptName = dept.name;
      await User.updateMany({
        department: deptName
      }, {
        $set: {
          permissions: normalizeDeptPermissions(permissions)
        }
      });
    }
    if (countries !== undefined || allCountries !== undefined) {
      const deptName = dept.name;
      const countryUpdate = {};
      if (dept.allCountries) {} else {
        countryUpdate.countries = dept.countries.map(c => c._id || c);
      }
      if (Object.keys(countryUpdate).length > 0) {
        await User.updateMany({
          department: deptName
        }, {
          $set: countryUpdate
        });
      }
    }
    await logActivity(req, 'department.updated', {
      targetType: 'Department',
      targetId: dept._id,
      message: `Updated department "${dept.name}"`
    });
    res.json({
      department: dept
    });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({
      message: 'Department name already exists'
    });
    res.status(500).json({
      message: 'Failed to update department'
    });
  }
});
router.delete('/:id', requireSuperAdmin, async (req, res) => {
  try {
    const dept = await Department.findById(req.params.id);
    if (!dept) return res.status(404).json({
      message: 'Department not found'
    });
    const count = await User.countDocuments({
      $or: [{ department: dept.name }, { departments: dept.name }]
    });
    if (count > 0) {
      return res.status(400).json({
        message: `Cannot delete "${dept.name}": ${count} user${count !== 1 ? 's' : ''} belong to this department. Reassign them first.`
      });
    }
    await Department.findByIdAndDelete(req.params.id);
    await logActivity(req, 'department.deleted', {
      targetType: 'Department',
      targetId: dept._id,
      message: `Deleted department "${dept.name}"`
    });
    res.json({
      success: true
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to delete department'
    });
  }
});
module.exports = router;
