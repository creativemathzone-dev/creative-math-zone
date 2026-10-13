/**
 * ============================================================
 *  CREATIVE MATH ZONE — InvoicesApi.gs
 *  Installment 2: Monthly invoice generation and browsing.
 * ============================================================
 */

function monthLabel_(ym) {
  if (!/^\d{4}-\d{2}$/.test(ym || '')) return ym || '';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return months[parseInt(ym.slice(5, 7), 10) - 1] + ' ' + ym.slice(0, 4);
}

function parseLineItems_(s) {
  if (!s) return [];
  try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}

/**
 * Line items with per-subject money (paidAmount, balanceAmount).
 * Invoices made before per-subject payments have no paidAmount on their lines,
 * so their single PaidAmount is spread over the lines in order.
 */
function invoiceLines_(inv) {
  const raw = parseLineItems_(inv.LineItems);
  const tracked = raw.some(l => l.paidAmount !== undefined && l.paidAmount !== null);
  let left = tracked ? 0 : (Number(inv.PaidAmount) || 0);
  return raw.map(l => {
    const fin = Number(l.finalAmount) || 0;
    let paid;
    if (tracked) {
      paid = Number(l.paidAmount) || 0;
    } else {
      paid = Math.min(fin, left);
      left = Math.round((left - paid) * 100) / 100;
    }
    return Object.assign({}, l, {
      standardAmount: Number(l.standardAmount) || 0, discountAmount: Number(l.discountAmount) || 0,
      finalAmount: fin, paidAmount: paid, balanceAmount: Math.max(0, Math.round((fin - paid) * 100) / 100)
    });
  });
}

/** Back to the text stored in the sheet (balanceAmount is always worked out, never stored). */
function serializeLines_(lines) {
  return JSON.stringify(lines.map(l => { const o = Object.assign({}, l); delete o.balanceAmount; return o; }));
}

/** Month string (yyyy-MM) of the current date, or the next month. */
function thisMonth_() { return Utilities.formatDate(nowDate_(), tz_(), 'yyyy-MM'); }

/** Due date for an invoice in a given month: INVOICE_DUE_DAY of that month (default 10). */
function invoiceDueDate_(ym) {
  const day = getSettingInt_('INVOICE_DUE_DAY', 10, 1, 28);
  return ym + '-' + pad_(day, 2);
}

/** Status derivation from money and dates. Called on read so it stays current. */
function deriveInvoiceStatus_(total, paid, dueDate, storedStatus) {
  const s = String(storedStatus || '').toUpperCase();
  if (s === 'CANCELLED') return 'CANCELLED';
  const t = Number(total) || 0, p = Number(paid) || 0, bal = Math.max(0, t - p);
  if (t === 0) return 'PAID';
  if (bal <= 0) return 'PAID';
  const overdue = dueDate && dueDate < todayStr_();
  if (p > 0) return overdue ? 'OVERDUE' : 'PARTIAL';
  return overdue ? 'OVERDUE' : 'UNPAID';
}

/* ============================================================
 *  GENERATE MONTHLY INVOICES
 * ============================================================ */

function invoicesGenerate_(session, p) {
  const ym = String(p.month || '').trim();
  if (!/^\d{4}-\d{2}$/.test(ym)) throw bad_('Pick a valid month (YYYY-MM).');
  const studentIdFilter = p.studentId ? String(p.studentId) : null;
  const ay = currentAcademicYear_();

  const students = studentIdFilter
    ? readAll_('STUDENTS').filter(s => s.StudentID === studentIdFilter)
    : readAll_('STUDENTS').filter(s => String(s.Status).toUpperCase() === 'ACTIVE');

  if (!students.length) throw bad_('No eligible students found.');

  const existing = {};
  readAll_('INVOICES').forEach(inv => {
    if (String(inv.Month) === ym && String(inv.Status).toUpperCase() !== 'CANCELLED') {
      existing[inv.StudentID] = inv;
    }
  });
  const result = { generated: 0, skippedExisting: 0, skippedEmpty: 0, total: 0, details: [] };

  return withLock_(() => {
    // Pre-compute next invoice number for this month
    const idPrefix = 'INV-' + ym.replace('-', '') + '-';
    let nextNum = 0;
    const re = new RegExp('^' + escapeRe_(idPrefix) + '(\\d+)$');
    readColumn_('INVOICES', 'InvoiceID').forEach(v => {
      const m = re.exec(String(v));
      if (m) nextNum = Math.max(nextNum, parseInt(m[1], 10));
    });

    const dueDate = invoiceDueDate_(ym);

    students.forEach(st => {
      if (existing[st.StudentID]) { result.skippedExisting++; return; }

      const activeSubjects = readAll_('STUDENT_SUBJECTS').filter(r =>
        r.StudentID === st.StudentID && isActive_(r.Status));
      if (!activeSubjects.length) { result.skippedEmpty++; return; }

      const lines = activeSubjects.map(ss => {
        const eff = effectiveMonthlyFee_(st.StudentID, ss.SubjectID, ay);
        return {
          subjectId: ss.SubjectID,
          subjectName: subjectName_(ss.SubjectID),
          standardAmount: eff.standard,
          discountAmount: eff.discount,
          finalAmount: eff.amount,
          paidAmount: 0
        };
      }).filter(l => l.finalAmount > 0);

      if (!lines.length) { result.skippedEmpty++; return; }

      const total = lines.reduce((s, l) => s + l.finalAmount, 0);
      const id = idPrefix + pad_(++nextNum, 4);

      appendObject_('INVOICES', {
        InvoiceID: id,
        StudentID: st.StudentID,
        Month: ym,
        AcademicYear: ay,
        LineItems: JSON.stringify(lines),
        TotalAmount: total,
        PaidAmount: 0,
        BalanceAmount: total,
        Status: 'UNPAID',
        DueDate: dueDate,
        CreatedAt: nowStr_(),
        UpdatedAt: nowStr_()
      });

      result.generated++;
      result.total += total;
      result.details.push({ studentId: st.StudentID, name: st.Name, invoiceId: id, amount: total });
    });

    logAdmin_(session, 'GENERATE_INVOICES', 'INVOICES', ym,
      { generated: result.generated, skipped: result.skippedExisting + result.skippedEmpty });

    return result;
  });
}

/* ============================================================
 *  LIST / READ
 * ============================================================ */

function invoicesList_(p) {
  const month = String((p && p.month) || '').trim();
  const status = String((p && p.status) || '').toUpperCase();
  const q = String((p && p.search) || '').trim().toLowerCase();
  const limit = Math.min(Math.max(parseInt(p && p.limit, 10) || 500, 1), 2000);

  const students = {};
  readAll_('STUDENTS').forEach(s => { students[s.StudentID] = s; });

  const rows = readAll_('INVOICES').map(inv => {
    const st = students[inv.StudentID];
    const total = Number(inv.TotalAmount) || 0;
    const paid = Number(inv.PaidAmount) || 0;
    const bal = Math.max(0, total - paid);
    const derived = deriveInvoiceStatus_(total, paid, inv.DueDate, inv.Status);
    return {
      InvoiceID: inv.InvoiceID,
      StudentID: inv.StudentID,
      StudentName: st ? st.Name : inv.StudentID,
      CurrentClass: st ? st.CurrentClass : '',
      Month: inv.Month,
      MonthLabel: monthLabel_(inv.Month),
      TotalAmount: total,
      PaidAmount: paid,
      BalanceAmount: bal,
      DueDate: inv.DueDate,
      Status: derived,
      StoredStatus: inv.Status
    };
  })
  .filter(r => !month || r.Month === month)
  .filter(r => !status || r.Status === status)
  .filter(r => !q || r.StudentName.toLowerCase().indexOf(q) >= 0 ||
               r.StudentID.toLowerCase().indexOf(q) >= 0 ||
               r.InvoiceID.toLowerCase().indexOf(q) >= 0)
  .sort((a, b) => String(b.Month).localeCompare(String(a.Month)) || String(b.InvoiceID).localeCompare(String(a.InvoiceID)));

  const totals = { count: 0, billed: 0, paid: 0, balance: 0, overdue: 0 };
  rows.forEach(r => {
    const isCancelled = String(r.Status).toUpperCase() === 'CANCELLED';
    if (isCancelled) return;   // cancelled invoices never affect money totals
    totals.count += 1;
    totals.billed += r.TotalAmount;
    totals.paid += r.PaidAmount;
    totals.balance += r.BalanceAmount;
    if (r.Status === 'OVERDUE') totals.overdue += r.BalanceAmount;
  });

  return { rows: rows.slice(0, limit), totals: totals };
}

function invoicesGet_(p) {
  const id = reqStr_(p, 'invoiceId', 'Invoice ID');
  const inv = findOne_('INVOICES', 'InvoiceID', id);
  if (!inv) throw new AppError_('NOT_FOUND', 'Invoice not found.');
  const st = findOne_('STUDENTS', 'StudentID', inv.StudentID);
  const total = Number(inv.TotalAmount) || 0;
  const paid = Number(inv.PaidAmount) || 0;
  const bal = Math.max(0, total - paid);
  const payments = readAll_('PAYMENTS')
    .filter(x => x.InvoiceID === id)
    .sort((a, b) => String(b.PaymentDate).localeCompare(String(a.PaymentDate)))
    .map(x => ({
      PaymentID: x.PaymentID,
      Amount: Number(x.Amount) || 0,
      PaymentDate: x.PaymentDate,
      PaymentMode: x.PaymentMode,
      TransactionReference: x.TransactionReference,
      Status: x.Status,
      ReceiptID: x.ReceiptID,
      Notes: x.Notes,
      Allocations: parseAllocations_(x.Allocations)
    }));
  return {
    invoice: {
      InvoiceID: inv.InvoiceID, StudentID: inv.StudentID,
      StudentName: st ? st.Name : inv.StudentID,
      CurrentClass: st ? st.CurrentClass : '',
      Month: inv.Month, MonthLabel: monthLabel_(inv.Month),
      TotalAmount: total, PaidAmount: paid, BalanceAmount: bal,
      DueDate: inv.DueDate,
      Status: deriveInvoiceStatus_(total, paid, inv.DueDate, inv.Status),
      CreatedAt: inv.CreatedAt, UpdatedAt: inv.UpdatedAt
    },
    lines: invoiceLines_(inv),
    payments: payments
  };
}

/** Cancel an invoice. Money records stay; the invoice is just marked cancelled. */
function invoicesCancel_(session, p) {
  const id = reqStr_(p, 'invoiceId', 'Invoice ID');
  return withLock_(() => {
    const inv = findOne_('INVOICES', 'InvoiceID', id);
    if (!inv) throw new AppError_('NOT_FOUND', 'Invoice not found.');
    if (String(inv.Status).toUpperCase() === 'CANCELLED') return { ok: true, unchanged: true };
    if (Number(inv.PaidAmount) > 0) throw bad_('Cannot cancel an invoice that already has payments.');
    updateObject_('INVOICES', inv._row, { Status: 'CANCELLED', UpdatedAt: nowStr_() });
    logAdmin_(session, 'CANCEL_INVOICE', 'INVOICE', id, { reason: p.reason || '' });
    return { ok: true };
  });
}

function invoiceActionDefs_() {
  return {
    'invoices.list':    { perm: 'FINANCE_VIEW', run: (s, p) => invoicesList_(p) },
    'invoices.get':     { perm: 'FINANCE_VIEW', run: (s, p) => invoicesGet_(p) },
    'invoices.generate':{ perm: 'FINANCE_EDIT', run: (s, p) => invoicesGenerate_(s, p) },
    'invoices.cancel':  { perm: 'FINANCE_EDIT', run: (s, p) => invoicesCancel_(s, p) }
  };
}