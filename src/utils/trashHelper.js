const mongoose = require('mongoose');
const Trash = require('../models/Trash');
const MODELS = {
  get Application() {
    return require('../models/Application');
  },
  get Inquiry() {
    return require('../models/Inquiry');
  },
  get Country() {
    return require('../models/Country');
  },
  get User() {
    return require('../models/User');
  },
  get FieldConfig() {
    return require('../models/FieldConfig');
  },
  get TestType() {
    return require('../models/TestType');
  },
  get TestPrepRecord() {
    return require('../models/TestPrepRecord');
  },
  get TestPrepFieldConfig() {
    return require('../models/TestPrepFieldConfig');
  },
  get ContactGroup() {
    return require('../models/ContactGroup');
  },
  get Contact() {
    return require('../models/Contact');
  },
  get CountryGroup() {
    return require('../models/CountryGroup');
  },
  get Portal() {
    return require('../models/Portal');
  },
  get Diary() {
    return require('../models/Diary');
  },
  get HallBooking() {
    return require('../models/HallBooking');
  },
  get StudentFollowUp() {
    return require('../models/StudentFollowUp');
  },
  get CommissionRate() {
    return require('../models/CommissionRate');
  },
  get CommissionDepartment() {
    return require('../models/CommissionDepartment');
  },
  get AssociateDetail() {
    return require('../models/AssociateDetail');
  },
  get Unicommission() {
    return require('../models/Unicommission');
  }
};
function flattenMaps(value) {
  if (value instanceof Map) {
    return flattenMaps(Object.fromEntries(value));
  }
  if (Array.isArray(value)) {
    return value.map(flattenMaps);
  }
  if (value && typeof value === 'object' && !(value instanceof mongoose.Types.ObjectId) && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = flattenMaps(v);
    return out;
  }
  return value;
}
async function softDelete({
  modelName,
  doc,
  userId,
  userName,
  meta = {}
}) {
  const Model = MODELS[modelName];
  if (!Model) throw new Error(`Unknown model for trash: ${modelName}`);
  const data = flattenMaps(doc.toObject ? doc.toObject() : doc);
  const trashDoc = await Trash.create({
    model: modelName,
    originalId: data._id,
    data,
    deletedBy: userId,
    deletedByName: userName || '',
    meta,
    expiresAt: new Date(Date.now() + Trash.TTL_DAYS * 24 * 60 * 60 * 1000)
  });
  await Model.deleteOne({
    _id: data._id
  });
  return trashDoc;
}
async function softDeleteMany({
  modelName,
  docs,
  userId,
  userName,
  metaFor = () => ({})
}) {
  const Model = MODELS[modelName];
  if (!Model) throw new Error(`Unknown model for trash: ${modelName}`);
  if (!docs || docs.length === 0) return [];

  const expiresAt = new Date(Date.now() + Trash.TTL_DAYS * 24 * 60 * 60 * 1000);
  const trashDocs = docs.map(doc => {
    const data = flattenMaps(doc.toObject ? doc.toObject() : doc);
    return {
      model: modelName,
      originalId: data._id,
      data,
      deletedBy: userId,
      deletedByName: userName || '',
      meta: metaFor(doc) || {},
      expiresAt
    };
  });

  const inserted = await Trash.insertMany(trashDocs, { ordered: false });
  const ids = docs.map(d => (d._id ? d._id : d));
  await Model.deleteMany({ _id: { $in: ids } });
  return inserted;
}
async function restoreFromTrash(trashId) {
  const trashDoc = await Trash.findById(trashId);
  if (!trashDoc) throw new Error('Trash item not found');
  const Model = MODELS[trashDoc.model];
  if (!Model) throw new Error(`Unknown model for trash: ${trashDoc.model}`);
  const existing = await Model.findById(trashDoc.originalId);
  if (existing) {
    throw new Error('An item with this ID already exists in the destination. Cannot restore automatically.');
  }
  const {
    _id,
    ...rest
  } = trashDoc.data;
  await Model.collection.insertOne({
    _id: new mongoose.Types.ObjectId(trashDoc.originalId),
    ...rest
  });
  const restored = await Model.findById(trashDoc.originalId);
  await Trash.findByIdAndDelete(trashId);
  return restored;
}
async function permanentDelete(trashId) {
  const trashDoc = await Trash.findByIdAndDelete(trashId);
  if (!trashDoc) throw new Error('Trash item not found');
  return trashDoc;
}
module.exports = {
  softDelete,
  softDeleteMany,
  restoreFromTrash,
  permanentDelete,
  MODELS
};
