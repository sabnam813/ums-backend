const express = require('express');
const Department = require('../models/Department');
const User = require('../models/User');
const Country = require('../models/Country');
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
const {
  REPORT_MODES,
  legacyOverrides,
  computeAccess
} = require('../utils/permissionResolver');

function resolveMode(body, fallbackViewOnly) {
  if (REPORT_MODES.includes(body.dailyReportMode)) return body.dailyReportMode;
  if (body.dailyReportViewOnly !== undefined) return body.dailyReportViewOnly ? 'view' : 'write';
  return fallbackViewOnly ? 'view' : 'write';
}

// Re-derive every member's effective access after a department changes.
// Individual overrides are preserved (legacy users are migrated on the spot
// from their pre-change state), so a department edit never wipes what was
// granted to one person.
async function recomputeMembers(oldDept, newDept) {
  const members = await User.find({
    $or: [{ department: newDept.name }, { departments: newDept.name }]
  });
  if (members.length === 0) return;
  const allDepts = await Department.find({});
  const byName = new Map(allDepts.map(d => [d.name, d]));
  const ops = [];
  for (const m of members) {
    const names = [...new Set([m.department, ...(m.departments || [])].filter(Boolean))];
    const newDepts = names.map(n => byName.get(n)).filter(Boolean);
    const oldDepts = newDepts.map(d => String(d._id) === String(newDept._id) ? oldDept : d);
    let overrides = m.permissionOverrides;
    let extra = m.extraCountries;
    let modeOverride = m.dailyReportModeOverride;
    if (overrides === undefined) {
      const legacy = legacyOverrides(m, oldDepts);
      overrides = legacy.overrides;
      extra = legacy.extraCountries;
      modeOverride = legacy.modeOverride;
    }
    const access = await computeAccess({ role: m.role, depts: newDepts, overrides, extraCountries: extra, modeOverride });
    const set = { ...access, permissionOverrides: overrides, extraCountries: extra, dailyReportModeOverride: modeOverride };
    const oldList = (oldDept.dailyReportDepartments || []).join('|');
    const curList = (m.dailyReportDepartments || []).join('|');
    if (curList === '' || curList === oldList) set.dailyReportDepartments = newDept.dailyReportDepartments || [];
    ops.push({ updateOne: { filter: { _id: m._id }, update: { $set: set } } });
  }
  if (ops.length) await User.bulkWrite(ops);
}
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
  await User.updateMany(
    { dailyReportDepartments: oldName },
    { $set: { 'dailyReportDepartments.$[elem]': newName } },
    { arrayFilters: [{ elem: oldName }] }
  );
  await Department.updateMany(
    { dailyReportDepartments: oldName },
    { $set: { 'dailyReportDepartments.$[elem]': newName } },
    { arrayFilters: [{ elem: oldName }] }
  );

  await Portal.updateMany(
    { departments: oldName },
    { $set: { 'departments.$[elem]': newName } },
    { arrayFilters: [{ elem: oldName }] }
  );
  await Portal.updateMany({}, [{ $set: { departments: { $setUnion: ['$departments', []] } } }]);

  await DailyReport.updateMany({ department: oldName }, { $set: { department: newName } });
}

// Strip a deleted department's name out of every place that references it by
// name, so nothing lingers pointing at a department that no longer exists.
async function scrubDeletedDepartmentEverywhere(deptName) {
  if (!deptName) return;
  await User.updateMany({}, { $pull: { dailyReportDepartments: deptName } });
  await Department.updateMany({}, { $pull: { dailyReportDepartments: deptName } });
  await Portal.updateMany({}, { $pull: { departments: deptName } });
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
      allCountries,
      dailyReportViewOnly,
      dailyReportDepartments
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
      allCountries: !!allCountries,
      dailyReportViewOnly: resolveMode(req.body, false) === 'view',
      dailyReportMode: resolveMode(req.body, false),
      dailyReportDepartments: Array.isArray(dailyReportDepartments)
        ? dailyReportDepartments.map(d => String(d).trim()).filter(Boolean)
        : []
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
      allCountries,
      dailyReportViewOnly,
      dailyReportDepartments
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
    if (dailyReportViewOnly !== undefined || req.body.dailyReportMode !== undefined) {
      update.dailyReportMode = resolveMode(req.body, existing.dailyReportViewOnly);
      update.dailyReportViewOnly = update.dailyReportMode === 'view';
    }
    if (dailyReportDepartments !== undefined) {
      update.dailyReportDepartments = Array.isArray(dailyReportDepartments)
        ? dailyReportDepartments.map(d => String(d).trim()).filter(Boolean)
        : [];
    }
    const dept = await Department.findByIdAndUpdate(req.params.id, update, {
      new: true
    }).populate('countries', 'name flag');
    if (!dept) return res.status(404).json({
      message: 'Department not found'
    });
    if (name !== undefined && dept.name !== oldName) {
      await renameDepartmentEverywhere(oldName, dept.name);
    }
    await recomputeMembers(existing, dept);
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
    await scrubDeletedDepartmentEverywhere(dept.name);
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
