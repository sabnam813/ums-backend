const MODULES = [{
  key: 'applications',
  label: 'Applications'
}, {
  key: 'inquiry',
  label: 'Inquiry'
}, {
  key: 'followUp',
  label: 'Associate Follow Up'
}, {
  key: 'studentFollowUp',
  label: 'Student Follow Up'
}, {
  key: 'testPreparation',
  label: 'Test Preparation'
}, {
  key: 'contacts',
  label: 'Contacts'
}, {
  key: 'reports',
  label: 'Reports'
}, {
  key: 'achievements',
  label: 'Achievements'
}, {
  key: 'tpAchievements',
  label: 'TP Achievements'
}, {
  key: 'dailyReport',
  label: 'Daily Report'
}, {
  key: 'trash',
  label: 'Trash'
}, {
  key: 'portal',
  label: 'Portal'
}, {
  key: 'hallBooking',
  label: 'Hall Booking'
}, {
  key: 'trainingSchedule',
  label: 'Training Schedule'
}, {
  key: 'associateDetails',
  label: 'Associate Details'
}, {
  key: 'commissionAssociate',
  label: 'Commission — Associate'
}, {
  key: 'commissionShareholder',
  label: 'Commission — Shareholder'
}, {
  key: 'commissionDepartment',
  label: 'Commission — Department'
}, {
  key: 'unicommission',
  label: 'Unicommission'
}];
const ACTIONS = ['access', 'view', 'create', 'edit', 'delete', 'import', 'exportExcel', 'exportPdf', 'print', 'bulkEdit', 'reports', 'manageFields', 'settings'];
const MODULE_KEYS = MODULES.map(m => m.key);
function emptyModulePermission() {
  const perm = {};
  ACTIONS.forEach(a => {
    perm[a] = false;
  });
  return perm;
}
const ADMIN_DEFAULT_ACTIONS = ['access', 'view', 'exportExcel', 'exportPdf', 'print', 'reports'];
const ADMIN_NO_AUTO_GRANT = ['trainingSchedule', 'commissionAssociate', 'commissionShareholder', 'commissionDepartment', 'unicommission'];
function getDefaultPermissions(role = 'user') {
  const perms = {};
  MODULE_KEYS.forEach(key => {
    perms[key] = emptyModulePermission();
  });
  if (role === 'admin') {
    MODULE_KEYS.forEach(key => {
      if (ADMIN_NO_AUTO_GRANT.includes(key)) return;
      ADMIN_DEFAULT_ACTIONS.forEach(a => {
        perms[key][a] = true;
      });
    });
  } else {
    perms.applications.access = true;
    perms.applications.view = true;
    perms.applications.create = true;
    perms.applications.edit = true;
    perms.dailyReport.access = true;
    perms.dailyReport.view = true;
    perms.dailyReport.create = true;
    perms.dailyReport.edit = true;
  }
  return perms;
}
function normalizePermissions(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const perms = {};
  MODULE_KEYS.forEach(key => {
    const modulePerm = source[key] && typeof source[key] === 'object' ? source[key] : {};
    perms[key] = {};
    ACTIONS.forEach(a => {
      perms[key][a] = modulePerm[a] === true;
    });
  });
  return perms;
}
function hasPermission(user, moduleKey, action = 'access') {
  if (!user) return false;
  if (user.role === 'super_admin') return true;
  const perms = normalizePermissions(user.permissions);
  const modulePerm = perms[moduleKey];
  if (!modulePerm) return false;
  if (!modulePerm.access) return false;
  if (action === 'access') return true;
  return modulePerm[action] === true;
}
module.exports = {
  MODULES,
  ACTIONS,
  MODULE_KEYS,
  emptyModulePermission,
  getDefaultPermissions,
  normalizePermissions,
  hasPermission
};
