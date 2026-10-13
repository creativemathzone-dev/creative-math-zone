/**
 * ============================================================
 *  CREATIVE MATH ZONE — AttendanceAdminApi.gs
 *  Step 5: admin can browse class sessions and correct attendance.
 *  View needs STUDENT_VIEW. Correcting needs ATTENDANCE_CORRECT
 *  (Super Admin has it; grant it to others under Admin users > Access).
 *  Needs teacherStudentsFor_ from TeacherApi.gs and the name helpers
 *  from StudentApi.gs.
 * ============================================================
 */

function attAdminSessions_(p) {
  const from = String((p && p.from) || '');
  const to = String((p && p.to) || '');
  const batchId = String((p && p.batchId) || '');
  const teacherId = String((p && p.teacherId) || '');
  if (from && !validDate_(from)) throw bad_('From date is not valid.');
  if (to && !validDate_(to)) throw bad_('To date is not valid.');

  const sessions = readAll_('CLASS_SESSIONS')
    .filter(s => (!from || s.Date >= from) && (!to || s.Date <= to))
    .filter(s => !batchId || s.BatchID === batchId)
    .filter(s => !teacherId || s.TeacherID === teacherId)
    .sort((a, b) => String(b.Date).localeCompare(String(a.Date)) || String(b.StartTime).localeCompare(String(a.StartTime)))
    .slice(0, 300);
  if (!sessions.length) return [];

  const ids = {};
  sessions.forEach(s => { ids[s.SessionID] = { PRESENT: 0, LATE: 0, ABSENT: 0 }; });
  readAll_('ATTENDANCE').forEach(a => { if (ids[a.SessionID] && ids[a.SessionID][a.Status] !== undefined) ids[a.SessionID][a.Status]++; });

  return sessions.map(s => ({
    SessionID: s.SessionID, Date: s.Date, StartTime: s.StartTime, EndTime: s.EndTime,
    BatchName: batchName_(s.BatchID), SubjectName: subjectName_(s.SubjectID), TeacherName: teacherName_(s.TeacherID),
    RoomName: roomName_(s.RoomID), Status: s.Status,
    Present: ids[s.SessionID].PRESENT, Late: ids[s.SessionID].LATE, Absent: ids[s.SessionID].ABSENT
  }));
}

function attAdminDetail_(p) {
  const sid = reqStr_(p, 'sessionId', 'Session ID');
  const s = findOne_('CLASS_SESSIONS', 'SessionID', sid);
  if (!s) throw new AppError_('NOT_FOUND', 'Class session not found.');
  const marks = {};
  readAll_('ATTENDANCE').filter(a => a.SessionID === sid).forEach(a => { marks[a.StudentID] = a; });

  const roster = {};
  teacherStudentsFor_(s.TeacherID, s.BatchID, s.SubjectID).forEach(x => { roster[x.StudentID] = x; });
  const missing = Object.keys(marks).filter(id => !roster[id]); // marked, but no longer on the roster
  if (missing.length) {
    readAll_('STUDENTS').filter(x => missing.indexOf(x.StudentID) >= 0)
      .forEach(x => { roster[x.StudentID] = { StudentID: x.StudentID, Name: x.Name, RollNo: x.RollNo || '' }; });
  }
  const students = Object.keys(roster).map(id => roster[id])
    .sort((a, b) => String(a.RollNo || a.Name).localeCompare(String(b.RollNo || b.Name)))
    .map(x => ({
      StudentID: x.StudentID, Name: x.Name, RollNo: x.RollNo,
      Status: marks[x.StudentID] ? marks[x.StudentID].Status : null,
      Method: marks[x.StudentID] ? marks[x.StudentID].Method : null,
      MarkedAt: marks[x.StudentID] ? marks[x.StudentID].MarkedAt : null
    }));

  return {
    session: {
      SessionID: s.SessionID, Date: s.Date, StartTime: s.StartTime, EndTime: s.EndTime,
      BatchName: batchName_(s.BatchID), SubjectName: subjectName_(s.SubjectID),
      TeacherName: teacherName_(s.TeacherID), RoomName: roomName_(s.RoomID), Status: s.Status
    },
    students: students
  };
}

function attAdminCorrect_(session, p) {
  const sid = reqStr_(p, 'sessionId', 'Session ID');
  const studentId = reqStr_(p, 'studentId', 'Student ID');
  const status = validateFields_({ Status: { req: true, type: 'enum', values: ['PRESENT', 'LATE', 'ABSENT'] } },
                                  { Status: p.status }, false).Status;
  const reason = String(p.reason || '').trim().slice(0, 200);
  if (!reason) throw bad_('Please give a reason for the correction.');

  return withLock_(() => {
    const s = findOne_('CLASS_SESSIONS', 'SessionID', sid);
    if (!s) throw new AppError_('NOT_FOUND', 'Class session not found.');
    if (!findOne_('STUDENTS', 'StudentID', studentId)) throw new AppError_('NOT_FOUND', 'Student not found.');

    attForget_(sid, studentId);
    const existing = readAll_('ATTENDANCE').find(a => a.SessionID === sid && a.StudentID === studentId);
    if (existing) {
      if (existing.Status === status) return { ok: true, unchanged: true };
      updateObject_('ATTENDANCE', existing._row, {
        Status: status, MarkedBy: session.username, MarkedAt: nowStr_(), Method: 'ADMIN_CORRECTION'
      });
      appendObject_('ATTENDANCE_LOGS', {
        LogID: 'AL-' + Utilities.formatDate(nowDate_(), tz_(), 'yyyyMMddHHmmss') + '-' + randomHex_(4),
        AttendanceID: existing.AttendanceID, SessionID: sid, StudentID: studentId,
        OldStatus: existing.Status, NewStatus: status, ChangedBy: session.username, ChangedAt: nowStr_(), Reason: reason
      });
      logAdmin_(session, 'CORRECT_ATTENDANCE', 'ATTENDANCE', existing.AttendanceID, { from: existing.Status, to: status, reason: reason });
      return { ok: true, changed: true };
    }

    const aid = nextId_('ATTENDANCE', 'AttendanceID', 'ATT-', 5);
    appendObject_('ATTENDANCE', {
      AttendanceID: aid, SessionID: sid, StudentID: studentId, SubjectID: s.SubjectID, BatchID: s.BatchID, Date: s.Date,
      Status: status, MarkedBy: session.username, MarkedAt: nowStr_(), Method: 'ADMIN_CORRECTION',
      LocationVerified: 'FALSE', AcademicYear: currentAcademicYear_()
    });
    appendObject_('ATTENDANCE_LOGS', {
      LogID: 'AL-' + Utilities.formatDate(nowDate_(), tz_(), 'yyyyMMddHHmmss') + '-' + randomHex_(4),
      AttendanceID: aid, SessionID: sid, StudentID: studentId,
      OldStatus: '', NewStatus: status, ChangedBy: session.username, ChangedAt: nowStr_(), Reason: reason
    });
    logAdmin_(session, 'CORRECT_ATTENDANCE', 'ATTENDANCE', aid, { from: '', to: status, reason: reason });
    return { ok: true, created: true };
  });
}

function attendanceAdminActionDefs_() {
  return {
    'attendance.sessions': { perm: 'STUDENT_VIEW', run: (s, p) => attAdminSessions_(p) },
    'attendance.detail':   { perm: 'STUDENT_VIEW', run: (s, p) => attAdminDetail_(p) },
    'attendance.correct':  { perm: 'ATTENDANCE_CORRECT', run: (s, p) => attAdminCorrect_(s, p) }
  };
}
