const express = require('express');
const Application = require('../models/Application');
const Inquiry = require('../models/Inquiry');
const Contact = require('../models/Contact');
const ContactGroup = require('../models/ContactGroup');
const Country = require('../models/Country');
const {
  verifyAccess
} = require('../middleware/auth');
const {
  hasPermission
} = require('../config/rbac');
const router = express.Router();
router.use(verifyAccess);
const PER_TYPE_LIMIT = 8;
router.get('/', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({
      results: []
    });
    const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const user = req.user;
    const tasks = [];
    if (hasPermission(user, 'applications', 'access')) {
      const appQuery = {
        $or: [{
          name: regex
        }, {
          providerName: regex
        }, {
          referredBy: regex
        }, {
          through: regex
        }, {
          'universities.providerName': regex
        }]
      };
      if (!['admin', 'super_admin'].includes(user.role)) {
        appQuery.country = {
          $in: user.countries || []
        };
      }
      tasks.push(Application.find(appQuery).populate('country', 'name flag flagImage code').sort({
        updatedAt: -1
      }).limit(PER_TYPE_LIMIT).then(rows => rows.map(a => ({
        type: 'application',
        id: a._id,
        title: a.name,
        subtitle: [a.providerName, a.country?.name].filter(Boolean).join(' · '),
        country: a.country ? {
          id: a.country._id,
          name: a.country.name,
          flag: a.country.flag,
          flagImage: a.country.flagImage
        } : null,
        details: {
          'Referred By': a.referredBy || '—',
          'Level': a.level || '—',
          'Course': a.course || '—',
          'Provider': a.providerName || '—',
          'Country': a.country?.name || '—'
        },
        openPath: `/admin/applications/${a.country?._id || ''}?highlight=${a._id}`
      }))));
    } else {
      tasks.push(Promise.resolve([]));
    }
    if (hasPermission(user, 'inquiry', 'access')) {
      tasks.push(Inquiry.find({
        $or: [{
          applicantName: regex
        }, {
          referredBy: regex
        }]
      }).sort({
        updatedAt: -1
      }).limit(PER_TYPE_LIMIT).then(rows => rows.map(i => ({
        type: 'inquiry',
        id: i._id,
        title: i.applicantName,
        subtitle: [i.country, i.stage].filter(Boolean).join(' · '),
        details: {
          'Referred By': i.referredBy || '—',
          'Country': i.country || '—',
          'Stage': i.stage || '—',
          'Level': i.level || '—',
          'Remarks': i.remarks || '—'
        },
        openPath: `/admin/inquiries?highlight=${i._id}`
      }))));
    } else {
      tasks.push(Promise.resolve([]));
    }
    if (hasPermission(user, 'contacts', 'access')) {
      tasks.push((async () => {
        const groups = await ContactGroup.find();
        const groupsById = new Map(groups.map(g => [String(g._id), g]));
        const needle = q.toLowerCase();
        const contacts = await Contact.find({
          group: {
            $in: groups.map(g => g._id)
          }
        }).sort({
          createdAt: -1
        }).limit(500);
        const matches = [];
        for (const c of contacts) {
          const entries = Array.from((c.data || new Map()).entries());
          const hit = entries.some(([, v]) => String(v).toLowerCase().includes(needle));
          if (!hit) continue;
          const group = groupsById.get(String(c.group));
          if (!group) continue;
          const details = {};
          entries.forEach(([k, v]) => {
            const field = group.fields.find(f => f.key === k);
            details[field?.label || k] = v || '—';
          });
          const primaryValue = entries[0]?.[1] || group.name;
          matches.push({
            type: 'contact',
            id: c._id,
            title: primaryValue,
            subtitle: group.name,
            details,
            openPath: `/admin/contacts?group=${group._id}&highlight=${c._id}`
          });
          if (matches.length >= PER_TYPE_LIMIT) break;
        }
        return matches;
      })());
    } else {
      tasks.push(Promise.resolve([]));
    }
    const [applications, inquiries, contacts] = await Promise.all(tasks);
    res.json({
      results: [...applications, ...inquiries, ...contacts]
    });
  } catch (err) {
    res.status(500).json({
      message: 'Search failed'
    });
  }
});
module.exports = router;
