/**
 * ============================================================
 *  CREATIVE MATH ZONE — PaymentsApi.gs
 *  Record payments (per subject), generate receipts, void.
 *
 *  A payment is split across the invoice's subject lines ("allocations"):
 *    payments.record { invoiceId, allocations: [{ subjectId, amount }], mode, ... }
 *  The old form { invoiceId, amount, mode } still works: the amount is
 *  spread over the subjects in order (first subject first).
 *  Each subject line keeps its own paidAmount inside 15_Invoices.LineItems,
 *  and the payment remembers its split in 16_Payments.Allocations (JSON).
 *  Needs invoiceLines_ + serializeLines_ from InvoiceApi.gs.
 * ============================================================
 */

const PAYMENT_MODES_ = ['CASH', 'UPI', 'BANK_TRANSFER', 'CHEQUE'];

function nextReceiptId_() {
  const dateStr = Utilities.formatDate(nowDate_(), tz_(), 'yyyyMMdd');
  const prefix = 'CMZ-' + dateStr + '-';
  let max = 0;
  const re = new RegExp('^' + escapeRe_(prefix) + '(\\d+)$');
  readColumn_('RECEIPTS', 'ReceiptID').forEach(v => {
    const m = re.exec(String(v));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return prefix + pad_(max + 1, 3);
}

function round2_(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/** Reads the Allocations cell: [{ subjectId, subjectName, amount }]. Empty for payments made before per-subject tracking. */
function parseAllocations_(s) {
  if (!s) return [];
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? a.map(x => ({
      subjectId: String((x && x.subjectId) || ''), subjectName: (x && x.subjectName) || '', amount: Number(x && x.amount) || 0
    })) : [];
  } catch (e) { return []; }
}

/** Adds a column to a sheet if it is missing, so no one has to re-run setup first. */
function ensureColumn_(key, header) {
  const sh = getSheet_(key);
  const have = headersOf_(sh);
  if (have.indexOf(header) >= 0) return;
  const col = have.length + 1;
  sh.getRange(1, col).setValue(header);
  sh.getRange(2, col, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('@');
}

function recordPayment_(session, p) {
  const invoiceId = reqStr_(p, 'invoiceId', 'Invoice ID');
  const data = validateFields_({
    PaymentMode:          { req: true, type: 'enum', values: PAYMENT_MODES_ },
    TransactionReference: { max: 100 },
    Notes:                { max: 500 },
    PaymentDate:          { type: 'date' }
  }, {
    PaymentMode:          p.mode,
    TransactionReference: p.reference || '',
    Notes:                p.notes || '',
    PaymentDate:          p.paymentDate || todayStr_()
  }, false);

  const wanted = (Array.isArray(p.allocations) && p.allocations.length) ? p.allocations : null;
  const lump = wanted ? null : validateFields_(
    { Amount: { req: true, type: 'num', min: 1, max: 10000000 } }, { Amount: p.amount }, false).Amount;

  return withLock_(() => {
    ensureColumn_('PAYMENTS', 'Allocations');
    const inv = findOne_('INVOICES', 'InvoiceID', invoiceId);
    if (!inv) throw new AppError_('NOT_FOUND', 'Invoice not found.');
    if (String(inv.Status).toUpperCase() === 'CANCELLED') throw bad_('This invoice is cancelled.');
    const total = Number(inv.TotalAmount) || 0;
    const paid = Number(inv.PaidAmount) || 0;
    const balance = Math.max(0, total - paid);
    if (balance <= 0) throw bad_('This invoice is already fully paid.');

    const lines = invoiceLines_(inv);
    const allocs = [];
    if (wanted) {
      const seen = {};
      wanted.forEach(a => {
        const sid = String((a && a.subjectId) || '');
        const amt = round2_(a && a.amount);
        if (!isFinite(amt) || amt <= 0) return; // blank rows are ignored
        if (seen[sid]) throw bad_('A subject appears twice.');
        seen[sid] = true;
        const line = lines.find(l => l.subjectId === sid);
        if (!line) throw bad_('That subject is not on this invoice.');
        if (amt > line.balanceAmount + 0.005) {
          throw bad_(line.subjectName + ': amount is more than its balance (₹' + line.balanceAmount + ').');
        }
        allocs.push({ subjectId: sid, subjectName: line.subjectName, amount: amt });
      });
      if (!allocs.length) throw bad_('Enter an amount for at least one subject.');
    } else {
      if (lump > balance + 0.005) throw bad_('Amount exceeds the balance (₹' + balance + ').');
      let left = lump;
      lines.forEach(l => {
        if (left <= 0 || l.balanceAmount <= 0) return;
        const a = round2_(Math.min(left, l.balanceAmount));
        allocs.push({ subjectId: l.subjectId, subjectName: l.subjectName, amount: a });
        left = round2_(left - a);
      });
      if (left > 0.005) throw bad_('Amount exceeds the balance (₹' + balance + ').');
    }

    const amount = round2_(allocs.reduce((s, a) => s + a.amount, 0));
    if (amount < 1) throw bad_('The total must be at least ₹1.');
    if (amount > balance + 0.005) throw bad_('Amount exceeds the balance (₹' + balance + ').');

    const paymentId = nextId_('PAYMENTS', 'PaymentID', 'PAY-', 5);
    const receiptId = nextReceiptId_();

    appendObject_('PAYMENTS', {
      PaymentID: paymentId, StudentID: inv.StudentID, InvoiceID: invoiceId,
      PaymentDate: data.PaymentDate, Amount: amount,
      PaymentMode: data.PaymentMode, TransactionReference: data.TransactionReference,
      ReceivedBy: session.username, Status: 'PAID', Notes: data.Notes,
      ReceiptID: receiptId, AcademicYear: currentAcademicYear_(),
      VoidedBy: '', VoidDate: '', VoidReason: '', Allocations: JSON.stringify(allocs)
    });

    appendObject_('RECEIPTS', {
      ReceiptID: receiptId, PaymentID: paymentId, StudentID: inv.StudentID,
      ReceiptDate: data.PaymentDate, Amount: amount, Format: 'A5', Status: 'PAID',
      VoidedBy: '', VoidDate: '', VoidReason: '',
      AcademicYear: currentAcademicYear_(), CreatedBy: session.username, CreatedAt: nowStr_()
    });

    allocs.forEach(a => {
      const l = lines.find(x => x.subjectId === a.subjectId);
      l.paidAmount = round2_(l.paidAmount + a.amount);
    });
    const newPaid = round2_(lines.reduce((s, l) => s + l.paidAmount, 0));
    const newBalance = Math.max(0, round2_(total - newPaid));
    const newStatus = deriveInvoiceStatus_(total, newPaid, inv.DueDate, '');
    updateObject_('INVOICES', inv._row, {
      LineItems: serializeLines_(lines), PaidAmount: newPaid, BalanceAmount: newBalance, Status: newStatus, UpdatedAt: nowStr_()
    });

    logAdmin_(session, 'ADD_PAYMENT', 'PAYMENT', paymentId,
      { invoiceId: invoiceId, amount: amount, mode: data.PaymentMode, receiptId: receiptId,
        subjects: allocs.map(a => a.subjectId + ':' + a.amount).join(',') });
    logAdmin_(session, 'CREATE_RECEIPT', 'RECEIPT', receiptId,
      { paymentId: paymentId, amount: amount });

    return { paymentId: paymentId, receiptId: receiptId, amount: amount,
             invoiceStatus: newStatus, balance: newBalance, allocations: allocs };
  });
}

function receiptsList_(p) {
  const q = String((p && p.search) || '').trim().toLowerCase();
  const from = String((p && p.from) || '');
  const to = String((p && p.to) || '');
  const limit = Math.min(Math.max(parseInt(p && p.limit, 10) || 200, 1), 1000);
  const students = {};
  readAll_('STUDENTS').forEach(s => { students[s.StudentID] = s; });

  return readAll_('RECEIPTS')
    .filter(r => !from || r.ReceiptDate >= from)
    .filter(r => !to   || r.ReceiptDate <= to)
    .filter(r => !q || String(r.ReceiptID).toLowerCase().indexOf(q) >= 0 ||
                 String(r.StudentID).toLowerCase().indexOf(q) >= 0 ||
                 (students[r.StudentID] && String(students[r.StudentID].Name).toLowerCase().indexOf(q) >= 0))
    .sort((a, b) => String(b.ReceiptDate).localeCompare(String(a.ReceiptDate)) ||
                    String(b.ReceiptID).localeCompare(String(a.ReceiptID)))
    .slice(0, limit)
    .map(r => ({
      ReceiptID: r.ReceiptID, StudentID: r.StudentID,
      StudentName: students[r.StudentID] ? students[r.StudentID].Name : r.StudentID,
      ReceiptDate: r.ReceiptDate, Amount: Number(r.Amount) || 0,
      Status: r.Status, CreatedBy: r.CreatedBy
    }));
}

function receiptGet_(p) {
  const id = reqStr_(p, 'receiptId', 'Receipt ID');
  const r = findOne_('RECEIPTS', 'ReceiptID', id);
  if (!r) throw new AppError_('NOT_FOUND', 'Receipt not found.');
  const payment = findOne_('PAYMENTS', 'PaymentID', r.PaymentID);
  const st = findOne_('STUDENTS', 'StudentID', r.StudentID);
  const inv = payment ? findOne_('INVOICES', 'InvoiceID', payment.InvoiceID) : null;

  return {
    receipt: {
      ReceiptID: r.ReceiptID, ReceiptDate: r.ReceiptDate, Amount: Number(r.Amount) || 0,
      Status: r.Status, Format: r.Format, CreatedBy: r.CreatedBy, CreatedAt: r.CreatedAt,
      VoidedBy: r.VoidedBy, VoidDate: r.VoidDate, VoidReason: r.VoidReason
    },
    payment: payment ? {
      PaymentID: payment.PaymentID, Mode: payment.PaymentMode,
      Reference: payment.TransactionReference, Notes: payment.Notes,
      PaymentDate: payment.PaymentDate, Allocations: parseAllocations_(payment.Allocations)
    } : null,
    invoice: inv ? {
      InvoiceID: inv.InvoiceID, Month: inv.Month, MonthLabel: monthLabel_(inv.Month),
      LineItems: invoiceLines_(inv),
      TotalAmount: Number(inv.TotalAmount) || 0,
      PaidAmount: Number(inv.PaidAmount) || 0,
      BalanceAmount: Number(inv.BalanceAmount) || 0
    } : null,
    student: st ? {
      StudentID: st.StudentID, Name: st.Name, CurrentClass: st.CurrentClass,
      CurrentBatch: st.CurrentBatch, ParentName: st.ParentName,
      Mobile: st.Mobile || st.ParentMobile
    } : null,
    centre: {
      name: getSetting_('CENTRE_NAME', 'Creative Math Zone'),
      tagline: getSetting_('TAGLINE', ''),
      address: getSetting_('ADDRESS', ''),
      mobile: getSetting_('MOBILE', ''),
      email: getSetting_('EMAIL', ''),
      website: getSetting_('WEBSITE', ''),
      academicYear: currentAcademicYear_()
    }
  };
}

function receiptVoid_(session, p) {
  const id = reqStr_(p, 'receiptId', 'Receipt ID');
  const reason = String(p.reason || '').slice(0, 200);
  if (!reason) throw bad_('Please give a reason for voiding.');

  return withLock_(() => {
    const r = findOne_('RECEIPTS', 'ReceiptID', id);
    if (!r) throw new AppError_('NOT_FOUND', 'Receipt not found.');
    if (String(r.Status).toUpperCase() === 'VOID') return { ok: true, unchanged: true };
    const pay = findOne_('PAYMENTS', 'PaymentID', r.PaymentID);
    if (!pay) throw new AppError_('NOT_FOUND', 'Linked payment not found.');
    if (String(pay.Status).toUpperCase() === 'VOID') return { ok: true, unchanged: true };

    updateObject_('RECEIPTS', r._row, {
      Status: 'VOID', VoidedBy: session.username, VoidDate: nowStr_(), VoidReason: reason
    });
    updateObject_('PAYMENTS', pay._row, {
      Status: 'VOID', VoidedBy: session.username, VoidDate: nowStr_(), VoidReason: reason
    });

    const inv = findOne_('INVOICES', 'InvoiceID', pay.InvoiceID);
    if (inv && String(inv.Status).toUpperCase() !== 'CANCELLED') {
      const total = Number(inv.TotalAmount) || 0;
      const amt = Number(pay.Amount) || 0;
      const lines = invoiceLines_(inv);
      const allocs = parseAllocations_(pay.Allocations);
      if (allocs.length) {
        // give each subject back exactly what this payment put on it
        allocs.forEach(a => {
          const l = lines.find(x => x.subjectId === a.subjectId);
          if (l) l.paidAmount = Math.max(0, round2_(l.paidAmount - a.amount));
        });
      } else {
        // payment made before per-subject tracking: take it back from the last subject first
        let left = amt;
        for (let i = lines.length - 1; i >= 0 && left > 0; i--) {
          const d = Math.min(left, lines[i].paidAmount);
          lines[i].paidAmount = round2_(lines[i].paidAmount - d);
          left = round2_(left - d);
        }
      }
      const newPaid = round2_(lines.reduce((s, l) => s + l.paidAmount, 0));
      const newBalance = Math.max(0, round2_(total - newPaid));
      const newStatus = deriveInvoiceStatus_(total, newPaid, inv.DueDate, '');
      updateObject_('INVOICES', inv._row, {
        LineItems: serializeLines_(lines), PaidAmount: newPaid, BalanceAmount: newBalance, Status: newStatus, UpdatedAt: nowStr_()
      });
    }

    logAdmin_(session, 'VOID_PAYMENT', 'PAYMENT', pay.PaymentID, { reason: reason });
    logAdmin_(session, 'VOID_RECEIPT', 'RECEIPT', id, { reason: reason });
    return { ok: true };
  });
}

function paymentActionDefs_() {
  return {
    'payments.record': { perm: 'FINANCE_EDIT', run: (s, p) => recordPayment_(s, p) },
    'receipts.list':   { perm: 'FINANCE_VIEW', run: (s, p) => receiptsList_(p) },
    'receipts.get':    { perm: 'FINANCE_VIEW', run: (s, p) => receiptGet_(p) },
    'receipts.void':   { perm: 'FINANCE_EDIT', run: (s, p) => receiptVoid_(s, p) }
  };
}
