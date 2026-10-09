const StudentFollowUp = require('../models/StudentFollowUp');

const SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * Fires "follow-up starting soon" reminders.
 *
 * The query is `remindAt <= now AND reminderSentAt == null`, not "reminders due
 * in the last minute", so a restart, redeploy or a sleeping host catches up on
 * the next tick instead of silently dropping reminders. Setting reminderSentAt
 * makes it idempotent — nobody gets the same reminder twice.
 */
async function sweepReminders(io) {
  const now = new Date();
  const due = await StudentFollowUp.find({
    status: 'pending',
    remindAt: { $ne: null, $lte: now },
    reminderSentAt: null
  })
    .limit(200)
    .populate([
      { path: 'application', select: 'name referredBy providerName' },
      { path: 'country', select: 'name flag' }
    ]);

  if (!due.length) return 0;

  const ids = [];
  due.forEach(doc => {
    ids.push(doc._id);
    if (!io || !doc.assignedTo) return;
    const studentName = doc.application?.name || doc.studentName || 'Student';
    io.to(`user:${doc.assignedTo}`).emit('studentFollowUp:reminder', {
      id: String(doc._id),
      studentName,
      country: doc.country?.name || '',
      scheduledAt: doc.scheduledAt,
      method: doc.method,
      plannedNotes: doc.plannedNotes || ''
    });
  });

  await StudentFollowUp.updateMany({ _id: { $in: ids } }, { $set: { reminderSentAt: now } });
  return ids.length;
}

function startReminderSweeper(io) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sweepReminders(io);
    } catch (err) {
      console.warn('Follow-up reminder sweep failed:', err.message);
    } finally {
      running = false;
    }
  };
  // First pass shortly after boot so a restart catches up quickly.
  setTimeout(tick, 10 * 1000);
  const handle = setInterval(tick, SWEEP_INTERVAL_MS);
  if (handle.unref) handle.unref();
  return handle;
}

module.exports = {
  sweepReminders,
  startReminderSweeper,
  SWEEP_INTERVAL_MS
};
