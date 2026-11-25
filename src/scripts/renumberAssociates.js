const AssociateDetail = require('../models/AssociateDetail');

async function renumberAssociates() {
  const dupes = await AssociateDetail.aggregate([
    { $group: { _id: '$sno', n: { $sum: 1 } } },
    { $match: { $or: [{ n: { $gt: 1 } }, { _id: null }] } },
    { $limit: 1 }
  ]);
  if (dupes.length === 0) return 0;
  const docs = await AssociateDetail.find({}).select('_id sno createdAt').lean();
  docs.sort((a, b) => {
    const sa = a.sno == null ? Infinity : a.sno;
    const sb = b.sno == null ? Infinity : b.sno;
    if (sa !== sb) return sa - sb;
    const ta = new Date(a.createdAt || 0).getTime();
    const tb = new Date(b.createdAt || 0).getTime();
    if (ta !== tb) return ta - tb;
    return String(a._id).localeCompare(String(b._id));
  });
  const ops = docs.map((d, i) => ({ updateOne: { filter: { _id: d._id }, update: { $set: { sno: i + 1 } } } }));
  if (ops.length) await AssociateDetail.bulkWrite(ops);
  return ops.length;
}

module.exports = { renumberAssociates };
