/**
 * ============================================================
 *  CREATIVE MATH ZONE — StudentApi.gs
 *  Student-portal-only actions. Loaded alongside Api.gs;
 *  the ACTIONS_ table in Api.gs is patched to include these.
 * ============================================================
 */

function studentDashboard_(session) {
  const sid = session.linkedId;
  const st = findOne_('STUDENTS', 'StudentID', sid);
  if (!st) throw new AppError_('NOT_FOUND', 'Student record not found.');

  const subjects = readAll_('STUDENT_SUBJECTS').filter(r => r.StudentID === sid && isActive_(r.Status));

  const dayNames = ['SUNDAY','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'];
  const today = dayNames[nowDate_().getDay()];
  const todayClasses = readAll_('TIMETABLE')
    .filter(r => r.BatchID === st.CurrentBatch && String(r.Day).toUpperCase() === today && isActive_(r.Status))
    .sort((a,b) => String(a.StartTime).localeCompare(String(b.StartTime)))
    .map(t => ({
      TimetableID: t.TimetableID,
      StartTime: t.StartTime, EndTime: t.EndTime,
      SubjectName: subjectName_(t.SubjectID),
      TeacherName: teacherName_(t.TeacherID),
      RoomName: roomName_(t.RoomID)
    }));

  // Attendance over the last 30 days
  const from = Utilities.formatDate(new Date(Date.now() - 30*86400000), tz_(), 'yyyy-MM-dd');
  const rows = readAll_('ATTENDANCE').filter(r => r.StudentID === sid && r.Date >= from);
  const present = rows.filter(r => r.Status === 'PRESENT').length;
  const late = rows.filter(r => r.Status === 'LATE').length;
  const total = rows.length;
  const pct = total ? Math.round(((present + late * 0.5) / total) * 100) : 0;

  return {
    student: pub_(st),
    stats: {
      activeSubjects: subjects.length,
      attendancePct: pct,
      present: present,
      late: late,
      absent: total - present - late,
      totalSessions: total
    },
    todayClasses: todayClasses,
    recentNotices: noticesForStudent_(st, 3)
  };
}

function studentSubjects_(session) {
  return readAll_('STUDENT_SUBJECTS')
    .filter(r => r.StudentID === session.linkedId)
    .map(r => ({
      StudentSubjectID: r.StudentSubjectID,
      SubjectID: r.SubjectID, SubjectName: subjectName_(r.SubjectID),
      TeacherID: r.TeacherID, TeacherName: teacherName_(r.TeacherID),
      BatchID: r.BatchID, BatchName: batchName_(r.BatchID),
      StartDate: r.StartDate, EndDate: r.EndDate,
      Status: r.Status
    }))
    .sort((a,b) => String(b.StartDate).localeCompare(String(a.StartDate)));
}

function studentTimetable_(session) {
  const st = findOne_('STUDENTS', 'StudentID', session.linkedId);
  if (!st) throw new AppError_('NOT_FOUND', 'Student record not found.');
  return readAll_('TIMETABLE')
    .filter(r => r.BatchID === st.CurrentBatch && isActive_(r.Status))
    .map(r => ({
      TimetableID: r.TimetableID, Day: String(r.Day).toUpperCase(),
      StartTime: r.StartTime, EndTime: r.EndTime,
      SubjectName: subjectName_(r.SubjectID),
      TeacherName: teacherName_(r.TeacherID),
      RoomName: roomName_(r.RoomID)
    }));
}

function studentAttendance_(session, p) {
  const days = Math.min(Math.max(parseInt(p && p.days, 10) || 60, 1), 400);
  const from = Utilities.formatDate(new Date(Date.now() - days*86400000), tz_(), 'yyyy-MM-dd');
  const rows = readAll_('ATTENDANCE')
    .filter(r => r.StudentID === session.linkedId && r.Date >= from)
    .map(r => ({
      AttendanceID: r.AttendanceID,
      Date: r.Date,
      SubjectName: subjectName_(r.SubjectID),
      BatchName: batchName_(r.BatchID),
      Status: r.Status, Method: r.Method, MarkedAt: r.MarkedAt
    }))
    .sort((a,b) => String(b.Date).localeCompare(String(a.Date)));
  const present = rows.filter(r => r.Status === 'PRESENT').length;
  const late = rows.filter(r => r.Status === 'LATE').length;
  const absent = rows.filter(r => r.Status === 'ABSENT').length;
  const pct = rows.length ? Math.round(((present + late * 0.5) / rows.length) * 100) : 0;
  return { from: from, rows: rows, summary: { present: present, late: late, absent: absent, total: rows.length, pct: pct } };
}

const STUDENT_SELF_EDITABLE_ = ['Mobile','Email','Address','ParentName','ParentMobile','ParentWhatsApp','ParentEmail'];

function studentUpdateProfile_(session, p) {
  const changes = (p && p.changes) || {};
  const allowed = {};
  STUDENT_SELF_EDITABLE_.forEach(k => { if (k in changes) allowed[k] = changes[k]; });
  if (!Object.keys(allowed).length) throw new AppError_('BAD_REQUEST', 'Nothing to update.');

  const spec = {
    Mobile: { type: 'mobile' }, Email: { type: 'email' }, Address: { max: 300 },
    ParentName: { max: 100 }, ParentMobile: { type: 'mobile' },
    ParentWhatsApp: { type: 'mobile' }, ParentEmail: { type: 'email' }
  };
  const data = validateFields_(spec, allowed, true);

  return withLock_(() => {
    const st = findOne_('STUDENTS', 'StudentID', session.linkedId);
    if (!st) throw new AppError_('NOT_FOUND', 'Student record not found.');
    const d = diffFields_(st, data);
    if (!Object.keys(d.patch).length) return { changed: [] };
    updateObject_('STUDENTS', st._row, Object.assign({}, d.patch, { UpdatedAt: nowStr_() }));
    logAdmin_(session, 'STUDENT_SELF_EDIT', 'STUDENT', session.linkedId, d.diff);
    return { changed: Object.keys(d.patch) };
  });
}

function noticesForStudent_(st, limit) {
  const today = todayStr_();
  const rows = readAll_('NOTICES').filter(n => {
    if (String(n.Status).toUpperCase() !== 'ACTIVE') return false;
    if (n.ExpiresAt && n.ExpiresAt < today) return false;
    const aud = String(n.Audience || '').toUpperCase();
    if (aud === 'ALL' || aud === 'STUDENTS') return true;
    if (aud === 'BATCH' && n.BatchID === st.CurrentBatch) return true;
    return false;
  });
  rows.sort((a,b) => String(b.PostedAt || '').localeCompare(String(a.PostedAt || '')));
  return rows.slice(0, limit || 50).map(n => pub_(n));
}

function noticesList_(session) {
  const st = findOne_('STUDENTS', 'StudentID', session.linkedId);
  if (!st) throw new AppError_('NOT_FOUND', 'Student record not found.');
  return noticesForStudent_(st, 100);
}

function subjectName_(id) { const r = findOne_('SUBJECTS', 'SubjectID', id); return r ? r.SubjectName : id; }
function teacherName_(id) { const r = findOne_('TEACHERS', 'TeacherID', id); return r ? r.Name : id; }
function batchName_(id)   { const r = findOne_('BATCHES',  'BatchID', id);   return r ? r.BatchName : id; }
function roomName_(id)    { const r = findOne_('ROOMS',    'RoomID', id);    return r ? r.RoomName : id; }

/** Called by api() in Api.gs — returns the student-portal action table. */
/* ============================================================
 *  Attendance by code: built for a whole class tapping at once
 *   - open classes and class rosters are remembered for a short time (Cache)
 *   - each student's entry first goes into the cache (no waiting), then
 *     whoever holds the lock writes EVERY waiting entry in one batch
 *   - a student only gets "marked" after their row is really in the sheet
 * ============================================================ */

const ATT_PENDING_TTL_ = 120;
const ATT_DONE_TTL_ = 1800;
const attQKey_ = (sid, stu) => 'AQ_' + sid + '_' + stu;
const attDKey_ = (sid, stu) => 'AD_' + sid + '_' + stu;

/** Teacher / admin changed this mark: forget the "already marked" shortcut for that student. */
function attForget_(sid, stu) {
  try { CacheService.getScriptCache().remove(attDKey_(sid, stu)); } catch (e) { /* optional */ }
}

/** Classes that are open right now (with subject name), remembered for 20 seconds. */
function openSessions_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('OPEN_SESS');
  if (hit) return JSON.parse(hit);
  const subj = {};
  readAll_('SUBJECTS').forEach(x => { subj[x.SubjectID] = x.SubjectName; });
  const list = readAll_('CLASS_SESSIONS').filter(s => s.Status === 'OPEN').map(s => ({
    SessionID: s.SessionID, AttendanceCode: s.AttendanceCode, CodeCreatedAt: s.CodeCreatedAt, CodeExpiresAt: s.CodeExpiresAt,
    SubjectID: s.SubjectID, BatchID: s.BatchID, Date: s.Date, SubjectName: subj[s.SubjectID] || s.SubjectID
  }));
  cache.put('OPEN_SESS', JSON.stringify(list), 20);
  return list;
}

/** Active students who take this class's subject in its batch, remembered for 10 minutes. */
function sessionRosterIds_(s) {
  const cache = CacheService.getScriptCache();
  const key = 'ROS_' + s.SessionID + '_' + rosterGen_();
  const hit = cache.get(key);
  const toMap = arr => { const m = {}; arr.forEach(id => { m[id] = true; }); return m; };
  if (hit) return toMap(JSON.parse(hit));
  const ids = {};
  readAll_('STUDENT_SUBJECTS')
    .filter(r => r.SubjectID === s.SubjectID && r.BatchID === s.BatchID && isActive_(r.Status))
    .forEach(r => { ids[r.StudentID] = true; });
  const active = {};
  readAll_('STUDENTS').forEach(x => { if (isActive_(x.Status)) active[x.StudentID] = true; });
  const out = Object.keys(ids).filter(id => active[id]);
  cache.put(key, JSON.stringify(out), 600);
  return toMap(out);
}

/**
 * Writes every waiting code-entry of this class in ONE batch. Call inside the lock.
 * have = students already in the sheet for this session; own = { id, s, t } entry that must be included.
 */
function attFlush_(chosen, have, own) {
  const cache = CacheService.getScriptCache();
  const sid = chosen.SessionID, prefix = 'AQ_' + sid + '_';
  const keys = Object.keys(sessionRosterIds_(chosen)).filter(id => !have[id]).map(id => prefix + id);
  const pend = {};
  for (let i = 0; i < keys.length; i += 100) Object.assign(pend, cache.getAll(keys.slice(i, i + 100)));
  if (own) pend[prefix + own.id] = JSON.stringify({ s: own.s, t: own.t });

  const todo = [];
  Object.keys(pend).forEach(k => {
    const id = k.slice(prefix.length);
    if (!id || have[id]) return;
    let v; try { v = JSON.parse(pend[k]); } catch (e) { return; }
    if (v && v.s) todo.push({ id: id, s: v.s, t: v.t || nowStr_() });
  });
  if (!todo.length) return todo;

  let max = 0;
  const re = /^ATT-(\d+)$/;
  readColumn_('ATTENDANCE', 'AttendanceID').forEach(v => { const m = re.exec(String(v)); if (m) max = Math.max(max, parseInt(m[1], 10)); });
  const ay = currentAcademicYear_();
  appendObjects_('ATTENDANCE', todo.map((x, i) => ({
    AttendanceID: 'ATT-' + pad_(max + 1 + i, 5), SessionID: sid, StudentID: x.id,
    SubjectID: chosen.SubjectID, BatchID: chosen.BatchID, Date: chosen.Date,
    Status: x.s, MarkedBy: x.id, MarkedAt: x.t, Method: 'CODE', LocationVerified: 'FALSE', AcademicYear: ay
  })));
  for (let i = 0; i < todo.length; i += 100) {
    const part = todo.slice(i, i + 100), done = {};
    part.forEach(x => { done[attDKey_(sid, x.id)] = JSON.stringify({ s: x.s, t: x.t }); });
    cache.putAll(done, ATT_DONE_TTL_);
    cache.removeAll(part.map(x => prefix + x.id));
  }
  logAdmin_({ uid: '', username: 'students', role: '' }, 'MARK_ATTENDANCE_BATCH', 'CLASS_SESSION', sid, { method: 'CODE', count: todo.length });
  return todo;
}

/** Write out anything still waiting for this class (used before closing or marking everyone). Call inside the lock. */
function attFlushPending_(s) {
  const have = {};
  readWhere_('ATTENDANCE', 'SessionID', s.SessionID).forEach(a => { have[a.StudentID] = true; });
  attFlush_(s, have, null);
}

function attCommit_(chosen, stu, entry) {
  const cache = CacheService.getScriptCache();
  const sid = chosen.SessionID;
  const reply = (st, at, again) => ({ ok: true, alreadyMarked: !!again, status: st, subjectName: chosen.SubjectName, markedAt: at });

  const d0 = cache.get(attDKey_(sid, stu));
  if (d0) { const d = JSON.parse(d0); return reply(d.s, d.t, false); } // another student's batch already wrote our entry

  const have = {};
  readWhere_('ATTENDANCE', 'SessionID', sid).forEach(a => { have[a.StudentID] = a; });
  if (have[stu]) { // marked earlier (and the shortcut was forgotten)
    const a = have[stu];
    cache.remove(attQKey_(sid, stu));
    cache.put(attDKey_(sid, stu), JSON.stringify({ s: a.Status, t: a.MarkedAt }), ATT_DONE_TTL_);
    return reply(a.Status, a.MarkedAt, true);
  }
  const todo = attFlush_(chosen, have, { id: stu, s: entry.s, t: entry.t });
  const mine = todo.find(x => x.id === stu);
  return reply(mine.s, mine.t, false);
}

/** Student enters the 4-digit code shown by the teacher to mark themselves present. */
function studentEnterAttendanceCode_(session, p) {
  const code = String(p.code || '').trim();
  if (!/^\d{4}$/.test(code)) throw new AppError_('BAD_CODE', 'Enter the 4-digit code shown by your teacher.');
  const stu = session.linkedId;
  const now = nowStr_();

  const open = openSessions_().filter(s => String(s.AttendanceCode) === code && s.CodeExpiresAt && s.CodeExpiresAt >= now);
  if (!open.length) throw new AppError_('BAD_CODE', 'That code is wrong or has expired. Ask your teacher for the current code.');
  let chosen = null;
  for (const s of open) { if (sessionRosterIds_(s)[stu]) { chosen = s; break; } }
  if (!chosen) throw new AppError_('NOT_IN_CLASS', 'That class is not one of your subjects.');

  const cache = CacheService.getScriptCache();
  const done = cache.get(attDKey_(chosen.SessionID, stu));
  if (done) { const d = JSON.parse(done); return { ok: true, alreadyMarked: true, status: d.s, subjectName: chosen.SubjectName, markedAt: d.t }; }

  const created = chosen.CodeCreatedAt || now;
  const diffSec = Math.round((new Date(now.replace(' ', 'T')) - new Date(created.replace(' ', 'T'))) / 1000);
  const entry = { s: diffSec > 120 ? 'LATE' : 'PRESENT', t: now };
  cache.put(attQKey_(chosen.SessionID, stu), JSON.stringify(entry), ATT_PENDING_TTL_); // joins the next batch, no waiting
  return withLock_(() => attCommit_(chosen, stu, entry), 45000);
}

/** The logged-in student's own invoices and payments. Cancelled invoices and voided payments are hidden. */
function studentInvoices_(session) {
  const sid = session.linkedId;
  const pays = readAll_('PAYMENTS').filter(x => x.StudentID === sid && String(x.Status).toUpperCase() !== 'VOID');
  const byInvoice = {};
  pays.forEach(x => { (byInvoice[x.InvoiceID] = byInvoice[x.InvoiceID] || []).push(x); });

  const rows = readAll_('INVOICES')
    .filter(i => i.StudentID === sid && String(i.Status).toUpperCase() !== 'CANCELLED')
    .map(i => {
      const total = Number(i.TotalAmount) || 0, paid = Number(i.PaidAmount) || 0;
      return {
        InvoiceID: i.InvoiceID, Month: i.Month, MonthLabel: monthLabel_(i.Month),
        TotalAmount: total, PaidAmount: paid, BalanceAmount: Math.max(0, total - paid),
        DueDate: i.DueDate, Status: deriveInvoiceStatus_(total, paid, i.DueDate, i.Status),
        Lines: invoiceLines_(i).map(l => ({
          subjectId: l.subjectId, subjectName: l.subjectName, standardAmount: l.standardAmount, discountAmount: l.discountAmount,
          finalAmount: l.finalAmount, paidAmount: l.paidAmount, balanceAmount: l.balanceAmount
        })),
        Payments: (byInvoice[i.InvoiceID] || [])
          .sort((a, b) => String(b.PaymentDate).localeCompare(String(a.PaymentDate)))
          .map(x => ({ PaymentDate: x.PaymentDate, Amount: Number(x.Amount) || 0, PaymentMode: x.PaymentMode, ReceiptID: x.ReceiptID, Allocations: parseAllocations_(x.Allocations) }))
      };
    })
    .sort((a, b) => String(b.Month).localeCompare(String(a.Month)));

  const totals = { billed: 0, paid: 0, balance: 0, overdue: 0 };
  rows.forEach(r => {
    totals.billed += r.TotalAmount; totals.paid += r.PaidAmount; totals.balance += r.BalanceAmount;
    if (r.Status === 'OVERDUE') totals.overdue += r.BalanceAmount;
  });
  return { rows: rows, totals: totals };
}

function centreInfo_() {
  return {
    name: getSetting_('CENTRE_NAME', 'Creative Math Zone'), tagline: getSetting_('TAGLINE', ''),
    address: getSetting_('ADDRESS', ''), mobile: getSetting_('MOBILE', ''), email: getSetting_('EMAIL', ''),
    website: getSetting_('WEBSITE', ''), academicYear: currentAcademicYear_()
  };
}

/** A receipt the logged-in student paid for. Voided receipts and other students' receipts are not available. */
function studentReceipt_(session, p) {
  const id = reqStr_(p, 'receiptId', 'Receipt ID');
  const r = findOne_('RECEIPTS', 'ReceiptID', id);
  if (!r || r.StudentID !== session.linkedId || String(r.Status).toUpperCase() === 'VOID') {
    throw new AppError_('NOT_FOUND', 'Receipt not found.');
  }
  const d = receiptGet_({ receiptId: id });
  d.receipt.CreatedBy = ''; d.receipt.VoidedBy = ''; d.receipt.VoidReason = '';
  return d;
}

/** One of the student's own invoices, with its subject lines and valid (not voided) payments. */
function studentInvoiceDoc_(session, p) {
  const id = reqStr_(p, 'invoiceId', 'Invoice ID');
  const inv = findOne_('INVOICES', 'InvoiceID', id);
  if (!inv || inv.StudentID !== session.linkedId || String(inv.Status).toUpperCase() === 'CANCELLED') {
    throw new AppError_('NOT_FOUND', 'Invoice not found.');
  }
  const st = findOne_('STUDENTS', 'StudentID', inv.StudentID);
  const total = Number(inv.TotalAmount) || 0, paid = Number(inv.PaidAmount) || 0;
  const payments = readAll_('PAYMENTS')
    .filter(x => x.InvoiceID === id && String(x.Status).toUpperCase() !== 'VOID')
    .sort((a, b) => String(a.PaymentDate).localeCompare(String(b.PaymentDate)) || String(a.ReceiptID).localeCompare(String(b.ReceiptID)))
    .map(x => ({
      PaymentDate: x.PaymentDate, Amount: Number(x.Amount) || 0, PaymentMode: x.PaymentMode,
      ReceiptID: x.ReceiptID, Allocations: parseAllocations_(x.Allocations)
    }));
  return {
    invoice: {
      InvoiceID: inv.InvoiceID, Month: inv.Month, MonthLabel: monthLabel_(inv.Month), DueDate: inv.DueDate,
      Status: deriveInvoiceStatus_(total, paid, inv.DueDate, inv.Status),
      TotalAmount: total, PaidAmount: paid, BalanceAmount: Math.max(0, total - paid)
    },
    lines: invoiceLines_(inv),
    payments: payments,
    student: st ? { StudentID: st.StudentID, Name: st.Name, CurrentClass: st.CurrentClass, ParentName: st.ParentName } : null,
    centre: centreInfo_()
  };
}

function studentActionDefs_() {
  return {
    'student.dashboard':     { perm: 'SELF_VIEW', run: (s) => studentDashboard_(s) },
    'student.subjects':      { perm: 'SELF_VIEW', run: (s) => studentSubjects_(s) },
    'student.timetable':     { perm: 'SELF_VIEW', run: (s) => studentTimetable_(s) },
    'student.attendance':    { perm: 'SELF_VIEW', run: (s, p) => studentAttendance_(s, p) },
    'student.updateProfile': { perm: 'SELF_VIEW', run: (s, p) => studentUpdateProfile_(s, p) },
    'notices.list':          { perm: 'NOTICE_VIEW', run: (s) => noticesList_(s) },
    'student.enterCode':     { perm: 'ATTENDANCE_SELF', run: (s, p) => studentEnterAttendanceCode_(s, p) },
    'student.invoices':      { perm: 'SELF_VIEW', run: (s) => studentInvoices_(s) },
    'student.receipt':       { perm: 'SELF_VIEW', run: (s, p) => studentReceipt_(s, p) },
    'student.invoiceDoc':    { perm: 'SELF_VIEW', run: (s, p) => studentInvoiceDoc_(s, p) }
  };
}