
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/ums';

const ADMIN_USERNAME = process.env.SEED_ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'admin123';

async function seed() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log(' Connected to MongoDB');

    const existingAdmin = await User.findOne({ username: ADMIN_USERNAME.toLowerCase() });

    if (existingAdmin) {
      console.log(` Admin account "${ADMIN_USERNAME}" already exists — nothing to do.`);
    } else {
      await User.create({
        username: ADMIN_USERNAME,
        password: ADMIN_PASSWORD,
        name: 'System Administrator',
        role: 'admin',
      });
      console.log(` Admin created: ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}`);
      console.log('   Please log in and change this password right away.');
    }

    console.log('\nNo sample countries, users, or applications were created.');
    console.log('Add countries and applications from inside the app — everything you add is saved to the database.\n');
  } catch (err) {
    console.error(' Seed failed:', err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

seed();
