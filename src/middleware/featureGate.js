const FeatureFlag = require('../models/FeatureFlag');
const requireFeatureEnabled = key => async (req, res, next) => {
  try {
    if (req.user?.role === 'super_admin') return next();
    const flag = await FeatureFlag.findOne({
      key
    });
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
