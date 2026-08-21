const fs = require('fs');
const path = require('path');
const Backup = require('../models/Backup');
const BACKUP_DIR = path.join(__dirname, '..', '..', 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, {
  recursive: true
});
const MODELS = {
  User: require('../models/User'),
  Country: require('../models/Country'),
  Application: require('../models/Application'),
  Inquiry: require('../models/Inquiry'),
  FieldConfig: require('../models/FieldConfig'),
  Conversation: require('../models/Conversation'),
  Message: require('../models/Message'),
  Trash: require('../models/Trash')
};
const COLLECTION_NAMES = Object.keys(MODELS);
const MAX_BACKUPS_KEPT = 1;
const SINGLE_BACKUP_FILENAME = 'backup-latest.json';
const MAX_PRE_RESTORE_BACKUPS_KEPT = 5;
const INDIVIDUAL_BACKUP_DIR = path.join(BACKUP_DIR, 'individual');
if (!fs.existsSync(INDIVIDUAL_BACKUP_DIR)) fs.mkdirSync(INDIVIDUAL_BACKUP_DIR, {
  recursive: true
});
async function createBackup({
  type = 'manual',
  userId
} = {}) {
  const data = {};
  const counts = {};
  for (const name of COLLECTION_NAMES) {
    const docs = await MODELS[name].find({}).lean();
    data[name] = docs;
    counts[name] = docs.length;
  }
  const isPreRestore = type === 'pre-restore';
  const filename = isPreRestore ? `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.json` : SINGLE_BACKUP_FILENAME;
  const filePath = path.join(BACKUP_DIR, filename);
  fs.writeFileSync(filePath, JSON.stringify(data));
  const {
    size
  } = fs.statSync(filePath);
  let backup;
  if (isPreRestore) {
    backup = await Backup.create({
      filename,
      sizeBytes: size,
      type,
      counts,
      createdBy: userId
    });
  } else {
    backup = await Backup.findOne({
      type: {
        $ne: 'pre-restore'
      }
    }).sort({
      createdAt: -1
    });
    if (backup) {
      backup.filename = filename;
      backup.sizeBytes = size;
      backup.type = type;
      backup.counts = counts;
      backup.createdBy = userId;
      backup.createdAt = new Date();
      await backup.save();
    } else {
      backup = await Backup.create({
        filename,
        sizeBytes: size,
        type,
        counts,
        createdBy: userId
      });
    }
  }
  try {
    for (const name of COLLECTION_NAMES) {
      const colFilename = `${name.toLowerCase()}-latest.json`;
      const colPath = path.join(INDIVIDUAL_BACKUP_DIR, colFilename);
      fs.writeFileSync(colPath, JSON.stringify({
        [name]: data[name]
      }));
    }
  } catch (e) {
    console.error('Individual collection backup write failed:', e.message);
  }
  await pruneOldBackups();
  return backup;
}
async function pruneOldBackups() {
  const regular = await Backup.find({
    type: {
      $ne: 'pre-restore'
    }
  }).sort({
    createdAt: -1
  });
  const regularToRemove = regular.slice(MAX_BACKUPS_KEPT);
  const preRestore = await Backup.find({
    type: 'pre-restore'
  }).sort({
    createdAt: -1
  });
  const preRestoreToRemove = preRestore.slice(MAX_PRE_RESTORE_BACKUPS_KEPT);
  for (const b of [...regularToRemove, ...preRestoreToRemove]) {
    const p = path.join(BACKUP_DIR, b.filename);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    await Backup.findByIdAndDelete(b._id);
  }
}
async function listBackups() {
  const backups = await Backup.find().sort({
    createdAt: -1
  }).lean();
  return backups.map(b => ({
    ...b,
    fileAvailable: fs.existsSync(path.join(BACKUP_DIR, b.filename))
  }));
}
async function getBackupFilePath(id) {
  const backup = await Backup.findById(id);
  if (!backup) throw new Error('Backup not found');
  const filePath = path.join(BACKUP_DIR, backup.filename);
  if (!fs.existsSync(filePath)) {
    throw new Error('Backup file is no longer on disk (server may have restarted or redeployed since it was created)');
  }
  return {
    backup,
    filePath
  };
}
async function applyBackupData(data) {
  const counts = {};
  for (const name of COLLECTION_NAMES) {
    const Model = MODELS[name];
    const docs = data[name] || [];
    await Model.deleteMany({});
    if (docs.length) {
      await Model.collection.insertMany(docs, {
        ordered: false
      }).catch(() => {});
    }
    counts[name] = docs.length;
  }
  return counts;
}
async function restoreBackup(id) {
  const {
    filePath
  } = await getBackupFilePath(id);
  const raw = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw);
  const counts = await applyBackupData(data);
  return {
    restored: true,
    counts
  };
}
function validateBackupPayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Backup file is not valid. Expected a JSON object of collections.');
  }
  const keys = Object.keys(data);
  if (keys.length === 0) {
    throw new Error('Backup file is empty');
  }
  const recognized = keys.filter(k => COLLECTION_NAMES.includes(k));
  if (recognized.length === 0) {
    throw new Error('Backup file does not contain any recognized collections for this system');
  }
  for (const k of keys) {
    if (!Array.isArray(data[k])) {
      throw new Error(`Backup file is malformed: "${k}" should be a list of records`);
    }
  }
  const counts = {};
  recognized.forEach(k => {
    counts[k] = data[k].length;
  });
  return {
    collections: recognized,
    counts,
    recordCount: recognized.reduce((s, k) => s + counts[k], 0)
  };
}
async function restoreFromUploadedData(data, {
  userId
} = {}) {
  validateBackupPayload(data);
  const safetyBackup = await createBackup({
    type: 'pre-restore',
    userId
  });
  try {
    const counts = await applyBackupData(data);
    return {
      restored: true,
      counts,
      safetyBackupId: safetyBackup._id
    };
  } catch (err) {
    try {
      const {
        filePath
      } = await getBackupFilePath(safetyBackup._id);
      const raw = fs.readFileSync(filePath, 'utf-8');
      const safetyData = JSON.parse(raw);
      await applyBackupData(safetyData);
    } catch (rollbackErr) {
      const combined = new Error(`Restore failed (${err.message}) and automatic rollback also failed (${rollbackErr.message}). ` + `A safety backup was saved before the restore attempt (id: ${safetyBackup._id}). Restore it manually from Backup & Restore.`);
      throw combined;
    }
    throw new Error(`Restore failed and the database was rolled back to its pre-restore state: ${err.message}`);
  }
}
async function exportCollectionJSON(collectionName) {
  if (!COLLECTION_NAMES.includes(collectionName)) {
    throw new Error(`Unknown collection: ${collectionName}`);
  }
  const docs = await MODELS[collectionName].find({}).lean();
  const buf = Buffer.from(JSON.stringify({
    [collectionName]: docs
  }, null, 2), 'utf-8');
  return {
    buf,
    filename: `${collectionName.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.json`,
    count: docs.length
  };
}
async function exportAllExcel() {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'UMS Backup';
  wb.created = new Date();
  const SHEET_ORDER = [['Application', 'Applications'], ['Inquiry', 'Inquiries'], ['User', 'Users'], ['Country', 'Countries'], ['FieldConfig', 'Field Config'], ['Conversation', 'Conversations'], ['Message', 'Messages'], ['Trash', 'Trash']];
  for (const [modelKey, sheetName] of SHEET_ORDER) {
    if (!MODELS[modelKey]) continue;
    const docs = await MODELS[modelKey].find({}).lean();
    const ws = wb.addWorksheet(sheetName);
    if (docs.length === 0) {
      ws.addRow(['No records']);
      continue;
    }
    const flatten = (obj, prefix = '') => {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
          Object.assign(out, flatten(v, key));
        } else if (Array.isArray(v)) {
          out[key] = v.map(i => typeof i === 'object' ? JSON.stringify(i) : i).join('; ');
        } else {
          out[key] = v;
        }
      }
      return out;
    };
    const flat = docs.map(flatten);
    const allKeys = [...new Set(flat.flatMap(Object.keys))];
    ws.columns = allKeys.map(k => ({
      header: k,
      key: k,
      width: Math.min(Math.max(k.length + 4, 12), 40)
    }));
    const headerRow = ws.getRow(1);
    headerRow.font = {
      bold: true,
      color: {
        argb: 'FFFFFFFF'
      }
    };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: {
        argb: 'FF2E4F8F'
      }
    };
    headerRow.alignment = {
      vertical: 'middle'
    };
    headerRow.commit();
    for (const row of flat) {
      ws.addRow(allKeys.map(k => {
        const v = row[k];
        if (v instanceof Date) return v.toISOString();
        if (v === null || v === undefined) return '';
        return String(v);
      }));
    }
    ws.views = [{
      state: 'frozen',
      ySplit: 1
    }];
  }
  const summary = wb.addWorksheet('_Summary');
  summary.columns = [{
    header: 'Collection',
    key: 'col',
    width: 20
  }, {
    header: 'Records',
    key: 'count',
    width: 12
  }, {
    header: 'Exported At',
    key: 'ts',
    width: 24
  }];
  const sumHeader = summary.getRow(1);
  sumHeader.font = {
    bold: true,
    color: {
      argb: 'FFFFFFFF'
    }
  };
  sumHeader.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: {
      argb: 'FFF08641'
    }
  };
  sumHeader.commit();
  for (const [modelKey, sheetName] of SHEET_ORDER) {
    if (!MODELS[modelKey]) continue;
    const count = await MODELS[modelKey].countDocuments();
    summary.addRow({
      col: sheetName,
      count,
      ts: new Date().toISOString()
    });
  }
  const buf = await wb.xlsx.writeBuffer();
  const filename = `ums-backup-${new Date().toISOString().slice(0, 10)}.xlsx`;
  return {
    buf,
    filename
  };
}
async function deleteBackup(id) {
  const backup = await Backup.findById(id);
  if (!backup) throw new Error('Backup not found');
  const filePath = path.join(BACKUP_DIR, backup.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  await Backup.findByIdAndDelete(id);
}
async function isRecentBackupStillFresh(intervalHours) {
  const existing = await Backup.findOne().sort({
    createdAt: -1
  });
  if (!existing) return false;
  const ageMs = Date.now() - new Date(existing.createdAt).getTime();
  return ageMs < intervalHours * 60 * 60 * 1000;
}
let scheduled = false;
function scheduleAutoBackup({
  intervalHours = 24
} = {}) {
  if (scheduled) return;
  scheduled = true;
  const ms = intervalHours * 60 * 60 * 1000;
  const runIfDue = async () => {
    const BackgroundJobRun = require('../models/BackgroundJobRun');
    const start = Date.now();
    try {
      if (await isRecentBackupStillFresh(intervalHours)) return;
      const backup = await createBackup({
        type: 'auto'
      });
      await BackgroundJobRun.create({
        key: 'auto-backup',
        label: 'Automatic Database Backup',
        status: 'success',
        durationMs: Date.now() - start,
        message: `Backup created: ${backup.filename || backup._id}`,
        trigger: 'schedule'
      }).catch(() => {});
    } catch (e) {
      console.error('Auto backup failed:', e.message);
      await BackgroundJobRun.create({
        key: 'auto-backup',
        label: 'Automatic Database Backup',
        status: 'failed',
        durationMs: Date.now() - start,
        message: e.message,
        trigger: 'schedule'
      }).catch(() => {});
    }
  };
  setTimeout(runIfDue, 60 * 1000);
  setInterval(runIfDue, ms);
  console.log(`🗄️  Auto backup scheduled every ${intervalHours}h (only the single most recent snapshot is kept)`);
}
module.exports = {
  createBackup,
  listBackups,
  restoreBackup,
  restoreFromUploadedData,
  validateBackupPayload,
  deleteBackup,
  getBackupFilePath,
  scheduleAutoBackup,
  exportCollectionJSON,
  exportAllExcel,
  BACKUP_DIR,
  INDIVIDUAL_BACKUP_DIR,
  COLLECTION_NAMES
};
