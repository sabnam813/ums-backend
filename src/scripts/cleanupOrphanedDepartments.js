const Department = require('../models/Department');
const User = require('../models/User');
const Portal = require('../models/Portal');
const DailyReport = require('../models/DailyReport');

async function cleanupOrphanedDepartments() {
  const departments = await Department.find({}, 'name').lean();
  const validNames = new Set(departments.map(d => d.name));

  let usersFixed = 0;
  let reportsFixed = 0;
  const users = await User.find({
    $or: [
      { departments: { $exists: true, $not: { $size: 0 } } },
      { department: { $nin: ['', null] } }
    ]
  });

  for (const user of users) {
    const originalDepartments = user.departments || [];
    const cleanedDepartments = [...new Set(originalDepartments)].filter(d => validNames.has(d));
    const departmentsChanged =
      cleanedDepartments.length !== originalDepartments.length ||
      cleanedDepartments.some((d, i) => d !== originalDepartments[i]);

    const validPrimary = user.department && validNames.has(user.department) ? user.department : '';
    const newPrimary = validPrimary || cleanedDepartments[0] || '';
    const primaryChanged = newPrimary !== (user.department || '');

    if (departmentsChanged || primaryChanged) {
      user.departments = cleanedDepartments;
      user.department = newPrimary;
      await user.save();
      usersFixed++;
    }

    if (newPrimary) {
      const result = await DailyReport.updateMany(
        { user: user._id, department: { $ne: newPrimary } },
        { $set: { department: newPrimary } }
      );
      reportsFixed += result.modifiedCount || 0;
    }
  }

  let portalsFixed = 0;
  const portals = await Portal.find({ departments: { $exists: true, $not: { $size: 0 } } });
  for (const portal of portals) {
    const original = portal.departments || [];
    const cleaned = [...new Set(original)].filter(d => validNames.has(d));
    const changed = cleaned.length !== original.length || cleaned.some((d, i) => d !== original[i]);
    if (changed) {
      portal.departments = cleaned;
      await portal.save();
      portalsFixed++;
    }
  }

  if (usersFixed || portalsFixed || reportsFixed) {
    console.log(`Department cleanup: fixed ${usersFixed} user(s), ${portalsFixed} portal(s), ${reportsFixed} daily report(s) with stale department name(s).`);
  }
  return { usersFixed, portalsFixed, reportsFixed };
}

module.exports = { cleanupOrphanedDepartments };

if (require.main === module) {
  require('dotenv').config();
  const mongoose = require('mongoose');
  (async () => {
    try {
      await mongoose.connect(process.env.MONGODB_URI);
      console.log('Connected. Cleaning up orphaned department names...');
      const result = await cleanupOrphanedDepartments();
      console.log('Done.', result);
    } catch (err) {
      console.error('Cleanup failed:', err.message);
    } finally {
      await mongoose.disconnect();
    }
  })();
}
