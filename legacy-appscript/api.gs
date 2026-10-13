/**
 * ============================================================
 *  CREATIVE MATH ZONE — Api.gs
 *  The ONLY function the browser calls:
 *      google.script.run.api({ action, token, payload })
 *  Flow: validate request → check session → check permission → run → respond.
 *  Response: { ok:true, data } or { ok:false, code, error }.
 * ============================================================
 */

function api(request) {
  let action = '';
  try {
    request = request || {};
    action = String(request.action || '');
    const ALL_ACTIONS = Object.assign({}, ACTIONS_, studentActionDefs_(), teacherActionDefs_(), timetableActionDefs_(), noticeActionDefs_(), financeActionDefs_(), invoiceActionDefs_(), paymentActionDefs_(), teacherIncomeActionDefs_(), attendanceAdminActionDefs_(), reportsActionDefs_(), registrationActionDefs_());
    if (!Object.prototype.hasOwnProperty.call(ALL_ACTIONS, action)) throw new AppError_('UNKNOWN_ACTION', 'Unknown action.');
    const def = ALL_ACTIONS[action];
    const payload = (request.payload && typeof request.payload === 'object') ? request.payload : {};
    let session = null;
    if (!def.public) {
      session = getSession_(request.token, !!def.noTouch);
      if (session.mustChange && !def.allowPending) {
        throw new AppError_('PASSWORD_CHANGE_REQUIRED', 'Please change your temporary password first.');
      }
      if (def.perm) requirePerm_(session, def.perm);
    }
    const data = def.run(session, payload);
    return { ok: true, data: data === undefined ? null : data, v: dataVersion_(), l: logVersion_() };
  } catch (e) {
    return errorResponse_(e, action);
  }
}

function errorResponse_(e, action) {
  if (e instanceof AppError_) return { ok: false, code: e.code, error: e.message };
  const msg = String((e && e.message) || e);
  if (/lock/i.test(msg) && /obtain|timeout|timed out/i.test(msg)) {
    return { ok: false, code: 'BUSY', error: 'The system is busy. Please try again in a few seconds.' };
  }
  console.error('ERROR in action "' + action + '": ' + ((e && e.stack) || msg));
  return { ok: false, code: 'SERVER_ERROR', error: 'Something went wrong. Please try again.' };
}

/* ------------------------------------------------------------
 *  Action table. perm = server-side permission required.
 *  public = no login needed. allowPending = usable while the
 *  user still has to change a temporary password.
 * ------------------------------------------------------------ */
const ACTIONS_ = {
  'public.config':        { public: true, run: () => publicConfig_() },
  'auth.login':           { public: true, run: (s, p) => login_(p.username, p.password, p.portal) },
  'auth.logout':          { allowPending: true, run: (s) => logout_(s) },
  'auth.ping':            { allowPending: true, run: (s) => ({ alive: true, serverTime: nowStr_() }) },
  'auth.me':              { allowPending: true, run: (s) => me_(s) },
  'auth.changePassword':  { allowPending: true, run: (s, p) => changePassword_(s, p.oldPassword, p.newPassword) },
  'sync.version':         { noTouch: true, run: () => ({ v: dataVersion_(), l: logVersion_() }) },

  'settings.get':         { perm: 'SETTINGS_VIEW', run: () => settingsGet_() },
  'settings.update':      { perm: 'SETTINGS_EDIT', run: (s, p) => settingsUpdate_(s, p) },

  'subjects.list':        { perm: 'MASTER_VIEW', run: () => masterList_(MASTERS_.subjects) },
  'subjects.add':         { perm: 'MASTER_EDIT', run: (s, p) => masterAdd_(s, MASTERS_.subjects, p) },
  'subjects.update':      { perm: 'MASTER_EDIT', run: (s, p) => masterUpdate_(s, MASTERS_.subjects, p) },
  'batches.list':         { perm: 'MASTER_VIEW', run: () => masterList_(MASTERS_.batches) },
  'batches.add':          { perm: 'MASTER_EDIT', run: (s, p) => masterAdd_(s, MASTERS_.batches, p) },
  'batches.update':       { perm: 'MASTER_EDIT', run: (s, p) => masterUpdate_(s, MASTERS_.batches, p) },
  'rooms.list':           { perm: 'MASTER_VIEW', run: () => masterList_(MASTERS_.rooms) },
  'rooms.add':            { perm: 'MASTER_EDIT', run: (s, p) => masterAdd_(s, MASTERS_.rooms, p) },
  'rooms.update':         { perm: 'MASTER_EDIT', run: (s, p) => masterUpdate_(s, MASTERS_.rooms, p) },

  'students.list':          { perm: 'STUDENT_VIEW', run: (s, p) => studentsList_(p) },
  'students.get':           { perm: 'STUDENT_VIEW', run: (s, p) => studentsGet_(p) },
  'students.add':           { perm: 'STUDENT_EDIT', run: (s, p) => studentsAdd_(s, p) },
  'students.update':        { perm: 'STUDENT_EDIT', run: (s, p) => studentsUpdate_(s, p) },
  'students.resetPassword': { perm: 'STUDENT_EDIT', run: (s, p) => linkedResetPassword_(s, 'STUDENT', p.studentId, p.password) },
  'studentSubjects.assign': { perm: 'STUDENT_EDIT', run: (s, p) => subjectAssign_(s, p) },
  'studentSubjects.end':    { perm: 'STUDENT_EDIT', run: (s, p) => subjectEnd_(s, p) },
  'changes.list':           { perm: 'STUDENT_VIEW', run: (s, p) => changesList_(p) },

  'teachers.list':          { perm: 'TEACHER_VIEW', run: () => readAll_('TEACHERS').map(t => pub_(t)) },
  'teachers.add':           { perm: 'TEACHER_EDIT', run: (s, p) => teachersAdd_(s, p) },
  'teachers.update':        { perm: 'TEACHER_EDIT', run: (s, p) => teachersUpdate_(s, p) },
  'teachers.resetPassword': { perm: 'TEACHER_EDIT', run: (s, p) => linkedResetPassword_(s, 'TEACHER', p.teacherId, p.password) },

  'users.list':           { perm: 'USER_MANAGE', run: () => readAll_('USERS').map(u => pub_(u, ['PasswordHash'])) },
  'users.createAdmin':    { perm: 'USER_MANAGE', run: (s, p) => adminCreate_(s, p) },
  'users.setStatus':      { perm: 'USER_MANAGE', run: (s, p) => userSetStatus_(s, p) },
  'users.resetPassword':  { perm: 'USER_MANAGE', run: (s, p) => userResetPassword_(s, p) },
  'users.setPermissions': { perm: 'USER_MANAGE', run: (s, p) => userSetPermissions_(s, p) },
  'logs.list':            { perm: 'LOG_VIEW', run: (s, p) => logsList_(p) }
};

/* ============================================================
 *  Input validation helpers
 * ============================================================ */

function bad_(msg) { return new AppError_('BAD_REQUEST', msg); }

function reqStr_(p, field, label, max) {
  const v = (p[field] === undefined || p[field] === null) ? '' : String(p[field]).trim();
  if (!v) throw bad_((label || field) + ' is required.');
  if (v.length > (max || 100)) throw bad_((label || field) + ' is too long.');
  return v;
}

function normMobile_(v) {
  let d = String(v).replace(/\D/g, '');
  if (d.length === 12 && d.indexOf('91') === 0) d = d.slice(2);
  if (d.length === 11 && d.charAt(0) === '0') d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

function validDate_(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * spec: { Field: { req, type: str|enum|date|mobile|email|int|num|username, max, values, min, upper } }
 * partial=true → only fields present are validated (for updates). Unknown fields are rejected.
 */
function validateFields_(spec, input, partial) {
  input = input || {};
  const out = {};
  Object.keys(input).forEach(k => { if (!spec[k]) throw bad_('Unknown field: ' + k); });
  Object.keys(spec).forEach(f => {
    const s = spec[f];
    if (!Object.prototype.hasOwnProperty.call(input, f)) {
      if (s.req && !partial) throw bad_(f + ' is required.');
      return;
    }
    let v = (input[f] === null || input[f] === undefined) ? '' : String(input[f]).trim();
    if (v === '') {
      if (s.req) throw bad_(f + ' is required.');
      out[f] = '';
      return;
    }
    switch (s.type || 'str') {
      case 'str':
        v = v.replace(/^[=+\-@]+/, ''); // no spreadsheet-formula starts
        if (v.length > (s.max || 200)) throw bad_(f + ' is too long.');
        if (s.upper) v = v.toUpperCase();
        break;
      case 'enum': {
        const hit = s.values.find(x => x.toLowerCase() === v.toLowerCase());
        if (!hit) throw bad_(f + ' must be one of: ' + s.values.join(', ') + '.');
        v = hit;
        break;
      }
      case 'date':
        if (!validDate_(v)) throw bad_(f + ' must be a valid date (yyyy-mm-dd).');
        break;
      case 'mobile': {
        const m = normMobile_(v);
        if (!m) throw bad_(f + ' must be a valid 10-digit mobile number.');
        v = m;
        break;
      }
      case 'email':
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || v.length > 120) throw bad_(f + ' is not a valid email.');
        v = v.toLowerCase();
        break;
      case 'username':
        if (!/^[A-Za-z0-9._-]{3,30}$/.test(v)) throw bad_(f + ' must be 3–30 letters, numbers, dot, dash or underscore.');
        break;
      case 'int':
      case 'num': {
        const n = Number(v);
        if (isNaN(n) || (s.type === 'int' && Math.floor(n) !== n)) throw bad_(f + ' must be a number.');
        if (s.min !== undefined && n < s.min) throw bad_(f + ' must be at least ' + s.min + '.');
        if (s.max !== undefined && n > s.max) throw bad_(f + ' must be at most ' + s.max + '.');
        v = n;
        break;
      }
    }
    out[f] = v;
  });
  return out;
}

function isActive_(v) { return String(v).toUpperCase() === 'ACTIVE'; }

function usernameTaken_(username) {
  return readAll_('USERS').some(u => String(u.Username).toLowerCase() === String(username).toLowerCase());
}

function newUserRow_(username, userType, role, linkedId, passwordHash) {
  return {
    UserID: nextId_('USERS', 'UserID', 'U-', 4), Username: username, PasswordHash: passwordHash, UserType: userType,
    Role: role, LinkedID: linkedId || '', Status: 'Active', LastLogin: '', LastLogout: '', CreatedDate: todayStr_(),
    PasswordChanged: 'No', FailedAttempts: 0, LockedUntil: '', ExtraPermissions: ''
  };
}

function diffFields_(oldRow, changes) {
  const patch = {}, diff = {};
  Object.keys(changes).forEach(k => {
    if (String(oldRow[k]) !== String(changes[k])) { patch[k] = changes[k]; diff[k] = [oldRow[k], changes[k]]; }
  });
  return { patch: patch, diff: diff };
}

/* ============================================================
 *  Public / session actions
 * ============================================================ */

function publicConfig_() {
  return {
    centreName: getSetting_('CENTRE_NAME', 'Creative Math Zone'),
    tagline: getSetting_('TAGLINE', ''),
    logoUrl: logoUrl_(),
    academicYear: currentAcademicYear_(),
    sessionTimeoutMinutes: getSettingInt_('SESSION_TIMEOUT_MINUTES', 30, 5, 600),
    registrationEnabled: getSettingBool_('REGISTRATION_ENABLED', true),
    version: CMZ.VERSION
  };
}

function me_(session) {
  const base = { userId: session.uid, username: session.username, userType: session.userType, role: session.role,
    linkedId: session.linkedId, mustChangePassword: session.mustChange, permissions: clientPerms_(session) };
  if (session.userType === 'STUDENT') {
    const st = findOne_('STUDENTS', 'StudentID', session.linkedId);
    base.profile = st ? pub_(st) : null;
  } else if (session.userType === 'TEACHER') {
    const t = findOne_('TEACHERS', 'TeacherID', session.linkedId);
    // income details are hidden unless an admin has granted this teacher visibility (checked server-side)
    base.profile = t ? pub_(t, can_(session, 'TEACHER_INCOME_VIEW') ? [] : ['IncomeMethod', 'DefaultRatePerStudent', 'IncomeVisibleToTeacher']) : null;
  }
  return base;
}

/* ============================================================
 *  Settings
 * ============================================================ */

const SETTING_RULES_ = {
  ACADEMIC_YEAR: v => { if (!/^\d{4}-\d{2}$/.test(v)) throw bad_('ACADEMIC_YEAR must look like 2026-27.'); },
  STUDENT_ID_PREFIX: v => { if (!/^[A-Z]{2,6}$/.test(v)) throw bad_('STUDENT_ID_PREFIX must be 2–6 capital letters.'); },
  ATTENDANCE_CODE_MINUTES: v => intRule_('ATTENDANCE_CODE_MINUTES', v, 1, 30),
  SESSION_TIMEOUT_MINUTES: v => intRule_('SESSION_TIMEOUT_MINUTES', v, 5, 240),
  LOGIN_MAX_ATTEMPTS: v => intRule_('LOGIN_MAX_ATTEMPTS', v, 3, 20),
  LOGIN_LOCK_MINUTES: v => intRule_('LOGIN_LOCK_MINUTES', v, 1, 240),
  REGISTRATION_ENABLED: v => { if (!/^(TRUE|FALSE)$/.test(v)) throw bad_('REGISTRATION_ENABLED must be TRUE or FALSE.'); },
  REGISTRATION_MAX_PER_HOUR: v => intRule_('REGISTRATION_MAX_PER_HOUR', v, 1, 200),
  LATE_FEE_ENABLED: v => { if (!/^(TRUE|FALSE)$/.test(v)) throw bad_('LATE_FEE_ENABLED must be TRUE or FALSE.'); },
  LOCATION_CHECK_ENABLED: v => { if (!/^(TRUE|FALSE)$/.test(v)) throw bad_('LOCATION_CHECK_ENABLED must be TRUE or FALSE.'); },
  SUBJECT_BLOCKED_PAIRS: v => {
    if (v === '') return;
    const ids = readAll_('SUBJECTS').map(s => s.SubjectID);
    v.split(';').forEach(pair => {
      const p = pair.trim().split('|').map(x => x.trim());
      if (p.length !== 2 || ids.indexOf(p[0]) < 0 || ids.indexOf(p[1]) < 0 || p[0] === p[1]) {
        throw bad_('SUBJECT_BLOCKED_PAIRS must look like SUB002|SUB003;SUB001|SUB004 using existing subject IDs.');
      }
    });
  }
};
function intRule_(k, v, min, max) {
  const n = Number(v);
  if (!/^\d+$/.test(v) || n < min || n > max) throw bad_(k + ' must be a whole number from ' + min + ' to ' + max + '.');
}

function settingsGet_() {
  return readAll_('SETTINGS').map(r => ({ key: r.SettingKey, value: r.Value, description: r.Description, updatedAt: r.UpdatedAt, updatedBy: r.UpdatedBy }));
}

function settingsUpdate_(session, p) {
  const changes = p.changes;
  if (!changes || typeof changes !== 'object' || !Object.keys(changes).length) throw bad_('Nothing to update.');
  return withLock_(() => {
    const rows = readAll_('SETTINGS');
    const byKey = {};
    rows.forEach(r => { byKey[r.SettingKey] = r; });
    const diff = {};
    Object.keys(changes).forEach(k => {
      if (!byKey[k]) throw bad_('Unknown setting: ' + k);
      const v = String(changes[k] === null || changes[k] === undefined ? '' : changes[k]).trim();
      if (v.length > 300) throw bad_(k + ' is too long.');
      if (SETTING_RULES_[k]) SETTING_RULES_[k](v);
      else if (v === '' && k !== 'SUBJECT_BLOCKED_PAIRS') throw bad_(k + ' cannot be empty.');
      if (String(byKey[k].Value) !== v) diff[k] = [byKey[k].Value, v];
    });
    Object.keys(diff).forEach(k => updateObject_('SETTINGS', byKey[k]._row, { Value: diff[k][1], UpdatedAt: nowStr_(), UpdatedBy: session.username }));
    clearSettingsCache_();
    if (Object.keys(diff).length) logAdmin_(session, 'CHANGE_SETTING', 'SETTING', Object.keys(diff).join(','), diff);
    return { changed: Object.keys(diff) };
  });
}

/* ============================================================
 *  Master data: Subjects, Batches, Rooms
 * ============================================================ */

const MASTERS_ = {
  subjects: {
    sheet: 'SUBJECTS', id: 'SubjectID', prefix: 'SUB', width: 3, label: 'Subject', nameField: 'SubjectName',
    spec: { SubjectName: { req: true, max: 60 }, Status: { type: 'enum', values: ['Active', 'Inactive'] } }
  },
  batches: {
    sheet: 'BATCHES', id: 'BatchID', prefix: 'B', width: 3, label: 'Batch', nameField: 'BatchName',
    spec: { BatchName: { req: true, max: 30 }, Class: { req: true, max: 10, upper: true }, Section: { max: 5, upper: true },
      AcademicYear: { max: 10 }, Status: { type: 'enum', values: ['Active', 'Inactive'] } }
  },
  rooms: {
    sheet: 'ROOMS', id: 'RoomID', prefix: 'R', width: 3, label: 'Room', nameField: 'RoomName',
    spec: { RoomName: { req: true, max: 40 }, Capacity: { type: 'int', min: 1, max: 500 }, Status: { type: 'enum', values: ['Active', 'Inactive'] } }
  }
};

function masterList_(m) { return readAll_(m.sheet).map(r => pub_(r)); }

function masterAdd_(session, m, p) {
  const data = validateFields_(m.spec, p.item, false);
  return withLock_(() => {
    const dupe = readAll_(m.sheet).find(r => String(r[m.nameField]).toLowerCase() === String(data[m.nameField]).toLowerCase());
    if (dupe) throw new AppError_('DUPLICATE', m.label + ' "' + data[m.nameField] + '" already exists.');
    const row = Object.assign({ Status: 'Active' }, m.sheet === 'BATCHES' ? { AcademicYear: currentAcademicYear_() } : {}, data);
    row[m.id] = nextId_(m.sheet, m.id, m.prefix, m.width);
    appendObject_(m.sheet, row);
    logAdmin_(session, 'ADD_' + m.label.toUpperCase(), m.label.toUpperCase(), row[m.id], data);
    return pub_(row);
  });
}

function masterUpdate_(session, m, p) {
  const id = reqStr_(p, 'id', m.label + ' ID');
  const changes = validateFields_(m.spec, p.changes, true);
  return withLock_(() => {
    const row = findOne_(m.sheet, m.id, id);
    if (!row) throw new AppError_('NOT_FOUND', m.label + ' not found.');
    if (changes[m.nameField]) {
      const dupe = readAll_(m.sheet).find(r => r[m.id] !== id && String(r[m.nameField]).toLowerCase() === String(changes[m.nameField]).toLowerCase());
      if (dupe) throw new AppError_('DUPLICATE', m.label + ' "' + changes[m.nameField] + '" already exists.');
    }
    const d = diffFields_(row, changes);
    if (!Object.keys(d.patch).length) return pub_(row);
    updateObject_(m.sheet, row._row, d.patch);
    logAdmin_(session, 'EDIT_' + m.label.toUpperCase(), m.label.toUpperCase(), id, d.diff);
    return pub_(Object.assign({}, row, d.patch));
  });
}

/* ============================================================
 *  Students
 * ============================================================ */

const STUDENT_SPEC_ = {
  RollNo: { max: 20 }, Name: { req: true, max: 100 }, PhotoURL: { max: 500 }, DOB: { type: 'date' },
  Gender: { type: 'enum', values: ['MALE', 'FEMALE', 'OTHER'] }, Mobile: { type: 'mobile' }, Email: { type: 'email' },
  Address: { max: 300 }, School: { max: 100 }, Board: { max: 30 }, CurrentClass: { req: true, max: 10, upper: true },
  CurrentBatch: { max: 20 }, ParentName: { max: 100 }, Relationship: { max: 30 }, ParentMobile: { type: 'mobile' },
  ParentWhatsApp: { type: 'mobile' }, ParentEmail: { type: 'email' }, PreviousPercentage: { type: 'num', min: 0, max: 100 },
  Status: { type: 'enum', values: ['ACTIVE', 'INACTIVE', 'COMPLETED', 'LEFT', 'SUSPENDED'] }
};
const STUDENT_TRACKED_ = ['CurrentClass', 'CurrentBatch', 'Status'];

function checkStudentBatch_(rec) {
  if (!rec.CurrentBatch) return;
  const b = findOne_('BATCHES', 'BatchID', rec.CurrentBatch);
  if (!b) throw bad_('Batch "' + rec.CurrentBatch + '" does not exist.');
  if (!isActive_(b.Status)) throw bad_('Batch ' + b.BatchName + ' is not active.');
  if (String(b.Class).toUpperCase() !== String(rec.CurrentClass).toUpperCase()) {
    throw bad_('Batch ' + b.BatchName + ' is for class ' + b.Class + ', not ' + rec.CurrentClass + '.');
  }
}

function studentsList_(p) {
  const q = String(p.search || '').trim().toLowerCase();
  const status = String(p.status || '').toUpperCase();
  const batch = String(p.batchId || '');
  const limit = Math.min(Math.max(parseInt(p.limit, 10) || 200, 1), 1000);
  const rows = readAll_('STUDENTS').filter(s =>
    (!status || String(s.Status).toUpperCase() === status) &&
    (!batch || s.CurrentBatch === batch) &&
    (!q || String(s.Name).toLowerCase().indexOf(q) >= 0 || String(s.StudentID).toLowerCase().indexOf(q) >= 0));
  return { total: rows.length, students: rows.slice(0, limit).map(s => pub_(s)) };
}

function studentsGet_(p) {
  const id = reqStr_(p, 'studentId', 'Student ID');
  const st = findOne_('STUDENTS', 'StudentID', id);
  if (!st) throw new AppError_('NOT_FOUND', 'Student not found.');
  return {
    student: pub_(st),
    subjects: readAll_('STUDENT_SUBJECTS').filter(r => r.StudentID === id).map(r => pub_(r)),
    user: (() => { const u = readAll_('USERS').find(x => x.UserType === 'STUDENT' && x.LinkedID === id); return u ? pub_(u, ['PasswordHash']) : null; })()
  };
}

function studentsAdd_(session, p) {
  const data = validateFields_(STUDENT_SPEC_, p.student, false);
  checkStudentBatch_(data);
  if (p.password) validateNewPassword_(String(p.password), '');
  return studentsCreate_(session, data, { password: p.password ? String(p.password) : '' });
}

/** Shared by "Add student" and by approving an online registration. opt = { password } or { passwordHash } (already hashed). */
function studentsCreate_(session, data, opt) {
  opt = opt || {};
  return withLock_(() => {
    if (data.Mobile) {
      const dupe = readAll_('STUDENTS').find(s => String(s.Name).toLowerCase() === data.Name.toLowerCase() && s.Mobile === data.Mobile);
      if (dupe) throw new AppError_('DUPLICATE', 'A student with the same name and mobile already exists (' + dupe.StudentID + ').');
    }
    const year = Utilities.formatDate(nowDate_(), tz_(), 'yyyy');
    const prefix = getSetting_('STUDENT_ID_PREFIX', 'CMZ') + '-' + year + '-';
    const id = nextId_('STUDENTS', 'StudentID', prefix, 3);
    const row = Object.assign({}, data, {
      StudentID: id, RegistrationYear: year, RegistrationDate: todayStr_(), RollNo: data.RollNo || id.slice(prefix.length),
      Status: 'ACTIVE', AcademicYear: currentAcademicYear_(), CreatedAt: nowStr_(), UpdatedAt: nowStr_()
    });
    const pw = opt.passwordHash ? '' : (opt.password || generatePassword_(8));
    appendObject_('STUDENTS', row);
    const urow = newUserRow_(id, 'STUDENT', 'STUDENT', id, opt.passwordHash || makePasswordHash_(pw));
    if (opt.passwordHash) urow.PasswordChanged = 'Yes'; // the student already chose this password
    appendObject_('USERS', urow);
    logAdmin_(session, 'ADD_STUDENT', 'STUDENT', id, { name: row.Name, class: row.CurrentClass, batch: row.CurrentBatch });
    return { studentId: id, username: id, tempPassword: pw };
  });
}

function studentsUpdate_(session, p) {
  const id = reqStr_(p, 'studentId', 'Student ID');
  const changes = validateFields_(STUDENT_SPEC_, p.changes, true);
  const reason = String(p.reason || '').trim().slice(0, 200);
  return withLock_(() => {
    const st = findOne_('STUDENTS', 'StudentID', id);
    if (!st) throw new AppError_('NOT_FOUND', 'Student not found.');
    const merged = Object.assign({}, st, changes);
    if (changes.CurrentClass !== undefined || changes.CurrentBatch !== undefined) checkStudentBatch_(merged);
    const d = diffFields_(st, changes);
    if (!Object.keys(d.patch).length) return { changed: [] };
    updateObject_('STUDENTS', st._row, Object.assign({}, d.patch, { UpdatedAt: nowStr_() }));
    STUDENT_TRACKED_.forEach(f => { if (d.diff[f]) logChange_(session, id, f, d.diff[f][0], d.diff[f][1], reason); });
    if (d.diff.Status) { // keep the login account in step with the student's status
      const u = readAll_('USERS').find(x => x.UserType === 'STUDENT' && x.LinkedID === id);
      const nowActive = ['ACTIVE', 'COMPLETED'].indexOf(d.diff.Status[1]) >= 0;
      if (u) {
        updateObject_('USERS', u._row, { Status: nowActive ? 'Active' : 'Inactive' });
        if (!nowActive) revokeSessions_(u.UserID);
      }
    }
    logAdmin_(session, 'EDIT_STUDENT', 'STUDENT', id, d.diff);
    if (d.diff.CurrentBatch) logAdmin_(session, 'CHANGE_BATCH', 'STUDENT', id, d.diff.CurrentBatch);
    return { changed: Object.keys(d.patch) };
  });
}

function changesList_(p) {
  const id = reqStr_(p, 'studentId', 'Student ID');
  return readAll_('CHANGE_HISTORY').filter(r => r.StudentID === id).map(r => pub_(r)).reverse();
}

/* ---- Student subjects (never overwritten: end the old row, add a new one) ---- */

function subjectAssign_(session, p) {
  const studentId = reqStr_(p, 'studentId', 'Student ID');
  const subjectId = reqStr_(p, 'subjectId', 'Subject');
  const teacherId = reqStr_(p, 'teacherId', 'Teacher');
  const batchId = reqStr_(p, 'batchId', 'Batch');
  const opt = validateFields_({
    StartDate: { type: 'date' }, FeeOverride: { type: 'num', min: 0, max: 100000 }, TeacherRateOverride: { type: 'num', min: 0, max: 100000 }
  }, { StartDate: p.startDate || todayStr_(), FeeOverride: p.feeOverride, TeacherRateOverride: p.teacherRateOverride }, false);
  return withLock_(() => {
    const st = findOne_('STUDENTS', 'StudentID', studentId);
    if (!st) throw new AppError_('NOT_FOUND', 'Student not found.');
    if (!isActive_(st.Status)) throw bad_('Student is not active.');
    const sub = findOne_('SUBJECTS', 'SubjectID', subjectId);
    if (!sub || !isActive_(sub.Status)) throw bad_('Subject is not available.');
    const tch = findOne_('TEACHERS', 'TeacherID', teacherId);
    if (!tch || !isActive_(tch.Status)) throw bad_('Teacher is not available.');
    const bat = findOne_('BATCHES', 'BatchID', batchId);
    if (!bat || !isActive_(bat.Status)) throw bad_('Batch is not available.');

    const current = readAll_('STUDENT_SUBJECTS').filter(r => r.StudentID === studentId && isActive_(r.Status));
    if (current.some(r => r.SubjectID === subjectId)) throw new AppError_('DUPLICATE', 'Student already takes ' + sub.SubjectName + '.');
    const clash = checkSubjectCombination_(current.map(r => r.SubjectID).concat(subjectId));
    if (clash) throw new AppError_('RULE_VIOLATION', clash);

    const row = {
      StudentSubjectID: nextId_('STUDENT_SUBJECTS', 'StudentSubjectID', 'SS-', 4), StudentID: studentId, SubjectID: subjectId,
      TeacherID: teacherId, BatchID: batchId, StartDate: opt.StartDate, EndDate: '', Status: 'ACTIVE',
      FeeOverride: opt.FeeOverride === '' ? '' : opt.FeeOverride, TeacherRateOverride: opt.TeacherRateOverride === '' ? '' : opt.TeacherRateOverride,
      AcademicYear: currentAcademicYear_(), CreatedAt: nowStr_()
    };
    appendObject_('STUDENT_SUBJECTS', row);
    logChange_(session, studentId, 'Subject', '', sub.SubjectName + ' / ' + tch.Name + ' / ' + bat.BatchName, String(p.reason || '').slice(0, 200));
    logAdmin_(session, 'CHANGE_TEACHER', 'STUDENT_SUBJECT', row.StudentSubjectID, { studentId: studentId, subjectId: subjectId, teacherId: teacherId, batchId: batchId });
    return pub_(row);
  });
}

function subjectEnd_(session, p) {
  const id = reqStr_(p, 'studentSubjectId', 'Student subject ID');
  const opt = validateFields_({ EndDate: { type: 'date' } }, { EndDate: p.endDate || todayStr_() }, false);
  return withLock_(() => {
    const row = findOne_('STUDENT_SUBJECTS', 'StudentSubjectID', id);
    if (!row) throw new AppError_('NOT_FOUND', 'Record not found.');
    if (!isActive_(row.Status)) throw bad_('This subject is already ended.');
    if (opt.EndDate < row.StartDate) throw bad_('End date cannot be before the start date.');
    updateObject_('STUDENT_SUBJECTS', row._row, { EndDate: opt.EndDate, Status: 'ENDED' });
    logChange_(session, row.StudentID, 'Subject', row.SubjectID + ' / ' + row.TeacherID + ' / ' + row.BatchID, 'ENDED', String(p.reason || '').slice(0, 200));
    logAdmin_(session, 'CHANGE_TEACHER', 'STUDENT_SUBJECT', id, { ended: opt.EndDate });
    return { ended: true };
  });
}

/* ============================================================
 *  Teachers
 * ============================================================ */

const TEACHER_SPEC_ = {
  Name: { req: true, max: 100 }, Photo: { max: 500 }, Mobile: { type: 'mobile' }, Email: { type: 'email' }, Address: { max: 300 },
  Qualification: { max: 150 }, JoiningDate: { type: 'date' }, Status: { type: 'enum', values: ['Active', 'Inactive'] },
  IncomeMethod: { type: 'enum', values: ['PER_STUDENT_MONTH'] }, DefaultRatePerStudent: { type: 'num', min: 0, max: 100000 },
  IncomeVisibleToTeacher: { type: 'enum', values: ['TRUE', 'FALSE'] }
};

function guardTeacherIncomeFields_(session, data) {
  if ('IncomeMethod' in data || 'DefaultRatePerStudent' in data) requirePerm_(session, 'TEACHER_INCOME_MANAGE');
  if ('IncomeVisibleToTeacher' in data) requirePerm_(session, 'TEACHER_INCOME_GRANT');
}

function teachersAdd_(session, p) {
  const t = p.teacher || {};
  const username = validateFields_({ Username: { req: true, type: 'username' } }, { Username: t.Username }, false).Username;
  const rest = Object.assign({}, t); delete rest.Username;
  const data = validateFields_(TEACHER_SPEC_, rest, false);
  guardTeacherIncomeFields_(session, data);
  if (p.password) validateNewPassword_(String(p.password), username);
  return withLock_(() => {
    if (usernameTaken_(username)) throw new AppError_('DUPLICATE', 'Username "' + username + '" is already taken.');
    const id = nextId_('TEACHERS', 'TeacherID', 'T-', 3);
    const row = Object.assign({ Status: 'Active', IncomeMethod: 'PER_STUDENT_MONTH', IncomeVisibleToTeacher: 'FALSE', JoiningDate: todayStr_() }, data,
      { TeacherID: id, Username: username, CreatedAt: nowStr_(), UpdatedAt: nowStr_() });
    const pw = p.password ? String(p.password) : generatePassword_(8);
    appendObject_('TEACHERS', row);
    appendObject_('USERS', newUserRow_(username, 'TEACHER', 'TEACHER', id, makePasswordHash_(pw)));
    logAdmin_(session, 'ADD_TEACHER', 'TEACHER', id, { name: row.Name, username: username });
    return { teacherId: id, username: username, tempPassword: pw };
  });
}

function teachersUpdate_(session, p) {
  const id = reqStr_(p, 'teacherId', 'Teacher ID');
  const changes = validateFields_(TEACHER_SPEC_, p.changes, true);
  guardTeacherIncomeFields_(session, changes);
  return withLock_(() => {
    const t = findOne_('TEACHERS', 'TeacherID', id);
    if (!t) throw new AppError_('NOT_FOUND', 'Teacher not found.');
    const d = diffFields_(t, changes);
    if (!Object.keys(d.patch).length) return { changed: [] };
    updateObject_('TEACHERS', t._row, Object.assign({}, d.patch, { UpdatedAt: nowStr_() }));
    if (d.diff.Status) {
      const u = readAll_('USERS').find(x => x.UserType === 'TEACHER' && x.LinkedID === id);
      if (u) { updateObject_('USERS', u._row, { Status: d.diff.Status[1] }); if (!isActive_(d.diff.Status[1])) revokeSessions_(u.UserID); }
    }
    if (d.diff.IncomeVisibleToTeacher) {
      const u = readAll_('USERS').find(x => x.UserType === 'TEACHER' && x.LinkedID === id);
      if (u) revokeSessions_(u.UserID);
    }
    logAdmin_(session, 'EDIT_TEACHER', 'TEACHER', id, d.diff);
    return { changed: Object.keys(d.patch) };
  });
}

/** Reset the login password of a student or teacher. Returns the new temporary password once. */
function linkedResetPassword_(session, userType, linkedId, chosen) {
  const id = String(linkedId || '').trim();
  if (!id) throw bad_('ID is required.');
  const u = readAll_('USERS').find(x => x.UserType === userType && x.LinkedID === id);
  if (!u) throw new AppError_('NOT_FOUND', 'No login account found for ' + id + '.');
  const pw = setTempPassword_(u, chosen);
  logAdmin_(session, 'RESET_PASSWORD', 'USER', u.UserID, userType + ' ' + id);
  return { username: u.Username, tempPassword: pw };
}

/* ============================================================
 *  User administration (Super Admin)
 * ============================================================ */

function adminCreate_(session, p) {
  const username = validateFields_({ Username: { req: true, type: 'username' } }, { Username: p.username }, false).Username;
  if (p.password) validateNewPassword_(String(p.password), username);
  return withLock_(() => {
    if (usernameTaken_(username)) throw new AppError_('DUPLICATE', 'Username "' + username + '" is already taken.');
    const pw = p.password ? String(p.password) : generatePassword_(10);
    const row = newUserRow_(username, 'ADMIN', 'ACCOUNTS_ADMIN', '', makePasswordHash_(pw));
    appendObject_('USERS', row);
    logAdmin_(session, 'CREATE_ADMIN', 'USER', row.UserID, { username: username, role: 'ACCOUNTS_ADMIN' });
    return { userId: row.UserID, username: username, role: 'ACCOUNTS_ADMIN', tempPassword: pw };
  });
}

function userSetStatus_(session, p) {
  const id = reqStr_(p, 'userId', 'User ID');
  const status = validateFields_({ Status: { req: true, type: 'enum', values: ['Active', 'Inactive'] } }, { Status: p.status }, false).Status;
  if (id === session.uid) throw bad_('You cannot change your own status.');
  return withLock_(() => {
    const u = findOne_('USERS', 'UserID', id);
    if (!u) throw new AppError_('NOT_FOUND', 'User not found.');
    updateObject_('USERS', u._row, { Status: status });
    if (status === 'Inactive') revokeSessions_(id);
    logAdmin_(session, u.UserType === 'ADMIN' ? (status === 'Inactive' ? 'DISABLE_ADMIN' : 'ENABLE_ADMIN') : 'SET_USER_STATUS',
      'USER', id, { username: u.Username, status: status });
    return { userId: id, status: status };
  });
}

function userResetPassword_(session, p) {
  const id = reqStr_(p, 'userId', 'User ID');
  const u = findOne_('USERS', 'UserID', id);
  if (!u) throw new AppError_('NOT_FOUND', 'User not found.');
  const pw = setTempPassword_(u, p.password);
  logAdmin_(session, 'RESET_PASSWORD', 'USER', id, u.Username);
  return { username: u.Username, tempPassword: pw };
}

function userSetPermissions_(session, p) {
  const id = reqStr_(p, 'userId', 'User ID');
  const list = Array.isArray(p.extraPermissions) ? p.extraPermissions.map(String) : null;
  if (!list) throw bad_('extraPermissions must be a list.');
  list.forEach(x => { if (ALL_PERMS.indexOf(x) < 0) throw bad_('Unknown permission: ' + x); });
  return withLock_(() => {
    const u = findOne_('USERS', 'UserID', id);
    if (!u) throw new AppError_('NOT_FOUND', 'User not found.');
    if (u.Role === 'SUPER_ADMIN') throw bad_('Super Admin already has every permission.');
    const clean = list.filter((x, i) => list.indexOf(x) === i);
    updateObject_('USERS', u._row, { ExtraPermissions: clean.join(',') });
    revokeSessions_(id); // takes effect immediately: user must log in again
    logAdmin_(session, 'CHANGE_PERMISSIONS', 'USER', id, { username: u.Username, extra: clean });
    return { userId: id, extraPermissions: clean };
  });
}

function logsList_(p) {
  const limit = Math.min(Math.max(parseInt(p.limit, 10) || 100, 1), 500);
  const action = String(p.action || '').toUpperCase();
  const username = String(p.username || '').toLowerCase();
  const sh = getSheet_('ADMIN_LOGS');
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const scan = (action || username) ? 3000 : limit; // when filtering, look further back
  const start = Math.max(2, lastRow - scan + 1);
  const headers = headersOf_(sh);
  const vals = sh.getRange(start, 1, lastRow - start + 1, headers.length).getValues();
  const rows = vals.map(r => { const o = {}; headers.forEach((h, i) => { o[h] = cellOut_(r[i], false); }); return o; }).reverse();
  return rows.filter(r => (!action || String(r.Action).toUpperCase() === action) && (!username || String(r.Username).toLowerCase() === username)).slice(0, limit);
}

