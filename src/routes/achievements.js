const express = require('express');
const mongoose = require('mongoose');
const AchievementTarget = require('../models/AchievementTarget');
const Application = require('../models/Application');
const Country = require('../models/Country');
const {
  verifyAccess,
  requirePermission
} = require('../middleware/auth');
const {
  getAuthoritativeMonthRange
} = require('../utils/nepaliMonthDates');
const router = express.Router();
router.use(verifyAccess);
router.use(requirePermission('achievements', 'access'));
function isSuperAdmin(user) {
  return user?.role === 'super_admin';
}
function scopeCountryFilter(req, requestedCountry) {
  if (isSuperAdmin(req.user)) {
    if (requestedCountry && mongoose.isValidObjectId(requestedCountry)) {
      return {
        ok: true,
        filter: {
          country: requestedCountry
        }
      };
    }
    return {
      ok: true,
      filter: {}
    };
  }
  const allowed = (req.user.countries || []).map(c => c.toString());
  if (requestedCountry) {
    if (!allowed.includes(String(requestedCountry))) {
      return {
        ok: false
      };
    }
    return {
      ok: true,
      filter: {
        country: requestedCountry
      }
    };
  }
  return {
    ok: true,
    filter: {
      country: {
        $in: allowed
      }
    }
  };
}
function canManageCountry(user, countryId) {
  if (isSuperAdmin(user)) return true;
  const allowed = (user.countries || []).map(c => c.toString());
  return allowed.includes(String(countryId));
}
const NEPALI_MONTHS = AchievementTarget.NEPALI_MONTHS;
const STAGES = AchievementTarget.STAGES;
const QUARTER_MAP = {
  Shrawan: 'Q1',
  Bhadra: 'Q1',
  Ashoj: 'Q1',
  Kartik: 'Q2',
  Mangsir: 'Q2',
  Poush: 'Q2',
  Magh: 'Q3',
  Falgun: 'Q3',
  Chaitra: 'Q3',
  Baishakh: 'Q4',
  Jestha: 'Q4',
  Ashadh: 'Q4'
};
const QUARTER_MONTHS = {
  Q1: ['Shrawan', 'Bhadra', 'Ashoj'],
  Q2: ['Kartik', 'Mangsir', 'Poush'],
  Q3: ['Magh', 'Falgun', 'Chaitra'],
  Q4: ['Baishakh', 'Jestha', 'Ashadh']
};
function computeQuarter(nepaliMonth) {
  return QUARTER_MAP[nepaliMonth] || null;
}
const STAGE_LABELS = {
  inquiry: 'Inquiry',
  wip: 'GS / WIP / Financial',
  visaLodge: 'Visa Lodge',
  visa: 'Visa'
};
function nonEmpty(field) {
  return {
    [field]: {
      $exists: true,
      $nin: [null, '']
    }
  };
}
function resolveAchievementRange(doc) {
  const authoritative = getAuthoritativeMonthRange(doc.fiscalYear, doc.nepaliMonth);
  if (authoritative) return authoritative;
  return {
    from: doc.fromDate,
    to: doc.toDate
  };
}
async function computeStageAchieved(countryId, fromDate, toDate) {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  const dateInRange = {
    date: {
      $gte: from,
      $lte: to
    }
  };
  const [inquiry, wip, visa] = await Promise.all([Application.countDocuments({
    country: countryId,
    ...dateInRange
  }), Application.countDocuments({
    country: countryId,
    ...dateInRange,
    ...nonEmpty('gsSubmission')
  }), Application.countDocuments({
    country: countryId,
    ...dateInRange,
    ...nonEmpty('visaOutcome')
  })]);
  const visaLodge = await Application.countDocuments({
    country: countryId,
    visaLodgement: {
      $gte: from,
      $lte: to
    }
  });
  return {
    inquiry,
    wip,
    visaLodge,
    visa
  };
}
function toTargetsObj(targets) {
  return {
    inquiry: Number(targets?.inquiry) || 0,
    wip: Number(targets?.wip) || 0,
    visaLodge: Number(targets?.visaLodge) || 0,
    visa: Number(targets?.visa) || 0
  };
}
function pct(achieved, target) {
  return target > 0 ? Math.round(achieved / target * 100) : 0;
}
function computeRatios(achieved) {
  const ratio = (num, den) => den > 0 ? Math.round(num / den * 1000) / 10 : 0;
  return {
    inquiryToWip: ratio(achieved.wip, achieved.inquiry),
    wipToVisaLodge: ratio(achieved.visaLodge, achieved.wip),
    visaLodgeToVisa: ratio(achieved.visa, achieved.visaLodge),
    inquiryToVisa: ratio(achieved.visa, achieved.inquiry)
  };
}
function serializeRow(doc) {
  const targets = toTargetsObj(doc.targets);
  const achieved = doc._achieved;
  const pctAchieved = {
    inquiry: pct(achieved.inquiry, targets.inquiry),
    wip: pct(achieved.wip, targets.wip),
    visaLodge: pct(achieved.visaLodge, targets.visaLodge),
    visa: pct(achieved.visa, targets.visa)
  };
  return {
    ...doc.toObject(),
    targets,
    quarter: computeQuarter(doc.nepaliMonth),
    achieved,
    pctAchieved,
    ratios: computeRatios(achieved),
    target: targets.inquiry,
    achievedTotal: achieved.inquiry
  };
}
router.get('/', async (req, res) => {
  try {
    const {
      fiscalYear,
      quarter,
      country,
      search
    } = req.query;
    const scope = scopeCountryFilter(req, country);
    if (!scope.ok) {
      return res.status(403).json({
        message: 'Access denied to this country'
      });
    }
    const filter = {
      ...scope.filter
    };
    if (fiscalYear) filter.fiscalYear = fiscalYear;
    if (quarter && QUARTER_MONTHS[quarter]) {
      filter.nepaliMonth = {
        $in: QUARTER_MONTHS[quarter]
      };
    }
    let targets = await AchievementTarget.find(filter).populate('country', 'name flag flagImage code').populate('createdBy', 'name username').sort({
      fiscalYear: -1,
      nepaliMonth: 1
    });
    if (search) {
      const q = search.toLowerCase();
      targets = targets.filter(t => t.nepaliMonth.toLowerCase().includes(q) || (t.country?.name || '').toLowerCase().includes(q));
    }
    const results = await Promise.all(targets.map(async t => {
      const range = resolveAchievementRange(t);
      const achieved = await computeStageAchieved(t.country._id, range.from, range.to);
      t._achieved = achieved;
      return serializeRow(t);
    }));
    res.json(results);
  } catch (err) {
    console.error('GET /achievements error:', err);
    res.status(500).json({
      message: err.message
    });
  }
});
router.get('/stages', (req, res) => {
  res.json(STAGES.map(key => ({
    key,
    label: STAGE_LABELS[key]
  })));
});
router.post('/', requirePermission('achievements', 'create'), async (req, res) => {
  try {
    const {
      fiscalYear,
      nepaliMonth,
      fromDate,
      toDate,
      country,
      targets
    } = req.body;
    if (!fiscalYear || !nepaliMonth || !fromDate || !toDate || !country || !targets) {
      return res.status(400).json({
        message: 'fiscalYear, nepaliMonth, fromDate, toDate, country and targets are required.'
      });
    }
    if (!NEPALI_MONTHS.includes(nepaliMonth)) {
      return res.status(400).json({
        message: 'Invalid nepaliMonth.'
      });
    }
    if (!mongoose.isValidObjectId(country)) {
      return res.status(400).json({
        message: 'Invalid country id.'
      });
    }
    if (!canManageCountry(req.user, country)) {
      return res.status(403).json({
        message: 'Access denied to this country'
      });
    }
    const cleanTargets = toTargetsObj(targets);
    let doc = await AchievementTarget.findOne({
      fiscalYear,
      nepaliMonth,
      country
    });
    if (doc) {
      doc.fromDate = fromDate;
      doc.toDate = toDate;
      doc.targets = cleanTargets;
      doc.createdBy = req.user._id;
      await doc.save();
    } else {
      doc = await AchievementTarget.create({
        fiscalYear,
        nepaliMonth,
        fromDate,
        toDate,
        country,
        targets: cleanTargets,
        createdBy: req.user._id
      });
    }
    await doc.populate('country', 'name flag flagImage code');
    const createRange = resolveAchievementRange(doc);
    doc._achieved = await computeStageAchieved(country, createRange.from, createRange.to);
    res.status(201).json(serializeRow(doc));
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        message: 'A target for this month/country/fiscal year already exists.'
      });
    }
    console.error('POST /achievements error:', err);
    res.status(500).json({
      message: err.message
    });
  }
});
router.put('/:id', requirePermission('achievements', 'edit'), async (req, res) => {
  try {
    const {
      fromDate,
      toDate,
      targets,
      fiscalYear,
      nepaliMonth,
      country
    } = req.body;
    const doc = await AchievementTarget.findById(req.params.id);
    if (!doc) return res.status(404).json({
      message: 'Not found.'
    });
    if (!canManageCountry(req.user, doc.country)) {
      return res.status(403).json({
        message: 'Access denied to this country'
      });
    }
    if (country !== undefined && !canManageCountry(req.user, country)) {
      return res.status(403).json({
        message: 'Access denied to this country'
      });
    }
    if (fromDate !== undefined) doc.fromDate = fromDate;
    if (toDate !== undefined) doc.toDate = toDate;
    if (targets !== undefined) {
      doc.targets = toTargetsObj({
        ...toTargetsObj(doc.targets),
        ...targets
      });
    }
    if (fiscalYear !== undefined) doc.fiscalYear = fiscalYear;
    if (nepaliMonth !== undefined) {
      if (!NEPALI_MONTHS.includes(nepaliMonth)) {
        return res.status(400).json({
          message: 'Invalid nepaliMonth.'
        });
      }
      doc.nepaliMonth = nepaliMonth;
    }
    if (country !== undefined) doc.country = country;
    await doc.save();
    await doc.populate('country', 'name flag flagImage code');
    const updateRange = resolveAchievementRange(doc);
    doc._achieved = await computeStageAchieved(doc.country._id, updateRange.from, updateRange.to);
    res.json(serializeRow(doc));
  } catch (err) {
    console.error('PUT /achievements/:id error:', err);
    res.status(500).json({
      message: err.message
    });
  }
});
router.delete('/:id', requirePermission('achievements', 'delete'), async (req, res) => {
  try {
    const existing = await AchievementTarget.findById(req.params.id);
    if (!existing) return res.status(404).json({
      message: 'Not found.'
    });
    if (!canManageCountry(req.user, existing.country)) {
      return res.status(403).json({
        message: 'Access denied to this country'
      });
    }
    const doc = await AchievementTarget.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({
      message: 'Not found.'
    });
    res.json({
      message: 'Deleted.'
    });
  } catch (err) {
    console.error('DELETE /achievements/:id error:', err);
    res.status(500).json({
      message: err.message
    });
  }
});
router.get('/quarterly', async (req, res) => {
  try {
    const {
      fiscalYear,
      quarter,
      country
    } = req.query;
    const scope = scopeCountryFilter(req, country);
    if (!scope.ok) {
      return res.status(403).json({
        message: 'Access denied to this country'
      });
    }
    const filter = {
      ...scope.filter
    };
    if (fiscalYear) filter.fiscalYear = fiscalYear;
    if (quarter && QUARTER_MONTHS[quarter]) {
      filter.nepaliMonth = {
        $in: QUARTER_MONTHS[quarter]
      };
    }
    const targets = await AchievementTarget.find(filter).populate('country', 'name flag flagImage code');
    const byCountryByQuarter = {};
    await Promise.all(targets.map(async t => {
      const q = computeQuarter(t.nepaliMonth);
      const cid = String(t.country._id);
      const key = `${cid}_${q}`;
      if (!byCountryByQuarter[key]) {
        byCountryByQuarter[key] = {
          country: t.country,
          quarter: q,
          fiscalYear: t.fiscalYear,
          totalTargets: {
            inquiry: 0,
            wip: 0,
            visaLodge: 0,
            visa: 0
          },
          totalAchieved: {
            inquiry: 0,
            wip: 0,
            visaLodge: 0,
            visa: 0
          }
        };
      }
      const qRange = resolveAchievementRange(t);
      const achieved = await computeStageAchieved(t.country._id, qRange.from, qRange.to);
      const stageTargets = toTargetsObj(t.targets);
      STAGES.forEach(stage => {
        byCountryByQuarter[key].totalTargets[stage] += stageTargets[stage];
        byCountryByQuarter[key].totalAchieved[stage] += achieved[stage];
      });
    }));
    const results = Object.values(byCountryByQuarter).map(item => ({
      ...item,
      pctAchieved: {
        inquiry: pct(item.totalAchieved.inquiry, item.totalTargets.inquiry),
        wip: pct(item.totalAchieved.wip, item.totalTargets.wip),
        visaLodge: pct(item.totalAchieved.visaLodge, item.totalTargets.visaLodge),
        visa: pct(item.totalAchieved.visa, item.totalTargets.visa)
      },
      ratios: computeRatios(item.totalAchieved),
      totalTarget: item.totalTargets.inquiry,
      totalAchieved_legacy: item.totalAchieved.inquiry
    }));
    results.sort((a, b) => {
      const qOrder = ['Q1', 'Q2', 'Q3', 'Q4'];
      const qi = qOrder.indexOf(a.quarter) - qOrder.indexOf(b.quarter);
      if (qi !== 0) return qi;
      return (a.country?.name || '').localeCompare(b.country?.name || '');
    });
    res.json(results);
  } catch (err) {
    console.error('GET /achievements/quarterly error:', err);
    res.status(500).json({
      message: err.message
    });
  }
});
module.exports = router;
