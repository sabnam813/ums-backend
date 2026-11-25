require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Department = require('../models/Department');
const Country = require('../models/Country');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/ums';

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB:', MONGO_URI);

  const allCountryIds = (await Country.find({}).select('_id')).map(c => c._id);
  const departments = await Department.find({});
  const deptByName = new Map(departments.map(d => [d.name, d]));

  const users = await User.find({ role: 'user' });
  let fixedCount = 0;

  for (const user of users) {
    const deptNames = user.departments && user.departments.length > 0
      ? user.departments
      : (user.department ? [user.department] : []);
    if (deptNames.length === 0) continue;

    const depts = deptNames.map(n => deptByName.get(n)).filter(Boolean);
    if (depts.length === 0) continue;

    const shouldHaveAllCountries = depts.some(d => d.allCountries);
    const currentlyHasFlag = !!user.allCountries;
    const currentCount = (user.countries || []).length;

    if (shouldHaveAllCountries && (!currentlyHasFlag || currentCount !== allCountryIds.length)) {
      user.allCountries = true;
      user.countries = allCountryIds;
      await user.save();
      fixedCount++;
      console.log(`Fixed: ${user.username} -> all countries (${allCountryIds.length})`);
    } else if (!shouldHaveAllCountries && currentlyHasFlag) {
      user.allCountries = false;
      const countrySet = new Set();
      depts.forEach(d => {
        (d.countries || []).forEach(c => countrySet.add(String(c._id || c)));
      });
      user.countries = Array.from(countrySet);
      await user.save();
      fixedCount++;
      console.log(`Fixed: ${user.username} -> reset to department-specific countries`);
    }
  }

  console.log(`Done. Checked ${users.length} users, fixed ${fixedCount}.`);
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Migration failed:', err.message);
  process.exitCode = 1;
});
