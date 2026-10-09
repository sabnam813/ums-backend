/**
 * One-time backfill for the Student Follow Up module.
 *
 * Existing users have a stored `permissions` object that predates the
 * `studentFollowUp` key, so every action normalises to false and the module
 * stays invisible until someone grants it by hand. This script grants it to
 * accounts that already work with applications, so staff aren't locked out on
 * release day.
 *
 * Country scoping is unchanged — a user still only ever sees follow-ups for
 * the countries assigned to them. Super admins bypass permissions entirely and
 * are skipped here.
 *
 * Usage:
 *   node src/scripts/enableStudentFollowUp.js            # grant to admins only
 *   node src/scripts/enableStudentFollowUp.js --all      # admins + users with applications access
 *   node src/scripts/enableStudentFollowUp.js --dry-run  # report, change nothing
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const { normalizePermissions } = require('../config/rbac');

const ADMIN_ACTIONS = ['access', 'view', 'create', 'edit', 'delete', 'exportExcel', 'exportPdf', 'print', 'reports'];
const USER_ACTIONS = ['access', 'view', 'create', 'edit', 'exportExcel', 'exportPdf', 'print'];

async function run() {
  const includeUsers = process.argv.includes('--all');
  const dryRun = process.argv.includes('--dry-run');

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set. Aborting.');
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  console.log('Connected.');

  const users = await User.find({ role: { $ne: 'super_admin' } });
  let granted = 0;
  let skipped = 0;

  for (const user of users) {
    const perms = normalizePermissions(user.permissions);

    if (perms.studentFollowUp && perms.studentFollowUp.access) {
      skipped += 1;
      continue;
    }

    let actions = null;
    if (user.role === 'admin') {
      actions = ADMIN_ACTIONS;
    } else if (includeUsers && perms.applications && perms.applications.access) {
      actions = USER_ACTIONS;
    }

    if (!actions) {
      skipped += 1;
      continue;
    }

    actions.forEach(a => { perms.studentFollowUp[a] = true; });

    if (!dryRun) {
      user.permissions = perms;
      user.markModified('permissions');
      await user.save();
    }
    granted += 1;
    console.log(`${dryRun ? '[dry-run] would grant' : 'granted'}: ${user.username} (${user.role})`);
  }

  console.log(`\nDone. Granted: ${granted}, skipped: ${skipped}, total scanned: ${users.length}`);
  console.log('Super admins were skipped — they already see everything.');

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
