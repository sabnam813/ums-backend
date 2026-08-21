const mongoose = require('mongoose');
const express = require('express');
const Application = require('../models/Application');
const Inquiry = require('../models/Inquiry');
const Country = require('../models/Country');
const TestPrepRecord = require('../models/TestPrepRecord');
const TestType = require('../models/TestType');
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
      // country can be a real array (new data) or a legacy single string —
      // possibly a comma-joined list from before multi-country support.
      // Normalize to an array, splitting legacy comma strings, before unwinding
      // so each country is counted individually instead of as one combined group.
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
