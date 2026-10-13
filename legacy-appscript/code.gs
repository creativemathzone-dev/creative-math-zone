/**
 * ============================================================
 *  CREATIVE MATH ZONE — Class Management System
 *  Code.gs · Phase 1 foundation
 * ============================================================
 *  Conventions
 *   - Functions ending in "_" are private. Apps Script never exposes them to
 *     google.script.run, so the browser cannot call them.
 *   - Browser-callable entry points: api(), doGet(), and the owner-only
 *     maintenance functions in Setup.gs (guarded by assertOwner_()).
 *   - Everything is stored as TEXT except columns listed in SCHEMA.*.numeric.
 *     Dates "yyyy-MM-dd", times "HH:mm", timestamps "yyyy-MM-dd HH:mm:ss"
 *     (script time zone, Asia/Kolkata). Portals format dates for display.
 *   - Sheet row 1 is the source of truth for column order; code maps by
 *     header name, so you may reorder columns without breaking anything.
 */

const CMZ = {
  VERSION: '1.0.0-phase1',
  DB_NAME: 'CMZ_CLASS_MANAGEMENT_2026_27',
  PROP_DB_ID: 'DB_ID',
  HASH_VERSION: 'v1',
  HASH_ITERATIONS: 600,
  SESSION_TTL_SECONDS: 21600, // CacheService maximum; refreshed on activity
  CACHE_SETTINGS_KEY: 'CMZ_SETTINGS'
};

/** Logical key -> sheet name + headers. Setup.gs adds missing columns, never removes any. */
const SCHEMA = {
  SETTINGS: { name: '01_Settings', headers: ['SettingKey', 'Value', 'Description', 'UpdatedAt', 'UpdatedBy'] },
  USERS: {
    name: '02_Users',
    headers: ['UserID', 'Username', 'PasswordHash', 'UserType', 'Role', 'LinkedID', 'Status', 'LastLogin', 'LastLogout',
      'CreatedDate', 'PasswordChanged', 'FailedAttempts', 'LockedUntil', 'ExtraPermissions'],
    numeric: ['FailedAttempts']
  },
  STUDENTS: {
    name: '03_Students',
    headers: ['StudentID', 'RegistrationYear', 'RegistrationDate', 'RollNo', 'Name', 'PhotoURL', 'DOB', 'Gender', 'Mobile',
      'Email', 'Address', 'School', 'Board', 'CurrentClass', 'CurrentBatch', 'ParentName', 'Relationship', 'ParentMobile',
      'ParentWhatsApp', 'ParentEmail', 'PreviousPercentage', 'Status', 'AcademicYear', 'CreatedAt', 'UpdatedAt'],
    numeric: ['PreviousPercentage']
  },
  STUDENT_SUBJECTS: {
    name: '04_StudentSubjects',
    headers: ['StudentSubjectID', 'StudentID', 'SubjectID', 'TeacherID', 'BatchID', 'StartDate', 'EndDate', 'Status',
      'FeeOverride', 'TeacherRateOverride', 'AcademicYear', 'CreatedAt'],
    numeric: ['FeeOverride', 'TeacherRateOverride']
  },
  TEACHERS: {
    name: '05_Teachers',
    headers: ['TeacherID', 'Name', 'Photo', 'Mobile', 'Email', 'Address', 'Qualification', 'JoiningDate', 'Status', 'Username',
      'IncomeMethod', 'DefaultRatePerStudent', 'IncomeVisibleToTeacher', 'CreatedAt', 'UpdatedAt'],
    numeric: ['DefaultRatePerStudent']
  },
  SUBJECTS: { name: '06_Subjects', headers: ['SubjectID', 'SubjectName', 'Status'] },
  BATCHES: { name: '07_Batches', headers: ['BatchID', 'BatchName', 'Class', 'Section', 'AcademicYear', 'Status'] },
  ROOMS: { name: '08_Rooms', headers: ['RoomID', 'RoomName', 'Capacity', 'Status'], numeric: ['Capacity'] },
  TIMETABLE: {
    name: '09_Timetable',
    headers: ['TimetableID', 'Day', 'StartTime', 'EndTime', 'BatchID', 'SubjectID', 'TeacherID', 'RoomID', 'AcademicYear', 'Status']
  },
  CLASS_SESSIONS: {
    name: '10_ClassSessions',
    headers: ['SessionID', 'TimetableID', 'Date', 'StartTime', 'EndTime', 'TeacherID', 'BatchID', 'SubjectID', 'RoomID',
      'AttendanceCode', 'CodeCreatedAt', 'CodeExpiresAt', 'Status', 'StartedAt', 'ClosedAt', 'AcademicYear']
  },
  ATTENDANCE: {
    name: '11_Attendance',
    headers: ['AttendanceID', 'SessionID', 'StudentID', 'SubjectID', 'BatchID', 'Date', 'Status', 'MarkedBy', 'MarkedAt',
      'Method', 'LocationVerified', 'AcademicYear']
  },
  ATTENDANCE_LOGS: {
    name: '12_AttendanceLogs',
    headers: ['LogID', 'AttendanceID', 'SessionID', 'StudentID', 'OldStatus', 'NewStatus', 'ChangedBy', 'ChangedAt', 'Reason']
  },
  FEE_STRUCTURE: {
    name: '13_FeeStructure',
    headers: ['FeeID', 'ItemType', 'SubjectID', 'Description', 'Amount', 'AcademicYear', 'Status'],
    numeric: ['Amount']
  },
  STUDENT_FEES: {
    name: '14_StudentFees',
    headers: ['StudentFeeID', 'StudentID', 'SubjectID', 'StandardAmount', 'DiscountAmount', 'FinalAmount', 'EffectiveFrom',
      'EffectiveTo', 'AcademicYear', 'Status', 'CreatedAt', 'Reason'],
    numeric: ['StandardAmount', 'DiscountAmount', 'FinalAmount']
  },
  INVOICES: {
    name: '15_Invoices',
    headers: ['InvoiceID', 'StudentID', 'Month', 'AcademicYear', 'LineItems', 'TotalAmount', 'PaidAmount', 'BalanceAmount',
      'Status', 'DueDate', 'CreatedAt', 'UpdatedAt'],
    numeric: ['TotalAmount', 'PaidAmount', 'BalanceAmount']
  },
  PAYMENTS: {
    name: '16_Payments',
    headers: ['PaymentID', 'StudentID', 'InvoiceID', 'PaymentDate', 'Amount', 'PaymentMode', 'TransactionReference',
      'ReceivedBy', 'Status', 'Notes', 'ReceiptID', 'AcademicYear', 'VoidedBy', 'VoidDate', 'VoidReason', 'Allocations'],
    numeric: ['Amount']
  },
  RECEIPTS: {
    name: '17_Receipts',
    headers: ['ReceiptID', 'PaymentID', 'StudentID', 'ReceiptDate', 'Amount', 'Format', 'Status', 'VoidedBy', 'VoidDate',
      'VoidReason', 'AcademicYear', 'CreatedBy', 'CreatedAt'],
    numeric: ['Amount']
  },
  DISCOUNTS: {
    name: '18_Discounts',
    headers: ['DiscountID', 'StudentID', 'SubjectID', 'OriginalAmount', 'DiscountAmount', 'DiscountType', 'Reason',
      'ApprovedBy', 'Date', 'Status', 'AcademicYear'],
    numeric: ['OriginalAmount', 'DiscountAmount']
  },
  TEACHER_INCOME: {
    name: '19_TeacherIncome',
    headers: ['IncomeID', 'TeacherID', 'SubjectID', 'Month', 'StudentCount', 'RatePerStudent', 'GrossIncome', 'Adjustment',
      'AdjustmentReason', 'FinalPayable', 'Status', 'AcademicYear', 'CreatedAt'],
    numeric: ['StudentCount', 'RatePerStudent', 'GrossIncome', 'Adjustment', 'FinalPayable']
  },
  TEACHER_PAYMENTS: {
    name: '20_TeacherPayments',
    headers: ['PaymentID', 'TeacherID', 'IncomeID', 'PaymentDate', 'Amount', 'PaymentMode', 'UPIReference', 'PaidBy', 'Notes'],
    numeric: ['Amount']
  },
  NOTICES: {
    name: '21_Notices',
    headers: ['NoticeID', 'Title', 'Body', 'Audience', 'BatchID', 'PostedBy', 'PostedAt', 'ExpiresAt', 'Status', 'AcademicYear']
  },
  ADMIN_LOGS: {
    name: '22_AdminLogs',
    headers: ['LogID', 'Timestamp', 'UserID', 'Username', 'Role', 'Action', 'EntityType', 'EntityID', 'Details', 'Result']
  },
  CHANGE_HISTORY: {
    name: '23_ChangeHistory',
    headers: ['ChangeID', 'StudentID', 'Field', 'OldValue', 'NewValue', 'ChangedBy', 'ChangedAt', 'Reason', 'AcademicYear']
  },
  REGISTRATIONS: {
    name: '24_Registrations',
    headers: ['RegistrationID', 'SubmittedAt', 'Status', 'Name', 'CurrentClass', 'DOB', 'Gender', 'Mobile', 'Email', 'Address',
      'School', 'Board', 'PreviousPercentage', 'ParentName', 'Relationship', 'ParentMobile', 'ParentWhatsApp', 'ParentEmail',
      'RequestedSubjects', 'PasswordHash', 'ReviewedBy', 'ReviewedAt', 'RejectReason', 'StudentID'],
    numeric: ['PreviousPercentage']
  }
};

/** Role -> permissions. "*" = everything. Edit this one table to change who can do what. */
const ROLE_PERMS = {
  SUPER_ADMIN: ['*'],
  ACCOUNTS_ADMIN: ['STUDENT_VIEW', 'TEACHER_VIEW', 'MASTER_VIEW', 'SETTINGS_VIEW', 'FINANCE_VIEW', 'FINANCE_EDIT',
    'TEACHER_INCOME_MANAGE', 'REPORT_VIEW', 'NOTICE_VIEW', 'SELF_VIEW'],
  TEACHER: ['SELF_VIEW', 'CLASS_RUN', 'ATTENDANCE_MARK', 'NOTICE_VIEW'],
  STUDENT: ['SELF_VIEW', 'ATTENDANCE_SELF', 'NOTICE_VIEW']
};

/** Every grantable permission (Super Admin can grant these on top of a role via ExtraPermissions). */
const ALL_PERMS = ['STUDENT_VIEW', 'STUDENT_EDIT', 'TEACHER_VIEW', 'TEACHER_EDIT', 'MASTER_VIEW', 'MASTER_EDIT',
  'SETTINGS_VIEW', 'SETTINGS_EDIT', 'USER_MANAGE', 'LOG_VIEW', 'FINANCE_VIEW', 'FINANCE_EDIT', 'TEACHER_INCOME_MANAGE',
  'TEACHER_INCOME_GRANT', 'TEACHER_INCOME_VIEW', 'REPORT_VIEW', 'NOTICE_VIEW', 'NOTICE_EDIT', 'CLASS_RUN',
  'ATTENDANCE_MARK', 'ATTENDANCE_SELF', 'ATTENDANCE_CORRECT', 'SELF_VIEW'];

class AppError_ extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}

/* ============================================================
 *  Small utilities
 * ============================================================ */

function tz_() { return Session.getScriptTimeZone() || 'Asia/Kolkata'; }
function nowDate_() { return new Date(Date.now()); }
function nowStr_() { return Utilities.formatDate(nowDate_(), tz_(), 'yyyy-MM-dd HH:mm:ss'); }
function todayStr_() { return Utilities.formatDate(nowDate_(), tz_(), 'yyyy-MM-dd'); }
function plusMinutesStr_(min) { return Utilities.formatDate(new Date(Date.now() + min * 60000), tz_(), 'yyyy-MM-dd HH:mm:ss'); }
function isTrue_(v) { return String(v).toUpperCase() === 'TRUE'; }
function splitList_(s) { return s ? String(s).split(',').map(x => x.trim()).filter(Boolean) : []; }
function escapeRe_(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function pad_(n, w) { return String(n).padStart(w, '0'); }

function toHex_(bytes) {
  return bytes.map(b => ((b < 0 ? b + 256 : b)).toString(16).padStart(2, '0')).join('');
}
function sha256Hex_(s) {
  return toHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8));
}
function randomHex_(n) {
  let s = '';
  while (s.length < n) s += sha256Hex_(Utilities.getUuid() + '|' + Date.now() + '|' + Math.random());
  return s.slice(0, n);
}
function generatePassword_(len) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes (0/O, 1/l/I)
  const hex = randomHex_(len * 2);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[parseInt(hex.substr(i * 2, 2), 16) % alphabet.length];
  return out;
}

/** Owner-only guard for maintenance functions that must never be reachable by portal users. */
function assertOwner_() {
  const active = Session.getActiveUser().getEmail();
  const effective = Session.getEffectiveUser().getEmail();
  if (!active || !effective || active !== effective) {
    throw new AppError_('FORBIDDEN', 'This function can only be run by the script owner from the Apps Script editor.');
  }
}

/* ============================================================
 *  Database layer (Google Sheets)
 * ============================================================ */

let dbCache_ = null;
let lockDepth_ = 0;

function setDb_(ss) { dbCache_ = ss; }

function getDb_() {
  if (dbCache_) return dbCache_;
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(CMZ.PROP_DB_ID);
  let ss = null;
  if (id) {
    ss = SpreadsheetApp.openById(id);
  } else {
    try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
    if (ss) props.setProperty(CMZ.PROP_DB_ID, ss.getId());
  }
  if (!ss) throw new AppError_('NOT_SETUP', 'Database is not set up yet. Run setupDatabase() from the Apps Script editor.');
  dbCache_ = ss;
  return ss;
}

function getSheet_(key) {
  const def = SCHEMA[key];
  if (!def) throw new Error('Unknown sheet key: ' + key);
  const sh = getDb_().getSheetByName(def.name);
  if (!sh) throw new AppError_('NOT_SETUP', 'Sheet "' + def.name + '" is missing. Run setupDatabase().');
  return sh;
}

function headersOf_(sh) {
  const n = sh.getLastColumn();
  return n ? sh.getRange(1, 1, 1, n).getValues()[0].map(h => String(h).trim()) : [];
}

function isNumericCol_(key, header) {
  return (SCHEMA[key].numeric || []).indexOf(header) >= 0;
}

function dateToText_(d) {
  if (d.getFullYear() < 1950) return Utilities.formatDate(d, tz_(), 'HH:mm'); // time-only cell
  const s = Utilities.formatDate(d, tz_(), 'yyyy-MM-dd HH:mm:ss');
  return s.endsWith(' 00:00:00') ? s.slice(0, 10) : s;
}

function cellOut_(v, numeric) {
  if (v instanceof Date) v = dateToText_(v);
  if (v === '' || v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (numeric) { const n = Number(v); return isNaN(n) ? v : n; }
  return String(v);
}

function cellIn_(v, isText) {
  if (v === undefined || v === null) return '';
  if (v instanceof Date) v = dateToText_(v);
  if (isText) return typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);
  if (v === '') return '';
  const n = Number(v);
  return isNaN(n) ? '' : n;
}

/* ---------- "data changed" stamps, so open admin pages can refresh themselves ---------- */
const NOISY_SHEETS_ = ['ADMIN_LOGS', 'USERS', 'ATTENDANCE_LOGS']; // change on every login: tracked separately

function verOf_(k) {
  const c = CacheService.getScriptCache();
  let v = c.get(k);
  if (!v) { v = String(Date.now()); c.put(k, v, 21600); }
  return v;
}
function dataVersion_() { return verOf_('DATA_VER'); }
function logVersion_() { return verOf_('LOG_VER'); }
function touchData_(key) {
  try {
    const c = CacheService.getScriptCache();
    const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    c.put(NOISY_SHEETS_.indexOf(key) >= 0 ? 'LOG_VER' : 'DATA_VER', stamp, 21600);
    if (key === 'CLASS_SESSIONS') c.remove('OPEN_SESS');                                  // open-class list is rebuilt
    if (key === 'STUDENTS' || key === 'STUDENT_SUBJECTS') c.put('ROS_GEN', stamp, 21600); // class rosters are rebuilt
  } catch (e) { /* never let this break a save */ }
}
function rosterGen_() { return verOf_('ROS_GEN'); }

/** Run fn while holding the script lock. Re-entrant within one execution. */
function withLock_(fn, waitMs) {
  if (lockDepth_ > 0) return fn();
  const lock = LockService.getScriptLock();
  lock.waitLock(waitMs || 20000);
  lockDepth_ = 1;
  try { return fn(); } finally { lockDepth_ = 0; lock.releaseLock(); }
}

/** Read every data row as an object keyed by header. Adds _row (1-based sheet row). */
function readAll_(key) {
  const sh = getSheet_(key);
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  const values = sh.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values[0].map(h => String(h).trim());
  const numeric = headers.map(h => isNumericCol_(key, h));
  const out = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (row.every(c => c === '' || c === null)) continue;
    const o = { _row: r + 1 };
    for (let c = 0; c < headers.length; c++) if (headers[c]) o[headers[c]] = cellOut_(row[c], numeric[c]);
    out.push(o);
  }
  return out;
}

function readColumn_(key, header) {
  const sh = getSheet_(key);
  const idx = headersOf_(sh).indexOf(header);
  if (idx < 0) throw new Error('Column "' + header + '" not found in ' + SCHEMA[key].name);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  return sh.getRange(2, idx + 1, lastRow - 1, 1).getValues().map(r => r[0]);
}

/** Like readAll_ but only builds objects for rows where field equals value (much lighter on big sheets). */
function readWhere_(key, field, value) {
  const sh = getSheet_(key);
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  const values = sh.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values[0].map(h => String(h).trim());
  const fi = headers.indexOf(field);
  if (fi < 0) throw new Error('Column "' + field + '" not found in ' + SCHEMA[key].name);
  const numeric = headers.map(h => isNumericCol_(key, h));
  const want = String(value), out = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (String(row[fi]) !== want) continue;
    const o = { _row: r + 1 };
    for (let c = 0; c < headers.length; c++) if (headers[c]) o[headers[c]] = cellOut_(row[c], numeric[c]);
    out.push(o);
  }
  return out;
}

function findOne_(key, field, value, caseInsensitive) {
  const v = caseInsensitive ? String(value).toLowerCase() : String(value);
  return readAll_(key).find(r => (caseInsensitive ? String(r[field]).toLowerCase() : String(r[field])) === v) || null;
}

function applyTextFormats_(rng, key, headers) {
  const fmts = rng.getNumberFormats();
  for (let i = 0; i < fmts.length; i++) {
    for (let j = 0; j < headers.length; j++) if (!isNumericCol_(key, headers[j])) fmts[i][j] = '@';
  }
  rng.setNumberFormats(fmts);
}

/** Append one or more objects. Returns them with _row set. */
function appendObjects_(key, objs) {
  if (!objs.length) return [];
  return withLock_(() => {
    const sh = getSheet_(key);
    const headers = headersOf_(sh);
    const start = Math.max(sh.getLastRow(), 1) + 1;
    const end = start + objs.length - 1;
    if (sh.getMaxRows() < end) sh.insertRowsAfter(sh.getMaxRows(), end - sh.getMaxRows() + 200);
    const rows = objs.map(o => headers.map(h => cellIn_(o[h], !isNumericCol_(key, h))));
    const rng = sh.getRange(start, 1, rows.length, headers.length);
    applyTextFormats_(rng, key, headers);
    rng.setValues(rows);
    touchData_(key);
    return objs.map((o, i) => Object.assign({ _row: start + i }, o));
  });
}

function appendObject_(key, obj) { return appendObjects_(key, [obj])[0]; }

/** Update the given columns of one row (rowNum is 1-based sheet row). */
function updateObject_(key, rowNum, patch) {
  return withLock_(() => {
    const sh = getSheet_(key);
    const headers = headersOf_(sh);
    Object.keys(patch).forEach(k => {
      if (k !== '_row' && headers.indexOf(k) < 0) throw new Error('Unknown column "' + k + '" for ' + SCHEMA[key].name);
    });
    const rng = sh.getRange(rowNum, 1, 1, headers.length);
    const row = rng.getValues()[0];
    headers.forEach((h, i) => {
      if (Object.prototype.hasOwnProperty.call(patch, h)) row[i] = cellIn_(patch[h], !isNumericCol_(key, h));
    });
    applyTextFormats_(rng, key, headers);
    rng.setValues([row]);
    touchData_(key);
  });
}

/** Next sequential ID like prefix + zero-padded number. Call inside withLock_ together with the insert. */
function nextId_(key, idField, prefix, width) {
  const re = new RegExp('^' + escapeRe_(prefix) + '(\\d+)$');
  let max = 0;
  readColumn_(key, idField).forEach(v => {
    const m = re.exec(String(v));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return prefix + pad_(max + 1, width);
}

/** Strip internal fields before sending a row to the browser. */
function pub_(row, omit) {
  const o = {};
  Object.keys(row).forEach(k => { if (k !== '_row' && !(omit && omit.indexOf(k) >= 0)) o[k] = row[k]; });
  return o;
}

/* ============================================================
 *  Settings
 * ============================================================ */

function getSettings_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(CMZ.CACHE_SETTINGS_KEY);
  if (hit) return JSON.parse(hit);
  const map = {};
  readAll_('SETTINGS').forEach(r => { map[r.SettingKey] = r.Value; });
  cache.put(CMZ.CACHE_SETTINGS_KEY, JSON.stringify(map), 300);
  return map;
}
function clearSettingsCache_() { CacheService.getScriptCache().remove(CMZ.CACHE_SETTINGS_KEY); }
function getSetting_(k, def) {
  const v = getSettings_()[k];
  return (v === undefined || v === '') ? def : v;
}
function getSettingInt_(k, def, min, max) {
  const n = parseInt(getSetting_(k, def), 10);
  if (isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}
function getSettingBool_(k, def) {
  const v = getSetting_(k, null);
  return v === null ? def : isTrue_(v);
}
function currentAcademicYear_() { return String(getSetting_('ACADEMIC_YEAR', '2026-27')); }

/* ============================================================
 *  Passwords (salted + iterated SHA-256; format v1$iterations$salt$hash)
 * ============================================================ */

function hashPassword_(password, salt, iterations) {
  let h = salt + ':' + password;
  for (let i = 0; i < iterations; i++) h = sha256Hex_(h + salt + password);
  return h;
}

function makePasswordHash_(password) {
  const salt = randomHex_(32);
  return [CMZ.HASH_VERSION, CMZ.HASH_ITERATIONS, salt, hashPassword_(password, salt, CMZ.HASH_ITERATIONS)].join('$');
}

function verifyPassword_(password, stored) {
  const p = String(stored || '').split('$');
  if (p.length !== 4 || p[0] !== CMZ.HASH_VERSION) return false;
  const calc = hashPassword_(password, p[2], parseInt(p[1], 10));
  let diff = calc.length ^ p[3].length; // constant-time style compare
  for (let i = 0; i < calc.length; i++) diff |= calc.charCodeAt(i) ^ (p[3].charCodeAt(i) || 0);
  return diff === 0;
}

function validateNewPassword_(pw, username) {
  if (typeof pw !== 'string' || pw.length < 6) throw new AppError_('WEAK_PASSWORD', 'Password must be at least 6 characters.');
  if (pw.length > 100) throw new AppError_('WEAK_PASSWORD', 'Password is too long.');
  if (username && pw.toLowerCase() === String(username).toLowerCase()) {
    throw new AppError_('WEAK_PASSWORD', 'Password cannot be the same as the username.');
  }
}

/* ============================================================
 *  Sessions (CacheService) — idle timeout comes from Settings
 * ============================================================ */

function createSession_(user, mustChange) {
  const cache = CacheService.getScriptCache();
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  const epochKey = 'EPOCH_' + user.UserID;
  const epoch = cache.get(epochKey) || '0';
  if (epoch !== '0') cache.put(epochKey, epoch, CMZ.SESSION_TTL_SECONDS);
  const now = Date.now();
  const s = {
    uid: user.UserID, username: user.Username, userType: user.UserType, role: user.Role, linkedId: user.LinkedID,
    extra: splitList_(user.ExtraPermissions), mustChange: !!mustChange, epoch: epoch, created: now, last: now
  };
  cache.put('S_' + token, JSON.stringify(s), CMZ.SESSION_TTL_SECONDS);
  return { token: token, session: s };
}

function getSession_(token, noTouch) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) {
    throw new AppError_('AUTH_REQUIRED', 'Please log in.');
  }
  const cache = CacheService.getScriptCache();
  const raw = cache.get('S_' + token);
  if (!raw) throw new AppError_('SESSION_EXPIRED', 'Your session has expired. Please log in again.');
  const s = JSON.parse(raw);
  const now = Date.now();
  const timeoutMin = getSettingInt_('SESSION_TIMEOUT_MINUTES', 30, 5, 600);
  if (now - s.last > timeoutMin * 60000) {
    cache.remove('S_' + token);
    throw new AppError_('SESSION_EXPIRED', 'You were logged out after ' + timeoutMin + ' minutes of inactivity.');
  }
  if ((cache.get('EPOCH_' + s.uid) || '0') !== s.epoch) {
    cache.remove('S_' + token);
    throw new AppError_('SESSION_REVOKED', 'Your session was ended. Please log in again.');
  }
  if (!noTouch && now - s.last > 20000) { // throttle cache writes (background checks never count as activity)
    s.last = now;
    cache.put('S_' + token, JSON.stringify(s), CMZ.SESSION_TTL_SECONDS);
    if (s.epoch !== '0') cache.put('EPOCH_' + s.uid, s.epoch, CMZ.SESSION_TTL_SECONDS);
  }
  s.token = token;
  return s;
}

function destroySession_(token) { CacheService.getScriptCache().remove('S_' + token); }

/** Invalidate every active session of a user (disable, reset password, permission change). */
function revokeSessions_(userId) {
  CacheService.getScriptCache().put('EPOCH_' + userId, Date.now() + '-' + randomHex_(6), CMZ.SESSION_TTL_SECONDS);
}

/* ============================================================
 *  Permissions (enforced server-side on every API call)
 * ============================================================ */

function permsOf_(session) {
  const base = ROLE_PERMS[session.role] || [];
  return base.indexOf('*') >= 0 ? ['*'] : base.concat(session.extra || []);
}

function can_(session, perm) {
  const perms = permsOf_(session);
  if (perms.indexOf('*') >= 0 || perms.indexOf(perm) >= 0) return true;
  if (perm === 'TEACHER_INCOME_VIEW' && session.userType === 'TEACHER') { // admin-granted per teacher
    const t = findOne_('TEACHERS', 'TeacherID', session.linkedId);
    return !!t && isTrue_(t.IncomeVisibleToTeacher) && String(t.Status).toUpperCase() === 'ACTIVE';
  }
  return false;
}

/** Permissions sent to the browser (adds TEACHER_INCOME_VIEW when an admin has granted it to a teacher). */
function clientPerms_(session) {
  const p = permsOf_(session).slice();
  if (p.indexOf('*') < 0 && p.indexOf('TEACHER_INCOME_VIEW') < 0 && can_(session, 'TEACHER_INCOME_VIEW')) p.push('TEACHER_INCOME_VIEW');
  return p;
}

function requirePerm_(session, perm) {
  if (!can_(session, perm)) throw new AppError_('FORBIDDEN', 'You do not have permission to do that.');
}

/* ============================================================
 *  Audit trail
 * ============================================================ */

function scrubDetails_(d) {
  if (d === undefined || d === null) return '';
  if (typeof d === 'string') return d.slice(0, 1500);
  try {
    return JSON.stringify(d, (k, v) => /pass|hash|token|secret/i.test(k) ? undefined : v).slice(0, 1500);
  } catch (e) { return ''; }
}

/** actor = session object (or {uid, username, role} for anonymous events such as failed logins). */
function logAdmin_(actor, action, entityType, entityId, details, result) {
  try {
    const a = actor || {};
    appendObject_('ADMIN_LOGS', {
      LogID: 'LOG-' + Utilities.formatDate(nowDate_(), tz_(), 'yyyyMMddHHmmss') + '-' + randomHex_(4),
      Timestamp: nowStr_(), UserID: a.uid || '', Username: a.username || '', Role: a.role || '',
      Action: action, EntityType: entityType || '', EntityID: entityId || '', Details: scrubDetails_(details), Result: result || 'OK'
    });
  } catch (e) {
    console.error('logAdmin_ failed: ' + (e && e.message)); // never let logging break the user's operation
  }
}

function logChange_(actor, studentId, field, oldValue, newValue, reason) {
  appendObject_('CHANGE_HISTORY', {
    ChangeID: 'CH-' + Utilities.formatDate(nowDate_(), tz_(), 'yyyyMMddHHmmss') + '-' + randomHex_(4),
    StudentID: studentId, Field: field, OldValue: oldValue, NewValue: newValue,
    ChangedBy: actor ? actor.username : '', ChangedAt: nowStr_(), Reason: reason || '', AcademicYear: currentAcademicYear_()
  });
}

/* ============================================================
 *  Subject-combination rule (e.g. Computer + Statistics not allowed)
 *  Setting SUBJECT_BLOCKED_PAIRS = "SUB002|SUB003;SUB00X|SUB00Y"
 * ============================================================ */

function blockedPairs_() {
  return String(getSetting_('SUBJECT_BLOCKED_PAIRS', '')).split(';').map(s => s.trim()).filter(Boolean)
    .map(p => p.split('|').map(x => x.trim())).filter(p => p.length === 2);
}

/** Returns null if allowed, otherwise a human-readable reason. */
function checkSubjectCombination_(subjectIds) {
  const set = {};
  subjectIds.forEach(id => { set[id] = true; });
  const names = {};
  readAll_('SUBJECTS').forEach(s => { names[s.SubjectID] = s.SubjectName; });
  for (const [a, b] of blockedPairs_()) {
    if (set[a] && set[b]) return (names[a] || a) + ' and ' + (names[b] || b) + ' cannot be taken together.';
  }
  return null;
}

/* ============================================================
 *  Authentication
 * ============================================================ */

const LOGIN_FAIL_MSG_ = 'Invalid username or password.';

function displayNameFor_(user) {
  try {
    if (user.UserType === 'STUDENT') { const s = findOne_('STUDENTS', 'StudentID', user.LinkedID); if (s) return s.Name; }
    if (user.UserType === 'TEACHER') { const t = findOne_('TEACHERS', 'TeacherID', user.LinkedID); if (t) return t.Name; }
  } catch (e) { /* fall through */ }
  return user.Username;
}

function login_(username, password, portal) {
  username = String(username || '').trim();
  password = String(password || '');
  portal = String(portal || '').toUpperCase();
  if (['STUDENT', 'TEACHER', 'ADMIN'].indexOf(portal) < 0) throw new AppError_('BAD_REQUEST', 'Invalid portal.');
  if (!username || !password || username.length > 60 || password.length > 200) throw new AppError_('BAD_LOGIN', LOGIN_FAIL_MSG_);

  const user = readAll_('USERS').find(u => String(u.Username).toLowerCase() === username.toLowerCase());
  const maxAttempts = getSettingInt_('LOGIN_MAX_ATTEMPTS', 5, 3, 20);
  const lockMinutes = getSettingInt_('LOGIN_LOCK_MINUTES', 15, 1, 240);
  const anon = { uid: user ? user.UserID : '', username: username, role: user ? user.Role : '' };

  if (!user) { // burn the same time as a real check so usernames cannot be probed by timing
    hashPassword_(password, 'x'.repeat(32), CMZ.HASH_ITERATIONS);
    logAdmin_(anon, 'LOGIN_FAILED', 'USER', '', 'unknown username', 'FAIL');
    throw new AppError_('BAD_LOGIN', LOGIN_FAIL_MSG_);
  }
  if (user.LockedUntil && String(user.LockedUntil) > nowStr_()) {
    throw new AppError_('LOCKED', 'Too many failed attempts. Please try again after ' + user.LockedUntil.slice(11, 16) + '.');
  }
  if (!verifyPassword_(password, user.PasswordHash)) {
    const attempts = (Number(user.FailedAttempts) || 0) + 1;
    withLock_(() => {
      if (attempts >= maxAttempts) {
        updateObject_('USERS', user._row, { FailedAttempts: 0, LockedUntil: plusMinutesStr_(lockMinutes) });
        logAdmin_(anon, 'LOGIN_LOCKED', 'USER', user.UserID, 'locked for ' + lockMinutes + ' min', 'FAIL');
      } else {
        updateObject_('USERS', user._row, { FailedAttempts: attempts });
        logAdmin_(anon, 'LOGIN_FAILED', 'USER', user.UserID, 'wrong password', 'FAIL');
      }
    });
    throw new AppError_('BAD_LOGIN', LOGIN_FAIL_MSG_);
  }
  // password is correct from here on
  if (String(user.Status).toUpperCase() !== 'ACTIVE') {
    logAdmin_(anon, 'LOGIN_BLOCKED', 'USER', user.UserID, 'account not active', 'FAIL');
    throw new AppError_('DISABLED', 'This account is disabled. Please contact the centre.');
  }
  const typeForPortal = { STUDENT: 'STUDENT', TEACHER: 'TEACHER', ADMIN: 'ADMIN' }[portal];
  if (user.UserType !== typeForPortal) {
    throw new AppError_('WRONG_PORTAL', 'This account belongs to the ' + user.UserType.toLowerCase() + ' portal.');
  }
  const mustChange = String(user.PasswordChanged).toLowerCase() !== 'yes';
  withLock_(() => updateObject_('USERS', user._row, { FailedAttempts: 0, LockedUntil: '', LastLogin: nowStr_() }));
  const created = createSession_(user, mustChange);
  logAdmin_(created.session, 'LOGIN', 'USER', user.UserID, portal, 'OK');
  return {
    token: created.token,
    sessionTimeoutMinutes: getSettingInt_('SESSION_TIMEOUT_MINUTES', 30, 5, 600),
    user: {
      userId: user.UserID, username: user.Username, userType: user.UserType, role: user.Role, linkedId: user.LinkedID,
      displayName: displayNameFor_(user), mustChangePassword: mustChange, permissions: clientPerms_(created.session)
    }
  };
}

function logout_(session) {
  destroySession_(session.token);
  const u = findOne_('USERS', 'UserID', session.uid);
  if (u) withLock_(() => updateObject_('USERS', u._row, { LastLogout: nowStr_() }));
  logAdmin_(session, 'LOGOUT', 'USER', session.uid, '', 'OK');
  return { loggedOut: true };
}

function changePassword_(session, oldPassword, newPassword) {
  const u = findOne_('USERS', 'UserID', session.uid);
  if (!u || !verifyPassword_(String(oldPassword || ''), u.PasswordHash)) {
    throw new AppError_('BAD_PASSWORD', 'Current password is incorrect.');
  }
  validateNewPassword_(newPassword, u.Username);
  if (String(newPassword) === String(oldPassword)) throw new AppError_('WEAK_PASSWORD', 'New password must be different from the current one.');
  withLock_(() => updateObject_('USERS', u._row, { PasswordHash: makePasswordHash_(newPassword), PasswordChanged: 'Yes' }));
  revokeSessions_(u.UserID); // sign out every other device
  destroySession_(session.token);
  const fresh = createSession_(u, false);
  logAdmin_(session, 'CHANGE_PASSWORD', 'USER', u.UserID, '', 'OK');
  return { token: fresh.token };
}

/** Admin-side reset/creation helper. Returns the plaintext temporary password ONCE (never stored or logged). */
function setTempPassword_(userRow, chosenPassword) {
  const pw = chosenPassword ? String(chosenPassword) : generatePassword_(8);
  validateNewPassword_(pw, userRow.Username);
  withLock_(() => updateObject_('USERS', userRow._row, {
    PasswordHash: makePasswordHash_(pw), PasswordChanged: 'No', FailedAttempts: 0, LockedUntil: ''
  }));
  revokeSessions_(userRow.UserID);
  return pw;
}

/* ============================================================
 *  Web app entry point
 * ============================================================ */

/**
 * Web app entry. ?page=admin | student | teacher serves the matching HTML file
 * (admin.html, student.html, teacher.html). Anything else shows a small start page.
 */
/** Lets HTML files pull in another file: <?!= include_('shared') ?> */
function include_(name) { return HtmlService.createHtmlOutputFromFile(name).getContent(); }

/** The centre logo: LOGO_URL setting if set, otherwise the built-in one from LogoData.gs. */
function logoUrl_() {
  const v = String(getSetting_('LOGO_URL', '') || '').trim();
  return v || (typeof LOGO_FALLBACK_ !== 'undefined' ? LOGO_FALLBACK_ : '');
}

function doGet(e) {
  const page = String((e && e.parameter && e.parameter.page) || 'index').toLowerCase();
  if (['admin', 'student', 'teacher'].indexOf(page) >= 0) {
    try {
      return HtmlService.createTemplateFromFile(page).evaluate()
        .setTitle(String(getSetting_('CENTRE_NAME', 'Creative Math Zone')))
        .addMetaTag('viewport', 'width=device-width, initial-scale=1');
    } catch (err) { /* portal file missing — fall through */ }
  }

  const centre = getSetting_('CENTRE_NAME', 'Creative Math Zone');
  const tagline = getSetting_('TAGLINE', 'Eat Math, Drink Math, Dream Math');
  const logo = logoUrl_();
  const shared = include_('shared');
  const ay = currentAcademicYear_();
  const address = getSetting_('ADDRESS', '');
  const mobile = getSetting_('MOBILE', '');
  const has = p => { try { HtmlService.createHtmlOutputFromFile(p); return true; } catch (e) { return false; } };
  let base = '';
  try { base = ScriptApp.getService().getUrl(); } catch (err) { base = ''; }

  // Split tagline into lines of two words each, highlight "Dream"
  const words = tagline.split(/\s+/);
  const lines = [];
  for (let i = 0; i < words.length; i += 2) lines.push(words.slice(i, i + 2).join(' '));
  const taglineHtml = lines
    .map(l => l.replace(/Dream/gi, '<span class="hi">Dream</span>'))
    .join('<br>');

  const card = (p, icon, title, sub, color, ready) => ready
    ? '<a class="portal ' + color + '" href="' + base + '?page=' + p + '" target="_top"><span class="ic">' + icon + '</span><span class="tx"><b>' + title + '</b><small>' + sub + '</small></span><span class="ar">→</span></a>'
    : '<div class="portal ' + color + ' soon"><span class="ic">' + icon + '</span><span class="tx"><b>' + title + '</b><small>' + sub + '</small></span><span class="ar">·</span></div>';


  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + centre + '</title>' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700;12..96,800&family=Figtree:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">' +
    '<style>' +
    ':root{--paper:#fbfaf6;--ink:#18263d;--ink-2:#4a5a73;--ink-3:#7b8aa0;--line:#e4e1d5;--grid:#e9e6dc;--navy:#16243b;--gold:#e8a020;' +
    '--r:14px;--shadow:0 1px 2px rgba(22,36,59,.06),0 8px 24px rgba(22,36,59,.08);' +
    '--display:"Bricolage Grotesque","Segoe UI",system-ui,sans-serif;--body:"Figtree","Segoe UI",system-ui,sans-serif;}' +
    '*{box-sizing:border-box}' +
    'html,body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 var(--body);-webkit-font-smoothing:antialiased}' +
    'a{color:inherit;text-decoration:none}img{max-width:100%}' +
    '#hero{min-height:100vh;display:grid;grid-template-columns:1.05fr 1fr}' +
    '.left{position:relative;overflow:hidden;background:#fdfcf8;background-image:linear-gradient(var(--grid) 1px,transparent 1px),linear-gradient(90deg,var(--grid) 1px,transparent 1px);background-size:34px 34px;padding:3rem 3rem 2.5rem;display:flex;flex-direction:column;justify-content:space-between}' +
    '.left::after{content:"";position:absolute;top:0;right:-10%;width:55%;height:100%;pointer-events:none;background:radial-gradient(ellipse at right center, rgba(232,160,32,.35), rgba(232,160,32,.12) 40%, transparent 70%)}' +
    '.left .deco{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}' +
    '.left .brand-line{position:relative;z-index:2;font-family:var(--display);font-weight:700;font-size:1.05rem;color:var(--navy);letter-spacing:-.01em;display:inline-flex;align-items:center;gap:.75rem}' +
    '.left .brand-line::after{content:"";display:inline-block;width:42px;height:3px;background:var(--gold);border-radius:99px}' +
    '.left .tagline{position:relative;z-index:2;font-family:var(--display);font-weight:800;font-size:clamp(2.4rem,5.2vw,4.4rem);line-height:.98;letter-spacing:-.03em;color:var(--navy);margin:0;max-width:12ch}' +
    '.left .tagline .hi{color:var(--gold)}' +
    '.fml{font-family:var(--body);font-style:italic;fill:#4a5a73}' +
    '.fml-strong{font-family:var(--body);font-style:italic;fill:#16243b;font-weight:600}' +
    '.right{background:#fff;padding:4rem 2rem;display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative}' +
    '.right .inner{width:100%;max-width:440px}' +
    '.ay-pill{position:absolute;top:1.5rem;right:1.5rem;display:inline-flex;align-items:center;gap:.5rem;padding:.5rem .9rem;border:1px solid var(--line);border-radius:999px;font-size:.85rem;color:var(--ink-2);background:#fff}' +
    '.ay-pill .dot{width:8px;height:8px;border-radius:50%;background:var(--gold)}' +
    '.ay-pill b{color:var(--navy);font-weight:700}' +
    '.brandblock{text-align:center;margin-bottom:2.25rem}' +
    '.brandblock img{height:110px;width:auto;object-fit:contain;display:block;margin:0 auto 1rem;border-radius:50%}' +
    '.brandblock h1{font-family:var(--display);font-weight:800;font-size:clamp(1.9rem,3vw,2.5rem);letter-spacing:-.02em;color:var(--navy);margin:0}' +
    '.brandblock .tag{color:var(--ink-2);font-style:italic;margin-top:.35rem;font-size:1.05rem}' +
    '.brandblock .dash{width:60px;height:3px;background:var(--gold);border-radius:99px;margin:1rem auto .85rem}' +
    '.brandblock .yr{color:var(--ink-3);font-size:.88rem;letter-spacing:.04em}' +
    '.portal{display:flex;align-items:center;gap:1rem;padding:1.05rem 1.15rem;margin-bottom:.75rem;border-radius:14px;box-shadow:var(--shadow);border:1px solid transparent;transition:transform .14s ease, box-shadow .14s ease}' +
    '.portal:hover{transform:translateY(-2px);box-shadow:0 4px 8px rgba(22,36,59,.08),0 14px 36px rgba(22,36,59,.14)}' +
    '.portal .ic{display:flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:12px;flex-shrink:0;font-size:1.4rem}' +
    '.portal .tx{flex:1;min-width:0}' +
    '.portal .tx b{display:block;font:700 1.08rem var(--display);color:var(--navy);letter-spacing:-.01em}' +
    '.portal .tx small{display:block;color:var(--ink-3);font-size:.85rem;margin-top:.15rem}' +
    '.portal .ar{width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1rem;transition:transform .14s ease;flex-shrink:0}' +
    '.portal:hover .ar{transform:translateX(2px)}' +
    '.portal.student{background:#fff7e6;border-color:#f7e3b3}.portal.student .ic{background:#f7c948;color:#5a3b00}.portal.student .ar{background:#f7c948;color:#5a3b00}' +
    '.portal.teacher{background:#eef4ff;border-color:#c9d9f5}.portal.teacher .ic{background:#7ba7f5;color:#0a2a66}.portal.teacher .ar{background:#7ba7f5;color:#0a2a66}' +
    '.portal.admin{background:#ffeeee;border-color:#f5c9c9}.portal.admin .ic{background:#f58b8b;color:#5a0a0a}.portal.admin .ar{background:#f58b8b;color:#5a0a0a}' +
    '.portal.soon{opacity:.5;cursor:not-allowed}.portal.soon:hover{transform:none;box-shadow:var(--shadow)}' +
    '.foot{display:flex;align-items:center;justify-content:center;gap:.5rem;margin-top:2rem;padding-top:1.25rem;border-top:1px solid var(--line);color:var(--ink-2);font-size:.88rem;text-align:center;flex-wrap:wrap}' +
    '@media (max-width:900px){#hero{grid-template-columns:1fr}.left{min-height:360px;padding:2rem 1.5rem}.left .tagline{font-size:clamp(2rem,9vw,3rem);max-width:none}.right{padding:2.5rem 1.25rem}.ay-pill{position:static;margin-bottom:1.5rem}.brandblock img{height:88px}}' +
    '.left{background-color:#0f1b30;background-image:radial-gradient(ellipse at 50% 40%,rgba(243,177,28,.2),transparent 60%),linear-gradient(rgba(255,255,255,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.05) 1px,transparent 1px);background-size:auto,34px 34px,34px 34px}' +
    '.left::after{display:none}' +
    '.left .brand-line{color:#fff}' +
    '.left .tagline{color:#fff;font-size:clamp(2rem,4.2vw,3.4rem)}' +
    '.hero-slot{position:absolute;left:0;right:0;top:9%;bottom:30%;display:grid;place-items:center;z-index:1}' +
    '.left .cmz-hero{--size:min(46vmin,420px)}' +
    '.portal{animation:cmz-rise .6s cubic-bezier(.2,.8,.2,1) both}.portal.student{animation-delay:.15s}.portal.teacher{animation-delay:.27s}.portal.admin{animation-delay:.39s}' +
    '@media (max-width:900px){.left{min-height:520px}.hero-slot{top:12%;bottom:34%}.left .cmz-hero{--size:min(58vw,260px)}}' +
    '</style>' + shared + '</head><body>' +
    '<section id="hero">' +
      '<div class="left"><div class="hero-slot" id="hero-slot"></div>' +
        '<div class="brand-line">' + centre + '</div>' +
        '<h1 class="tagline">' + taglineHtml + '</h1>' +
      '</div>' +
      '<div class="right">' +
        '<div class="ay-pill"><span class="dot"></span>Academic year <b>' + ay + '</b></div>' +
        '<div class="inner">' +
          '<div class="brandblock">' +
            '' +
            '<h1>' + centre + '</h1>' +
            '<div class="tag">' + tagline + '</div>' +
            '<div class="dash"></div>' +
            '<div class="yr">Academic year ' + ay + '</div>' +
          '</div>' +
          card('student', '🎓', 'Student portal', 'Attendance · Timetable · Fees · Notices', 'student', has('student')) +
          card('teacher', '📘', 'Teacher portal', 'Classes · Live attendance · Income', 'teacher', has('teacher')) +
          card('admin',   '🛡', 'Admin portal',   'Manage students, teachers and finances', 'admin',   has('admin')) +
          '<div class="foot">' +
            (address ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4a5a73" stroke-width="2"><path d="M12 22s-8-8.5-8-14a8 8 0 0116 0c0 5.5-8 14-8 14z"/><circle cx="12" cy="8" r="3"/></svg>' + address : '') +
            (address && mobile ? '<span>·</span>' : '') +
            (mobile ? '<span>' + mobile + '</span>' : '') +
          '</div>' +
        '</div>' +
      '</div>' +
    '</section>' +
    '<script>cmzHero(document.getElementById("hero-slot"),' + JSON.stringify(logo).replace(/</g, '\\u003c') + ');</script>' +
    '</body></html>';

  return HtmlService.createHtmlOutput(html).setTitle(centre);
}
