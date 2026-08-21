const BackgroundJobRun = require('../models/BackgroundJobRun');
const SystemLog = require('../models/SystemLog');
const backupService = require('./backupService');
const JOBS = {
  'auto-backup': {
    label: 'Automatic Database Backup',
    schedule: 'Every 24h (configurable via AUTO_BACKUP_INTERVAL_HOURS)',
    run: async () => {
      const backup = await backupService.createBackup({
        type: 'auto'
      });
      return `Backup created: ${backup.filename || backup._id}`;
    }
  },
  'system-log-purge': {
    label: 'System Log Purge',
    schedule: 'Every 6 hours, removes logs older than 30 days',
    run: async () => {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const result = await SystemLog.deleteMany({
        createdAt: {
          $lt: cutoff
        }
      });
      return `Purged ${result.deletedCount} log entr${result.deletedCount === 1 ? 'y' : 'ies'} older than 30 days`;
    }
  },
  'orphaned-chat-cleanup': {
    label: 'Orphaned Chat Cleanup',
    schedule: 'Weekly, removes conversations referencing deleted users',
    run: async () => {
      const User = require('../models/User');
      const Conversation = require('../models/Conversation');
      const Message = require('../models/Message');
      const userIds = (await User.find({}, '_id')).map(u => u._id.toString());
      const conversations = await Conversation.find({});
      const orphanedIds = conversations.filter(c => (c.participants || []).some(p => !userIds.includes(p.toString()))).map(c => c._id);
      if (orphanedIds.length > 0) {
        await Message.deleteMany({
          conversationId: {
            $in: orphanedIds
          }
        });
        await Conversation.deleteMany({
          _id: {
            $in: orphanedIds
          }
        });
      }
      return `Removed ${orphanedIds.length} orphaned conversation(s)`;
    }
  }
};
async function runJob(key, trigger = 'manual') {
  const job = JOBS[key];
  if (!job) throw new Error(`Unknown job: ${key}`);
  const start = Date.now();
  try {
    const message = await job.run();
    await BackgroundJobRun.create({
      key,
      label: job.label,
      status: 'success',
      durationMs: Date.now() - start,
      message,
      trigger
    });
    return {
      status: 'success',
      message
    };
  } catch (err) {
    await BackgroundJobRun.create({
      key,
      label: job.label,
      status: 'failed',
      durationMs: Date.now() - start,
      message: err.message,
      trigger
    });
    throw err;
  }
}
const INTERVALS_MS = {
  'auto-backup': null,
  'system-log-purge': 6 * 60 * 60 * 1000,
  'orphaned-chat-cleanup': 7 * 24 * 60 * 60 * 1000
};
function startScheduler() {
  Object.entries(INTERVALS_MS).forEach(([key, ms]) => {
    if (!ms) return;
    setInterval(() => {
      runJob(key, 'schedule').catch(() => {});
    }, ms);
  });
}
async function getJobsStatus() {
  const keys = Object.keys(JOBS);
  const statuses = await Promise.all(keys.map(async key => {
    const lastRun = await BackgroundJobRun.findOne({
      key
    }).sort({
      createdAt: -1
    });
    return {
      key,
      label: JOBS[key].label,
      schedule: JOBS[key].schedule,
      lastRun: lastRun ? {
        status: lastRun.status,
        message: lastRun.message,
        durationMs: lastRun.durationMs,
        at: lastRun.createdAt,
        trigger: lastRun.trigger
      } : null
    };
  }));
  return statuses;
}
module.exports = {
  JOBS,
  runJob,
  startScheduler,
  getJobsStatus
};
