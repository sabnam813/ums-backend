// Run once after deploying the multi-country Inquiry update:
//   node src/scripts/migrateInquiryCountries.js
//
// Fixes historical Inquiry documents where `country` was stored as a single
// string (including old rows where multiple countries were manually typed
// comma-separated into that one string) so they become a proper string array.
// Safe to run multiple times — already-migrated (array) documents are skipped.
require('dotenv').config();
const mongoose = require('mongoose');
const Inquiry = require('../models/Inquiry');

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected. Scanning inquiries...');

    const cursor = Inquiry.collection.find({ country: { $type: 'string' } });
    let scanned = 0;
    let updated = 0;

    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      scanned++;
      const raw = doc.country || '';
      const countryArr = [...new Set(
        raw.split(',').map(c => c.trim()).filter(Boolean)
      )];
      await Inquiry.collection.updateOne(
        { _id: doc._id },
        { $set: { country: countryArr } }
      );
      updated++;
    }

    console.log(`Scanned ${scanned} legacy string-country document(s), updated ${updated}.`);
  } catch (err) {
    console.error('Migration failed:', err.message);
  } finally {
    await mongoose.disconnect();
  }
})();
