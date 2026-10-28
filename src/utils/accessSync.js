const User = require('../models/User');
const Department = require('../models/Department');
const { legacyOverrides, computeAccess } = require('./permissionResolver');

async function recomputeUser(userDoc, prevRole) {
  const names = [...new Set([userDoc.department, ...(userDoc.departments || [])].filter(Boolean))];
  const depts = names.length ? await Department.find({ name: { $in: names } }) : [];
  let overrides = userDoc.permissionOverrides;
  let extra = userDoc.extraCountries;
  let modeOverride = userDoc.dailyReportModeOverride;
  if (overrides === undefined) {
    const plain = userDoc.toObject ? userDoc.toObject() : { ...userDoc };
    const legacy = legacyOverrides({ ...plain, role: prevRole || plain.role }, depts);
    overrides = legacy.overrides;
    extra = legacy.extraCountries;
    modeOverride = legacy.modeOverride;
  }
  const access = await computeAccess({ role: userDoc.role, depts, overrides, extraCountries: extra, modeOverride });
  await User.updateOne(
    { _id: userDoc._id },
    { $set: { ...access, permissionOverrides: overrides, extraCountries: extra, dailyReportModeOverride: modeOverride } }
  );
}

async function recomputeUsers(filter) {
  const users = await User.find(filter);
  for (const u of users) await recomputeUser(u);
  return users.map(u => String(u._id));
}

function notifyAccessChanged(app, userIds) {
  const io = app && app.get && app.get('io');
  if (!io) return;
  (userIds || []).forEach(id => io.to(`user:${id}`).emit('access:changed'));
}

module.exports = { recomputeUser, recomputeUsers, notifyAccessChanged };
