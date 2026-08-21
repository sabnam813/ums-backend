require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const {
  getDefaultPermissions,
  ACTIONS
} = require('../config/rbac');
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/ums';
function isAlreadyMigrated(permissions) {
  if (!permissions || typeof permissions !== 'object') return false;
  return Object.values(permissions).some(v => v && typeof v === 'object' && 'access' in v);
}
async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB:', MONGO_URI);
  const users = await User.find({});
  let migrated = 0,
    skipped = 0;
  for (const user of users) {
    const old = user.permissions || {};
    if (isAlreadyMigrated(old)) {
      skipped++;
      continue;
    }
    const next = getDefaultPermissions(user.role);
    ['testPreparation', 'inquiry', 'followUp'].forEach(key => {
      if (old[key] === true) {
        ACTIONS.forEach(a => {
          next[key][a] = true;
        });
      }
    });
    user.permissions = next;
    user.markModified('permissions');
    await user.save({
      validateBeforeSave: false
    });
    migrated++;
  }
  console.log(`Migration complete. Migrated: ${migrated}, already up to date: ${skipped}, total: ${users.length}`);
  await mongoose.disconnect();
}
run().catch(async err => {
  console.error('Migration failed:', err);
  await mongoose.disconnect();
  process.exitCode = 1;
});
