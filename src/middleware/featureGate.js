const FeatureFlag = require('../models/FeatureFlag');
const cache = require('../utils/simpleCache');
const requireFeatureEnabled = key => async (req, res, next) => {
  try {
    if (req.user?.role === 'super_admin') return next();
    const ck = `featureflag:${key}`;
    let flag = cache.get(ck);
    if (flag === undefined) {
      flag = await FeatureFlag.findOne({
        key
      }).lean();
      cache.set(ck, flag || null, 15000);
    }
    if (flag && flag.enabled === false) {
      return res.status(503).json({
        message: `This feature ("${flag.label}") is currently disabled by the administrator.`
      });
    }
    next();
  } catch (err) {
    next();
  }
};
module.exports = {
  requireFeatureEnabled
};
