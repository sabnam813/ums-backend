const express = require('express');
const {
  verifyAccess,
  requireSuperAdmin
} = require('../middleware/auth');
const backupService = require('../utils/backupService');
const {
  logActivity
} = require('../utils/auditLogger');
const router = express.Router();
router.use(verifyAccess, requireSuperAdmin);
router.get('/', async (req, res) => {
  try {
    const backups = await backupService.listBackups();
    res.json({
      backups,
      collections: backupService.COLLECTION_NAMES
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to list backups'
    });
  }
});
router.post('/run', async (req, res) => {
  try {
    const backup = await backupService.createBackup({
      type: 'manual',
      userId: req.user._id
    });
    await logActivity(req, 'backup.created', {
      targetType: 'Backup',
      targetId: backup._id || backup.id,
      message: 'Manual backup created'
    });
    res.status(201).json({
      message: 'Backup created',
      backup
    });
  } catch (err) {
    console.error('Manual backup failed:', err);
    res.status(500).json({
      message: err.message || 'Backup failed'
    });
  }
});
router.get('/:id/download', async (req, res) => {
  try {
    const {
      backup,
      filePath
    } = await backupService.getBackupFilePath(req.params.id);
    res.download(filePath, backup.filename);
  } catch (err) {
    res.status(404).json({
      message: err.message || 'Backup not found'
    });
  }
});
router.post('/:id/restore', async (req, res) => {
  try {
    const result = await backupService.restoreBackup(req.params.id);
    await logActivity(req, 'backup.restored', {
      targetType: 'Backup',
      targetId: req.params.id,
      message: 'Database restored from backup'
    });
    res.json({
      message: 'Database restored from backup',
      result
    });
  } catch (err) {
    console.error('Restore failed:', err);
    res.status(500).json({
      message: err.message || 'Restore failed'
    });
  }
});
router.post('/validate-upload', async (req, res) => {
  try {
    const {
      data
    } = req.body;
    const info = backupService.validateBackupPayload(data);
    res.json({
      valid: true,
      ...info
    });
  } catch (err) {
    res.status(400).json({
      valid: false,
      message: err.message || 'Invalid backup file'
    });
  }
});
router.post('/restore-upload', async (req, res) => {
  try {
    const {
      data
    } = req.body;
    const result = await backupService.restoreFromUploadedData(data, {
      userId: req.user._id
    });
    await logActivity(req, 'backup.restored', {
      targetType: 'Backup',
      targetId: result.safetyBackupId,
      message: 'Database restored from an uploaded backup file'
    });
    res.json({
      message: 'Database restored from uploaded backup',
      result
    });
  } catch (err) {
    console.error('Upload restore failed:', err);
    res.status(500).json({
      message: err.message || 'Restore failed'
    });
  }
});
router.get('/export/excel', async (req, res) => {
  try {
    const {
      buf,
      filename
    } = await backupService.exportAllExcel();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buf);
  } catch (err) {
    console.error('Excel export failed:', err);
    res.status(500).json({
      message: err.message || 'Excel export failed'
    });
  }
});
router.get('/export/collection/:name', async (req, res) => {
  try {
    const {
      buf,
      filename,
      count
    } = await backupService.exportCollectionJSON(req.params.name);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Record-Count', count);
    res.send(buf);
  } catch (err) {
    res.status(400).json({
      message: err.message || 'Export failed'
    });
  }
});
router.delete('/:id', async (req, res) => {
  try {
    await backupService.deleteBackup(req.params.id);
    await logActivity(req, 'backup.deleted', {
      targetType: 'Backup',
      targetId: req.params.id,
      message: 'Backup file deleted'
    });
    res.json({
      message: 'Backup deleted'
    });
  } catch (err) {
    res.status(500).json({
      message: err.message || 'Failed to delete backup'
    });
  }
});
module.exports = router;
