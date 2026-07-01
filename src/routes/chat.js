const router = require('express').Router();
const { verifyAccess: authenticate } = require('../middleware/auth');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const User = require('../models/User');
const mongoose = require('mongoose');

router.get('/conversations', authenticate, async (req, res) => {
  try {
    const convs = await Conversation.find({ participants: req.user._id })
      .populate('participants', 'name username role')
      .populate({ path: 'lastMessage', populate: { path: 'sender', select: 'name username' } })
      .sort({ lastMessageAt: -1 });
    res.json(convs);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/conversations', authenticate, async (req, res) => {
  try {
    const { type, participantIds, name } = req.body;
    if (!participantIds || !Array.isArray(participantIds) || participantIds.length === 0) {
      return res.status(400).json({ message: 'participantIds required' });
    }

    const all = [...new Set([req.user._id.toString(), ...participantIds])];
    const allIds = all.map(id => new mongoose.Types.ObjectId(id));

    if (type === 'direct' && allIds.length === 2) {
      const existing = await Conversation.findOne({
        type: 'direct',
        participants: { $all: allIds, $size: 2 },
      }).populate('participants', 'name username role');
      if (existing) return res.json(existing);
    }

    const conv = await Conversation.create({
      type: type || 'direct',
      name: name || '',
      participants: allIds,
      createdBy: req.user._id,
      lastMessageAt: new Date(),
    });
    const populated = await conv.populate('participants', 'name username role');
    res.status(201).json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/conversations/:id/messages', authenticate, async (req, res) => {
  try {
    const conv = await Conversation.findOne({
      _id: req.params.id,
      participants: req.user._id,
    });
    if (!conv) return res.status(404).json({ message: 'Conversation not found' });

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const messages = await Message.find({ conversationId: req.params.id, isDeleted: false })
      .populate('sender', 'name username role')
      .populate('forwardedFrom', 'text')
      .populate('deletedBy', 'name username')
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit);

    await Message.updateMany(
      { conversationId: req.params.id, readBy: { $ne: req.user._id } },
      { $addToSet: { readBy: req.user._id } }
    );

    res.json(messages);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/conversations/:id/messages', authenticate, async (req, res) => {
  try {
    const conv = await Conversation.findOne({
      _id: req.params.id,
      participants: req.user._id,
    });
    if (!conv) return res.status(404).json({ message: 'Conversation not found' });

    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ message: 'Message text required' });

    const msg = await Message.create({
      conversationId: conv._id,
      sender: req.user._id,
      text: text.trim(),
      readBy: [req.user._id],
    });

    conv.lastMessage = msg._id;
    conv.lastMessageAt = msg.createdAt;
    await conv.save();

    const populated = await msg.populate('sender', 'name username role');

    if (req.app.get('io')) {
      const io = req.app.get('io');
      
      conv.participants.forEach(pid => {
        io.to(`user:${pid.toString()}`).emit('new_message', {
          conversationId: conv._id,
          message: populated,
        });
      });
    }

    res.status(201).json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/users', authenticate, async (req, res) => {
  try {
    let query = { _id: { $ne: req.user._id }, status: 'active' };
    
    if (req.user.role !== 'admin') {
      query.role = 'admin';
    }
    const users = await User.find(query).select('name username role').sort({ name: 1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/unread-count', authenticate, async (req, res) => {
  try {
    const convs = await Conversation.find({ participants: req.user._id }).select('_id');
    const convIds = convs.map(c => c._id);
    const count = await Message.countDocuments({
      conversationId: { $in: convIds },
      sender: { $ne: req.user._id },
      readBy: { $ne: req.user._id },
      isDeleted: false,
    });
    res.json({ count });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.delete('/conversations/:convId/messages/:msgId', authenticate, async (req, res) => {
  try {
    const msg = await Message.findById(req.params.msgId);
    if (!msg) return res.status(404).json({ message: 'Message not found' });
    
    if (msg.sender.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Cannot delete other users\' messages' });
    }

    msg.isDeleted = true;
    msg.deletedAt = new Date();
    msg.deletedBy = req.user._id;
    await msg.save();

    const conv = await Conversation.findById(req.params.convId);
    if (conv) {
      const io = req.app.get('io');
      conv.participants.forEach(pid => {
        io.to(`user:${pid.toString()}`).emit('message_deleted', {
          conversationId: req.params.convId,
          messageId: req.params.msgId,
        });
      });
    }

    res.json({ message: 'Message deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/conversations/:convId/forward', authenticate, async (req, res) => {
  try {
    const { messageId, targetConvId } = req.body;
    if (!messageId || !targetConvId) {
      return res.status(400).json({ message: 'messageId and targetConvId required' });
    }

    const originalMsg = await Message.findById(messageId).populate('sender');
    if (!originalMsg) return res.status(404).json({ message: 'Message not found' });

    const sourceConv = await Conversation.findById(req.params.convId);
    const targetConv = await Conversation.findById(targetConvId);
    if (!sourceConv || !targetConv) {
      return res.status(404).json({ message: 'Conversation not found' });
    }

    if (!sourceConv.participants.includes(req.user._id) || !targetConv.participants.includes(req.user._id)) {
      return res.status(403).json({ message: 'Not a participant in these conversations' });
    }

    const forwardedMsg = await Message.create({
      conversationId: targetConvId,
      sender: req.user._id,
      text: originalMsg.text,
      forwardedFrom: originalMsg._id,
      isForwarded: true,
    });

    const populated = await forwardedMsg.populate('sender', 'name username').exec();

    targetConv.lastMessage = forwardedMsg._id;
    targetConv.lastMessageAt = new Date();
    await targetConv.save();

    const io = req.app.get('io');
    targetConv.participants.forEach(pid => {
      io.to(`user:${pid.toString()}`).emit('new_message', {
        conversationId: targetConvId,
        message: populated,
      });
    });

    res.status(201).json({
      message: 'Message forwarded',
      forwarded: populated,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// One-off cleanup: removes conversations/messages left behind by users that no
// longer exist (e.g. deleted before per-user chat cleanup was added). Admin only.
// NOTE: declared before '/conversations/:id' so it isn't shadowed by that param route.
router.delete('/conversations/cleanup-orphaned', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'Admin access required' });

    const allUserIds = new Set((await User.find({}, '_id')).map(u => u._id.toString()));
    const allConvs = await Conversation.find({}, '_id participants');

    const orphanedIds = allConvs
      .filter(c => !c.participants.some(p => allUserIds.has(p.toString())))
      .map(c => c._id);

    if (orphanedIds.length > 0) {
      await Message.deleteMany({ conversationId: { $in: orphanedIds } });
      await Conversation.deleteMany({ _id: { $in: orphanedIds } });
    }

    res.json({ message: `Removed ${orphanedIds.length} orphaned conversation(s)`, removed: orphanedIds.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.delete('/conversations/:id', authenticate, async (req, res) => {
  try {
    const conv = await Conversation.findOne({
      _id: req.params.id,
      participants: req.user._id,
    });
    if (!conv) return res.status(404).json({ message: 'Conversation not found' });

    await Message.deleteMany({ conversationId: conv._id });
    await Conversation.deleteOne({ _id: conv._id });

    const io = req.app.get('io');
    if (io) {
      conv.participants.forEach(pid => {
        io.to(`user:${pid.toString()}`).emit('conversation_deleted', {
          conversationId: conv._id,
        });
      });
    }

    res.json({ message: 'Conversation deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
