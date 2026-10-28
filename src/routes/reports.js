const mongoose = require('mongoose');
const express = require('express');
const Application = require('../models/Application');
const Inquiry = require('../models/Inquiry');
const Country = require('../models/Country');
const TestPrepRecord = require('../models/TestPrepRecord');
const TestType = require('../models/TestType');
const AssociateDetail = require('../models/AssociateDetail');
const FieldConfig = require('../models/FieldConfig');
const { LEVEL_DEFAULTS } = require('../utils/configRegistry');
const {
  verifyAccess,
  requireTestPrepAccess,
  requirePermission
} = require('../middleware/auth');
const {
  requireFeatureEnabled
} = require('../middleware/featureGate');
const router = express.Router();
router.use(verifyAccess);
router.use(requirePermission('reports', 'access'));
router.use(requirePermission('reports', 'view'));
const MONTH_ABBR = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function emptyApplicationTotals() {
  return {
    totalProcessed: 0,
    offerReceived: 0,
    withdraw: 0,
    visaLodgement: 0,
    visaWaiting: 0,
    visaGranted: 0,
    visaRejected: 0,
    refundReceived: 0,
    refundProcessing: 0,
    paymentComplete: 0,
    paymentIncomplete: 0
  };
}
function ciEq(fieldPath, value) {
  return {
    $eq: [{
      $toLower: {
        $trim: {
          input: {
            $ifNull: [fieldPath, '']
          }
        }
      }
    }, value.toLowerCase()]
  };
}
function hasValue(fieldPath) {
  return {
    $ne: [{
      $ifNull: [fieldPath, '']
    }, '']
  };
}
function intakeSortKey(str) {
  const m = /^([A-Za-z]{3,})\s+(\d{4})$/.exec(String(str || '').trim());
  if (!m) return null;
  const idx = MONTH_ABBR.indexOf(m[1].slice(0, 3).toLowerCase());
  if (idx === -1) return null;
  return Number(m[2]) * 12 + idx;
}
function sortIntakes(values) {
  return [...values].sort((a, b) => {
    const ka = intakeSortKey(a);
    const kb = intakeSortKey(b);
    if (ka !== null && kb !== null) return ka - kb;
    if (ka !== null) return -1;
    if (kb !== null) return 1;
    return String(a).localeCompare(String(b));
  });
}
function splitParam(val) {
  if (!val) return [];
  return String(val).split(',').map(s => s.trim()).filter(Boolean);
}
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function associateMatch(fieldName, value) {
  const v = String(value || '').trim();
  if (!v) return null;
  return {
    [fieldName]: {
      $regex: `^${escapeRegex(v)}$`,
      $options: 'i'
    }
  };
}
function valueBreakdownGroupStage(fieldPath, emptyLabel = 'Not Set') {
  return {
    $group: {
      _id: {
        $let: {
          vars: {
            trimmed: {
              $trim: {
                input: {
                  $ifNull: [fieldPath, '']
                }
              }
            }
          },
          in: {
            $cond: [{
              $eq: ['$$trimmed', '']
            }, emptyLabel, '$$trimmed']
          }
        }
      },
      count: {
        $sum: 1
      }
    }
  };
}
router.get('/applications', async (req, res) => {
  try {
    const {
      dateFrom,
      dateTo,
      country,
      intake,
      associate,
      paymentStatus
    } = req.query;
    const match = {};
    if (dateFrom || dateTo) {
      match.date = {};
      if (dateFrom) {
        const from = new Date(dateFrom);
        from.setHours(0, 0, 0, 0);
        match.date.$gte = from;
      }
      if (dateTo) {
        const to = new Date(dateTo);
        to.setHours(23, 59, 59, 999);
        match.date.$lte = to;
      }
    }
    const requestedIntakes = splitParam(intake);
    if (requestedIntakes.length) {
      match.initialIntake = {
        $in: requestedIntakes
      };
    }
    const associateFilter = associateMatch('referredBy', associate);
    if (associateFilter) Object.assign(match, associateFilter);
    if (paymentStatus === 'complete') {
      match.payment = {
        $nin: [null, '', undefined]
      };
      match.$expr = {
        $gt: [{
          $strLenCP: {
            $trim: {
              input: {
                $ifNull: ['$payment', '']
              }
            }
          }
        }, 0]
      };
    } else if (paymentStatus === 'incomplete') {
      match.$or = [{
        payment: {
          $exists: false
        }
      }, {
        payment: null
      }, {
        payment: ''
      }];
    }
    const isPrivileged = true;
    let allowedIds = isPrivileged ? null : (req.user.countries || []).map(c => c.toString());
    const requestedCountries = splitParam(country).filter(id => mongoose.Types.ObjectId.isValid(id));
    if (requestedCountries.length) {
      allowedIds = allowedIds ? allowedIds.filter(id => requestedCountries.includes(id)) : requestedCountries;
    }
    const scopedCountryQuery = allowedIds ? {
      _id: {
        $in: allowedIds
      }
    } : {};
    const scopedForOptions = isPrivileged ? {} : {
      country: {
        $in: (req.user.countries || []).map(id => new mongoose.Types.ObjectId(id.toString()))
      }
    };
    const [filterCountries, allIntakesRaw, allAssociatesRaw] = await Promise.all([Country.find(isPrivileged ? {} : {
      _id: {
        $in: req.user.countries || []
      }
    }).select('name flag flagImage').sort({
      name: 1
    }), Application.distinct('initialIntake', scopedForOptions), Application.distinct('referredBy', scopedForOptions)]);
    const filterIntakes = sortIntakes(allIntakesRaw.filter(Boolean));
    const filterAssociates = [...new Set(allAssociatesRaw.map(a => (a || '').trim()).filter(Boolean))].sort();
    if (allowedIds && allowedIds.length === 0) {
      return res.json({
        countries: [],
        grandTotal: emptyApplicationTotals(),
        filters: {
          dateFrom: dateFrom || null,
          dateTo: dateTo || null,
          country: requestedCountries,
          intake: requestedIntakes,
          associate: associate || '',
          paymentStatus: paymentStatus || ''
        },
        filterOptions: {
          countries: filterCountries,
          intakes: filterIntakes,
          associates: filterAssociates
        }
      });
    }
    if (allowedIds) {
      match.country = {
        $in: allowedIds.map(id => new mongoose.Types.ObjectId(id))
      };
    }
    const countries = await Country.find(scopedCountryQuery).sort({
      name: 1
    });
    const rows = await Application.aggregate([{
      $match: match
    }, {
      $group: {
        _id: '$country',
        totalProcessed: {
          $sum: 1
        },
        offerReceived: {
          $sum: {
            $cond: [ciEq('$offerLetter', 'received'), 1, 0]
          }
        },
        withdraw: {
          $sum: {
            $cond: [ciEq('$withdraw', 'yes'), 1, 0]
          }
        },
        visaLodgement: {
          $sum: {
            $cond: [{
              $or: [hasValue('$visaLodgement'), hasValue('$visaOutcome')]
            }, 1, 0]
          }
        },
        visaGranted: {
          $sum: {
            $cond: [ciEq('$visaOutcome', 'grant'), 1, 0]
          }
        },
        visaWaiting: {
          $sum: {
            $cond: [ciEq('$visaOutcome', 'waiting'), 1, 0]
          }
        },
        visaRejected: {
          $sum: {
            $cond: [ciEq('$visaOutcome', 'rejected'), 1, 0]
          }
        },
        refundReceived: {
          $sum: {
            $cond: [ciEq('$refund', 'received'), 1, 0]
          }
        },
        refundProcessing: {
          $sum: {
            $cond: [ciEq('$refund', 'processing'), 1, 0]
          }
        },
        paymentComplete: {
          $sum: {
            $cond: [{
              $and: [hasValue('$payment'), {
                $not: [{
                  $regexMatch: {
                    input: {
                      $ifNull: ['$payment', '']
                    },
                    regex: 'incomplete',
                    options: 'i'
                  }
                }]
              }]
            }, 1, 0]
          }
        },
        paymentIncomplete: {
          $sum: {
            $cond: [{
              $or: [{
                $not: [hasValue('$payment')]
              }, {
                $regexMatch: {
                  input: {
                    $ifNull: ['$payment', '']
                  },
                  regex: 'incomplete',
                  options: 'i'
                }
              }]
            }, 1, 0]
          }
        }
      }
    }]);
    const rowMap = new Map(rows.map(r => [String(r._id), r]));
    const countryReports = countries.map(c => {
      const r = rowMap.get(String(c._id));
      return {
        countryId: c._id,
        countryName: c.name,
        flag: c.flag,
        flagImage: c.flagImage,
        totalProcessed: r?.totalProcessed || 0,
        offerReceived: r?.offerReceived || 0,
        withdraw: r?.withdraw || 0,
        visaLodgement: r?.visaLodgement || 0,
        visaWaiting: r?.visaWaiting || 0,
        visaGranted: r?.visaGranted || 0,
        visaRejected: r?.visaRejected || 0,
        refundReceived: r?.refundReceived || 0,
        refundProcessing: r?.refundProcessing || 0,
        paymentComplete: r?.paymentComplete || 0,
        paymentIncomplete: r?.paymentIncomplete || 0
      };
    }).sort((a, b) => a.countryName.localeCompare(b.countryName));
    const grandTotal = countryReports.reduce((acc, c) => {
      Object.keys(acc).forEach(key => {
        acc[key] += c[key] || 0;
      });
      return acc;
    }, emptyApplicationTotals());
    res.json({
      countries: countryReports,
      grandTotal,
      filters: {
        dateFrom: dateFrom || null,
        dateTo: dateTo || null,
        country: requestedCountries,
        intake: requestedIntakes,
        associate: associate || '',
        paymentStatus: paymentStatus || ''
      },
      filterOptions: {
        countries: filterCountries,
        intakes: filterIntakes,
        associates: filterAssociates
      }
    });
  } catch (err) {
    console.error('Report generation error:', err);
    res.status(500).json({
      message: 'Failed to generate report'
    });
  }
});
function normKey(v) {
  return String(v || '').toLowerCase().replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim();
}
router.get('/associates', async (req, res) => {
  try {
    const {
      dateFrom,
      dateTo,
      country,
      intake,
      level,
      search
    } = req.query;
    const match = {};
    if (dateFrom || dateTo) {
      match.visaLodgement = {};
      if (dateFrom) {
        const from = new Date(dateFrom);
        from.setHours(0, 0, 0, 0);
        match.visaLodgement.$gte = from;
      }
      if (dateTo) {
        const to = new Date(dateTo);
        to.setHours(23, 59, 59, 999);
        match.visaLodgement.$lte = to;
      }
    }
    const requestedIntakes = splitParam(intake);
    if (requestedIntakes.length) match.initialIntake = {
      $in: requestedIntakes
    };
    const requestedCountries = splitParam(country).filter(id => mongoose.Types.ObjectId.isValid(id));
    if (requestedCountries.length) match.country = {
      $in: requestedCountries.map(id => new mongoose.Types.ObjectId(id))
    };
    const requestedLevels = splitParam(level).map(normKey);
    const levelCfg = await FieldConfig.findOne({
      kind: 'options',
      fieldKey: 'level'
    }).lean();
    const removedLevels = (levelCfg?.removedDefaults || []).map(normKey);
    const levelCanon = new Map();
    LEVEL_DEFAULTS.filter(d => !removedLevels.includes(normKey(d))).concat(levelCfg?.options || []).forEach(l => {
      if (!levelCanon.has(normKey(l))) levelCanon.set(normKey(l), String(l).trim());
    });
    const canonLevel = raw => {
      const k = normKey(raw);
      if (!k) return '';
      if (!levelCanon.has(k)) levelCanon.set(k, String(raw).replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim());
      return levelCanon.get(k);
    };
    const [allCountries, intakesRaw, levelsRaw, apps, associateDocs] = await Promise.all([Country.find({}).select('name flag flagImage').sort({
      name: 1
    }).lean(), Application.distinct('initialIntake'), Application.distinct('level'), Application.find(match).select('country referredBy level universities visaOutcome').lean(), AssociateDetail.find({}).select('consultancyName aliases status').lean()]);
    const assocCanon = new Map();
    const assocStatus = new Map();
    const assocKey = v => String(v || '').toLowerCase().replace(/[\s,.]+/g, ' ').trim();
    associateDocs.forEach(d => {
      const nm = String(d.consultancyName || '').replace(/\s+/g, ' ').trim();
      if (!nm) return;
      assocStatus.set(nm, ({ shareholder: 'Shareholder', terminated: 'Terminated', closed: 'Closed', inactive: 'Closed' })[String(d.status || '').toLowerCase()] || 'Associate');
      [nm, ...(d.aliases || [])].forEach(x => {
        const k = assocKey(x);
        if (k && !assocCanon.has(k)) assocCanon.set(k, nm);
      });
    });
    const countryMap = new Map(allCountries.map(c => [String(c._id), c]));
    const levelOf = a => {
      const direct = canonLevel(a.level);
      if (direct) return direct;
      const fromUni = (a.universities || []).map(u => canonLevel(u.level)).find(Boolean);
      return fromUni || 'Not Set';
    };
    const levelOptionSet = new Set(levelsRaw.map(canonLevel).filter(Boolean));
    const needle = String(search || '').trim().toLowerCase();
    const assocMap = new Map();
    const countryTopMap = new Map();
    let totalApplications = 0;
    let totalGranted = 0;
    apps.forEach(a => {
      const lv = levelOf(a);
      if (requestedLevels.length && !requestedLevels.includes(normKey(lv))) return;
      const rawName = String(a.referredBy || '').replace(/\s+/g, ' ').trim();
      const name = rawName ? assocCanon.get(assocKey(rawName)) : '';
      if (!name) return;
      if (needle && !name.toLowerCase().includes(needle)) return;
      const key = normKey(name);
      const granted = String(a.visaOutcome || '').trim().toLowerCase() === 'grant';
      const rejected = String(a.visaOutcome || '').trim().toLowerCase() === 'rejected';
      const waiting = String(a.visaOutcome || '').trim().toLowerCase() === 'waiting';
      const cid = String(a.country);
      if (!assocMap.has(key)) assocMap.set(key, {
        associate: name,
        total: 0,
        visaGranted: 0,
        visaRejected: 0,
        visaWaiting: 0,
        byCountry: new Map(),
        byLevel: new Map()
      });
      const row = assocMap.get(key);
      row.total += 1;
      totalApplications += 1;
      if (granted) {
        row.visaGranted += 1;
        totalGranted += 1;
      }
      if (rejected) row.visaRejected += 1;
      if (waiting) row.visaWaiting += 1;
      const cEntry = row.byCountry.get(cid) || {
        total: 0,
        granted: 0
      };
      cEntry.total += 1;
      if (granted) cEntry.granted += 1;
      row.byCountry.set(cid, cEntry);
      const lEntry = row.byLevel.get(lv) || {
        total: 0,
        granted: 0
      };
      lEntry.total += 1;
      if (granted) lEntry.granted += 1;
      row.byLevel.set(lv, lEntry);
      if (granted) {
        const perCountry = countryTopMap.get(cid) || new Map();
        perCountry.set(key, (perCountry.get(key) || 0) + 1);
        countryTopMap.set(cid, perCountry);
      }
      levelOptionSet.add(lv);
    });
    const usedCountryIds = new Set();
    const usedLevels = new Set();
    const associates = [...assocMap.values()].map(r => {
      const byCountry = [...r.byCountry.entries()].map(([cid, v]) => {
        usedCountryIds.add(cid);
        const c = countryMap.get(cid);
        return {
          countryId: cid,
          countryName: c ? c.name : 'Unknown',
          total: v.total,
          granted: v.granted
        };
      }).sort((a, b) => b.granted - a.granted || b.total - a.total);
      const byLevel = [...r.byLevel.entries()].map(([lv, v]) => {
        usedLevels.add(lv);
        return {
          level: lv,
          total: v.total,
          granted: v.granted
        };
      }).sort((a, b) => b.granted - a.granted || b.total - a.total);
      return {
        associate: r.associate,
        status: assocStatus.get(r.associate) || 'Associate',
        total: r.total,
        visaGranted: r.visaGranted,
        visaRejected: r.visaRejected,
        visaWaiting: r.visaWaiting,
        grantRate: r.total ? Math.round(r.visaGranted / r.total * 1000) / 10 : 0,
        byCountry,
        byLevel
      };
    }).sort((a, b) => b.visaGranted - a.visaGranted || b.total - a.total || a.associate.localeCompare(b.associate));
    associates.forEach((r, i) => {
      r.rank = i + 1;
    });
    const countryColumns = [...usedCountryIds].map(cid => {
      const c = countryMap.get(cid);
      return {
        countryId: cid,
        countryName: c ? c.name : 'Unknown',
        flag: c ? c.flag : '',
        flagImage: c ? c.flagImage : ''
      };
    }).sort((a, b) => a.countryName.localeCompare(b.countryName));
    const levelColumns = [...usedLevels].sort((a, b) => a.localeCompare(b));
    const topByCountry = countryColumns.map(c => {
      const perCountry = countryTopMap.get(c.countryId);
      if (!perCountry || perCountry.size === 0) return {
        ...c,
        topAssociate: '',
        granted: 0
      };
      const [topKey, topCount] = [...perCountry.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      return {
        ...c,
        topAssociate: assocMap.get(topKey).associate,
        granted: topCount
      };
    });
    res.json({
      associates,
      countryColumns,
      levelColumns,
      topByCountry,
      totals: {
        associates: associates.length,
        applications: totalApplications,
        visaGranted: totalGranted
      },
      filters: {
        dateFrom: dateFrom || null,
        dateTo: dateTo || null,
        country: requestedCountries,
        intake: requestedIntakes,
        level: splitParam(level),
        search: search || ''
      },
      filterOptions: {
        countries: allCountries,
        intakes: sortIntakes(intakesRaw.filter(Boolean)),
        levels: [...levelOptionSet].sort((a, b) => a.localeCompare(b))
      }
    });
  } catch (err) {
    console.error('Associate report error:', err);
    res.status(500).json({
      message: 'Failed to generate associate report'
    });
  }
});
router.get('/inquiries', requireFeatureEnabled('inquiries'), async (req, res) => {
  try {
    const {
      dateFrom,
      dateTo,
      country,
      level,
      associate
    } = req.query;
    const match = {};
    if (dateFrom || dateTo) {
      match.date = {};
      if (dateFrom) {
        const from = new Date(dateFrom);
        from.setHours(0, 0, 0, 0);
        match.date.$gte = from;
      }
      if (dateTo) {
        const to = new Date(dateTo);
        to.setHours(23, 59, 59, 999);
        match.date.$lte = to;
      }
    }
    const requestedCountries = splitParam(country);
    const requestedLevels = splitParam(level);
    if (requestedCountries.length) match.country = {
      $in: requestedCountries
    };
    if (requestedLevels.length) match.level = {
      $in: requestedLevels
    };
    const associateFilter = associateMatch('referredBy', associate);
    if (associateFilter) Object.assign(match, associateFilter);
    const [totalInquiries, byCountryRaw, byLevelRaw, filterCountriesRaw, filterLevelsRaw, filterAssociatesRaw] = await Promise.all([Inquiry.countDocuments(match), Inquiry.aggregate([{
      $match: match
    }, {
      $addFields: {
        countryList: {
          $cond: [{
            $isArray: '$country'
          }, '$country', {
            $cond: [{
              $or: [{
                $eq: ['$country', null]
              }, {
                $eq: ['$country', '']
              }]
            }, [], {
              $split: [{
                $ifNull: ['$country', '']
              }, ',']
            }]
          }]
        }
      }
    }, {
      $unwind: {
        path: '$countryList',
        preserveNullAndEmptyArrays: true
      }
    }, {
      $group: {
        _id: {
          $let: {
            vars: {
              trimmed: {
                $trim: {
                  input: {
                    $ifNull: ['$countryList', '']
                  }
                }
              }
            },
            in: {
              $cond: [{
                $eq: ['$$trimmed', '']
              }, 'Unspecified', '$$trimmed']
            }
          }
        },
        count: {
          $sum: 1
        }
      }
    }, {
      $sort: {
        _id: 1
      }
    }]), Inquiry.aggregate([{
      $match: match
    }, {
      $group: {
        _id: {
          $let: {
            vars: {
              trimmed: {
                $trim: {
                  input: {
                    $ifNull: ['$level', '']
                  }
                }
              }
            },
            in: {
              $cond: [{
                $eq: ['$$trimmed', '']
              }, 'Unspecified', '$$trimmed']
            }
          }
        },
        count: {
          $sum: 1
        }
      }
    }, {
      $sort: {
        _id: 1
      }
    }]), Inquiry.distinct('country'), Inquiry.distinct('level'), Inquiry.distinct('referredBy')]);
    const countryWise = byCountryRaw.map(r => ({
      country: r._id,
      count: r.count
    }));
    const levelWise = byLevelRaw.map(r => ({
      level: r._id,
      count: r.count
    }));
    const filterOptions = {
      countries: [...new Set(filterCountriesRaw.map(c => (c || '').trim()).filter(Boolean))].sort(),
      levels: [...new Set(filterLevelsRaw.map(l => (l || '').trim()).filter(Boolean))].sort(),
      associates: [...new Set(filterAssociatesRaw.map(a => (a || '').trim()).filter(Boolean))].sort()
    };
    res.json({
      totalInquiries,
      countries: countryWise,
      levels: levelWise,
      filters: {
        dateFrom: dateFrom || null,
        dateTo: dateTo || null,
        country: requestedCountries,
        level: requestedLevels,
        associate: associate || ''
      },
      filterOptions
    });
  } catch (err) {
    console.error('Inquiry report generation error:', err);
    res.status(500).json({
      message: 'Failed to generate inquiry report'
    });
  }
});
router.get('/test-prep', requireFeatureEnabled('testPreparation'), requireTestPrepAccess, async (req, res) => {
  try {
    const {
      dateFrom,
      dateTo,
      examType,
      associate
    } = req.query;
    const match = {};
    if (dateFrom || dateTo) {
      match.date = {};
      if (dateFrom) {
        const from = new Date(dateFrom);
        from.setHours(0, 0, 0, 0);
        match.date.$gte = from;
      }
      if (dateTo) {
        const to = new Date(dateTo);
        to.setHours(23, 59, 59, 999);
        match.date.$lte = to;
      }
    }
    const requestedExamTypes = splitParam(examType).filter(id => mongoose.Types.ObjectId.isValid(id));
    if (requestedExamTypes.length) {
      match.testType = {
        $in: requestedExamTypes.map(id => new mongoose.Types.ObjectId(id))
      };
    }
    const associateFilter = associateMatch('associates', associate);
    if (associateFilter) Object.assign(match, associateFilter);
    const [totalBookings, byExamTypeRaw, dateBounds, allTestTypes, allAssociatesRaw] = await Promise.all([TestPrepRecord.countDocuments(match), TestPrepRecord.aggregate([{
      $match: match
    }, {
      $group: {
        _id: '$testType',
        count: {
          $sum: 1
        }
      }
    }]), TestPrepRecord.aggregate([{
      $match: match
    }, {
      $group: {
        _id: null,
        earliest: {
          $min: '$date'
        },
        latest: {
          $max: '$date'
        }
      }
    }]), TestType.find().sort({
      order: 1,
      name: 1
    }), TestPrepRecord.distinct('associates')]);
    const countByType = new Map(byExamTypeRaw.map(r => [String(r._id), r.count]));
    const examTypeBreakdown = allTestTypes.map(t => ({
      testTypeId: t._id,
      testTypeName: t.name,
      slug: t.slug,
      count: countByType.get(String(t._id)) || 0
    }));
    const knownIds = new Set(allTestTypes.map(t => String(t._id)));
    byExamTypeRaw.forEach(r => {
      if (!knownIds.has(String(r._id))) {
        examTypeBreakdown.push({
          testTypeId: r._id,
          testTypeName: 'Unknown',
          slug: '',
          count: r.count
        });
      }
    });
    const pteTestTypes = allTestTypes.filter(t => /^pte$/i.test(t.slug) || /^pte$/i.test(t.name));
    let pteBonusVoucherCount = 0;
    if (pteTestTypes.length) {
      const pteTypeIds = pteTestTypes.map(t => t._id);
      const pteBaseMatch = {
        ...match,
        testType: {
          $in: pteTypeIds
        }
      };
      pteBonusVoucherCount = await TestPrepRecord.countDocuments({
        ...pteBaseMatch,
        voucher: 'Bonus Voucher'
      });
    }
    const filterAssociates = [...new Set(allAssociatesRaw.map(a => (a || '').trim()).filter(Boolean))].sort();
    res.json({
      totalBookings,
      examTypeBreakdown,
      pteBonusVoucherCount,
      dateRange: {
        earliest: dateBounds[0]?.earliest || null,
        latest: dateBounds[0]?.latest || null
      },
      filters: {
        dateFrom: dateFrom || null,
        dateTo: dateTo || null,
        examType: requestedExamTypes,
        associate: associate || ''
      },
      filterOptions: {
        examTypes: allTestTypes.map(t => ({
          _id: t._id,
          name: t.name,
          slug: t.slug
        })),
        associates: filterAssociates
      }
    });
  } catch (err) {
    console.error('Test prep report generation error:', err);
    res.status(500).json({
      message: 'Failed to generate test preparation report'
    });
  }
});
module.exports = router;
