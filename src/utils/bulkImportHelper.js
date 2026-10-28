async function bulkInsertWithReport(Model, rowsData) {
  const validDocs = [];
  const validRowNumbers = [];
  const failures = [];
  for (let i = 0; i < rowsData.length; i++) {
    try {
      const doc = new Model(rowsData[i]);
      await doc.validate();
      validDocs.push(doc);
      validRowNumbers.push(i + 1);
    } catch (err) {
      failures.push({
        row: i + 1,
        reason: describeError(err)
      });
      console.warn(`Bulk import: skipped row ${i + 1} — ${describeError(err)}`);
    }
  }
  let insertedDocs = [];
  if (validDocs.length > 0) {
    try {
      insertedDocs = await Model.insertMany(validDocs, {
        ordered: false
      });
    } catch (bulkErr) {
      insertedDocs = bulkErr.insertedDocs || [];
      const writeErrors = bulkErr.writeErrors || [];
      if (writeErrors.length > 0) {
        writeErrors.forEach(we => {
          const originalRow = validRowNumbers[we.index] ?? 'unknown';
          const reason = we.errmsg || we.err?.errmsg || 'Database write error';
          failures.push({
            row: originalRow,
            reason
          });
          console.warn(`Bulk import: row ${originalRow} failed at the database — ${reason}`);
        });
      } else {
        throw bulkErr;
      }
    }
  }
  failures.sort((a, b) => (Number(a.row) || 0) - (Number(b.row) || 0));
  return {
    insertedDocs,
    failures,
    totalRows: rowsData.length,
    successCount: insertedDocs.length,
    failedCount: failures.length
  };
}
function describeError(err) {
  if (err && err.errors) {
    return Object.values(err.errors).map(e => e.message).join('; ');
  }
  return err?.message || 'Unknown validation error';
}
module.exports = {
  bulkInsertWithReport
};
