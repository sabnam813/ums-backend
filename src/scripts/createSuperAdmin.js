require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/ums';
const username = (process.argv[2] || process.env.SUPER_ADMIN_USERNAME || 'superadmin').toLowerCase().trim();
const password = process.argv[3] || process.env.SUPER_ADMIN_PASSWORD || 'SuperAdmin@2026!';
async function run() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB:', MONGO_URI);
    let user = await User.findOne({
      username
    });
    if (user) {
      user.password = password;
      user.role = 'super_admin';
      user.status = 'active';
      user.mustChangePassword = false;
      await user.save();
      console.log(`Existing account "${username}" updated: role=super_admin, password reset.`);
    } else {
      user = await User.create({
        username,
        password,
        name: 'Super Admin',
        role: 'super_admin',
        mustChangePassword: false
      });
      console.log(`New Super Admin account created: "${username}".`);
    }
    console.log('Super Admin account ready');
    console.log(` Username: ${username}`);
    console.log(` Password: ${password}`);
    console.log('You can log in with these credentials now.');
  } catch (err) {
    console.error('Failed to create/update Super Admin:', err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}
run();
