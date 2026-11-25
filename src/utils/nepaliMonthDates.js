const NEPALI_MONTH_DATES_BY_FY = {
  '2082/83': {
    Shrawan: {
      from: '2025-07-16',
      to: '2025-08-15'
    },
    Bhadra: {
      from: '2025-08-16',
      to: '2025-09-15'
    },
    Ashoj: {
      from: '2025-09-16',
      to: '2025-10-16'
    },
    Kartik: {
      from: '2025-10-17',
      to: '2025-11-15'
    },
    Mangsir: {
      from: '2025-11-16',
      to: '2025-12-14'
    },
    Poush: {
      from: '2025-12-15',
      to: '2026-01-13'
    },
    Magh: {
      from: '2026-01-14',
      to: '2026-02-12'
    },
    Falgun: {
      from: '2026-02-13',
      to: '2026-03-13'
    },
    Chaitra: {
      from: '2026-03-14',
      to: '2026-04-12'
    },
    Baishakh: {
      from: '2026-04-13',
      to: '2026-05-13'
    },
    Jestha: {
      from: '2026-05-14',
      to: '2026-06-13'
    },
    Ashadh: {
      from: '2026-06-14',
      to: '2026-07-16'
    }
  },
  '2083/84': {
    Shrawan: {
      from: '2026-07-17',
      to: '2026-08-16'
    },
    Bhadra: {
      from: '2026-08-17',
      to: '2026-09-16'
    },
    Ashoj: {
      from: '2026-09-17',
      to: '2026-10-17'
    },
    Kartik: {
      from: '2026-10-18',
      to: '2026-11-16'
    },
    Mangsir: {
      from: '2026-11-17',
      to: '2026-12-15'
    },
    Poush: {
      from: '2026-12-16',
      to: '2027-01-14'
    },
    Magh: {
      from: '2027-01-15',
      to: '2027-02-12'
    },
    Falgun: {
      from: '2027-02-13',
      to: '2027-03-14'
    },
    Chaitra: {
      from: '2027-03-15',
      to: '2027-04-13'
    },
    Baishakh: {
      from: '2027-04-14',
      to: '2027-05-14'
    },
    Jestha: {
      from: '2027-05-15',
      to: '2027-06-14'
    },
    Ashadh: {
      from: '2027-06-15',
      to: '2027-07-15'
    }
  },
  '2084/85': {
    Shrawan: {
      from: '2027-07-16',
      to: '2027-08-16'
    },
    Bhadra: {
      from: '2027-08-17',
      to: '2027-09-16'
    },
    Ashoj: {
      from: '2027-09-17',
      to: '2027-10-17'
    },
    Kartik: {
      from: '2027-10-18',
      to: '2027-11-16'
    },
    Mangsir: {
      from: '2027-11-17',
      to: '2027-12-15'
    },
    Poush: {
      from: '2027-12-16',
      to: '2028-01-14'
    },
    Magh: {
      from: '2028-01-15',
      to: '2028-02-12'
    },
    Falgun: {
      from: '2028-02-13',
      to: '2028-03-14'
    },
    Chaitra: {
      from: '2028-03-15',
      to: '2028-04-13'
    },
    Baishakh: {
      from: '2028-04-14',
      to: '2028-05-14'
    },
    Jestha: {
      from: '2028-05-15',
      to: '2028-06-14'
    },
    Ashadh: {
      from: '2028-06-15',
      to: '2028-07-15'
    }
  }
};
function getAuthoritativeMonthRange(fiscalYear, nepaliMonth) {
  const range = (NEPALI_MONTH_DATES_BY_FY[fiscalYear] || {})[nepaliMonth];
  return range || null;
}
module.exports = {
  NEPALI_MONTH_DATES_BY_FY,
  getAuthoritativeMonthRange
};
