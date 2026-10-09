const Inquiry = require('../models/Inquiry');
const Unicommission = require('../models/Unicommission');
const UnicommissionSetting = require('../models/UnicommissionSetting');

const LEVEL_DEFAULTS = ['UG', 'PG', 'PGD', 'PhD', 'Diploma', 'Research/PhD', 'MRes'];

const LISTS = {
  inquiryStage: {
    label: 'Inquiry stage',
    note: 'Used in Inquiries filters, forms and bulk edit',
    defaults: ['New', 'Course Suggested', 'Follow Up'],
    maxLen: 60,
    upper: false,
    targets: [{ model: Inquiry, field: 'stage' }]
  },
  inquiryMode: {
    label: 'Inquiry mode',
    note: 'Used in Inquiries filters, forms and bulk edit',
    defaults: ['WhatsApp', 'Email', 'Phone'],
    maxLen: 60,
    upper: false,
    targets: [{ model: Inquiry, field: 'mode' }]
  },
  currency: {
    label: 'Currency',
    note: 'Suggestions in Unicommission forms and settings',
    defaults: ['USD', 'GBP', 'AUD', 'CAD', 'NZD', 'EUR', 'NPR', 'INR', 'AED', 'SGD', 'JPY', 'CHF', 'MYR'],
    maxLen: 6,
    upper: true,
    targets: [{ model: Unicommission, field: 'currency' }, { model: UnicommissionSetting, field: 'currency' }]
  }
};

module.exports = { LISTS, LEVEL_DEFAULTS };
