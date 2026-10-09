const Country = require('../models/Country');
const {
  MODULE_KEYS,
  ACTIONS,
  getDefaultPermissions,
  normalizePermissions
} = require('../config/rbac');

/**
 * Effective access = department base (union of the user's departments)
 * + the user's own overrides (true = extra grant, false = revoked).
 * User documents still cache the result in `permissions` / `countries` /
 * `dailyReportMode` because the rest of the app reads those directly, but the
 * overrides are stored separately so a department edit can never wipe them.
 */
const REPORT_MODES = ['write', 'view', 'both'];

function finalize(perms) {
  MODULE_KEYS.forEach(key => {
    const m = perms[key];
    if (!m.access) {
      ACTIONS.forEach(a => { m[a] = false; });
    } else if (!ACTIONS.some(a => a !== 'access' && m[a])) {
      m.view = true;
    }
  });
  return perms;
}

function deptReportMode(dept) {
  if (REPORT_MODES.includes(dept.dailyReportMode)) return dept.dailyReportMode;
  return dept.dailyReportViewOnly ? 'view' : 'write';
}

function roleDefaultReportMode(role) {
  return role === 'user' ? 'write' : 'view';
}

function basePermissions(role, depts) {
  if (!depts || depts.length === 0) return normalizePermissions(getDefaultPermissions(role));
  const base = normalizePermissions({});
  depts.forEach(d => {
    const dp = normalizePermissions(d.permissions);
    MODULE_KEYS.forEach(k => ACTIONS.forEach(a => { if (dp[k][a]) base[k][a] = true; }));
  });
  return finalize(base);
}

function baseReportMode(role, depts) {
  if (!depts || depts.length === 0) return roleDefaultReportMode(role);
  const modes = depts.map(deptReportMode);
  const canW = modes.some(m => m === 'write' || m === 'both');
  const canV = modes.some(m => m === 'view' || m === 'both');
  return canW && canV ? 'both' : canV ? 'view' : 'write';
}

function deptCountryIds(depts) {
  const set = new Set();
  (depts || []).forEach(d => (d.countries || []).forEach(c => set.add(String(c._id || c))));
  return set;
}

function diffOverrides(effective, base) {
  const eff = finalize(normalizePermissions(effective));
  const out = {};
  MODULE_KEYS.forEach(k => {
    ACTIONS.forEach(a => {
      if (eff[k][a] !== base[k][a]) {
        out[k] = out[k] || {};
        out[k][a] = eff[k][a];
      }
    });
  });
  return out;
}

function applyOverrides(base, overrides) {
  const perms = normalizePermissions(base);
  const ov = overrides && typeof overrides === 'object' ? overrides : {};
  MODULE_KEYS.forEach(k => {
    const mod = ov[k];
    if (mod && typeof mod === 'object') {
      ACTIONS.forEach(a => { if (typeof mod[a] === 'boolean') perms[k][a] = mod[a]; });
    }
  });
  return finalize(perms);
}

/** Work out the overrides a pre-existing user already has relative to their old departments. */
function legacyOverrides(user, oldDepts) {
  const base = basePermissions(user.role, oldDepts);
  const overrides = diffOverrides(user.permissions, base);
  let extraCountries;
  if ((oldDepts || []).some(d => d.allCountries)) {
    extraCountries = [];
  } else {
    const inDept = deptCountryIds(oldDepts);
    extraCountries = (user.countries || []).map(c => String(c._id || c)).filter(id => !inDept.has(id));
  }
  const cur = REPORT_MODES.includes(user.dailyReportMode)
    ? user.dailyReportMode
    : (user.dailyReportViewOnly ? 'view' : roleDefaultReportMode(user.role));
  const modeOverride = cur !== baseReportMode(user.role, oldDepts) ? cur : null;
  return { overrides, extraCountries, modeOverride };
}

async function computeAccess({ role, depts, overrides, extraCountries, modeOverride }) {
  const permissions = applyOverrides(basePermissions(role, depts), overrides);
  const allCountries = (depts || []).some(d => d.allCountries);
  let countries;
  if (allCountries) {
    countries = (await Country.find({}).select('_id')).map(c => c._id);
  } else {
    const set = deptCountryIds(depts);
    (extraCountries || []).forEach(c => set.add(String(c._id || c)));
    countries = Array.from(set);
  }
  const dailyReportMode = REPORT_MODES.includes(modeOverride) ? modeOverride : baseReportMode(role, depts);
  return {
    permissions,
    countries,
    allCountries,
    dailyReportMode,
    dailyReportViewOnly: dailyReportMode === 'view'
  };
}

module.exports = {
  REPORT_MODES,
  basePermissions,
  baseReportMode,
  deptCountryIds,
  diffOverrides,
  applyOverrides,
  legacyOverrides,
  computeAccess
};
