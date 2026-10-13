/**
 * ============================================================
 *  CREATIVE MATH ZONE — Setup.gs
 *  Run setupDatabase() ONCE from the Apps Script editor.
 *  It is safe to run again later: it only adds what is missing
 *  (sheets, columns, seed rows) and never deletes or overwrites data.
 * ============================================================
 */

function setupDatabase() {
  assertOwner_();
  const ss = ensureSpreadsheet_();
  const report = [];

  Object.keys(SCHEMA).forEach(key => report.push(ensureSheet_(ss, key)));
  removeDefaultSheet_(ss);

  const added = {
    settings: seedSettings_(),
    subjects: seedIfEmpty_('SUBJECTS', [
      { SubjectID: 'SUB001', SubjectName: 'Mathematics', Status: 'Active' },
      { SubjectID: 'SUB002', SubjectName: 'Computer', Status: 'Active' },
      { SubjectID: 'SUB003', SubjectName: 'Statistics', Status: 'Active' },
      { SubjectID: 'SUB004', SubjectName: 'Physics', Status: 'Active' }
    ]),
    batches: seedIfEmpty_('BATCHES', [
      ['B001', 'XI-A', 'XI', 'A'], ['B002', 'XI-B', 'XI', 'B'], ['B003', 'XII-A', 'XII', 'A'],
      ['B004', 'XII-B', 'XII', 'B'], ['B005', 'IX-A', 'IX', 'A'], ['B006', 'IX-B', 'IX', 'B']
    ].map(b => ({ BatchID: b[0], BatchName: b[1], Class: b[2], Section: b[3], AcademicYear: '2026-27', Status: 'Active' }))),
    rooms: seedIfEmpty_('ROOMS', [
      { RoomID: 'R001', RoomName: 'Room 1', Capacity: 25, Status: 'Active' },
      { RoomID: 'R002', RoomName: 'Room 2', Capacity: 30, Status: 'Active' },
      { RoomID: 'R003', RoomName: 'Computer Lab', Capacity: 20, Status: 'Active' }
    ]),
    fees: seedIfEmpty_('FEE_STRUCTURE', [
      { FeeID: 'F001', ItemType: 'REGISTRATION', SubjectID: '', Description: 'Registration Fee', Amount: 100 },
      { FeeID: 'F002', ItemType: 'SUBJECT', SubjectID: 'SUB001', Description: 'Mathematics monthly fee', Amount: 1200 },
      { FeeID: 'F003', ItemType: 'SUBJECT', SubjectID: 'SUB002', Description: 'Computer monthly fee', Amount: 500 },
      { FeeID: 'F004', ItemType: 'SUBJECT', SubjectID: 'SUB004', Description: 'Physics monthly fee', Amount: 1500 }
    ].map(f => Object.assign({ AcademicYear: '2026-27', Status: 'Active' }, f)))
  };

  const admin = ensureSuperAdmin_();

  Logger.log('================ CMZ SETUP COMPLETE ================');
  Logger.log('Spreadsheet: ' + ss.getName() + '  ' + ss.getUrl());
  report.forEach(r => Logger.log('  ' + r));
  Logger.log('Seed rows added: ' + JSON.stringify(added));
  if (admin.created) {
    Logger.log('----------------------------------------------------');
    Logger.log('SUPER ADMIN CREATED');
    Logger.log('  Username : ' + admin.username);
    Logger.log('  Temp password : ' + admin.password);
    Logger.log('  (shown only now — you must change it at first login)');
    Logger.log('----------------------------------------------------');
  } else {
    Logger.log('Super Admin already exists — not changed. (Locked out? run ownerResetAdminPassword)');
  }
  Logger.log('NOTE: Statistics has no fee row yet. Add it in 13_FeeStructure when you decide the amount.');
  return { ok: true, sheets: report.length, seeded: added, superAdminCreated: admin.created };
}

/** Owner-only recovery: issues a new temporary password for the Super Admin (default username "admin"). */
function ownerResetAdminPassword() {
  assertOwner_();
  const user = readAll_('USERS').find(u => u.Role === 'SUPER_ADMIN');
  if (!user) throw new AppError_('NOT_FOUND', 'No Super Admin exists. Run setupDatabase() first.');
  const pw = setTempPassword_(user, null);
  logAdmin_({ uid: 'OWNER', username: 'script-owner', role: 'OWNER' }, 'RESET_PASSWORD', 'USER', user.UserID, 'owner reset via editor', 'OK');
  Logger.log('Super Admin "' + user.Username + '" new temp password: ' + pw + '   (change it at next login)');
  return { ok: true };
}

/** Owner-only quick health check you can run in the editor after setup. */
function runSelfTest() {
  assertOwner_();
  const out = [];
  const check = (name, fn) => {
    try { const r = fn(); out.push((r === false ? 'FAIL ' : 'PASS ') + name); }
    catch (e) { out.push('FAIL ' + name + ' — ' + e.message); }
  };
  check('all sheets exist with headers', () => Object.keys(SCHEMA).every(k => {
    const have = headersOf_(getSheet_(k));
    return SCHEMA[k].headers.every(h => have.indexOf(h) >= 0);
  }));
  check('settings readable', () => getSetting_('CENTRE_NAME', '') === 'Creative Math Zone' || getSetting_('CENTRE_NAME', '') !== '');
  check('password hash round-trip', () => verifyPassword_('Abc123!', makePasswordHash_('Abc123!')) && !verifyPassword_('abc123!', makePasswordHash_('Abc123!')));
  check('Computer + Statistics blocked', () => !!checkSubjectCombination_(['SUB002', 'SUB003']));
  check('Mathematics + Computer allowed', () => checkSubjectCombination_(['SUB001', 'SUB002']) === null);
  check('super admin exists', () => readAll_('USERS').some(u => u.Role === 'SUPER_ADMIN'));
  check('session create/read/destroy', () => {
    const u = readAll_('USERS')[0];
    const s = createSession_(u, false);
    const back = getSession_(s.token);
    destroySession_(s.token);
    return back.uid === u.UserID;
  });
  out.forEach(l => Logger.log(l));
  return out;
}

/* ------------------------------------------------------------ */

function ensureSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  let ss = null;
  const id = props.getProperty(CMZ.PROP_DB_ID);
  if (id) ss = SpreadsheetApp.openById(id);
  if (!ss) { try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; } }
  if (!ss) ss = SpreadsheetApp.create(CMZ.DB_NAME); // standalone script: make the database
  props.setProperty(CMZ.PROP_DB_ID, ss.getId());
  setDb_(ss);
  return ss;
}

function colLetter_(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** Create the sheet if missing, add any missing header columns, style, freeze, and force text format on text columns. */
function ensureSheet_(ss, key) {
  const def = SCHEMA[key];
  let sh = ss.getSheetByName(def.name);
  let status = 'exists';
  if (!sh) { sh = ss.insertSheet(def.name); status = 'created'; }

  let have = headersOf_(sh);
  const missing = def.headers.filter(h => have.indexOf(h) < 0);
  if (missing.length) {
    sh.getRange(1, have.length + 1, 1, missing.length).setValues([missing]);
    if (status === 'exists') status = 'added columns: ' + missing.join(', ');
  }
  have = headersOf_(sh);

  const head = sh.getRange(1, 1, 1, have.length);
  head.setFontWeight('bold').setBackground('#1f3a5f').setFontColor('#ffffff');
  sh.setFrozenRows(1);

  const textCols = [];
  have.forEach((h, i) => { if (!isNumericCol_(key, h)) textCols.push(colLetter_(i + 1) + '2:' + colLetter_(i + 1)); });
  if (textCols.length) sh.getRangeList(textCols).setNumberFormat('@'); // keeps IDs, phone numbers, dates as typed text

  return def.name + ' — ' + status;
}

function removeDefaultSheet_(ss) {
  const names = Object.keys(SCHEMA).map(k => SCHEMA[k].name);
  ss.getSheets().forEach(sh => {
    const n = sh.getName();
    if (/^(Sheet1|Sheet 1)$/i.test(n) && names.indexOf(n) < 0 && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });
}

function seedIfEmpty_(key, rows) {
  if (readAll_(key).length > 0) return 0;
  appendObjects_(key, rows);
  return rows.length;
}

function seedSettings_() {
  const S = [
    ['CENTRE_NAME', 'Creative Math Zone', 'Centre name shown in portals and receipts'],
    ['ACADEMIC_YEAR', '2026-27', 'Current academic year (yyyy-yy)'],
    ['ADDRESS', '9 Gopal Lal Tagore Road', 'Centre address — please complete the full address'],
    ['MOBILE', '9836719201 / 9748460059', 'Contact numbers'],
    ['EMAIL', 'creativemathzone@gmail.com', 'Contact email'],
    ['WEBSITE', 'creativemathzone.in', 'Website'],
    ['TAGLINE', 'Eat Math, Drink Math, Dream Math', 'Tagline'],
    ['STUDENT_ID_PREFIX', 'CMZ', 'Prefix for Student IDs (CMZ-2026-001)'],
    ['ATTENDANCE_CODE_MINUTES', '5', 'How long the 4-digit attendance code stays valid'],
    ['SESSION_TIMEOUT_MINUTES', '30', 'Automatic logout after this many idle minutes'],
    ['LOGIN_MAX_ATTEMPTS', '5', 'Wrong passwords allowed before the account is temporarily locked'],
    ['LOGIN_LOCK_MINUTES', '15', 'How long a locked account stays locked'],
    ['LATE_FEE_ENABLED', 'FALSE', 'TRUE/FALSE'],
    ['REGISTRATION_ENABLED', 'TRUE', 'TRUE/FALSE: let new students send an online registration request'],
    ['REGISTRATION_MAX_PER_HOUR', '15', 'Most online registration requests accepted per hour (spam guard)'],
    ['LOCATION_CHECK_ENABLED', 'TRUE', 'TRUE/FALSE — verify student location when marking attendance'],
    ['SUBJECT_BLOCKED_PAIRS', 'SUB002|SUB003', 'Subjects that cannot be taken together: IDA|IDB;IDC|IDD (default: Computer + Statistics)']
  ];
  const existing = {};
  readAll_('SETTINGS').forEach(r => { existing[r.SettingKey] = true; });
  const rows = S.filter(s => !existing[s[0]]).map(s => ({ SettingKey: s[0], Value: s[1], Description: s[2], UpdatedAt: nowStr_(), UpdatedBy: 'setup' }));
  appendObjects_('SETTINGS', rows);
  clearSettingsCache_();
  return rows.length;
}

function ensureSuperAdmin_() {
  if (readAll_('USERS').some(u => u.Role === 'SUPER_ADMIN')) return { created: false };
  const password = generatePassword_(10);
  withLock_(() => {
    appendObject_('USERS', {
      UserID: nextId_('USERS', 'UserID', 'U-', 4), Username: 'admin', PasswordHash: makePasswordHash_(password),
      UserType: 'ADMIN', Role: 'SUPER_ADMIN', LinkedID: '', Status: 'Active', LastLogin: '', LastLogout: '',
      CreatedDate: todayStr_(), PasswordChanged: 'No', FailedAttempts: 0, LockedUntil: '', ExtraPermissions: ''
    });
  });
  logAdmin_({ uid: 'OWNER', username: 'script-owner', role: 'OWNER' }, 'CREATE_ADMIN', 'USER', 'admin', 'initial Super Admin', 'OK');
  return { created: true, username: 'admin', password: password };
}
