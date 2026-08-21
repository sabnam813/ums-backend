require('dotenv').config();
const mongoose = require('mongoose');
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/ums';
async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB:', MONGO_URI);
  const collection = mongoose.connection.collection('testpreprecords');
  const records = await collection.find({}).toArray();
  let backedUp = 0,
    skipped = 0;
  for (const rec of records) {
    if (rec.legacyPteVoucher !== undefined || rec.legacyVoucherCode !== undefined) {
      skipped++;
      continue;
    }
    const oldPteVoucher = typeof rec.pteVoucher === 'string' ? rec.pteVoucher.trim() : '';
    const oldVoucherCode = typeof rec.voucher === 'string' ? rec.voucher.trim() : '';
    await collection.updateOne({
      _id: rec._id
    }, {
      $set: {
        voucher: '',
        legacyPteVoucher: oldPteVoucher,
        legacyVoucherCode: oldVoucherCode
      }
    });
    backedUp++;
  }
  console.log(`Done. Backed up + reset to empty: ${backedUp}, already-migrated (skipped, untouched): ${skipped}, total: ${records.length}`);
  await mongoose.disconnect();
}
run().catch(err => {
  console.error('Voucher migration failed:', err);
  process.exit(1);
});
