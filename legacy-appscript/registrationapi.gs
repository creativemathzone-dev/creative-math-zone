/**
 * ============================================================
 *  CREATIVE MATH ZONE — RegistrationApi.gs
 *  Student self-registration (public) + admin review.
 *
 *  Flow
 *   1. A student fills the form on the student sign-in page (public.register).
 *      Nothing is created except a PENDING row in 24_Registrations.
 *      The password they choose is stored HASHED, never in plain text.
 *   2. An admin reviews it under Registrations. Approve = create the student
 *      record + login account (same code as "Add student") and give subjects.
 *      Reject = keep the row with a reason.
 *   3. After approval or rejection the stored password hash is wiped from the
 *      registration row (an approved one now lives only in 02_Users).
 *
 *  Permissions: viewing needs STUDENT_VIEW, approving/rejecting/editing needs
 *  STUDENT_EDIT. Needs studentsCreate_ + checkStudentBatch_ + subjectAssign_
 *  (Api.gs) and subjectName_ (StudentApi.gs).
 * ============================================================
 */

const REG_MAX_PENDING_ = 300;          // hard cap on waiting requests (spam guard)
const REG_MAX_PER_PARENT_ = 5;         // requests per parent mobile within the cache window (~6 h)
const REG_MAX_SUBJECTS_ = 6;

const REG_SPEC_ = {
  Name:               { req: true, max: 100 },
  CurrentClass:       { req: true, max: 10, upper: true },
  DOB:                { type: 'date' },
  Gender:             { type: 'enum', values: ['MALE', 'FEMALE', 'OTHER'] },
  Mobile:             { type: 'mobile' },
  Email:              { type: 'email' },
  Address:            { max: 300 },
  School:             { max: 100 },
  Board:              { max: 30 },
  PreviousPercentage: { type: 'num', min: 0, max: 100 },
  ParentName:         { req: true, max: 100 },
  Relationship:       { max: 30 },
  ParentMobile:       { req: true, type: 'mobile' },
  ParentWhatsApp:     { type: 'mobile' },
  ParentEmail:        { type: 'email' }
};

/* ---------- small helpers ---------- */

function regEnabled_() { return getSettingBool_('REGISTRATION_ENABLED', true); }

/** Classes that have at least one active batch, in the order batches were created. */
function regActiveClasses_() {
  const seen = {}, out = [];
  readAll_('BATCHES').filter(b => isActive_(b.Status)).forEach(b => {
    const c = String(b.Class).toUpperCase();
    if (!seen[c]) { seen[c] = true; out.push(c); }
  });
  return out;
}

function regCount_(key) { return parseInt(CacheService.getScriptCache().get(key), 10) || 0; }
function regBump_(key, ttl) { CacheService.getScriptCache().put(key, String(regCount_(key) + 1), ttl); }

function regNumbers_(r) { return [r.Mobile, r.ParentMobile].filter(Boolean); }

/** Validates a list of subject IDs: active, no repeats, allowed combination. Returns the clean list. */
function regCleanSubjects_(list) {
  if (list === undefined || list === null || list === '') return [];
  if (!Array.isArray(list)) throw bad_('Subjects must be a list.');
  const ids = list.map(String).filter((x, i, a) => a.indexOf(x) === i);
  if (ids.length > REG_MAX_SUBJECTS_) throw bad_('Too many subjects chosen.');
  const subs = readAll_('SUBJECTS');
  ids.forEach(id => {
    const s = subs.find(x => x.SubjectID === id);
    if (!s || !isActive_(s.Status)) throw bad_('One of the chosen subjects is not available.');
  });
  const clash = ids.length ? checkSubjectCombination_(ids) : null;
  if (clash) throw new AppError_('RULE_VIOLATION', clash);
  return ids;
}

/* ============================================================
 *  PUBLIC (no login)
 * ============================================================ */

/** What the registration form needs: is it open, which classes and subjects exist. */
function regOptions_() {
  return {
    enabled: regEnabled_(),
    classes: regActiveClasses_(),
    subjects: readAll_('SUBJECTS').filter(s => isActive_(s.Status)).map(s => ({ id: s.SubjectID, name: s.SubjectName })),
    blockedPairs: blockedPairs_()
  };
}

function registerSubmit_(p) {
  if (!regEnabled_()) throw new AppError_('CLOSED', 'Online registration is closed. Please contact the centre.');
  if (String(p.website || '').trim()) return { requestId: 'REG-00000' }; // honeypot filled in: a bot. Pretend it worked.

  const data = validateFields_(REG_SPEC_, p.student, false);
  const password = String(p.password || '');
  validateNewPassword_(password, '');
  if (regActiveClasses_().indexOf(data.CurrentClass) < 0) throw bad_('Please choose a class from the list.');
  const subjectIds = regCleanSubjects_(p.subjects);
  const hash = makePasswordHash_(password);

  return withLock_(() => {
    const hourKey = 'REG_H_' + Utilities.formatDate(nowDate_(), tz_(), 'yyyyMMddHH');
    const maxHour = getSettingInt_('REGISTRATION_MAX_PER_HOUR', 15, 1, 200);
    if (regCount_(hourKey) >= maxHour) {
      throw new AppError_('RATE_LIMIT', 'Many requests are coming in right now. Please try again in a little while.');
    }
    const parentKey = 'REG_M_' + data.ParentMobile;
    if (regCount_(parentKey) >= REG_MAX_PER_PARENT_) {
      throw new AppError_('RATE_LIMIT', 'Too many requests from this mobile number. Please contact the centre.');
    }

    const regs = readAll_('REGISTRATIONS');
    const pending = regs.filter(r => r.Status === 'PENDING');
    if (pending.length >= REG_MAX_PENDING_) {
      throw new AppError_('RATE_LIMIT', 'Registration is paused for now. Please contact the centre.');
    }

    // Duplicate = same name and a shared mobile number, among waiting requests and existing students.
    const nm = data.Name.toLowerCase();
    const mine = [data.Mobile, data.ParentMobile].filter(Boolean);
    const same = r => String(r.Name).toLowerCase() === nm && regNumbers_(r).some(n => mine.indexOf(n) >= 0);
    if (pending.some(same) || readAll_('STUDENTS').some(same)) {
      throw new AppError_('DUPLICATE', 'This looks like a duplicate of an existing record. Please contact the centre.');
    }

    const id = nextId_('REGISTRATIONS', 'RegistrationID', 'REG-', 5);
    appendObject_('REGISTRATIONS', Object.assign({}, data, {
      RegistrationID: id, SubmittedAt: nowStr_(), Status: 'PENDING',
      RequestedSubjects: subjectIds.join(','), PasswordHash: hash,
      ReviewedBy: '', ReviewedAt: '', RejectReason: '', StudentID: ''
    }));
    regBump_(hourKey, 3700);
    regBump_(parentKey, 21600);
    logAdmin_({ uid: '', username: 'public', role: '' }, 'REGISTRATION_SUBMITTED', 'REGISTRATION', id,
      { name: data.Name, class: data.CurrentClass });
    return { requestId: id };
  });
}

/** Student checks progress with request ID + a mobile number from the form. */
function registerStatus_(p) {
  const id = String(p.requestId || '').trim().toUpperCase();
  const mobile = normMobile_(p.mobile || '');
  const notFound = new AppError_('NOT_FOUND', 'No request found for those details. Check the request ID and mobile number.');
  if (!/^REG-\d{5}$/.test(id) || !mobile) throw notFound;
  const key = 'REG_S_' + id;
  if (regCount_(key) >= 10) throw new AppError_('RATE_LIMIT', 'Too many attempts. Please try again later.');
  regBump_(key, 3600);

  const r = findOne_('REGISTRATIONS', 'RegistrationID', id);
  if (!r || regNumbers_(r).indexOf(mobile) < 0) throw notFound;
  return {
    RegistrationID: r.RegistrationID, Name: r.Name, Status: r.Status, SubmittedAt: r.SubmittedAt,
    StudentID: r.Status === 'APPROVED' ? r.StudentID : '',
    RejectReason: r.Status === 'REJECTED' ? r.RejectReason : ''
  };
}

/* ============================================================
 *  ADMIN
 * ============================================================ */

function registrationsList_(p) {
  const status = String((p && p.status) || '').toUpperCase();
  const subj = {};
  readAll_('SUBJECTS').forEach(s => { subj[s.SubjectID] = s.SubjectName; });
  const all = readAll_('REGISTRATIONS');
  const counts = { PENDING: 0, APPROVED: 0, REJECTED: 0 };
  all.forEach(r => { if (counts[r.Status] !== undefined) counts[r.Status]++; });
  const rows = all
    .filter(r => !status || r.Status === status)
    .sort((a, b) => String(b.RegistrationID).localeCompare(String(a.RegistrationID)))
    .slice(0, 500)
    .map(r => Object.assign(pub_(r, ['PasswordHash']), {
      SubjectNames: splitList_(r.RequestedSubjects).map(id => subj[id] || id).join(', ')
    }));
  return { rows: rows, counts: counts };
}

function registrationsPendingCount_() {
  return { count: readAll_('REGISTRATIONS').filter(r => r.Status === 'PENDING').length };
}

function registrationsUpdate_(session, p) {
  const id = reqStr_(p, 'id', 'Request ID');
  const changes = validateFields_(REG_SPEC_, p.changes, true);
  if (changes.CurrentClass && regActiveClasses_().indexOf(changes.CurrentClass) < 0) {
    throw bad_('Class must be one that has an active batch.');
  }
  return withLock_(() => {
    const r = findOne_('REGISTRATIONS', 'RegistrationID', id);
    if (!r) throw new AppError_('NOT_FOUND', 'Request not found.');
    if (r.Status !== 'PENDING') throw bad_('Only pending requests can be edited.');
    const d = diffFields_(r, changes);
    if (!Object.keys(d.patch).length) return { changed: [] };
    updateObject_('REGISTRATIONS', r._row, d.patch);
    logAdmin_(session, 'EDIT_REGISTRATION', 'REGISTRATION', id, d.diff);
    return { changed: Object.keys(d.patch) };
  });
}

/**
 * Approve: everything is checked first so a failure cannot leave a half-created student.
 * p = { id, batchId, startDate?, subjects: [{ subjectId, teacherId }] }
 */
function registrationsApprove_(session, p) {
  const id = reqStr_(p, 'id', 'Request ID');
  const batchId = reqStr_(p, 'batchId', 'Batch');
  const startDate = validateFields_({ StartDate: { type: 'date' } }, { StartDate: p.startDate || todayStr_() }, false).StartDate;
  const picks = Array.isArray(p.subjects) ? p.subjects : [];
  if (picks.length > REG_MAX_SUBJECTS_) throw bad_('Too many subjects.');
  const seen = {};
  picks.forEach(x => {
    if (!x || !x.subjectId || !x.teacherId) throw bad_('Choose a teacher for every subject you tick.');
    if (seen[x.subjectId]) throw bad_('A subject was chosen twice.');
    seen[x.subjectId] = true;
  });

  return withLock_(() => {
    const r = findOne_('REGISTRATIONS', 'RegistrationID', id);
    if (!r) throw new AppError_('NOT_FOUND', 'Request not found.');
    if (r.Status !== 'PENDING') throw bad_('This request is already ' + String(r.Status).toLowerCase() + '.');

    const bat = findOne_('BATCHES', 'BatchID', batchId);
    if (!bat || !isActive_(bat.Status)) throw bad_('Batch is not available.');
    if (String(bat.Class).toUpperCase() !== String(r.CurrentClass).toUpperCase()) {
      throw bad_('Batch ' + bat.BatchName + ' is for class ' + bat.Class + ', not ' + r.CurrentClass + '.');
    }
    picks.forEach(x => {
      const sub = findOne_('SUBJECTS', 'SubjectID', x.subjectId);
      if (!sub || !isActive_(sub.Status)) throw bad_('A chosen subject is not available.');
      const tch = findOne_('TEACHERS', 'TeacherID', x.teacherId);
      if (!tch || !isActive_(tch.Status)) throw bad_('A chosen teacher is not available.');
    });
    const clash = picks.length ? checkSubjectCombination_(picks.map(x => x.subjectId)) : null;
    if (clash) throw new AppError_('RULE_VIOLATION', clash);

    const raw = {};
    ['Name', 'CurrentClass', 'DOB', 'Gender', 'Mobile', 'Email', 'Address', 'School', 'Board', 'ParentName',
     'Relationship', 'ParentMobile', 'ParentWhatsApp', 'ParentEmail', 'PreviousPercentage'].forEach(k => {
      if (r[k] !== '' && r[k] !== undefined && r[k] !== null) raw[k] = r[k];
    });
    raw.CurrentBatch = batchId;
    const data = validateFields_(STUDENT_SPEC_, raw, false);
    checkStudentBatch_(data);

    const created = studentsCreate_(session, data, { passwordHash: r.PasswordHash || '' });

    const warnings = [];
    picks.forEach(x => {
      try {
        subjectAssign_(session, {
          studentId: created.studentId, subjectId: x.subjectId, teacherId: x.teacherId, batchId: batchId,
          startDate: startDate, reason: 'Online registration ' + id
        });
      } catch (e) {
        warnings.push(subjectName_(x.subjectId) + ': ' + ((e && e.message) || 'could not be added'));
      }
    });

    updateObject_('REGISTRATIONS', r._row, {
      Status: 'APPROVED', ReviewedBy: session.username, ReviewedAt: nowStr_(),
      StudentID: created.studentId, PasswordHash: ''
    });
    logAdmin_(session, 'APPROVE_REGISTRATION', 'REGISTRATION', id,
      { studentId: created.studentId, batch: batchId, subjects: picks.map(x => x.subjectId) });

    let portalUrl = '';
    try { portalUrl = ScriptApp.getService().getUrl() + '?page=student'; } catch (e) { portalUrl = ''; }
    return {
      studentId: created.studentId, username: created.username,
      tempPassword: created.tempPassword || '', // only set if the request somehow had no saved password
      warnings: warnings, portalUrl: portalUrl
    };
  });
}

function registrationsReject_(session, p) {
  const id = reqStr_(p, 'id', 'Request ID');
  const reason = String(p.reason || '').trim().slice(0, 200);
  if (!reason) throw bad_('Please give a reason.');
  return withLock_(() => {
    const r = findOne_('REGISTRATIONS', 'RegistrationID', id);
    if (!r) throw new AppError_('NOT_FOUND', 'Request not found.');
    if (r.Status !== 'PENDING') throw bad_('This request is already ' + String(r.Status).toLowerCase() + '.');
    updateObject_('REGISTRATIONS', r._row, {
      Status: 'REJECTED', ReviewedBy: session.username, ReviewedAt: nowStr_(), RejectReason: reason, PasswordHash: ''
    });
    logAdmin_(session, 'REJECT_REGISTRATION', 'REGISTRATION', id, { reason: reason });
    return { ok: true };
  });
}

function registrationActionDefs_() {
  return {
    'public.registerOptions':      { public: true, run: () => regOptions_() },
    'public.register':             { public: true, run: (s, p) => registerSubmit_(p) },
    'public.registerStatus':       { public: true, run: (s, p) => registerStatus_(p) },
    'registrations.list':          { perm: 'STUDENT_VIEW', run: (s, p) => registrationsList_(p) },
    'registrations.pendingCount':  { perm: 'STUDENT_VIEW', run: () => registrationsPendingCount_() },
    'registrations.update':        { perm: 'STUDENT_EDIT', run: (s, p) => registrationsUpdate_(s, p) },
    'registrations.approve':       { perm: 'STUDENT_EDIT', run: (s, p) => registrationsApprove_(s, p) },
    'registrations.reject':        { perm: 'STUDENT_EDIT', run: (s, p) => registrationsReject_(s, p) }
  };
}
