const mongoose = require('mongoose');
const express = require('express');
const Application = require('../models/Application');
const Country = require('../models/Country');
const User = require('../models/User');
const {
  verifyAccess,
  requireAdmin,
  requirePermission
} = require('../middleware/auth');
const {
  requireFeatureEnabled
} = require('../middleware/featureGate');
const {
  softDelete
} = require('../utils/trashHelper');
const {
  bulkInsertWithReport
} = require('../utils/bulkImportHelper');
const router = express.Router();
router.use(verifyAccess);
async function checkCountryAccess(req, res, countryId) {
  if (['admin', 'super_admin'].includes(req.user.role)) return true;
  const allowed = req.user.countries.map(c => c.toString());
  if (!allowed.includes(countryId)) {
    res.status(403).json({
      message: 'Access denied to this country'
    });
    return false;
  }
  return true;
}
router.get('/stats/overview', requireAdmin, async (req, res) => {
  try {
    const {
      dateFrom,
      dateTo
    } = req.query;
    const dateFilter = {};
    if (dateFrom || dateTo) {
      dateFilter.date = {};
      if (dateFrom) dateFilter.date.$gte = new Date(dateFrom);
      if (dateTo) dateFilter.date.$lte = new Date(dateTo);
    }
    const [totalApplications, countriesActive, countryUsers, offered, paid] = await Promise.all([Application.countDocuments({
      ...dateFilter
    }), Country.countDocuments({
      status: 'active'
    }), User.countDocuments({
      role: 'user'
    }), Application.countDocuments({
      ...dateFilter,
      offerLetter: 'Received'
    }), Application.countDocuments({
      ...dateFilter,
      payment: 'Complete'
    })]);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const newThisWeek = await Application.countDocuments({
      createdAt: {
        $gte: sevenDaysAgo
      }
    });
    const recent = await Application.find({
      ...dateFilter
    }).sort({
      updatedAt: -1
    }).limit(8).populate('country', 'name flag').populate('createdBy', 'username name');
    const recentActivity = recent.map(a => ({
      id: a._id,
      action: a.createdAt.getTime() === a.updatedAt.getTime() ? 'New application added' : 'Application updated',
      country: a.country ? `${a.country.flag || ''} ${a.country.name}`.trim() : '—',
      user: a.createdBy?.username || a.createdBy?.name || '—',
      time: a.updatedAt
    }));
    res.json({
      stats: {
        totalApplications,
        countriesActive,
        countryUsers,
        offered,
        paid,
        newThisWeek,
        conversionRate: totalApplications > 0 ? Math.round(offered / totalApplications * 100) : 0
      },
      recentActivity
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to fetch stats'
    });
  }
});
async function buildAnalytics(match, dateFilter = {}) {
  const safeMatch = {
    ...match,
    ...dateFilter
  };
  if (safeMatch.country && !(safeMatch.country instanceof mongoose.Types.ObjectId)) {
    if (!mongoose.Types.ObjectId.isValid(safeMatch.country)) {
      return {
        total: 0,
        byLevel: {},
        byOffer: {},
        byPayment: {},
        byVisa: {},
        monthly: []
      };
    }
    safeMatch.country = new mongoose.Types.ObjectId(safeMatch.country);
  }
  const match_ = safeMatch;
  const [byLevel, byOffer, byPayment, byVisa, total] = await Promise.all([Application.aggregate([{
    $match: match_
  }, {
    $group: {
      _id: '$level',
      count: {
        $sum: 1
      }
    }
  }]), Application.aggregate([{
    $match: match_
  }, {
    $group: {
      _id: '$offerLetter',
      count: {
        $sum: 1
      }
    }
  }]), Application.aggregate([{
    $match: match_
  }, {
    $group: {
      _id: '$payment',
      count: {
        $sum: 1
      }
    }
  }]), Application.aggregate([{
    $match: match_
  }, {
    $group: {
      _id: '$visaOutcome',
      count: {
        $sum: 1
      }
    }
  }]), Application.countDocuments(match_)]);
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
  sixMonthsAgo.setDate(1);
  sixMonthsAgo.setHours(0, 0, 0, 0);
  const monthlyRaw = await Application.aggregate([{
    $match: {
      ...match_,
      createdAt: {
        $gte: sixMonthsAgo
      }
    }
  }, {
    $group: {
      _id: {
        y: {
          $year: '$createdAt'
        },
        m: {
          $month: '$createdAt'
        }
      },
      count: {
        $sum: 1
      }
    }
  }]);
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthly = [];
  const cursor = new Date(sixMonthsAgo);
  for (let i = 0; i < 6; i++) {
    const y = cursor.getFullYear(),
      m = cursor.getMonth() + 1;
    const found = monthlyRaw.find(r => r._id.y === y && r._id.m === m);
    monthly.push({
      label: monthNames[m - 1],
      year: y,
      count: found?.count || 0
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  const toMap = rows => rows.reduce((acc, r) => {
    acc[r._id || 'Unspecified'] = r.count;
    return acc;
  }, {});
  return {
    total,
    byLevel: toMap(byLevel),
    byOffer: toMap(byOffer),
    byPayment: toMap(byPayment),
    byVisa: toMap(byVisa),
    monthly
  };
}
router.get('/stats/analytics', requireAdmin, async (req, res) => {
  try {
    const {
      dateFrom,
      dateTo
    } = req.query;
    const dateFilter = {};
    if (dateFrom || dateTo) {
      dateFilter.date = {};
      if (dateFrom) dateFilter.date.$gte = new Date(dateFrom);
      if (dateTo) dateFilter.date.$lte = new Date(dateTo);
    }
    const overall = await buildAnalytics({}, dateFilter);
    const countries = await Country.find();
    const perCountry = await Promise.all(countries.map(async c => {
      const a = await buildAnalytics({
        country: c._id
      }, dateFilter);
      return {
        countryId: c._id,
        name: c.name,
        flag: c.flag,
        flagImage: c.flagImage,
        total: a.total,
        byOffer: a.byOffer,
        byPayment: a.byPayment
      };
    }));
    const users = await User.find({
      role: 'user'
    }).select('username name countries status');
    const perUser = await Promise.all(users.map(async u => {
      const count = await Application.countDocuments({
        createdBy: u._id
      });
      return {
        userId: u._id,
        username: u.username,
        name: u.name,
        status: u.status,
        countryCount: (u.countries || []).length,
        applicationsLogged: count
      };
    }));
    res.json({
      overall,
      perCountry,
      perUser
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to fetch analytics'
    });
  }
});
router.get('/notifications/recent', requireAdmin, requireFeatureEnabled('notifications'), async (req, res) => {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recent = await Application.find({
      createdAt: {
        $gte: since
      }
    }).sort({
      createdAt: -1
    }).limit(50).populate('country', 'name flag').populate('createdBy', 'username name');
    const notifications = recent.map(a => ({
      id: a._id,
      type: 'new_application',
      message: `New application: ${a.name} (${a.country?.flag || ''} ${a.country?.name || ''})`,
      applicantName: a.name,
      country: a.country ? `${a.country.flag || ''} ${a.country.name}`.trim() : '—',
      addedBy: a.createdBy?.name || a.createdBy?.username || '—',
      time: a.createdAt
    }));
    res.json({
      notifications
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to fetch notifications'
    });
  }
});
router.get('/stats/country/:countryId', async (req, res) => {
  try {
    const {
      countryId
    } = req.params;
    if (!(await checkCountryAccess(req, res, countryId))) return;
    const {
      dateFrom,
      dateTo
    } = req.query;
    const dateFilter = {};
    if (dateFrom || dateTo) {
      dateFilter.date = {};
      if (dateFrom) dateFilter.date.$gte = new Date(dateFrom);
      if (dateTo) dateFilter.date.$lte = new Date(dateTo);
    }
    const analytics = await buildAnalytics({
      country: countryId
    }, dateFilter);
    res.json({
      analytics
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to fetch country analytics'
    });
  }
});
router.get('/:countryId', requirePermission('applications', 'view'), async (req, res) => {
  try {
    const {
      countryId
    } = req.params;
    if (!(await checkCountryAccess(req, res, countryId))) return;
    const {
      search,
      level,
      offerLetter,
      payment,
      visaOutcome,
      savisFee,
      refund,
      dateFrom,
      dateTo,
      provider,
      course,
      limit = 500,
      gsSubmission,
      coeCas,
      olRequest,
      withdraw,
      visaWithdraw
    } = req.query;
    const query = {
      country: countryId
    };
    if (level) query.level = {
      $in: level.split(',')
    };
    if (offerLetter) query.offerLetter = {
      $in: offerLetter.split(',')
    };
    if (payment) query.payment = {
      $in: payment.split(',')
    };
    if (visaOutcome) query.visaOutcome = {
      $in: visaOutcome.split(',')
    };
    if (savisFee) query.savisFee = {
      $in: savisFee.split(',')
    };
    if (refund) query.refund = {
      $in: refund.split(',')
    };
    if (gsSubmission) query.gsSubmission = {
      $in: gsSubmission.split(',')
    };
    if (coeCas) query.coeCas = {
      $in: coeCas.split(',')
    };
    if (olRequest) query.olRequest = {
      $in: olRequest.split(',')
    };
    if (withdraw) query.withdraw = {
      $in: withdraw.split(',')
    };
    if (visaWithdraw) query.visaWithdraw = {
      $in: visaWithdraw.split(',')
    };
    if (dateFrom || dateTo) {
      query.date = {};
      if (dateFrom) query.date.$gte = new Date(dateFrom);
      if (dateTo) query.date.$lte = new Date(dateTo);
    }
    if (provider) query.providerName = new RegExp(provider, 'i');
    if (course) query.course = new RegExp(course, 'i');
    if (search) {
      query.$or = [{
        name: new RegExp(search, 'i')
      }, {
        referredBy: new RegExp(search, 'i')
      }, {
        course: new RegExp(search, 'i')
      }, {
        providerName: new RegExp(search, 'i')
      }, {
        remarks: new RegExp(search, 'i')
      }, {
        through: new RegExp(search, 'i')
      }];
    }
    const [applications, totalInDB] = await Promise.all([Application.find(query).sort({
      date: -1,
      createdAt: -1
    }).limit(Number(limit)), Application.countDocuments(query)]);
    res.json({
      applications,
      total: applications.length,
      returned: applications.length,
      totalInDB
    });
  } catch {
    res.status(500).json({
      message: 'Failed to fetch applications'
    });
  }
});
router.post('/:countryId', requirePermission('applications', 'create'), async (req, res) => {
  try {
    const {
      countryId
    } = req.params;
    if (!(await checkCountryAccess(req, res, countryId))) return;
    const app = await Application.create({
      ...req.body,
      country: countryId,
      createdBy: req.user._id,
      date: req.body.date || new Date()
    });
    req.app.get('io')?.emit('stats_updated', {
      type: 'application_created',
      countryId
    });
    res.status(201).json({
      application: app
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to create application'
    });
  }
});
router.post('/:countryId/bulk/create', requirePermission('applications', 'import'), async (req, res) => {
  try {
    const {
      countryId
    } = req.params;
    if (!(await checkCountryAccess(req, res, countryId))) return;
    const {
      applications
    } = req.body;
    if (!applications || !Array.isArray(applications) || applications.length === 0) {
      return res.status(400).json({
        message: 'No applications provided'
      });
    }
    const appsToCreate = applications.map(app => ({
      ...app,
      country: countryId,
      createdBy: req.user._id,
      date: app.date ? new Date(app.date) : new Date()
    }));
    const {
      insertedDocs,
      failures,
      totalRows,
      successCount,
      failedCount
    } = await bulkInsertWithReport(Application, appsToCreate);
    const namedFailures = failures.map(f => ({
      ...f,
      name: applications[f.row - 1]?.name || '(no name provided)'
    }));
    req.app.get('io')?.emit('stats_updated', {
      type: 'application_bulk_created',
      countryId
    });
    res.status(201).json({
      applications: insertedDocs,
      total: totalRows,
      created: successCount,
      failed: failedCount,
      failures: namedFailures,
      ...(failedCount > 0 && {
        skipped: failedCount,
        warning: `${failedCount} of ${totalRows} row(s) skipped, see 'failures'`
      })
    });
  } catch (err) {
    console.error('Bulk create error:', err);
    res.status(500).json({
      message: 'Failed to bulk create applications'
    });
  }
});
router.put('/:countryId/:id', requirePermission('applications', 'edit'), async (req, res) => {
  try {
    const {
      countryId,
      id
    } = req.params;
    if (!(await checkCountryAccess(req, res, countryId))) return;
    const {
      country,
      createdBy,
      _id,
      ...safeBody
    } = req.body;
    const app = await Application.findOneAndUpdate({
      _id: id,
      country: countryId
    }, safeBody, {
      new: true,
      runValidators: true
    });
    if (!app) return res.status(404).json({
      message: 'Not found'
    });
    req.app.get('io')?.emit('stats_updated', {
      type: 'application_updated',
      countryId
    });
    res.json({
      application: app
    });
  } catch {
    res.status(500).json({
      message: 'Failed to update'
    });
  }
});
router.put('/:countryId/bulk/update', requirePermission('applications', 'bulkEdit'), async (req, res) => {
  try {
    const {
      countryId
    } = req.params;
    if (!(await checkCountryAccess(req, res, countryId))) return;
    const {
      ids,
      updates
    } = req.body;
    if (!ids?.length) return res.status(400).json({
      message: 'No IDs provided'
    });
    const allowedFields = ['level', 'referredBy', 'providerName', 'course', 'universities', 'initialIntake', 'gsSubmission', 'olRequest', 'offerLetter', 'withdraw', 'payment', 'coeCas', 'savisFee', 'refund', 'visaOutcome', 'visaWithdraw', 'remarks', 'other', 'through'];
    const safeUpdates = {};
    allowedFields.forEach(f => {
      if (updates[f] !== undefined) safeUpdates[f] = updates[f];
    });
    if (updates.customFields && typeof updates.customFields === 'object') {
      Object.entries(updates.customFields).forEach(([k, v]) => {
        if (v !== '' && v !== null && v !== undefined) safeUpdates[`customFields.${k}`] = v;
      });
    }
    const result = await Application.updateMany({
      _id: {
        $in: ids
      },
      country: countryId
    }, safeUpdates);
    req.app.get('io')?.emit('stats_updated', {
      type: 'application_bulk_updated',
      countryId
    });
    res.json({
      updated: result.modifiedCount
    });
  } catch {
    res.status(500).json({
      message: 'Bulk update failed'
    });
  }
});
router.delete('/:countryId/:id', requirePermission('applications', 'delete'), async (req, res) => {
  try {
    const {
      countryId,
      id
    } = req.params;
    if (!(await checkCountryAccess(req, res, countryId))) return;
    const app = await Application.findOne({
      _id: id,
      country: countryId
    });
    if (!app) return res.status(404).json({
      message: 'Not found'
    });
    await softDelete({
      modelName: 'Application',
      doc: app,
      userId: req.user._id,
      userName: req.user.name || req.user.username,
      meta: {
        name: app.name,
        country: countryId
      }
    });
    req.app.get('io')?.emit('stats_updated', {
      type: 'application_deleted',
      countryId
    });
    res.json({
      message: 'Moved to trash'
    });
  } catch {
    res.status(500).json({
      message: 'Failed to delete'
    });
  }
});
router.delete('/:countryId/bulk/delete', requirePermission('applications', 'delete'), async (req, res) => {
  try {
    const {
      countryId
    } = req.params;
    if (!(await checkCountryAccess(req, res, countryId))) return;
    const {
      ids
    } = req.body;
    if (!ids?.length) return res.status(400).json({
      message: 'No IDs provided'
    });
    const apps = await Application.find({
      _id: {
        $in: ids
      },
      country: countryId
    });
    for (const app of apps) {
      await softDelete({
        modelName: 'Application',
        doc: app,
        userId: req.user._id,
        userName: req.user.name || req.user.username,
        meta: {
          name: app.name,
          country: countryId
        }
      });
    }
    req.app.get('io')?.emit('stats_updated', {
      type: 'application_bulk_deleted',
      countryId
    });
    res.json({
      deleted: apps.length
    });
  } catch {
    res.status(500).json({
      message: 'Bulk delete failed'
    });
  }
});
module.exports = router;
