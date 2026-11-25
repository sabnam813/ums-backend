const express = require('express');
const os = require('os');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const Trash = require('../models/Trash');
const SystemLog = require('../models/SystemLog');
const SystemAlert = require('../models/SystemAlert');
const MaintenanceMode = require('../models/MaintenanceMode');
const FeatureFlag = require('../models/FeatureFlag');
const {
  verifyAccess,
  requireSuperAdmin
} = require('../middleware/auth');
const {
  logActivity
} = require('../utils/auditLogger');
const jobRegistry = require('../utils/jobRegistry');
const cache = require('../utils/simpleCache');
const backupService = require('../utils/backupService');
const router = express.Router();
router.use(verifyAccess, requireSuperAdmin);
const BACKUP_DIR = path.join(__dirname, '..', '..', 'backups');
const startedAt = Date.now();
function dirSize(dir) {
  if (!fs.existsSync(dir)) return {
    bytes: 0,
    files: 0
  };
  let bytes = 0,
    files = 0;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    if (stat.isFile()) {
      bytes += stat.size;
      files += 1;
    }
  }
  return {
    bytes,
    files
  };
}
router.get('/overview', async (req, res) => {
  try {
    const data = await cache.cached('superadmin:overview', 10000, async () => {
      const dbState = mongoose.connection.readyState;
      const [userCount, trashCount, unreadAlerts, criticalAlerts, jobs, maintenance] = await Promise.all([User.countDocuments(), Trash.countDocuments(), SystemAlert.countDocuments({
        read: false
      }), SystemAlert.countDocuments({
        read: false,
        severity: 'critical'
      }), jobRegistry.getJobsStatus(), MaintenanceMode.findOne({
        key: 'singleton'
      })]);
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [requests24h, errors24h, avgDurationAgg] = await Promise.all([SystemLog.countDocuments({
        type: 'request',
        createdAt: {
          $gte: since24h
        }
      }), SystemLog.countDocuments({
        type: {
          $in: ['error', 'crash']
        },
        createdAt: {
          $gte: since24h
        }
      }), SystemLog.aggregate([{
        $match: {
          type: 'request',
          createdAt: {
            $gte: since24h
          }
        }
      }, {
        $group: {
          _id: null,
          avgMs: {
            $avg: '$durationMs'
          }
        }
      }])]);
      return {
        server: {
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
          nodeVersion: process.version,
          environment: process.env.NODE_ENV || 'development',
          platform: os.platform(),
          cpuCount: os.cpus().length,
          loadAvg: os.loadavg(),
          memoryUsageMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
          totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
          freeMemoryMb: Math.round(os.freemem() / 1024 / 1024)
        },
        database: {
          connected: dbState === 1,
          state: ['disconnected', 'connected', 'connecting', 'disconnecting'][dbState] || 'unknown',
          host: mongoose.connection.host || null,
          name: mongoose.connection.name || null
        },
        traffic: {
          requests24h,
          errors24h,
          avgResponseMs: Math.round(avgDurationAgg[0]?.avgMs || 0)
        },
        counts: {
          users: userCount,
          trashItems: trashCount
        },
        alerts: {
          unread: unreadAlerts,
          critical: criticalAlerts
        },
        jobs,
        maintenanceMode: {
          enabled: !!maintenance?.enabled
        }
      };
    });
    res.json(data);
  } catch (err) {
    console.error('Superadmin overview error:', err);
    res.status(500).json({
      message: 'Failed to load overview'
    });
  }
});
router.get('/overview/timeseries', async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const buckets = await SystemLog.aggregate([{
      $match: {
        type: 'request',
        createdAt: {
          $gte: since
        }
      }
    }, {
      $group: {
        _id: {
          $dateTrunc: {
            date: '$createdAt',
            unit: 'hour'
          }
        },
        count: {
          $sum: 1
        },
        errors: {
          $sum: {
            $cond: [{
              $gte: ['$statusCode', 400]
            }, 1, 0]
          }
        },
        avgMs: {
          $avg: '$durationMs'
        }
      }
    }, {
      $sort: {
        _id: 1
      }
    }]);
    res.json({
      series: buckets.map(b => ({
        hour: b._id,
        requests: b.count,
        errors: b.errors,
        avgMs: Math.round(b.avgMs || 0)
      }))
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to load timeseries'
    });
  }
});
router.get('/database', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.json({
        connected: false,
        collections: []
      });
    }
    const stats = await mongoose.connection.db.stats();
    const collections = await mongoose.connection.db.listCollections().toArray();
    const collectionStats = await Promise.all(collections.map(async c => {
      try {
        const count = await mongoose.connection.db.collection(c.name).countDocuments();
        return {
          name: c.name,
          documents: count
        };
      } catch {
        return {
          name: c.name,
          documents: null
        };
      }
    }));
    res.json({
      connected: true,
      host: mongoose.connection.host,
      name: mongoose.connection.name,
      stats: {
        collections: stats.collections,
        dataSizeMb: Math.round(stats.dataSize / 1024 / 1024 * 100) / 100,
        storageSizeMb: Math.round(stats.storageSize / 1024 / 1024 * 100) / 100,
        indexes: stats.indexes,
        indexSizeMb: Math.round(stats.indexSize / 1024 / 1024 * 100) / 100,
        objects: stats.objects
      },
      collections: collectionStats.sort((a, b) => (b.documents || 0) - (a.documents || 0))
    });
  } catch (err) {
    console.error('Database stats error:', err);
    res.status(500).json({
      message: 'Failed to load database stats'
    });
  }
});
router.get('/logs', async (req, res) => {
  try {
    const {
      type,
      level,
      path: pathFilter,
      statusCode,
      dateFrom,
      dateTo,
      limit = 100,
      page = 1
    } = req.query;
    const query = {};
    if (type) query.type = type.includes(',') ? {
      $in: type.split(',')
    } : type;
    if (level) query.level = level;
    if (pathFilter) query.path = new RegExp(pathFilter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (statusCode) query.statusCode = Number(statusCode);
    if (dateFrom || dateTo) {
      query.createdAt = {};
      if (dateFrom) query.createdAt.$gte = new Date(dateFrom);
      if (dateTo) query.createdAt.$lte = new Date(dateTo);
    }
    const pageSize = Math.min(Number(limit) || 100, 500);
    const skip = (Math.max(Number(page), 1) - 1) * pageSize;
    const [logs, total] = await Promise.all([SystemLog.find(query).sort({
      createdAt: -1
    }).skip(skip).limit(pageSize), SystemLog.countDocuments(query)]);
    res.json({
      logs,
      total,
      page: Number(page),
      pageSize
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to fetch system logs'
    });
  }
});
router.delete('/logs', async (req, res) => {
  try {
    const {
      olderThanDays
    } = req.query;
    const query = {};
    if (olderThanDays) query.createdAt = {
      $lt: new Date(Date.now() - Number(olderThanDays) * 24 * 60 * 60 * 1000)
    };
    const result = await SystemLog.deleteMany(query);
    await logActivity(req, 'superadmin.logs_cleared', {
      message: `Cleared ${result.deletedCount} system log(s)`
    });
    res.json({
      message: 'Logs cleared',
      deleted: result.deletedCount
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to clear logs'
    });
  }
});
router.get('/performance', async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const byRoute = await SystemLog.aggregate([{
      $match: {
        type: 'request',
        createdAt: {
          $gte: since
        }
      }
    }, {
      $group: {
        _id: {
          method: '$method',
          path: '$path'
        },
        count: {
          $sum: 1
        },
        avgMs: {
          $avg: '$durationMs'
        },
        maxMs: {
          $max: '$durationMs'
        },
        errors: {
          $sum: {
            $cond: [{
              $gte: ['$statusCode', 400]
            }, 1, 0]
          }
        }
      }
    }, {
      $sort: {
        avgMs: -1
      }
    }, {
      $limit: 25
    }]);
    res.json({
      routes: byRoute.map(r => ({
        method: r._id.method,
        path: r._id.path,
        count: r.count,
        avgMs: Math.round(r.avgMs || 0),
        maxMs: Math.round(r.maxMs || 0),
        errors: r.errors
      }))
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to load performance data'
    });
  }
});
router.get('/security', async (req, res) => {
  try {
    const [failedLogins, recentLogins, activeSessions, mustChangeCount, roleBreakdown] = await Promise.all([AuditLog.find({
      action: 'auth.login_failed'
    }).sort({
      createdAt: -1
    }).limit(50), AuditLog.find({
      action: 'auth.login'
    }).sort({
      createdAt: -1
    }).limit(50), User.countDocuments({
      sessions: {
        $exists: true,
        $not: {
          $size: 0
        }
      }
    }), User.countDocuments({
      mustChangePassword: true
    }), User.aggregate([{
      $group: {
        _id: '$role',
        count: {
          $sum: 1
        }
      }
    }])]);
    res.json({
      failedLogins,
      recentLogins,
      activeSessions,
      mustChangePasswordCount: mustChangeCount,
      roleBreakdown: roleBreakdown.map(r => ({
        role: r._id,
        count: r.count
      })),
      config: {
        jwtExpiresIn: '24h',
        refreshExpiresIn: '7d (30d with "remember me")',
        corsOrigins: (process.env.CLIENT_URL || 'http://localhost:3000').split(',').map(o => o.trim())
      }
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to load security data'
    });
  }
});
router.get('/alerts', async (req, res) => {
  try {
    const {
      read,
      severity,
      limit = 100,
      page = 1
    } = req.query;
    const query = {};
    if (read !== undefined) query.read = read === 'true';
    if (severity) query.severity = severity;
    const pageSize = Math.min(Number(limit) || 100, 300);
    const skip = (Math.max(Number(page), 1) - 1) * pageSize;
    const [alerts, total, unread] = await Promise.all([SystemAlert.find(query).sort({
      createdAt: -1
    }).skip(skip).limit(pageSize), SystemAlert.countDocuments(query), SystemAlert.countDocuments({
      read: false
    })]);
    res.json({
      alerts,
      total,
      unread,
      page: Number(page),
      pageSize
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to load alerts'
    });
  }
});
router.put('/alerts/:id/read', async (req, res) => {
  try {
    const alert = await SystemAlert.findByIdAndUpdate(req.params.id, {
      read: true
    }, {
      new: true
    });
    if (!alert) return res.status(404).json({
      message: 'Alert not found'
    });
    res.json({
      alert
    });
  } catch {
    res.status(500).json({
      message: 'Failed to update alert'
    });
  }
});
router.put('/alerts/read-all', async (req, res) => {
  try {
    const result = await SystemAlert.updateMany({
      read: false
    }, {
      read: true
    });
    res.json({
      updated: result.modifiedCount
    });
  } catch {
    res.status(500).json({
      message: 'Failed to update alerts'
    });
  }
});
router.delete('/alerts', async (req, res) => {
  try {
    const result = await SystemAlert.deleteMany({
      read: true
    });
    res.json({
      deleted: result.deletedCount
    });
  } catch {
    res.status(500).json({
      message: 'Failed to clear alerts'
    });
  }
});
router.get('/api-routes', async (req, res) => {
  try {
    const routes = [];
    req.app._router.stack.forEach(layer => {
      if (layer.name === 'router' && layer.regexp) {
        const match = layer.regexp.toString().match(/\^\\\/(.+?)\\\/\?/);
        const base = match ? `/${match[1].replace(/\\\//g, '/')}` : '';
        layer.handle.stack.forEach(sub => {
          if (sub.route) {
            const methods = Object.keys(sub.route.methods).map(m => m.toUpperCase());
            methods.forEach(method => routes.push({
              method,
              path: `/api${base}${sub.route.path}`
            }));
          }
        });
      }
    });
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const traffic = await SystemLog.aggregate([{
      $match: {
        type: 'request',
        createdAt: {
          $gte: since
        }
      }
    }, {
      $group: {
        _id: {
          method: '$method',
          path: '$path'
        },
        count: {
          $sum: 1
        },
        errors: {
          $sum: {
            $cond: [{
              $gte: ['$statusCode', 400]
            }, 1, 0]
          }
        }
      }
    }]);
    const trafficMap = {};
    traffic.forEach(t => {
      trafficMap[`${t._id.method} ${t._id.path}`] = {
        count: t.count,
        errors: t.errors
      };
    });
    const enriched = routes.map(r => ({
      ...r,
      requests24h: trafficMap[`${r.method} ${r.path}`]?.count || 0,
      errors24h: trafficMap[`${r.method} ${r.path}`]?.errors || 0
    }));
    res.json({
      routes: enriched,
      total: enriched.length
    });
  } catch (err) {
    console.error('API routes introspection error:', err);
    res.status(500).json({
      message: 'Failed to introspect API routes'
    });
  }
});
router.get('/cache', (req, res) => {
  res.json(cache.getStats());
});
router.post('/cache/flush', async (req, res) => {
  const cleared = cache.flush();
  await logActivity(req, 'superadmin.cache_flushed', {
    message: `Flushed ${cleared} cache entr${cleared === 1 ? 'y' : 'ies'}`
  });
  res.json({
    message: 'Cache flushed',
    cleared
  });
});
router.get('/jobs', async (req, res) => {
  try {
    const jobs = await jobRegistry.getJobsStatus();
    res.json({
      jobs
    });
  } catch {
    res.status(500).json({
      message: 'Failed to load background jobs'
    });
  }
});
router.get('/jobs/:key/history', async (req, res) => {
  try {
    const BackgroundJobRun = require('../models/BackgroundJobRun');
    const runs = await BackgroundJobRun.find({
      key: req.params.key
    }).sort({
      createdAt: -1
    }).limit(50);
    res.json({
      runs
    });
  } catch {
    res.status(500).json({
      message: 'Failed to load job history'
    });
  }
});
router.post('/jobs/:key/run', async (req, res) => {
  try {
    const result = await jobRegistry.runJob(req.params.key, 'manual');
    await logActivity(req, 'superadmin.job_run', {
      message: `Manually ran job "${req.params.key}"`,
      meta: result
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({
      message: err.message || 'Job failed'
    });
  }
});
router.get('/storage', async (req, res) => {
  try {
    const backups = dirSize(BACKUP_DIR);
    let dbStorageMb = null;
    if (mongoose.connection.readyState === 1) {
      const stats = await mongoose.connection.db.stats();
      dbStorageMb = Math.round(stats.storageSize / 1024 / 1024 * 100) / 100;
    }
    res.json({
      backups: {
        sizeMb: Math.round(backups.bytes / 1024 / 1024 * 100) / 100,
        files: backups.files,
        path: BACKUP_DIR
      },
      database: {
        storageSizeMb: dbStorageMb
      },
      diskFree: (() => {
        try {
          const stat = fs.statfsSync ? fs.statfsSync(BACKUP_DIR) : null;
          if (!stat) return null;
          return {
            freeGb: Math.round(stat.bfree * stat.bsize / 1024 / 1024 / 1024 * 100) / 100
          };
        } catch {
          return null;
        }
      })()
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to load storage info'
    });
  }
});
router.get('/config', async (req, res) => {
  try {
    const maintenance = await MaintenanceMode.findOneAndUpdate({
      key: 'singleton'
    }, {}, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true
    });
    res.json({
      maintenanceMode: {
        enabled: maintenance.enabled,
        message: maintenance.message,
        updatedAt: maintenance.updatedAt
      },
      environment: {
        nodeEnv: process.env.NODE_ENV || 'development',
        nodeVersion: process.version,
        port: process.env.PORT || 5000,
        clientUrl: process.env.CLIENT_URL || 'http://localhost:3000',
        autoBackupIntervalHours: Number(process.env.AUTO_BACKUP_INTERVAL_HOURS) || 24
      }
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to load configuration'
    });
  }
});
router.put('/config/maintenance', async (req, res) => {
  try {
    const {
      enabled,
      message
    } = req.body;
    const update = {
      updatedBy: req.user._id
    };
    if (enabled !== undefined) update.enabled = !!enabled;
    if (message !== undefined) update.message = message;
    const maintenance = await MaintenanceMode.findOneAndUpdate({
      key: 'singleton'
    }, update, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true
    });
    await logActivity(req, enabled ? 'superadmin.maintenance_enabled' : 'superadmin.maintenance_disabled', {
      message: `Maintenance mode ${enabled ? 'enabled' : 'disabled'}`
    });
    if (enabled) {
      await SystemAlert.create({
        severity: 'warning',
        source: 'maintenance',
        title: 'Maintenance mode enabled',
        message: `All non-Super-Admin traffic is now blocked: "${maintenance.message}"`
      });
    }
    res.json({
      maintenanceMode: maintenance
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to update maintenance mode'
    });
  }
});
router.get('/devtools', async (req, res) => {
  try {
    const backendPkg = require('../../package.json');
    const frontendPkgPath = path.join(__dirname, '..', '..', '..', 'ums-frontend', 'package.json');
    let frontendVersion = null,
      reactVersion = null;
    if (fs.existsSync(frontendPkgPath)) {
      const frontendPkg = JSON.parse(fs.readFileSync(frontendPkgPath, 'utf-8'));
      frontendVersion = frontendPkg.version;
      reactVersion = frontendPkg.dependencies?.react;
    }
    res.json({
      backend: {
        version: backendPkg.version,
        node: process.version,
        dependencies: backendPkg.dependencies
      },
      frontend: {
        version: frontendVersion,
        react: reactVersion
      },
      featureFlags: await FeatureFlag.find().select('key label enabled')
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to load developer diagnostics'
    });
  }
});
module.exports = router;
