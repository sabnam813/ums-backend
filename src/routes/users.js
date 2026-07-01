const express = require('express');
const User = require('../models/User');
const Country = require('../models/Country');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const { verifyAccess, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(verifyAccess);

router.get('/', requireAdmin, async (req, res) => {
  try {
    const users = await User.find({ role: 'user' })
      .select('-password -refreshToken')
      .populate('countries', 'name flag');
    res.json({ users });
  } catch {
    res.status(500).json({ message: 'Failed to fetch users' });
  }
});

router.post('/', requireAdmin, async (req, res) => {
  try {
    const { username, password, name, countries } = req.body;
    if (!username || !password) {
      return res.status(400).json({ message: 'username and password required' });
    }
    const user = await User.create({
      username: username.toLowerCase().trim(),
      password,
      name: name || '',
      role: 'user',
      countries: countries || [],
      mustChangePassword: req.body.mustChangePassword || false,
    });
    const safe = await User.findById(user._id).select('-password -refreshToken').populate('countries', 'name flag');
    res.status(201).json({ user: safe });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'Username already taken' });
    res.status(500).json({ message: 'Failed to create user' });
  }
});

router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { name, username, countries, mustChangePassword } = req.body;
    const update = {};
    if (name !== undefined) update.name = name;
    if (username !== undefined) update.username = username.toLowerCase().trim();
    if (countries !== undefined) update.countries = countries;
    if (mustChangePassword !== undefined) update.mustChangePassword = mustChangePassword;

    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true })
      .select('-password -refreshToken')
      .populate('countries', 'name flag');
    if (!user) return res.status(404).json({ message: 'Not found' });
    res.json({ user });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'Username already taken' });
    res.status(500).json({ message: 'Failed to update user' });
  }
});

router.put('/:id/status', requireAdmin, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { status: req.body.status },
      { new: true }
    ).select('-password -refreshToken').populate('countries', 'name flag');
    res.json({ user });
  } catch {
    res.status(500).json({ message: 'Failed' });
  }
});

router.put('/:id/password', requireAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'Not found' });
    user.password = req.body.password;
    if (req.body.mustChangePassword !== undefined) user.mustChangePassword = req.body.mustChangePassword;
    await user.save();
    res.json({ message: 'Password updated' });
  } catch {
    res.status(500).json({ message: 'Failed' });
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;

    const conversations = await Conversation.find({ participants: userId }, '_id');
    const conversationIds = conversations.map(c => c._id);

    if (conversationIds.length > 0) {
      
      await Message.deleteMany({ conversationId: { $in: conversationIds } });

      await Conversation.deleteMany({ _id: { $in: conversationIds } });
    }

    await User.findByIdAndDelete(userId);

    res.json({ message: 'User and all associated chats deleted' });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ message: 'Failed to delete user' });
  }
});

module.exports = router;
