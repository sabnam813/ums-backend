require('dotenv').config();
const mongoose = require('mongoose');
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/ums';
async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB:', MONGO_URI);
  const collection = mongoose.connection.collection('achievementtargets');
  const rows = await collection.find({}).toArray();
  let migrated = 0,
    skipped = 0;
  for (const row of rows) {
    const hasStageTargets = row.targets && Object.values(row.targets).some(v => Number(v) > 0);
    if (hasStageTargets) {
      skipped++;
      continue;
    }
    const legacyTarget = Number(row.target) || 0;
    await collection.updateOne({
      _id: row._id
    }, {
      $set: {
        targets: {
          inquiry: legacyTarget,
          wip: 0,
          visaLodge: 0,
          visa: 0
        }
      }
    });
    migrated++;
  }
  console.log(`Done. Migrated: ${migrated}, already had stage targets (skipped, untouched): ${skipped}, total: ${rows.length}`);
  await mongoose.disconnect();
}
run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
