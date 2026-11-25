const AssociateDetail = require('../models/AssociateDetail');

async function migrateOwners() {
  const docs = await AssociateDetail.find({
    $and: [
      { $or: [{ owners: { $exists: false } }, { owners: { $size: 0 } }] },
      { $or: [{ ownerName: { $ne: '' } }, { designation: { $ne: '' } }, { ownerContact: { $ne: '' } }] }
    ]
  }).select('_id ownerName designation ownerContact').lean();
  if (docs.length === 0) return 0;
  const ops = docs.map(d => ({
    updateOne: {
      filter: { _id: d._id },
      update: { $set: { owners: [{ name: d.ownerName || '', designation: d.designation || '', contact: d.ownerContact || '' }] } }
    }
  }));
  await AssociateDetail.bulkWrite(ops);
  return ops.length;
}

module.exports = { migrateOwners };
