/**
 * ============================================================
 *  CREATIVE MATH ZONE — TeacherApi.gs
 *  Teacher-portal actions: today's classes, start class,
 *  live attendance status, manual marking, income.
 * ============================================================
 */

function teacherDashboard_(session) {
  const tid = session.linkedId;
  const t = findOne_('TEACHERS', 'TeacherID', tid);
  if (!t) throw new AppError_('NOT_FOUND', 'Teacher record not found.');

  const assigned = readAll_('STUDENT_SUBJECTS').filter(r => r.TeacherID === tid && isActive_(r.Status));
  const uniqueStudents = {};
  assigned.forEach(r => { uniqueStudents[r.StudentID] = true; });
  const subjectSet = {};
  assigned.forEach(r => { subjectSet[r.SubjectID] = true; });

  const dayNames = ['SUNDAY','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'];
  const today = dayNames[nowDate_().getDay()];
  const sessionsToday = readAll_('CLASS_SESSIONS').filter(s => s.Date === todayStr_());

  const todayClasses = readAll_('TIMETABLE')
    .filter(r => r.TeacherID === tid && String(r.Day).toUpperCase() === today && isActive_(r.Status))
    .sort((a,b) => String(a.StartTime).localeCompare(String(b.StartTime)))
    .map(tt => {
      const open = sessionsToday.find(s => s.TimetableID === tt.TimetableID && s.Status === 'OPEN');
      const closed = sessionsToday.find(s => s.TimetableID === tt.TimetableID && s.Status === 'CLOSED');
      return {
        TimetableID: tt.TimetableID,
        StartTime: tt.StartTime, EndTime: tt.EndTime,
        BatchID: tt.BatchID, BatchName: batchName_(tt.BatchID),
        SubjectID: tt.SubjectID, SubjectName: subjectName_(tt.SubjectID),
        RoomID: tt.RoomID, RoomName: roomName_(tt.RoomID),
        ActiveSessionID: open ? open.SessionID : null,
        ClosedSessionID: closed ? closed.SessionID : null
      };
    });

  return {
    teacher: pub_(t, can_(session, 'TEACHER_INCOME_VIEW') ? [] : ['IncomeMethod','DefaultRatePerStudent','IncomeVisibleToTeacher']),
    stats: {
      students: Object.keys(uniqueStudents).length,
      subjects: Object.keys(subjectSet).length,
      todayClasses: todayClasses.length
    },
    todayClasses: todayClasses
  };
}

function teacherTimetable_(session) {
  return readAll_('TIMETABLE')
    .filter(r => r.TeacherID === session.linkedId && isActive_(r.Status))
    .map(t => ({
      TimetableID: t.TimetableID, Day: String(t.Day).toUpperCase(),
      StartTime: t.StartTime, EndTime: t.EndTime,
      BatchID: t.BatchID, BatchName: batchName_(t.BatchID),
      SubjectID: t.SubjectID, SubjectName: subjectName_(t.SubjectID),
      RoomID: t.RoomID, RoomName: roomName_(t.RoomID)
    }));
}

function teacherMyStudents_(session) {
  const tid = session.linkedId;
  const assigned = readAll_('STUDENT_SUBJECTS').filter(r => r.TeacherID === tid && isActive_(r.Status));
  const groups = {};
  assigned.forEach(r => {
    const key = r.SubjectID + '|' + r.BatchID;
    if (!groups[key]) groups[key] = { subjectId: r.SubjectID, subjectName: subjectName_(r.SubjectID),
                                      batchId: r.BatchID, batchName: batchName_(r.BatchID), students: [] };
    groups[key].students.push(r.StudentID);
  });
  const all = {};
  readAll_('STUDENTS').forEach(s => { all[s.StudentID] = s; });
  return Object.keys(groups).map(k => {
    const g = groups[k];
    const students = g.students.map(sid => all[sid])
      .filter(s => s && isActive_(s.Status))
      .map(s => ({ StudentID: s.StudentID, Name: s.Name, RollNo: s.RollNo || '' }))
      .sort((a,b) => String(a.RollNo || a.Name).localeCompare(String(b.RollNo || b.Name)));
    return { subjectId: g.subjectId, subjectName: g.subjectName, batchId: g.batchId, batchName: g.batchName, students: students };
  }).sort((a,b) => a.subjectName.localeCompare(b.subjectName) || a.batchName.localeCompare(b.batchName));
}

function teacherStudentsFor_(teacherId, batchId, subjectId) {
  const cache = CacheService.getScriptCache();
  const key = 'TSF_' + teacherId + '_' + batchId + '_' + subjectId + '_' + rosterGen_();
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const out = teacherStudentsForRaw_(teacherId, batchId, subjectId);
  try { cache.put(key, JSON.stringify(out), 300); } catch (e) { /* too big to remember: fine */ }
  return out;
}

function teacherStudentsForRaw_(teacherId, batchId, subjectId) {
  const ids = {};
  readAll_('STUDENT_SUBJECTS')
    .filter(r => r.TeacherID === teacherId && r.BatchID === batchId && r.SubjectID === subjectId && isActive_(r.Status))
    .forEach(r => { ids[r.StudentID] = true; });
  if (!Object.keys(ids).length) return [];
  return readAll_('STUDENTS')
    .filter(s => ids[s.StudentID] && isActive_(s.Status))
    .map(s => ({ StudentID: s.StudentID, Name: s.Name, RollNo: s.RollNo || '' }))
    .sort((a,b) => String(a.RollNo || a.Name).localeCompare(String(b.RollNo || b.Name)));
}

function newAttendanceCode_() {
  const active = readAll_('CLASS_SESSIONS').filter(s => s.Status === 'OPEN').map(s => String(s.AttendanceCode));
  for (let i = 0; i < 100; i++) {
    const c = String(Math.floor(1000 + Math.random() * 9000));
    if (active.indexOf(c) < 0) return c;
  }
  return String(Math.floor(1000 + Math.random() * 9000));
}

function teacherStartClass_(session, p) {
  const timetableId = reqStr_(p, 'timetableId', 'Timetable ID');
  const tt = findOne_('TIMETABLE', 'TimetableID', timetableId);
  if (!tt) throw new AppError_('NOT_FOUND', 'Timetable entry not found.');
  if (tt.TeacherID !== session.linkedId) throw new AppError_('FORBIDDEN', 'This is not your class.');

  return withLock_(() => {
    const existing = readAll_('CLASS_SESSIONS').find(s =>
      s.TimetableID === timetableId && s.Date === todayStr_() && s.Status === 'OPEN');
    if (existing) return { sessionId: existing.SessionID, code: existing.AttendanceCode, reused: true };

    const prefix = 'SESSION-' + Utilities.formatDate(nowDate_(), tz_(), 'yyyyMMdd') + '-';
    const sid = nextId_('CLASS_SESSIONS', 'SessionID', prefix, 3);
    const codeMin = getSettingInt_('ATTENDANCE_CODE_MINUTES', 5, 1, 30);
    const row = {
      SessionID: sid, TimetableID: timetableId, Date: todayStr_(),
      StartTime: tt.StartTime, EndTime: tt.EndTime,
      TeacherID: tt.TeacherID, BatchID: tt.BatchID, SubjectID: tt.SubjectID, RoomID: tt.RoomID,
      AttendanceCode: newAttendanceCode_(),
      CodeCreatedAt: nowStr_(), CodeExpiresAt: plusMinutesStr_(codeMin),
      Status: 'OPEN', StartedAt: nowStr_(), ClosedAt: '',
      AcademicYear: currentAcademicYear_()
    };
    appendObject_('CLASS_SESSIONS', row);
    logAdmin_(session, 'START_CLASS', 'CLASS_SESSION', sid, { batch: tt.BatchID, subject: tt.SubjectID });
    return { sessionId: sid, code: row.AttendanceCode, reused: false };
  });
}

function teacherRegenerateCode_(session, p) {
  const sid = reqStr_(p, 'sessionId', 'Session ID');
  const s = findOne_('CLASS_SESSIONS', 'SessionID', sid);
  if (!s) throw new AppError_('NOT_FOUND', 'Session not found.');
  if (s.TeacherID !== session.linkedId) throw new AppError_('FORBIDDEN', 'Not your class.');
  if (s.Status !== 'OPEN') throw new AppError_('BAD_REQUEST', 'This class is closed.');
  return withLock_(() => {
    const codeMin = getSettingInt_('ATTENDANCE_CODE_MINUTES', 5, 1, 30);
    const code = newAttendanceCode_();
    updateObject_('CLASS_SESSIONS', s._row, {
      AttendanceCode: code, CodeCreatedAt: nowStr_(), CodeExpiresAt: plusMinutesStr_(codeMin)
    });
    return { code: code, expiresAt: plusMinutesStr_(codeMin) };
  });
}

function teacherClassStatus_(session, p) {
  const sid = reqStr_(p, 'sessionId', 'Session ID');
  const s = findOne_('CLASS_SESSIONS', 'SessionID', sid);
  if (!s) throw new AppError_('NOT_FOUND', 'Class session not found.');
  if (s.TeacherID !== session.linkedId && !can_(session, 'ATTENDANCE_CORRECT')) {
    throw new AppError_('FORBIDDEN', 'This is not your class.');
  }

  const students = teacherStudentsFor_(s.TeacherID, s.BatchID, s.SubjectID);
  const att = readWhere_('ATTENDANCE', 'SessionID', sid);
  const byStatus = { PRESENT: 0, LATE: 0, ABSENT: 0 };
  const map = {};
  att.forEach(a => { byStatus[a.Status] = (byStatus[a.Status] || 0) + 1; map[a.StudentID] = { Status: a.Status, Method: a.Method, MarkedAt: a.MarkedAt }; });

  const now = nowStr_();
  let secLeft = 0;
  if (s.CodeExpiresAt && s.CodeExpiresAt > now) {
    secLeft = Math.max(0, Math.round((new Date(s.CodeExpiresAt.replace(' ','T')) - new Date(now.replace(' ','T'))) / 1000));
  }

  return {
    session: {
      SessionID: s.SessionID, Date: s.Date, StartTime: s.StartTime, EndTime: s.EndTime,
      BatchName: batchName_(s.BatchID), SubjectName: subjectName_(s.SubjectID),
      RoomName: roomName_(s.RoomID), Status: s.Status,
      AttendanceCode: s.AttendanceCode, CodeExpiresAt: s.CodeExpiresAt,
      StartedAt: s.StartedAt, ClosedAt: s.ClosedAt
    },
    codeSecondsLeft: secLeft,
    students: students.map(x => ({
      StudentID: x.StudentID, Name: x.Name, RollNo: x.RollNo,
      Status: map[x.StudentID] ? map[x.StudentID].Status : null,
      Method: map[x.StudentID] ? map[x.StudentID].Method : null,
      MarkedAt: map[x.StudentID] ? map[x.StudentID].MarkedAt : null
    })),
    counts: {
      total: students.length,
      present: byStatus.PRESENT || 0,
      late: byStatus.LATE || 0,
      absent: byStatus.ABSENT || 0,
      unmarked: students.length - ((byStatus.PRESENT||0) + (byStatus.LATE||0) + (byStatus.ABSENT||0))
    }
  };
}

function teacherManualAttendance_(session, p) {
  const sid = reqStr_(p, 'sessionId', 'Session ID');
  const studentId = reqStr_(p, 'studentId', 'Student ID');
  const status = validateFields_({ Status: { req: true, type: 'enum', values: ['PRESENT','LATE','ABSENT'] } },
                                  { Status: p.status }, false).Status;
  const reason = String(p.reason || '').slice(0, 200);

  const s = findOne_('CLASS_SESSIONS', 'SessionID', sid);
  if (!s) throw new AppError_('NOT_FOUND', 'Class session not found.');
  if (s.TeacherID !== session.linkedId) throw new AppError_('FORBIDDEN', 'This is not your class.');
  if (s.Status !== 'OPEN') throw new AppError_('BAD_REQUEST', 'This class is closed.');

  return withLock_(() => {
    attForget_(sid, studentId);
    const existing = readWhere_('ATTENDANCE', 'SessionID', sid).find(a => a.StudentID === studentId);
    if (existing) {
      if (existing.Status === status) return { ok: true, unchanged: true };
      updateObject_('ATTENDANCE', existing._row, { Status: status, MarkedBy: session.username, MarkedAt: nowStr_(), Method: 'TEACHER_MANUAL' });
      appendObject_('ATTENDANCE_LOGS', {
        LogID: 'AL-' + Utilities.formatDate(nowDate_(), tz_(), 'yyyyMMddHHmmss') + '-' + randomHex_(4),
        AttendanceID: existing.AttendanceID, SessionID: sid, StudentID: studentId,
        OldStatus: existing.Status, NewStatus: status, ChangedBy: session.username, ChangedAt: nowStr_(), Reason: reason
      });
      logAdmin_(session, 'CHANGE_ATTENDANCE', 'ATTENDANCE', existing.AttendanceID, { from: existing.Status, to: status });
      return { ok: true, changed: true };
    }
    const aid = nextId_('ATTENDANCE', 'AttendanceID', 'ATT-', 5);
    appendObject_('ATTENDANCE', {
      AttendanceID: aid, SessionID: sid, StudentID: studentId,
      SubjectID: s.SubjectID, BatchID: s.BatchID, Date: s.Date,
      Status: status, MarkedBy: session.username, MarkedAt: nowStr_(),
      Method: 'TEACHER_MANUAL', LocationVerified: 'FALSE', AcademicYear: currentAcademicYear_()
    });
    logAdmin_(session, 'MARK_ATTENDANCE', 'ATTENDANCE', aid, { student: studentId, status: status });
    return { ok: true, created: true };
  });
}

function teacherCloseClass_(session, p) {
  const sid = reqStr_(p, 'sessionId', 'Session ID');
  const markAbsent = p.markAbsent !== false;
  const s = findOne_('CLASS_SESSIONS', 'SessionID', sid);
  if (!s) throw new AppError_('NOT_FOUND', 'Class session not found.');
  if (s.TeacherID !== session.linkedId) throw new AppError_('FORBIDDEN', 'This is not your class.');
  if (s.Status === 'CLOSED') return { ok: true, alreadyClosed: true };

  return withLock_(() => {
    let markedAbsent = 0;
    attFlushPending_(s); // students who tapped just before closing still count
    if (markAbsent) {
      const students = teacherStudentsFor_(s.TeacherID, s.BatchID, s.SubjectID);
      const have = {};
      readAll_('ATTENDANCE').filter(a => a.SessionID === sid).forEach(a => { have[a.StudentID] = true; });
      const rows = students.filter(st => !have[st.StudentID]).map(st => ({
        SessionID: sid, StudentID: st.StudentID,
        SubjectID: s.SubjectID, BatchID: s.BatchID, Date: s.Date,
        Status: 'ABSENT', MarkedBy: session.username, MarkedAt: nowStr_(),
        Method: 'TEACHER_MANUAL', LocationVerified: 'FALSE', AcademicYear: currentAcademicYear_()
      }));
      if (rows.length) {
        let max = 0;
        const re = /^ATT-(\d+)$/;
        readColumn_('ATTENDANCE', 'AttendanceID').forEach(v => { const m = re.exec(String(v)); if (m) max = Math.max(max, parseInt(m[1], 10)); });
        rows.forEach((r, i) => { r.AttendanceID = 'ATT-' + pad_(max + 1 + i, 5); });
        appendObjects_('ATTENDANCE', rows);
        markedAbsent = rows.length;
      }
    }
    updateObject_('CLASS_SESSIONS', s._row, { Status: 'CLOSED', ClosedAt: nowStr_() });
    logAdmin_(session, 'CLOSE_CLASS', 'CLASS_SESSION', sid, { markedAbsent: markedAbsent });
    return { ok: true, markedAbsent: markedAbsent };
  });
}

/** One tap for a big class: everyone not marked yet gets the chosen status (default PRESENT). */
function teacherMarkAll_(session, p) {
  const sid = reqStr_(p, 'sessionId', 'Session ID');
  const status = validateFields_({ Status: { req: true, type: 'enum', values: ['PRESENT', 'LATE', 'ABSENT'] } },
                                  { Status: p.status || 'PRESENT' }, false).Status;
  const s = findOne_('CLASS_SESSIONS', 'SessionID', sid);
  if (!s) throw new AppError_('NOT_FOUND', 'Class session not found.');
  if (s.TeacherID !== session.linkedId) throw new AppError_('FORBIDDEN', 'This is not your class.');
  if (s.Status !== 'OPEN') throw new AppError_('BAD_REQUEST', 'This class is closed.');

  return withLock_(() => {
    attFlushPending_(s); // keep the real PRESENT / LATE of students who already tapped
    const have = {};
    readWhere_('ATTENDANCE', 'SessionID', sid).forEach(a => { have[a.StudentID] = true; });
    const rows = teacherStudentsFor_(s.TeacherID, s.BatchID, s.SubjectID).filter(st => !have[st.StudentID]).map(st => ({
      SessionID: sid, StudentID: st.StudentID, SubjectID: s.SubjectID, BatchID: s.BatchID, Date: s.Date,
      Status: status, MarkedBy: session.username, MarkedAt: nowStr_(),
      Method: 'TEACHER_MANUAL', LocationVerified: 'FALSE', AcademicYear: currentAcademicYear_()
    }));
    if (rows.length) {
      let max = 0;
      const re = /^ATT-(\d+)$/;
      readColumn_('ATTENDANCE', 'AttendanceID').forEach(v => { const m = re.exec(String(v)); if (m) max = Math.max(max, parseInt(m[1], 10)); });
      rows.forEach((r, i) => { r.AttendanceID = 'ATT-' + pad_(max + 1 + i, 5); });
      appendObjects_('ATTENDANCE', rows);
    }
    logAdmin_(session, 'MARK_ALL_ATTENDANCE', 'CLASS_SESSION', sid, { status: status, count: rows.length });
    return { ok: true, marked: rows.length, status: status };
  });
}

function teacherSessions_(session, p) {
  const limit = Math.min(Math.max(parseInt(p && p.limit, 10) || 30, 1), 200);
  return readAll_('CLASS_SESSIONS')
    .filter(s => s.TeacherID === session.linkedId)
    .sort((a,b) => String(b.StartedAt).localeCompare(String(a.StartedAt)))
    .slice(0, limit)
    .map(s => {
      const att = readAll_('ATTENDANCE').filter(a => a.SessionID === s.SessionID);
      return {
        SessionID: s.SessionID, Date: s.Date, StartTime: s.StartTime, EndTime: s.EndTime,
        BatchName: batchName_(s.BatchID), SubjectName: subjectName_(s.SubjectID),
        Status: s.Status,
        Present: att.filter(a => a.Status === 'PRESENT').length,
        Late: att.filter(a => a.Status === 'LATE').length,
        Absent: att.filter(a => a.Status === 'ABSENT').length,
        Total: att.length
      };
    });
}

function teacherIncome_(session) {
  if (!can_(session, 'TEACHER_INCOME_VIEW')) throw new AppError_('FORBIDDEN', 'Income view is not enabled for you.');
  const tid = session.linkedId;
  const t = findOne_('TEACHERS', 'TeacherID', tid);
  const rows = readAll_('TEACHER_INCOME').filter(r => r.TeacherID === tid);
  const payments = readAll_('TEACHER_PAYMENTS').filter(r => r.TeacherID === tid);
  return {
    teacher: { Name: t.Name, Rate: t.DefaultRatePerStudent, Method: t.IncomeMethod },
    income: rows.map(r => ({
      IncomeID: r.IncomeID, Month: r.Month, SubjectName: subjectName_(r.SubjectID),
      StudentCount: r.StudentCount, Rate: r.RatePerStudent, Gross: r.GrossIncome,
      Adjustment: r.Adjustment, FinalPayable: r.FinalPayable, Status: r.Status
    })),
    payments: payments.map(p => ({
      PaymentID: p.PaymentID, Date: p.PaymentDate, Amount: p.Amount, Mode: p.PaymentMode, Notes: p.Notes
    }))
  };
}

/** Notices a teacher should see: ALL, TEACHERS, and BATCH notices for batches they teach. */
function teacherNotices_(session) {
  const tid = session.linkedId;
  const today = todayStr_();
  const myBatches = {};
  readAll_('TIMETABLE').filter(r => r.TeacherID === tid && isActive_(r.Status)).forEach(r => { myBatches[r.BatchID] = true; });
  readAll_('STUDENT_SUBJECTS').filter(r => r.TeacherID === tid && isActive_(r.Status)).forEach(r => { myBatches[r.BatchID] = true; });
  return readAll_('NOTICES')
    .filter(n => {
      if (String(n.Status).toUpperCase() !== 'ACTIVE') return false;
      if (n.ExpiresAt && n.ExpiresAt < today) return false;
      const aud = String(n.Audience || '').toUpperCase();
      if (aud === 'ALL' || aud === 'TEACHERS') return true;
      return aud === 'BATCH' && !!myBatches[n.BatchID];
    })
    .sort((a, b) => String(b.PostedAt || '').localeCompare(String(a.PostedAt || '')))
    .slice(0, 100)
    .map(n => ({
      NoticeID: n.NoticeID, Title: n.Title, Body: n.Body, Audience: n.Audience,
      BatchName: n.BatchID ? batchName_(n.BatchID) : '', PostedAt: n.PostedAt, ExpiresAt: n.ExpiresAt
    }));
}

function teacherActionDefs_() {
  return {
    'teacher.dashboard':        { perm: 'SELF_VIEW', run: (s) => teacherDashboard_(s) },
    'teacher.timetable':        { perm: 'SELF_VIEW', run: (s) => teacherTimetable_(s) },
    'teacher.students':         { perm: 'SELF_VIEW', run: (s) => teacherMyStudents_(s) },
    'teacher.startClass':       { perm: 'CLASS_RUN', run: (s, p) => teacherStartClass_(s, p) },
    'teacher.regenerateCode':   { perm: 'CLASS_RUN', run: (s, p) => teacherRegenerateCode_(s, p) },
    'teacher.classStatus':      { perm: 'CLASS_RUN', run: (s, p) => teacherClassStatus_(s, p) },
    'teacher.manualAttendance': { perm: 'ATTENDANCE_MARK', run: (s, p) => teacherManualAttendance_(s, p) },
    'teacher.markAll':         { perm: 'ATTENDANCE_MARK', run: (s, p) => teacherMarkAll_(s, p) },
    'teacher.closeClass':       { perm: 'CLASS_RUN', run: (s, p) => teacherCloseClass_(s, p) },
    'teacher.sessions':         { perm: 'SELF_VIEW', run: (s, p) => teacherSessions_(s, p) },
    'teacher.income':           { perm: 'TEACHER_INCOME_VIEW', run: (s) => teacherIncome_(s) },
    'teacher.notices':          { perm: 'NOTICE_VIEW', run: (s) => teacherNotices_(s) }
  };
}