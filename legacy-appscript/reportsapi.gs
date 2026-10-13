/**
 * ============================================================
 *  CREATIVE MATH ZONE — ReportsApi.gs
 *  Step 6: read-only reports. All need REPORT_VIEW, plus the
 *  permission of the data they show (finance / students / teacher pay).
 *  Needs monthLabel_, deriveInvoiceStatus_, tiPaidMap_, tiStatus_.
 * ============================================================
 */

function repRange_(p) {
  const from = String((p && p.from) || '');
  const to = String((p && p.to) || '');
  if (from && !validDate_(from)) throw bad_('From date is not valid.');
  if (to && !validDate_(to)) throw bad_('To date is not valid.');
  return { from: from, to: to };
}

/** Money received, by month and by payment mode. Voided payments excluded. */
function reportCollection_(session, p) {
  requirePerm_(session, 'FINANCE_VIEW');
  const r = repRange_(p);
  const byMonth = {}, byMode = {};
  let total = 0, count = 0;
  readAll_('PAYMENTS').forEach(x => {
    if (String(x.Status).toUpperCase() === 'VOID') return;
    if (r.from && x.PaymentDate < r.from) return;
    if (r.to && x.PaymentDate > r.to) return;
    const amt = Number(x.Amount) || 0, m = String(x.PaymentDate).slice(0, 7);
    byMonth[m] = (byMonth[m] || 0) + amt;
    byMode[x.PaymentMode] = (byMode[x.PaymentMode] || 0) + amt;
    total += amt; count++;
  });
  return {
    total: total, count: count,
    months: Object.keys(byMonth).sort().map(m => ({ Month: m, MonthLabel: monthLabel_(m), Amount: byMonth[m] })),
    modes: Object.keys(byMode).sort().map(k => ({ Mode: k, Amount: byMode[k] }))
  };
}

/** Students with unpaid balance across all non-cancelled invoices. */
function reportDues_(session, p) {
  requirePerm_(session, 'FINANCE_VIEW');
  const month = String((p && p.month) || '');
  const students = {};
  readAll_('STUDENTS').forEach(s => { students[s.StudentID] = s; });
  const by = {};
  readAll_('INVOICES').forEach(i => {
    if (month && i.Month !== month) return;
    const total = Number(i.TotalAmount) || 0, paid = Number(i.PaidAmount) || 0;
    const status = deriveInvoiceStatus_(total, paid, i.DueDate, i.Status);
    const bal = Math.max(0, total - paid);
    if (status === 'CANCELLED' || bal <= 0) return;
    const g = by[i.StudentID] || (by[i.StudentID] = { balance: 0, overdue: 0, invoices: 0, oldestDue: '', subj: {} });
    g.balance += bal; g.invoices++;
    invoiceLines_(i).forEach(l => { if (l.balanceAmount > 0) g.subj[l.subjectName] = true; });
    if (status === 'OVERDUE') g.overdue += bal;
    if (!g.oldestDue || (i.DueDate && i.DueDate < g.oldestDue)) g.oldestDue = i.DueDate || g.oldestDue;
  });
  const rows = Object.keys(by).map(id => {
    const s = students[id] || {};
    return {
      StudentID: id, StudentName: s.Name || id, CurrentClass: s.CurrentClass || '',
      Phone: s.ParentMobile || s.Mobile || '', Invoices: by[id].invoices,
      Balance: by[id].balance, Overdue: by[id].overdue, OldestDue: by[id].oldestDue, Subjects: Object.keys(by[id].subj).join(', ')
    };
  }).sort((a, b) => b.Overdue - a.Overdue || b.Balance - a.Balance);
  return {
    rows: rows,
    totals: { students: rows.length, balance: rows.reduce((s, x) => s + x.Balance, 0), overdue: rows.reduce((s, x) => s + x.Overdue, 0) }
  };
}

/** Attendance % per batch, and students below the threshold. */
function reportAttendance_(session, p) {
  requirePerm_(session, 'STUDENT_VIEW');
  const r = repRange_(p);
  const threshold = Math.min(Math.max(parseInt(p && p.threshold, 10) || 75, 1), 100);
  const students = {};
  readAll_('STUDENTS').forEach(s => { students[s.StudentID] = s; });
  const batches = {}, perStudent = {};
  readAll_('ATTENDANCE').forEach(a => {
    if (r.from && a.Date < r.from) return;
    if (r.to && a.Date > r.to) return;
    const w = a.Status === 'PRESENT' ? 1 : (a.Status === 'LATE' ? 0.5 : 0);
    const b = batches[a.BatchID] || (batches[a.BatchID] = { total: 0, score: 0, present: 0, late: 0, absent: 0 });
    b.total++; b.score += w;
    if (a.Status === 'PRESENT') b.present++; else if (a.Status === 'LATE') b.late++; else b.absent++;
    const s = perStudent[a.StudentID] || (perStudent[a.StudentID] = { total: 0, score: 0, absent: 0 });
    s.total++; s.score += w; if (a.Status === 'ABSENT') s.absent++;
  });
  const pct = (score, total) => total ? Math.round((score / total) * 100) : 0;
  return {
    threshold: threshold,
    batches: Object.keys(batches).map(id => ({
      BatchID: id, BatchName: batchName_(id), Sessions: batches[id].total,
      Present: batches[id].present, Late: batches[id].late, Absent: batches[id].absent,
      Pct: pct(batches[id].score, batches[id].total)
    })).sort((a, b) => a.Pct - b.Pct),
    lowStudents: Object.keys(perStudent).map(id => {
      const s = students[id] || {};
      return { StudentID: id, StudentName: s.Name || id, CurrentClass: s.CurrentClass || '',
               Status: s.Status || '', Sessions: perStudent[id].total, Absent: perStudent[id].absent,
               Pct: pct(perStudent[id].score, perStudent[id].total) };
    }).filter(x => x.Pct < threshold && String(x.Status).toUpperCase() === 'ACTIVE')
      .sort((a, b) => a.Pct - b.Pct).slice(0, 100)
  };
}

/** Teacher pay for a month: payable, paid, balance per teacher. */
function reportTeacherPay_(session, p) {
  requirePerm_(session, 'TEACHER_INCOME_MANAGE');
  const month = String((p && p.month) || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw bad_('Pick a valid month (YYYY-MM).');
  const paid = tiPaidMap_();
  const by = {};
  readAll_('TEACHER_INCOME').filter(i => i.Month === month).forEach(i => {
    const fin = Number(i.FinalPayable) || 0, pd = paid[i.IncomeID] || 0;
    const g = by[i.TeacherID] || (by[i.TeacherID] = { payable: 0, paid: 0, students: 0, subjects: 0 });
    g.payable += fin; g.paid += pd; g.students += Number(i.StudentCount) || 0; g.subjects++;
  });
  const rows = Object.keys(by).map(id => ({
    TeacherID: id, TeacherName: teacherName_(id), Subjects: by[id].subjects, Students: by[id].students,
    Payable: by[id].payable, Paid: by[id].paid, Balance: Math.max(0, by[id].payable - by[id].paid)
  })).sort((a, b) => String(a.TeacherName).localeCompare(String(b.TeacherName)));
  return {
    rows: rows,
    totals: { payable: rows.reduce((s, x) => s + x.Payable, 0), paid: rows.reduce((s, x) => s + x.Paid, 0), balance: rows.reduce((s, x) => s + x.Balance, 0) }
  };
}

function reportsActionDefs_() {
  return {
    'reports.collection': { perm: 'REPORT_VIEW', run: (s, p) => reportCollection_(s, p) },
    'reports.dues':       { perm: 'REPORT_VIEW', run: (s, p) => reportDues_(s, p) },
    'reports.attendance': { perm: 'REPORT_VIEW', run: (s, p) => reportAttendance_(s, p) },
    'reports.teacherPay': { perm: 'REPORT_VIEW', run: (s, p) => reportTeacherPay_(s, p) }
  };
}
