const mongoose = require('mongoose');

const lazy = (file) => () => require(`../models/${file}`);

const SENSITIVE_FIELD = /password|token|secret|encrypted|hash|session/i;

function isWideUser(user) {
  return ['admin', 'super_admin'].includes(user.role) || !!user.allCountries;
}
function userCountryIds(user) {
  return (user.countries || [])
    .map(c => String(c && c._id ? c._id : c))
    .filter(id => mongoose.Types.ObjectId.isValid(id));
}
function countryScope(user) {
  if (isWideUser(user)) return null;
  return { $in: userCountryIds(user).map(id => new mongoose.Types.ObjectId(id)) };
}
function commissionScope(user) {
  if (user.role === 'super_admin' || user.allCountries) return null;
  return { $in: userCountryIds(user).map(id => new mongoose.Types.ObjectId(id)) };
}
function userDepartments(user) {
  if (user.departments && user.departments.length) return user.departments;
  if (user.department) return [user.department];
  return [];
}
function reportMode(user) {
  if (user.role === 'super_admin') return 'view';
  if (['write', 'view', 'both'].includes(user.dailyReportMode)) return user.dailyReportMode;
  if (user.role === 'user') return user.dailyReportViewOnly ? 'view' : 'write';
  return 'view';
}
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ENTITIES = [
  {
    key: 'applications', label: 'Applications', singular: 'application', titleField: 'name',
    aliases: ['application', 'applications', 'applicant', 'applicants', 'student', 'students', 'case', 'cases', 'file', 'files'],
    model: lazy('Application'), modules: ['applications'],
    scope: u => { const c = countryScope(u); return c ? { country: c } : {}; },
    countryField: 'country',
    title: d => d.name, subtitle: d => [d.course, d.providerName].filter(Boolean).join(' · '),
    dateFields: [
      { key: 'date', label: 'application date', kind: 'date', default: true },
      { key: 'visaLodgement', label: 'visa granted date', kind: 'date' }
    ],
    vocab: ['level', 'course', 'providerName', 'initialIntake', 'deferredIntake', 'referredBy', 'visaOutcome', 'payment', 'offerLetter', 'gsSubmission', 'olRequest', 'withdraw', 'coeCas', 'savisFee', 'refund', 'visaWithdraw', 'through'],
    show: ['level', 'course', 'providerName', 'initialIntake', 'referredBy', 'visaOutcome'],
    groupable: ['providerName', 'course', 'level', 'initialIntake', 'referredBy', 'visaOutcome', 'payment', 'through', 'country'],
    labels: { providerName: 'provider', initialIntake: 'intake', referredBy: 'referred by', visaLodgement: 'visa granted date', olRequest: 'OL request', offerLetter: 'OL received', gsSubmission: 'GS/WIP/financial', coeCas: 'COE/CAS' },
    fieldWords: { providerName: ['provider', 'providers', 'university', 'universities', 'college', 'colleges', 'institution', 'institutions'], course: ['course', 'courses', 'program', 'programs', 'programme', 'programmes'], level: ['level', 'levels'], initialIntake: ['intake', 'intakes'], referredBy: ['associate', 'associates', 'agent', 'agents', 'referrer', 'referrers', 'referral', 'referrals', 'consultancy', 'consultancies'], visaOutcome: ['outcome', 'outcomes'], country: ['country', 'countries'], payment: ['payment', 'payments'], through: ['channel', 'channels'] },
    presets: [
      { key: 'visaGranted', label: 'visas granted', phrases: ['visa\\s*grant(?:ed|s)?', 'granted\\s*visas?', 'visas?\\s*(?:was|were|got)?\\s*granted'], filter: { field: 'visaOutcome', op: 'eq', value: 'Grant' }, dateField: 'visaLodgement' },
      { key: 'visaRejected', label: 'visas rejected', phrases: ['visa\\s*(?:reject|refus)\\w*', '(?:rejected|refused)\\s*visas?'], filter: { field: 'visaOutcome', op: 'regex', value: 'reject|refus' }, dateField: 'visaLodgement' },
      { key: 'visaWaiting', label: 'visas waiting', phrases: ['visa\\s*(?:waiting|pending|in\\s*process)', '(?:waiting|pending)\\s*visas?'], filter: { field: 'visaOutcome', op: 'regex', value: 'wait|pend' } },
      { key: 'offerReceived', label: 'offer letters received', phrases: ['offers?(?:\\s*letters?)?(?:\\s*received)?', 'ol\\s*received', 'received\\s*offers?'], filter: { field: 'offerLetter', op: 'eq', value: 'Received' } },
      { key: 'paid', label: 'paid applications', phrases: ['paid', 'payment\\s*(?:complete|completed|done)', 'fully\\s*paid'], filter: { field: 'payment', op: 'eq', value: 'Complete' } },
      { key: 'withdrawn', label: 'withdrawn applications', phrases: ['withdraw(?:n|al|als)?'], filter: { field: 'withdraw', op: 'filled' } },
      { key: 'deferred', label: 'deferred applications', phrases: ['deferr(?:ed|al|als)'], filter: { field: 'deferredIntake', op: 'filled' } },
      { key: 'refund', label: 'refund cases', phrases: ['refunds?'], filter: { field: 'refund', op: 'filled' } },
      { key: 'coeCas', label: 'COE/CAS issued', phrases: ['coe', 'cas'], filter: { field: 'coeCas', op: 'filled' } }
    ],
    nav: { path: '/applications/:country', highlight: true }
  },
  {
    key: 'testPrep', label: 'Test preparation records', singular: 'test prep record', titleField: 'candidateName',
    aliases: ['test prep', 'testprep', 'test preparation', 'ielts', 'pte', 'toefl', 'duolingo', 'gre', 'gmat', 'exam booking', 'exam bookings', 'candidate', 'candidates', 'test booking', 'test bookings'],
    model: lazy('TestPrepRecord'), modules: ['testPreparation'], scope: () => ({}),
    title: d => d.candidateName, subtitle: d => [d.associates, d.module].filter(Boolean).join(' · '),
    dateFields: [
      { key: 'date', label: 'record date', kind: 'date', default: true },
      { key: 'examDate', label: 'exam date', kind: 'date' },
      { key: 'bookingDate', label: 'booking date', kind: 'date' },
      { key: 'paymentDate', label: 'payment date', kind: 'date' }
    ],
    vocab: ['associates', 'module', 'place', 'paymentStatus', 'paymentMadeBy', 'voucher'],
    show: ['associates', 'module', 'place', 'paymentStatus', 'examDate'],
    groupable: ['associates', 'module', 'place', 'paymentStatus', 'testType'],
    labels: { associates: 'associate', paymentStatus: 'payment status' },
    fieldWords: { associates: ['associate', 'associates', 'agent', 'agents', 'referrer'], module: ['module', 'modules'], place: ['place', 'centre', 'center', 'venue'], paymentStatus: ['payment', 'payments'], testType: ['test', 'tests', 'type', 'types'] },
    populate: [{ path: 'testType', select: 'name slug' }],
    presets: [
      { key: 'upcomingExam', label: 'upcoming exams', phrases: ['upcoming\\s*exams?', 'exams?\\s*(?:coming|ahead)'], filter: { field: 'examDate', op: 'gte', value: '$today' } }
    ],
    nav: { path: '/test-prep/:slug', highlight: true }
  },
  {
    key: 'inquiries', label: 'Inquiries', singular: 'inquiry', titleField: 'applicantName',
    aliases: ['inquiry', 'inquiries', 'enquiry', 'enquiries', 'lead', 'leads'],
    model: lazy('Inquiry'), modules: ['inquiry'], scope: () => ({}),
    title: d => d.applicantName, subtitle: d => [d.stage, d.level].filter(Boolean).join(' · '),
    dateFields: [{ key: 'date', label: 'inquiry date', kind: 'date', default: true }],
    vocab: ['referredBy', 'level', 'stage', 'mode', 'respondedBy', 'emailType', 'country'],
    show: ['country', 'level', 'stage', 'mode', 'referredBy'],
    groupable: ['referredBy', 'level', 'stage', 'mode', 'respondedBy', 'country'],
    labels: { referredBy: 'referred by', respondedBy: 'responded by', emailType: 'email type' },
    fieldWords: { referredBy: ['associate', 'associates', 'agent', 'referrer'], stage: ['stage', 'stages'], mode: ['mode', 'modes'], respondedBy: ['responder', 'staff'], level: ['level', 'levels'], country: ['country', 'countries'] },
    nav: { path: '/inquiries', highlight: true }
  },
  {
    key: 'associateFollowUps', label: 'Associate follow-ups', singular: 'associate follow-up', titleField: 'companyName',
    aliases: ['associate followup', 'associate followups', 'associate follow up', 'associate follow ups', 'associate follow-up', 'associate follow-ups', 'company followup', 'consultancy followup'],
    model: lazy('FollowUp'), modules: ['followUp'], scope: () => ({}),
    title: d => d.companyName, subtitle: d => d.talkedTo || '',
    dateFields: [{ key: 'date', label: 'follow-up date', kind: 'date', default: true }],
    vocab: ['companyName', 'talkedTo'], show: ['talkedTo', 'remarks'], groupable: ['companyName', 'talkedTo'],
    fieldWords: { companyName: ['company', 'companies', 'consultancy', 'associate'], talkedTo: ['person', 'contact'] },
    nav: { path: '/follow-up', highlight: true }
  },
  {
    key: 'studentFollowUps', label: 'Student follow-ups', singular: 'student follow-up', titleField: 'studentName',
    aliases: ['student followup', 'student followups', 'student follow up', 'student follow ups', 'student follow-up', 'student follow-ups', 'followup', 'followups', 'follow up', 'follow ups', 'follow-up', 'follow-ups', 'reminder', 'reminders'],
    model: lazy('StudentFollowUp'), modules: ['studentFollowUp'],
    scope: u => { const c = countryScope(u); return c ? { country: c } : {}; },
    countryField: 'country',
    title: d => d.studentName, subtitle: d => [d.method, d.status].filter(Boolean).join(' · '),
    dateFields: [{ key: 'scheduledAt', label: 'scheduled time', kind: 'instant', default: true }, { key: 'completedAt', label: 'completed time', kind: 'instant' }],
    vocab: ['status', 'method', 'referredBy', 'providerName'], show: ['status', 'method', 'referredBy', 'providerName', 'scheduledAt'],
    groupable: ['status', 'method', 'referredBy', 'providerName', 'country'],
    labels: { referredBy: 'referred by', providerName: 'provider', scheduledAt: 'scheduled' },
    fieldWords: { status: ['status'], method: ['method', 'channel'], referredBy: ['associate', 'agent', 'referrer'], providerName: ['provider', 'university', 'college'], country: ['country', 'countries'] },
    presets: [
      { key: 'pending', label: 'pending follow-ups', phrases: ['pending', 'open', 'not\\s*done', 'upcoming'], filter: { field: 'status', op: 'eq', value: 'pending' } },
      { key: 'overdue', label: 'overdue follow-ups', phrases: ['overdue', 'late', 'missed', 'delayed'], filter: { field: 'status', op: 'eq', value: 'pending' }, extra: { field: 'scheduledAt', op: 'lt', value: '$now' } },
      { key: 'completed', label: 'completed follow-ups', phrases: ['completed', 'done', 'finished'], filter: { field: 'status', op: 'eq', value: 'completed' } },
      { key: 'noResponse', label: 'follow-ups with no response', phrases: ['no\\s*response', 'not\\s*responding', 'unresponsive'], filter: { field: 'status', op: 'eq', value: 'no_response' } },
      { key: 'cancelled', label: 'cancelled follow-ups', phrases: ['cancel(?:led|ed)'], filter: { field: 'status', op: 'eq', value: 'cancelled' } }
    ],
    nav: { path: '/student-follow-up', highlight: true }
  },
  {
    key: 'hallBookings', label: 'Hall bookings', singular: 'hall booking', titleField: 'hall',
    aliases: ['hall booking', 'hall bookings', 'hall', 'halls', 'booking', 'bookings', 'visit', 'visits', 'room booking'],
    model: lazy('HallBooking'), modules: ['hallBooking'],
    scope: u => (u.role === 'super_admin' ? {} : {
      $or: [
        { 'visibility.mode': { $exists: false } }, { 'visibility.mode': 'everyone' },
        { createdBy: u._id }, { 'visibility.mode': 'specific', 'visibility.allowedUsers': u._id }
      ]
    }),
    countryField: 'country',
    title: d => d.hall, subtitle: d => [d.institution, d.representativeName].filter(Boolean).join(' · '),
    dateFields: [{ key: 'date', label: 'booking date', kind: 'date', default: true }],
    vocab: ['hall', 'status', 'institution', 'designation', 'eventType'], show: ['institution', 'representativeName', 'time', 'status'],
    groupable: ['hall', 'status', 'institution', 'country'],
    labels: { representativeName: 'representative' },
    fieldWords: { hall: ['hall', 'halls', 'room', 'rooms'], status: ['status'], institution: ['institution', 'university', 'college', 'portal'], country: ['country', 'countries'] },
    presets: [
      { key: 'upcoming', label: 'upcoming hall bookings', phrases: ['upcoming', 'future', 'scheduled'], filter: { field: 'date', op: 'gte', value: '$today' } }
    ],
    nav: { path: '/hall-booking', highlight: true }
  },
  {
    key: 'trainingSchedules', label: 'Training schedules', singular: 'training schedule', titleField: 'title',
    aliases: ['training schedule', 'training schedules', 'training', 'trainings', 'meeting', 'meetings', 'department meeting', 'department meetings', 'workshop', 'workshops', 'session', 'sessions'],
    model: lazy('TrainingSchedule'), modules: ['trainingSchedule'], scope: () => ({}),
    title: d => d.title, subtitle: d => [d.type, d.startTime, d.venue].filter(Boolean).join(' · '),
    dateFields: [{ key: 'date', label: 'schedule date', kind: 'date', default: true }],
    vocab: ['type', 'status', 'mode', 'venue', 'host'], show: ['type', 'startTime', 'endTime', 'venue', 'host', 'mode', 'status'],
    groupable: ['type', 'status', 'mode', 'venue', 'host'],
    labels: { startTime: 'start', endTime: 'end' },
    fieldWords: { type: ['type', 'types'], status: ['status'], mode: ['mode'], venue: ['venue', 'room', 'place'], host: ['host', 'trainer'] },
    presets: [
      { key: 'upcoming', label: 'upcoming schedules', phrases: ['upcoming', 'future', 'scheduled', 'next'], filter: { field: 'date', op: 'gte', value: '$today' } }
    ],
    nav: { path: '/training-schedule', highlight: true }
  },
  {
    key: 'associates', label: 'Associates', singular: 'associate', titleField: 'consultancyName',
    aliases: ['associate', 'associates', 'associate detail', 'associate details', 'consultancy', 'consultancies', 'partner', 'partners', 'agent', 'agents', 'owner', 'owners', 'director', 'directors', 'manager'],
    model: lazy('AssociateDetail'), modules: ['associateDetails'], scope: () => ({}),
    title: d => d.consultancyName, subtitle: d => [d.ownerName, d.location].filter(Boolean).join(' · '),
    dateFields: [{ key: 'dateOfOnboarding', label: 'onboarding date', kind: 'date', default: true }],
    vocab: ['location', 'association', 'referredBy', 'designation', 'ownerName', 'managerName'],
    show: ['ownerName', 'ownerContact', 'email', 'location', 'managerName', 'managerContact', 'website'],
    groupable: ['location', 'association', 'referredBy', 'designation'],
    labels: { consultancyName: 'consultancy', ownerName: 'owner', ownerContact: 'owner contact', managerName: 'manager', managerContact: 'manager contact', referredBy: 'referred by', dateOfOnboarding: 'onboarding date', emailAdmission: 'admission email', emailTestRegistration: 'test registration email', emailOthers: 'other email', officialPhone: 'official phone' },
    fieldWords: { location: ['location', 'locations', 'city', 'cities', 'district', 'place', 'area'], association: ['association', 'associations'], referredBy: ['referrer', 'referred'], designation: ['designation', 'designations', 'role'] },
    nav: { path: '/associate-details', highlight: true }
  },
  {
    key: 'commissionAssociate', label: 'Commission associate rates', singular: 'associate commission row', titleField: 'university',
    aliases: ['commission', 'commissions', 'associate commission', 'associate commissions', 'commission rate', 'commission rates'],
    model: lazy('CommissionRate'), modules: ['commissionAssociate'], superAdminOnly: true,
    scope: u => { const c = commissionScope(u); return { section: 'associate', ...(c ? { country: c } : {}) }; },
    countryField: 'country',
    title: d => d.university, subtitle: d => [d.undergraduate && `UG: ${d.undergraduate}`, d.postgraduate && `PG: ${d.postgraduate}`].filter(Boolean).join(' · '),
    dateFields: [], vocab: [], show: ['undergraduate', 'postgraduate', 'remarks'], groupable: ['country'],
    labels: { university: 'name' }, fieldWords: { country: ['country', 'countries'] },
    nav: { path: '/commission/:intake/:country/associate', highlight: true }
  },
  {
    key: 'commissionShareholder', label: 'Commission shareholder rates', singular: 'shareholder commission row', titleField: 'university',
    aliases: ['shareholder commission', 'shareholder commissions', 'shareholder', 'shareholders'],
    model: lazy('CommissionRate'), modules: ['commissionShareholder'], superAdminOnly: true,
    scope: u => { const c = commissionScope(u); return { section: 'shareholder', ...(c ? { country: c } : {}) }; },
    countryField: 'country',
    title: d => d.university, subtitle: d => [d.undergraduate && `UG: ${d.undergraduate}`, d.postgraduate && `PG: ${d.postgraduate}`].filter(Boolean).join(' · '),
    dateFields: [], vocab: [], show: ['undergraduate', 'postgraduate', 'partner', 'remarks'], groupable: ['country'],
    labels: { university: 'name' }, fieldWords: { country: ['country', 'countries'] },
    nav: { path: '/commission/:intake/:country/shareholder', highlight: true }
  },
  {
    key: 'commissionDepartment', label: 'Commission department channels', singular: 'department commission row', titleField: 'university',
    aliases: ['department commission', 'department commissions', 'channel partner', 'channel partners', 'commission department'],
    model: lazy('CommissionDepartment'), modules: ['commissionDepartment'],
    scope: u => { const c = commissionScope(u); return c ? { country: c } : {}; },
    countryField: 'country',
    title: d => d.university, subtitle: d => [d.channelPartner, d.directIndirect].filter(Boolean).join(' · '),
    dateFields: [], vocab: ['directIndirect', 'channelPartner'], show: ['channelPartner', 'directIndirect'], groupable: ['directIndirect', 'channelPartner', 'country'],
    labels: { university: 'name', directIndirect: 'direct/indirect', channelPartner: 'channel partner' },
    fieldWords: { directIndirect: ['direct', 'indirect'], channelPartner: ['channel', 'partner'], country: ['country', 'countries'] },
    nav: { path: '/commission/:intake/:country/department', highlight: true }
  },
  {
    key: 'contacts', label: 'Contacts', singular: 'contact',
    aliases: ['contact', 'contacts', 'phone book', 'phonebook', 'directory'],
    model: lazy('Contact'), modules: ['contacts'], scope: () => ({}), mapField: 'data',
    title: d => { const v = d.data && Object.values(d.data).find(x => x && String(x).trim()); return v ? String(v) : 'Contact'; },
    subtitle: d => { const v = d.data ? Object.values(d.data).filter(x => x && String(x).trim()).slice(1, 3) : []; return v.join(' · '); },
    dateFields: [{ key: 'createdAt', label: 'added date', kind: 'instant', default: true }],
    vocab: [], show: [], groupable: ['group'], fieldWords: { group: ['group', 'groups', 'category', 'categories'] },
    populate: [{ path: 'group', select: 'name slug' }],
    nav: { path: '/contacts/:slug', highlight: true }
  },
  {
    key: 'portals', label: 'Portals', singular: 'portal', titleField: 'name',
    aliases: ['portal', 'portals', 'website login', 'login site', 'logins'],
    model: lazy('Portal'), modules: ['portal'],
    scope: u => {
      if (['admin', 'super_admin'].includes(u.role)) return {};
      const mine = userDepartments(u).map(d => new RegExp(`^\\s*${escapeRegex(d)}\\s*$`, 'i'));
      return { $or: [{ allDepartments: true }, { departments: { $in: mine } }] };
    },
    exclude: ['username', 'passwordEncrypted'],
    title: d => d.name, subtitle: d => [d.category, d.url].filter(Boolean).join(' · '),
    dateFields: [], vocab: ['category', 'status'], show: ['category', 'url', 'status'], groupable: ['category', 'status'],
    nav: { path: '/portal', highlight: true }
  },
  {
    key: 'dailyReports', label: 'Daily reports', singular: 'daily report',
    aliases: ['daily report', 'daily reports', 'report entry', 'work report'],
    model: lazy('DailyReport'), modules: ['dailyReport'],
    scope: u => {
      if (u.role === 'super_admin') return {};
      const m = reportMode(u);
      if (m === 'view' || m === 'both') {
        const depts = Array.isArray(u.dailyReportDepartments) ? u.dailyReportDepartments.filter(Boolean) : [];
        return depts.length ? { department: { $in: depts } } : {};
      }
      return { user: u._id };
    },
    exclude: ['points'],
    title: d => d.date, subtitle: d => d.department || '',
    dateFields: [], vocab: ['department'], show: ['department', 'date'], groupable: ['department'],
    populate: [{ path: 'user', select: 'name username' }],
    nav: { path: '/daily-report' }
  },
  {
    key: 'diary', label: 'Diary entries', singular: 'diary entry', titleField: 'name',
    aliases: ['diary', 'diary entry', 'diary entries'],
    model: lazy('Diary'), modules: [], superAdminOnly: true, scope: () => ({}),
    title: d => d.name, subtitle: d => [d.post, d.mobile].filter(Boolean).join(' · '),
    dateFields: [], vocab: ['post'], show: ['post', 'mobile', 'remarks'], groupable: ['post'],
    nav: { path: '/diary', highlight: true }
  },
  {
    key: 'users', label: 'Users', singular: 'user', titleField: 'name',
    aliases: ['user', 'users', 'staff', 'staffs', 'employee', 'employees', 'team member', 'team members', 'account', 'accounts'],
    model: lazy('User'), modules: [], superAdminOnly: true, scope: () => ({}),
    exclude: ['password', 'permissions', 'permissionOverrides', 'sessions', 'refreshToken'],
    title: d => d.name || d.username, subtitle: d => [d.username, d.role].filter(Boolean).join(' · '),
    dateFields: [{ key: 'lastLogin', label: 'last login', kind: 'instant', default: true }],
    vocab: ['role', 'status', 'department'], show: ['username', 'role', 'department', 'status'], groupable: ['role', 'status', 'department'],
    fieldWords: { role: ['role', 'roles'], department: ['department', 'departments'], status: ['status'] },
    nav: { path: '/users', highlight: true }
  },
  {
    key: 'departments', label: 'Departments', singular: 'department', titleField: 'name',
    aliases: ['department', 'departments'],
    model: lazy('Department'), modules: [], superAdminOnly: true, scope: () => ({}),
    exclude: ['permissions'],
    title: d => d.name, subtitle: () => '',
    dateFields: [], vocab: [], show: [], groupable: [],
    nav: { path: '/departments', highlight: true }
  },
  {
    key: 'countries', label: 'Countries', singular: 'country', titleField: 'name',
    aliases: ['country', 'countries', 'destination', 'destinations'],
    model: lazy('Country'), modules: ['applications'],
    scope: u => { const c = countryScope(u); return c ? { _id: c } : {}; },
    title: d => d.name, subtitle: d => d.code || '',
    dateFields: [], vocab: ['status'], show: ['code', 'status'], groupable: ['status'],
    nav: { path: '/applications/:id', highlight: false }
  }
];

const FEATURES = [
  { key: 'dashboard', label: 'Dashboard', path: '', exact: true, aliases: ['home', 'main page', 'overview'], desc: 'Overview of the whole system', keywords: 'overview summary totals recent activity' },
  { key: 'applications', label: 'Applications', path: '/applications', modules: ['applications'], aliases: ['application', 'country applications', 'student applications', 'visa', 'offers'], desc: 'Student applications, grouped by country', keywords: 'application student visa offer intake provider course country granted payment', userOpen: 'applications' },
  { key: 'testPrep', label: 'Test Preparation', path: '/test-prep', modules: ['testPreparation'], aliases: ['test prep', 'testprep', 'ielts', 'pte', 'toefl', 'duolingo', 'exam', 'exams', 'tp'], desc: 'IELTS/PTE and other test bookings and receipts', keywords: 'ielts pte exam booking candidate voucher receipt payment' },
  { key: 'contacts', label: 'Contacts', path: '/contacts', modules: ['contacts'], aliases: ['contact', 'phone book', 'directory'], desc: 'Grouped contact lists', keywords: 'contact phone email group' },
  { key: 'inquiries', label: 'Inquiries', path: '/inquiries', modules: ['inquiry'], aliases: ['inquiry', 'enquiry', 'enquiries', 'leads'], desc: 'Walk-in and online inquiries', keywords: 'inquiry enquiry lead stage mode responded' },
  { key: 'associateFollowUp', label: 'Associate Followup', path: '/follow-up', modules: ['followUp'], aliases: ['associate follow up', 'associate follow-up', 'associate followups', 'company followup'], desc: 'Calls and visits with partner consultancies', keywords: 'followup associate company talked' },
  { key: 'studentFollowUp', label: 'Student Followup', path: '/student-follow-up', modules: ['studentFollowUp'], aliases: ['student follow up', 'student follow-up', 'followup', 'followups', 'follow up', 'follow ups', 'reminders'], desc: 'Per-student follow-up timeline and reminders', keywords: 'followup reminder overdue today pending student call' },
  { key: 'reports', label: 'Reports', path: '/reports', modules: ['reports'], aliases: ['report', 'statistics', 'stats', 'analytics'], desc: 'Application, inquiry and test-prep reports by associate, intake and country', keywords: 'report statistics applications visa granted intake associate country analytics how many' },
  { key: 'achievements', label: 'Achievements', path: '/achievements', modules: ['achievements'], aliases: ['achievement', 'targets', 'target'], desc: 'Application targets versus actuals', keywords: 'achievement target visa offer month quarter actual' },
  { key: 'tpAchievements', label: 'TP Achievements', path: '/tp-achievements', modules: ['tpAchievements'], aliases: ['tp achievement', 'test prep achievements', 'tp targets'], desc: 'Test-prep booking targets versus actuals', keywords: 'test prep target achievement booking weekly monthly' },
  { key: 'dailyReport', label: 'Daily Report', path: '/daily-report', modules: ['dailyReport'], aliases: ['daily reports', 'work report', 'daily work'], desc: 'Write or review the daily work report', keywords: 'daily report work points feedback' },
  { key: 'portal', label: 'Portal', path: '/portal', modules: ['portal'], aliases: ['portals', 'logins', 'login sites'], desc: 'Shared portal links and logins', keywords: 'portal login url password category' },
  { key: 'hallBooking', label: 'Hall Booking', path: '/hall-booking', modules: ['hallBooking'], aliases: ['hall', 'halls', 'book hall', 'room booking', 'visit booking'], desc: 'University / college / portal visits and general events', keywords: 'hall room booking visit event representative' },
  { key: 'trainingSchedule', label: 'Training Schedule', path: '/training-schedule', modules: ['trainingSchedule'], aliases: ['training', 'trainings', 'meeting schedule', 'meetings', 'department meetings', 'schedule', 'workshop'], desc: 'When each department holds its meetings and trainings', keywords: 'training schedule meeting department workshop date time venue host' },
  { key: 'associateDetails', label: 'Associate Details', path: '/associate-details', modules: ['associateDetails'], aliases: ['associate', 'associates', 'associate detail', 'consultancy details', 'partners', 'agents'], desc: 'Master list of partner consultancies and their contacts', keywords: 'associate consultancy owner manager email phone location onboarding association referred' },
  { key: 'commission', label: 'Commission', path: '/commission', modules: ['commissionAssociate', 'commissionShareholder', 'commissionDepartment'], aliases: ['commissions', 'commission rate', 'commission rates'], desc: 'Commission rates by intake and country', keywords: 'commission rate intake associate shareholder department channel partner' },
  { key: 'unicommission', label: 'Unicommission', path: '/unicommission', modules: ['unicommission'], aliases: ['uni commission', 'university commission', 'visa granted students', 'visa granted list', 'commission tracking'], desc: 'Visa-granted students per country with fee and commission, filled automatically from Applications', keywords: 'unicommission commission visa granted student fee provider university intake associate payment received pending' },
  { key: 'diary', label: 'Diary', path: '/diary', superAdminOnly: true, aliases: ['phone diary'], desc: 'Personal contact diary', keywords: 'diary name post mobile' },
  { key: 'users', label: 'Users', path: '/users', superAdminOnly: true, aliases: ['user', 'staff', 'accounts', 'team'], desc: 'Create staff accounts and set permissions', keywords: 'user staff account permission role department country' },
  { key: 'departments', label: 'Departments', path: '/departments', superAdminOnly: true, aliases: ['department'], desc: 'Departments and their base permissions', keywords: 'department permission module base' },
  { key: 'messages', label: 'Messages', path: '/chat', open: true, aliases: ['chat', 'message', 'inbox'], desc: 'Internal chat', keywords: 'chat message conversation' },
  { key: 'trash', label: 'Trash', path: '/trash', modules: ['trash'], aliases: ['recycle bin', 'deleted', 'bin', 'restore'], desc: 'Restore anything that was deleted in the last 60 days', keywords: 'trash deleted restore recycle' },
  { key: 'settings', label: 'Settings', path: '/settings', open: true, aliases: ['setting', 'preferences', 'password', 'profile'], desc: 'Your account settings', keywords: 'settings password profile' }
];

module.exports = {
  ENTITIES, FEATURES, SENSITIVE_FIELD,
  isWideUser, userCountryIds, countryScope, escapeRegex
};
