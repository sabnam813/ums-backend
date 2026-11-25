const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Country = require('../models/Country');
const Application = require('../models/Application');
const Inquiry = require('../models/Inquiry');
const TestType = require('../models/TestType');
const TestPrepRecord = require('../models/TestPrepRecord');
const Trash = require('../models/Trash');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const {
  verifyAccess,
  requireSuperAdmin
} = require('../middleware/auth');
const {
  logActivity
} = require('../utils/auditLogger');
const router = express.Router();
router.use(verifyAccess, requireSuperAdmin);
const startedAt = Date.now();
router.get('/stats', async (req, res) => {
  try {
    const dbState = mongoose.connection.readyState;
    const [userCount, adminCount, staffCount, countryCount, applicationCount, inquiryCount, testTypeCount, testPrepRecordCount, trashCount, conversationCount, messageCount] = await Promise.all([User.countDocuments(), User.countDocuments({
      role: 'admin'
    }), User.countDocuments({
      role: 'user'
    }), Country.countDocuments(), Application.countDocuments(), Inquiry.countDocuments(), TestType.countDocuments(), TestPrepRecord.countDocuments(), Trash.countDocuments(), Conversation.countDocuments(), Message.countDocuments()]);
    res.json({
      server: {
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        nodeVersion: process.version,
        environment: process.env.NODE_ENV || 'development',
        memoryUsageMb: Math.round(process.memoryUsage().rss / 1024 / 1024)
      },
      database: {
        connected: dbState === 1,
        state: ['disconnected', 'connected', 'connecting', 'disconnecting'][dbState] || 'unknown',
        host: mongoose.connection.host || null
      },
      counts: {
        users: userCount,
        admins: adminCount,
        staff: staffCount,
        countries: countryCount,
        applications: applicationCount,
        inquiries: inquiryCount,
        testTypes: testTypeCount,
        testPrepRecords: testPrepRecordCount,
        trashItems: trashCount,
        conversations: conversationCount,
        messages: messageCount
      }
    });
  } catch (err) {
    console.error('System stats error:', err);
    res.status(500).json({
      message: 'Failed to load system stats'
    });
  }
});
router.post('/reseed-test-types', async (req, res) => {
  try {
    const count = await TestType.countDocuments();
    if (count > 0) {
      return res.status(400).json({
        message: 'Test types already exist. Delete them first for a clean reset.'
      });
    }
    const defaults = ['IELTS', 'PTE', 'Duolingo'];
    await TestType.insertMany(defaults.map((name, i) => ({
      name,
      slug: name.toLowerCase(),
      order: i
    })));
    await logActivity(req, 'system.reseed_test_types', {
      message: 'Re-seeded default test types'
    });
    res.json({
      message: 'Default test types re-seeded',
      created: defaults
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to reseed test types'
    });
  }
});
router.delete('/trash/empty-all', async (req, res) => {
  try {
    const result = await Trash.deleteMany({});
    await logActivity(req, 'system.trash_emptied', {
      message: `Permanently emptied trash (${result.deletedCount} items)`
    });
    res.json({
      message: 'Trash permanently emptied',
      deleted: result.deletedCount
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to empty trash'
    });
  }
});
router.delete('/chat/cleanup-orphaned', async (req, res) => {
  try {
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
    await logActivity(req, 'system.chat_cleanup', {
      message: `Cleaned up ${orphanedIds.length} orphaned conversation(s)`
    });
    res.json({
      message: 'Orphaned chat data cleaned up',
      removed: orphanedIds.length
    });
  } catch (err) {
    res.status(500).json({
      message: 'Cleanup failed'
    });
  }
});
module.exports = router;
