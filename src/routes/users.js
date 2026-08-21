const express = require('express');
const User = require('../models/User');
const Country = require('../models/Country');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Department = require('../models/Department');
const {
  verifyAccess,
  requireAdmin,
  requireSuperAdmin,
  canManageTargetUser
} = require('../middleware/auth');
const {
  softDelete
} = require('../utils/trashHelper');
const {
  logActivity
} = require('../utils/auditLogger');
const {
  MODULE_KEYS,
  ACTIONS,
  getDefaultPermissions,
  normalizePermissions
} = require('../config/rbac');
function withNormalizedPermissions(userDoc) {
  if (!userDoc) return userDoc;
  const obj = userDoc.toObject ? userDoc.toObject() : userDoc;
  obj.permissions = normalizePermissions(obj.permissions);
  return obj;
}
function mergePermissions(basePermissions, incoming) {
  const base = normalizePermissions(basePermissions);
  if (!incoming || typeof incoming !== 'object') return base;
  const merged = {};
  MODULE_KEYS.forEach(key => {
    const incomingModule = incoming[key];
    merged[key] = {
      ...base[key]
    };
    if (incomingModule && typeof incomingModule === 'object') {
      ACTIONS.forEach(action => {
        if (incomingModule[action] !== undefined) {
          merged[key][action] = !!incomingModule[action];
        }
      });
      if (merged[key].access && !ACTIONS.some(a => a !== 'access' && merged[key][a])) {
        merged[key].view = true;
      }
      if (!merged[key].access) {
        ACTIONS.forEach(action => {
          if (action !== 'access') merged[key][action] = false;
        });
      }
    }
  });
  return merged;
}
const router = express.Router();
router.use(verifyAccess);
router.get('/', requireSuperAdmin, async (req, res) => {
  try {
    const roleFilter = req.user.role === 'super_admin' ? {
      role: {
        $in: ['user', 'admin']
      }
    } : {
      role: 'user'
    };
    const users = await User.find(roleFilter).select('-password -sessions').populate('countries', 'name flag');
    const safeUsers = users.map(u => {
      const obj = u.toObject();
      obj.permissions = normalizePermissions(obj.permissions);
      return obj;
    });
    res.json({
      users: safeUsers
    });
  } catch {
    res.status(500).json({
      message: 'Failed to fetch users'
    });
  }
});
router.post('/', requireSuperAdmin, async (req, res) => {
  try {
    const {
      username,
      password,
      name,
      countries,
      permissions,
      role,
      department,
      departments
    } = req.body;
    const rawDeptList = departments && departments.length > 0 ? departments : department ? [department] : [];
    const deptList = [...new Set(rawDeptList)];
    const primaryDept = deptList[0] || '';
    if (!username || !password) {
      return res.status(400).json({
        message: 'username and password required'
      });
    }
    let targetRole = 'user';
    if (role === 'admin') {
      if (req.user.role !== 'super_admin') {
        return res.status(403).json({
          message: 'Only a Super Admin can create Admin accounts'
        });
      }
      targetRole = 'admin';
    } else if (role === 'super_admin') {
      return res.status(403).json({
        message: 'Super Admin accounts cannot be created through this endpoint'
      });
    }
    let initialPermissions = permissions !== undefined ? mergePermissions(getDefaultPermissions(targetRole), permissions) : getDefaultPermissions(targetRole);
    let assignedCountries = countries || [];
    if (deptList.length > 0) {
      const depts = await Department.find({
        name: {
          $in: deptList
        }
      });
      if (depts.length > 0) {
        let merged = getDefaultPermissions(targetRole);
        depts.forEach(dept => {
          merged = mergePermissions(merged, dept.permissions);
        });
        initialPermissions = permissions !== undefined ? mergePermissions(merged, permissions) : merged;
        const hasAllCountries = depts.some(d => d.allCountries);
        if (!hasAllCountries) {
          const countrySet = new Set();
          depts.forEach(dept => {
            if (dept.countries && dept.countries.length > 0) {
              dept.countries.forEach(c => countrySet.add(String(c._id || c)));
            }
          });
          if (countrySet.size > 0) assignedCountries = Array.from(countrySet);
        }
      }
    }
    const user = await User.create({
      username: username.toLowerCase().trim(),
      password,
      name: name || '',
      role: targetRole,
      department: primaryDept,
      departments: deptList,
      countries: assignedCountries,
      permissions: initialPermissions,
      mustChangePassword: req.body.mustChangePassword || false
    });
    const safe = await User.findById(user._id).select('-password -sessions').populate('countries', 'name flag');
    await logActivity(req, 'user.created', {
      targetType: 'User',
      targetId: user._id,
      message: `Created ${targetRole} account "${user.username}"${department ? ` in department "${department}"` : ''}`
    });
    res.status(201).json({
      user: withNormalizedPermissions(safe)
    });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({
      message: 'Username already taken'
    });
    res.status(500).json({
      message: 'Failed to create user'
    });
  }
});
router.put('/:id', requireSuperAdmin, async (req, res) => {
  try {
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({
      message: 'Not found'
    });
    if (!canManageTargetUser(req.user, target)) {
      return res.status(403).json({
        message: 'You do not have permission to modify this account'
      });
    }
    const {
      name,
      username,
      countries,
      mustChangePassword,
      permissions,
      department,
      departments
    } = req.body;
    const rawDeptList = departments && departments.length > 0 ? departments : department !== undefined ? department ? [department] : [] : null;
    const deptList = rawDeptList ? [...new Set(rawDeptList)] : null;
    const primaryDept = deptList ? deptList[0] || '' : undefined;
    const update = {};
    if (name !== undefined) update.name = name;
    if (username !== undefined) update.username = username.toLowerCase().trim();
    if (countries !== undefined) update.countries = countries;
    if (mustChangePassword !== undefined) update.mustChangePassword = mustChangePassword;
    if (deptList !== null) {
      update.department = primaryDept;
      update.departments = deptList;
      if (deptList.length > 0) {
        const depts = await Department.find({
          name: {
            $in: deptList
          }
        });
        if (depts.length > 0) {
          let merged = getDefaultPermissions(target.role);
          depts.forEach(dept => {
            merged = mergePermissions(merged, dept.permissions);
          });
          update.permissions = merged;
          const hasAllCountries = depts.some(d => d.allCountries);
          if (!hasAllCountries) {
            const countrySet = new Set();
            depts.forEach(dept => {
              if (dept.countries && dept.countries.length > 0) {
                dept.countries.forEach(c => countrySet.add(String(c._id || c)));
              }
            });
            if (countrySet.size > 0) update.countries = Array.from(countrySet);
          }
        }
      }
    }
    if (permissions !== undefined) {
      if (req.user.role !== 'super_admin') {
        return res.status(403).json({
          message: 'Only a Super Admin can modify permissions'
        });
      }
      const base = update.permissions || target.permissions;
      update.permissions = mergePermissions(base, permissions);
    }
    const user = await User.findByIdAndUpdate(req.params.id, update, {
      new: true
    }).select('-password -sessions').populate('countries', 'name flag');
    if (!user) return res.status(404).json({
      message: 'Not found'
    });
    await logActivity(req, 'user.updated', {
      targetType: 'User',
      targetId: user._id,
      message: `Updated account "${user.username}"`,
      meta: update
    });
    res.json({
      user: withNormalizedPermissions(user)
    });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({
      message: 'Username already taken'
    });
    res.status(500).json({
      message: 'Failed to update user'
    });
  }
});
router.put('/:id/status', requireSuperAdmin, async (req, res) => {
  try {
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({
      message: 'Not found'
    });
    if (!canManageTargetUser(req.user, target)) {
      return res.status(403).json({
        message: 'You do not have permission to modify this account'
      });
    }
    const user = await User.findByIdAndUpdate(req.params.id, {
      status: req.body.status
    }, {
      new: true
    }).select('-password -sessions').populate('countries', 'name flag');
    await logActivity(req, 'user.status_changed', {
      targetType: 'User',
      targetId: req.params.id,
      message: `Set status to "${req.body.status}" for "${user.username}"`
    });
    res.json({
      user: withNormalizedPermissions(user)
    });
  } catch {
    res.status(500).json({
      message: 'Failed'
    });
  }
});
router.put('/:id/password', requireSuperAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({
      message: 'Not found'
    });
    if (!canManageTargetUser(req.user, user)) {
      return res.status(403).json({
        message: 'You do not have permission to modify this account'
      });
    }
    user.password = req.body.password;
    if (req.body.mustChangePassword !== undefined) user.mustChangePassword = req.body.mustChangePassword;
    await user.save();
    await logActivity(req, 'user.password_reset', {
      targetType: 'User',
      targetId: user._id,
      message: `Reset password for "${user.username}"`
    });
    res.json({
      message: 'Password updated'
    });
  } catch {
    res.status(500).json({
      message: 'Failed'
    });
  }
});
router.put('/:id/role', requireSuperAdmin, async (req, res) => {
  try {
    const {
      role
    } = req.body;
    if (!['user', 'admin'].includes(role)) {
      return res.status(400).json({
        message: 'Role must be "user" or "admin"'
      });
    }
    const target = await User.findById(req.params.id);
    if (!target) return res.status(404).json({
      message: 'Not found'
    });
    if (target.role === 'super_admin') {
      return res.status(403).json({
        message: 'Super Admin accounts cannot be changed'
      });
    }
    target.role = role;
    await target.save();
    const safe = await User.findById(target._id).select('-password -sessions').populate('countries', 'name flag');
    await logActivity(req, 'user.role_changed', {
      targetType: 'User',
      targetId: target._id,
      message: `Changed role of "${target.username}" to "${role}"`
    });
    res.json({
      user: withNormalizedPermissions(safe)
    });
  } catch {
    res.status(500).json({
      message: 'Failed to update role'
    });
  }
});
router.delete('/:id', requireSuperAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({
      message: 'Not found'
    });
    if (!canManageTargetUser(req.user, user)) {
      return res.status(403).json({
        message: 'You do not have permission to delete this account'
      });
    }
    const conversations = await Conversation.find({
      participants: userId
    }, '_id');
    const conversationIds = conversations.map(c => c._id);
    if (conversationIds.length > 0) {
      await Message.deleteMany({
        conversationId: {
          $in: conversationIds
        }
      });
      await Conversation.deleteMany({
        _id: {
          $in: conversationIds
        }
      });
    }
    await softDelete({
      modelName: 'User',
      doc: user,
      userId: req.user._id,
      userName: req.user.name || req.user.username,
      meta: {
        username: user.username,
        name: user.name
      }
    });
    await logActivity(req, 'user.deleted', {
      targetType: 'User',
      targetId: userId,
      message: `Moved account "${user.username}" to trash`
    });
    res.json({
      message: 'User moved to trash. Their chats have been removed.'
    });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({
      message: 'Failed to delete user'
    });
  }
});
module.exports = router;
