import { createClient } from 'npm:@supabase/supabase-js@2'

type AppUser = {
  id: string
  auth_user_id: string | null
  username: string
  user_type: 'ADMIN' | 'TEACHER' | 'STUDENT'
  role: 'SUPER_ADMIN' | 'ACCOUNTS_ADMIN' | 'TEACHER' | 'STUDENT'
  linked_id: string | null
  status: string
  must_change_password: boolean
  extra_permissions: string[]
}

class ApiFault extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

const ROLE_PERMISSIONS: Record<string, string[]> = {
  SUPER_ADMIN: ['*'],
  ACCOUNTS_ADMIN: ['STUDENT_VIEW', 'TEACHER_VIEW', 'MASTER_VIEW', 'SETTINGS_VIEW', 'FINANCE_VIEW', 'FINANCE_EDIT', 'TEACHER_INCOME_MANAGE', 'REPORT_VIEW', 'NOTICE_VIEW', 'SELF_VIEW'],
  TEACHER: ['SELF_VIEW', 'CLASS_RUN', 'ATTENDANCE_MARK', 'NOTICE_VIEW'],
  STUDENT: ['SELF_VIEW', 'ATTENDANCE_SELF', 'NOTICE_VIEW'],
}

const PERMISSION_LABELS: Record<string, string> = {
  STUDENT_VIEW: 'View students', STUDENT_EDIT: 'Add and edit students',
  TEACHER_VIEW: 'View teachers', TEACHER_EDIT: 'Add and edit teachers',
  MASTER_VIEW: 'View subjects, batches, rooms', MASTER_EDIT: 'Edit subjects, batches, rooms',
  SETTINGS_VIEW: 'View settings', SETTINGS_EDIT: 'Change settings', USER_MANAGE: 'Manage users',
  LOG_VIEW: 'View activity log', FINANCE_VIEW: 'View finance', FINANCE_EDIT: 'Record payments and fees',
  TEACHER_INCOME_MANAGE: 'Manage teacher monthly statements and contributions', TEACHER_INCOME_GRANT: 'Allow teachers to see their income',
  REPORT_VIEW: 'View reports', NOTICE_EDIT: 'Post notices', ATTENDANCE_CORRECT: 'Correct attendance',
}

function clients() {
  const url = Deno.env.get('SUPABASE_URL')!
  const publishable = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}').default
  const secret = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default
  if (!url || !publishable || !secret) throw new Error('Supabase function keys are not configured.')
  return {
    auth: createClient(url, publishable, { auth: { persistSession: false, autoRefreshToken: false } }),
    admin: createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false, experimental: { passkey: true } } }),
  }
}

async function revokeUserPasskeys(admin: ReturnType<typeof clients>['admin'], authUserId: string) {
  const passkeyAdmin = (admin.auth.admin as any).passkey
  if (!passkeyAdmin?.listPasskeys || !passkeyAdmin?.deletePasskey) {
    throw new ApiFault('PASSKEY_REVOCATION_FAILED', 'Could not verify or revoke this user’s device passkeys. The password was not reset; please retry or contact support.')
  }
  const { data, error } = await passkeyAdmin.listPasskeys({ userId: authUserId })
  // If passkeys are disabled at the project level, none can authenticate; allow
  // password recovery to continue. Any other listing/deletion error fails closed.
  if (error && String(error.code || '').toLowerCase() === 'passkey_disabled') return
  if (error) throw new ApiFault('PASSKEY_REVOCATION_FAILED', 'Could not verify this user’s registered passkeys. The password was not reset; please retry.')
  for (const passkey of (Array.isArray(data) ? data : data?.passkeys || [])) {
    const { error: deleteError } = await passkeyAdmin.deletePasskey({ userId: authUserId, passkeyId: passkey.id })
    if (deleteError) throw new ApiFault('PASSKEY_REVOCATION_FAILED', 'Could not revoke every registered passkey. The password was not reset; please retry.')
  }
}

async function revokeUserSessions(
  auth: ReturnType<typeof clients>['auth'], admin: ReturnType<typeof clients>['admin'], email: string, password: string,
) {
  // Admin sign-out requires a valid JWT for the target user. Authenticate once
  // with the newly issued temporary password, then revoke every refresh-token
  // session, including the one created for this operation.
  const { data, error } = await auth.auth.signInWithPassword({ email, password })
  if (error || !data.session) return false
  const { error: revokeError } = await (admin.auth.admin as any).signOut(data.session.access_token, 'global')
  return !revokeError
}

function userClient(token: string) {
  const url = Deno.env.get('SUPABASE_URL')!
  const publishable = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}').default
  return createClient(url, publishable, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

// The Auth server validates the signature and expiry in getUser(token). Read
// only the iat claim from that already-verified JWT so a password reset can
// invalidate this app's older access tokens immediately. JWT iat has seconds
// precision, so tokens issued in the same second as the reset remain usable
// for at most that one-second boundary.
function verifiedTokenIssuedAt(token: string): number | null {
  try {
    const payload = token.split('.')[1]
    if (!payload) return null
    const base64 = payload.replaceAll('-', '+').replaceAll('_', '/')
    const claims = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')))
    const issuedAt = Number(claims.iat)
    return Number.isFinite(issuedAt) ? issuedAt : null
  } catch {
    return null
  }
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function response(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { ...cors, 'Content-Type': 'application/json' } })
}

function fail(code: string, error: string) {
  return { ok: false, code, error }
}

function requireText(value: unknown, label: string, max = 200, required = false) {
  const text = value == null ? '' : String(value).trim()
  if (required && !text) throw new ApiFault('BAD_REQUEST', `${label} is required.`)
  if (text.length > max) throw new ApiFault('BAD_REQUEST', `${label} is too long.`)
  return text
}

function mapMaster(table: string, row: Record<string, unknown>) {
  if (table === 'subjects') return { SubjectID: row.id, SubjectName: row.name, Status: row.status }
  if (table === 'batches') return { BatchID: row.id, BatchName: row.name, Class: row.class,
    Section: row.section, AcademicYear: row.academic_year, Status: row.status }
  return { RoomID: row.id, RoomName: row.name, Capacity: row.capacity, Status: row.status }
}

async function newId(admin: ReturnType<typeof clients>['admin'], counter: string, prefix: string, width = 3) {
  const { data, error } = await admin.rpc('next_id', { p_counter_name: counter, p_prefix: prefix, p_width: width })
  if (error) throw error
  return String(data)
}

// Supabase returns at most 1,000 rows per request. Read every page so large
// tables are never silently cut short. `build` must return a fresh query with a
// stable order each time it is called.
async function fetchAll<T = any>(build: () => any, pageSize = 1000, maxRows = 200000): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1)
    if (error) throw error
    rows.push(...((data || []) as T[]))
    if (!data || data.length < pageSize) break
  }
  return rows
}

// Reserve many readable IDs in one database call; falls back to one call per
// ID if the batch function has not been installed yet.
async function newIds(admin: ReturnType<typeof clients>['admin'], counter: string, prefix: string, width: number, count: number) {
  if (count <= 0) return [] as string[]
  const { data, error } = await admin.rpc('next_ids', { p_counter_name: counter, p_prefix: prefix, p_width: width, p_count: count })
  if (!error && Array.isArray(data) && data.length === count) return data.map(String)
  const ids: string[] = []
  for (let i = 0; i < count; i++) ids.push(await newId(admin, counter, prefix, width))
  return ids
}

// Look up rows for a long list of IDs in groups, so the request address never
// gets too long (a single `in (...)` with thousands of IDs can be rejected).
async function selectIn<T = any>(ids: string[], build: (chunk: string[]) => any, size = 150): Promise<T[]> {
  const unique = [...new Set(ids.filter(Boolean))]
  const out: T[] = []
  for (let i = 0; i < unique.length; i += size) {
    const { data, error } = await build(unique.slice(i, i + size))
    if (error) throw error
    out.push(...((data || []) as T[]))
  }
  return out
}

// Turn free text into a safe PostgREST filter value (no commas, brackets or quotes).
function safeSearch(value: unknown, max = 60) {
  return String(value || '').replace(/[^\p{L}\p{N} @._-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

async function logAction(admin: ReturnType<typeof clients>['admin'], user: AppUser,
  action: string, entityType: string, entityId: string, details: unknown) {
  await admin.from('admin_logs').insert({
    id: `LOG-${crypto.randomUUID()}`, user_id: user.id, username: user.username, role: user.role,
    action, entity_type: entityType, entity_id: entityId, details: JSON.stringify(details), result: 'OK',
  })
}

function permissionsFor(user: AppUser) {
  return [...new Set([...(ROLE_PERMISSIONS[user.role] || []), ...(user.extra_permissions || [])])]
}

function legacyStudent(row: Record<string, unknown>) {
  return {
    StudentID: row.id, RegistrationYear: row.registration_year, RegistrationDate: row.registration_date,
    RollNo: row.roll_no, Name: row.name, PhotoURL: row.photo_url, DOB: row.dob, Gender: row.gender,
    Mobile: row.mobile, Email: row.email, Address: row.address, School: row.school, Board: row.board,
    CurrentClass: row.current_class, CurrentBatch: row.current_batch_id, ParentName: row.parent_name,
    Relationship: row.relationship, ParentMobile: row.parent_mobile, ParentWhatsApp: row.parent_whatsapp,
    ParentEmail: row.parent_email, PreviousPercentage: row.previous_percentage, Status: row.status,
    AcademicYear: row.academic_year, CreatedAt: row.created_at, UpdatedAt: row.updated_at,
  }
}

function studentClassLevel(value: unknown): number {
  const key = String(value || '').trim().toUpperCase().replace(/^CLASS\s*/, '').replace(/[^IVX0-9]/g, '')
  const roman: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10, XI: 11, XII: 12 }
  return /^\d{1,2}$/.test(key) ? Number(key) : (roman[key] || 0)
}

function canonicalStudentBoard(value: unknown, currentClass: unknown): string {
  const level = studentClassLevel(currentClass)
  if (!level) throw new ApiFault('BAD_REQUEST', 'Choose a supported class from I to XII before selecting a board.')
  const key = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  const higher = level >= 11
  if (key === 'CBSE') return higher ? 'CBSE (Higher)' : 'CBSE (Lower)'
  if (key === 'CBSEHIGHER' || key === 'CBSESR' || key === 'CBSECLASS11') {
    if (!higher) throw new ApiFault('BAD_REQUEST', 'CBSE (Higher) is available only for Classes XI and XII.')
    return 'CBSE (Higher)'
  }
  if (key === 'CBSELOWER' || key === 'CBSEJR' || key === 'CBSECLASS10') {
    if (higher) throw new ApiFault('BAD_REQUEST', 'CBSE (Lower) is available only for Classes I to X.')
    return 'CBSE (Lower)'
  }
  const allowed: Record<string, string> = higher ? { WBCHSE: 'WBCHSE', ISC: 'ISC' } : { WBBSE: 'WBBSE', ICSE: 'ICSE' }
  const board = allowed[key]
  if (board) return board
  throw new ApiFault('BAD_REQUEST', higher
    ? 'For Classes XI and XII, choose WBCHSE, ISC, or CBSE (Higher).'
    : 'For Classes I to X, choose WBBSE, ICSE, or CBSE (Lower).')
}

function normalizeStudentBoardRow(row: Record<string, unknown>) {
  if (row.current_class && row.board) row.board = canonicalStudentBoard(row.board, row.current_class)
}

function validateStudentInput(input: Record<string, unknown>, partial: boolean) {
  const fields: Record<string, { column: string; max?: number; required?: boolean; kind?: 'date' | 'number' | 'mobile' | 'email' | 'status' | 'gender' }> = {
    RollNo: { column: 'roll_no', max: 20 }, Name: { column: 'name', max: 100, required: !partial },
    PhotoURL: { column: 'photo_url', max: 500 }, DOB: { column: 'dob', kind: 'date' },
    Gender: { column: 'gender', kind: 'gender' }, Mobile: { column: 'mobile', kind: 'mobile' },
    Email: { column: 'email', kind: 'email' }, Address: { column: 'address', max: 300 },
    School: { column: 'school', max: 100 }, Board: { column: 'board', max: 30, required: !partial },
    CurrentClass: { column: 'current_class', max: 10, required: !partial },
    CurrentBatch: { column: 'current_batch_id', max: 40 }, ParentName: { column: 'parent_name', max: 100 },
    Relationship: { column: 'relationship', max: 30 }, ParentMobile: { column: 'parent_mobile', kind: 'mobile' },
    ParentWhatsApp: { column: 'parent_whatsapp', kind: 'mobile' }, ParentEmail: { column: 'parent_email', kind: 'email' },
    PreviousPercentage: { column: 'previous_percentage', kind: 'number' },
    Status: { column: 'status', kind: 'status' },
  }
  const row: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    const spec = fields[key]
    if (!spec) throw new ApiFault('BAD_REQUEST', `Unknown field: ${key}`)
    let v = requireText(value, key, spec.max || 300, !!spec.required)
    if (v === '') { row[spec.column] = spec.kind === 'date' || spec.kind === 'number' || spec.column === 'current_batch_id' ? null : ''; continue }
    if (spec.kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ApiFault('BAD_REQUEST', `${key} must use yyyy-mm-dd.`)
    if (spec.kind === 'number') {
      const n = Number(v)
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new ApiFault('BAD_REQUEST', `${key} must be from 0 to 100.`)
      row[spec.column] = n; continue
    }
    if (spec.kind === 'mobile') {
      let digits = v.replace(/\D/g, '')
      if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2)
      if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1)
      if (!/^[6-9]\d{9}$/.test(digits)) throw new ApiFault('BAD_REQUEST', `${key} must be a valid 10-digit mobile number.`)
      v = digits
    }
    if (spec.kind === 'email') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || v.length > 120) throw new ApiFault('BAD_REQUEST', `${key} is not a valid email.`)
      v = v.toLowerCase()
    }
    if (spec.kind === 'gender') {
      const gender = v.toUpperCase()
      if (!['MALE', 'FEMALE', 'OTHER'].includes(gender)) throw new ApiFault('BAD_REQUEST', 'Gender must be Male, Female or Other.')
      v = gender
    }
    if (spec.kind === 'status') {
      const status = v.toUpperCase()
      if (!['ACTIVE', 'INACTIVE', 'COMPLETED', 'LEFT', 'SUSPENDED'].includes(status)) throw new ApiFault('BAD_REQUEST', 'Invalid student status.')
      v = status
    }
    if (key === 'CurrentClass') v = v.toUpperCase()
    row[spec.column] = v.replace(/^[=+\-@]+/, '')
  }
  if (!partial) {
    for (const [key, spec] of Object.entries(fields)) if (spec.required && !(spec.column in row)) throw new ApiFault('BAD_REQUEST', `${key} is required.`)
  }
  normalizeStudentBoardRow(row)
  return row
}

function passwordTemp(length = 12) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%'
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

function authEmailForUsername(username: string) {
  return `${username.toLowerCase()}@login.creativemathzone.in`
}

function legacyTeacher(row: Record<string, unknown>) {
  return { TeacherID: row.id, Name: row.name, Photo: row.photo_url, Mobile: row.mobile, Email: row.email,
    Address: row.address, Qualification: row.qualification, JoiningDate: row.joining_date, Status: row.status,
    Username: row.username, IncomeMethod: row.income_method, DefaultRatePerStudent: row.default_rate_per_student,
    IncomeVisibleToTeacher: row.income_visible_to_teacher ? 'TRUE' : 'FALSE', CreatedAt: row.created_at, UpdatedAt: row.updated_at }
}

function validateTeacherInput(input: Record<string, unknown>, partial: boolean) {
  const fields: Record<string, { column: string; max?: number; kind?: 'date' | 'mobile' | 'email' | 'status' | 'money' | 'bool' | 'income' }> = {
    Name: { column: 'name', max: 100 }, Photo: { column: 'photo_url', max: 500 }, Mobile: { column: 'mobile', kind: 'mobile' },
    Email: { column: 'email', kind: 'email' }, Address: { column: 'address', max: 300 },
    Qualification: { column: 'qualification', max: 150 }, JoiningDate: { column: 'joining_date', kind: 'date' },
    Status: { column: 'status', kind: 'status' }, IncomeMethod: { column: 'income_method', kind: 'income' },
    DefaultRatePerStudent: { column: 'default_rate_per_student', kind: 'money' },
    IncomeVisibleToTeacher: { column: 'income_visible_to_teacher', kind: 'bool' },
  }
  const row: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(input)) {
    const spec = fields[key]
    if (!spec) throw new ApiFault('BAD_REQUEST', `Unknown field: ${key}`)
    let value = requireText(raw, key, spec.max || 300, key === 'Name' && !partial)
    if (!value) { row[spec.column] = spec.kind === 'date' ? null : ''; continue }
    if (spec.kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ApiFault('BAD_REQUEST', 'JoiningDate must use yyyy-mm-dd.')
    if (spec.kind === 'mobile') {
      let digits = value.replace(/\D/g, '')
      if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2)
      if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1)
      if (!/^[6-9]\d{9}$/.test(digits)) throw new ApiFault('BAD_REQUEST', 'Mobile must be a valid 10-digit number.')
      value = digits
    }
    if (spec.kind === 'email') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 120) throw new ApiFault('BAD_REQUEST', `${key} is not a valid email.`)
      value = value.toLowerCase()
    }
    if (spec.kind === 'status') {
      const normalized = value.toLowerCase()
      if (!['active', 'inactive'].includes(normalized)) throw new ApiFault('BAD_REQUEST', 'Status must be Active or Inactive.')
      value = normalized === 'active' ? 'Active' : 'Inactive'
    }
    if (spec.kind === 'income' && value !== 'PER_STUDENT_MONTH') throw new ApiFault('BAD_REQUEST', 'IncomeMethod is invalid.')
    if (spec.kind === 'money') {
      const n = Number(value)
      if (!Number.isFinite(n) || n < 0 || n > 100000) throw new ApiFault('BAD_REQUEST', 'DefaultRatePerStudent must be from 0 to 100000.')
      row[spec.column] = n; continue
    }
    if (spec.kind === 'bool') {
      const normalized = value.toUpperCase()
      if (!['TRUE', 'FALSE'].includes(normalized)) throw new ApiFault('BAD_REQUEST', 'IncomeVisibleToTeacher must be TRUE or FALSE.')
      row[spec.column] = normalized === 'TRUE'; continue
    }
    row[spec.column] = value.replace(/^[=+\-@]+/, '')
  }
  if (!partial && !row.name) throw new ApiFault('BAD_REQUEST', 'Name is required.')
  return row
}

function validateRegistrationInput(input: Record<string, unknown>, partial = false) {
  const allowed: Record<string, { column: string; max?: number; required?: boolean; kind?: 'date' | 'gender' | 'mobile' | 'email' | 'number' }> = {
    Name: { column: 'name', max: 100, required: !partial }, CurrentClass: { column: 'current_class', max: 10, required: !partial },
    DOB: { column: 'dob', kind: 'date' }, Gender: { column: 'gender', kind: 'gender' }, Mobile: { column: 'mobile', kind: 'mobile' },
    Email: { column: 'email', kind: 'email' }, Address: { column: 'address', max: 300 }, School: { column: 'school', max: 100 },
    Board: { column: 'board', max: 30, required: !partial }, PreviousPercentage: { column: 'previous_percentage', kind: 'number' },
    ParentName: { column: 'parent_name', max: 100, required: !partial }, Relationship: { column: 'relationship', max: 30 },
    ParentMobile: { column: 'parent_mobile', kind: 'mobile', required: !partial },
    ParentWhatsApp: { column: 'parent_whatsapp', kind: 'mobile' }, ParentEmail: { column: 'parent_email', kind: 'email' },
  }
  const row: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(input)) {
    const spec = allowed[key]
    if (!spec) throw new ApiFault('BAD_REQUEST', `Unknown field: ${key}`)
    let value = requireText(raw, key, spec.max || 300, !!spec.required)
    if (!value) { row[spec.column] = spec.kind === 'date' || spec.kind === 'number' ? null : ''; continue }
    if (spec.kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ApiFault('BAD_REQUEST', 'DOB must use yyyy-mm-dd.')
    if (spec.kind === 'gender') {
      value = value.toUpperCase()
      if (!['MALE','FEMALE','OTHER'].includes(value)) throw new ApiFault('BAD_REQUEST', 'Gender must be Male, Female or Other.')
    }
    if (spec.kind === 'mobile') {
      let digits = value.replace(/\D/g, '')
      if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2)
      if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1)
      if (!/^[6-9]\d{9}$/.test(digits)) throw new ApiFault('BAD_REQUEST', `${key} must be a valid 10-digit mobile number.`)
      value = digits
    }
    if (spec.kind === 'email') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 120) throw new ApiFault('BAD_REQUEST', `${key} is not a valid email.`)
      value = value.toLowerCase()
    }
    if (spec.kind === 'number') {
      const n = Number(value)
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new ApiFault('BAD_REQUEST', 'PreviousPercentage must be from 0 to 100.')
      row[spec.column] = n; continue
    }
    if (key === 'CurrentClass') value = value.toUpperCase()
    row[spec.column] = value.replace(/^[=+\-@]+/, '')
  }
  for (const [key, spec] of Object.entries(allowed)) if (!partial && spec.required && !(spec.column in row)) throw new ApiFault('BAD_REQUEST', `${key} is required.`)
  normalizeStudentBoardRow(row)
  return row
}

async function sha256Hex(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function consumeRegistrationLimit(admin: ReturnType<typeof clients>['admin'], rateKey: string, seconds: number, max: number) {
  const { data, error } = await admin.rpc('consume_registration_limit', { p_rate_key: await sha256Hex(rateKey),
    p_window_seconds: seconds, p_max_hits: max })
  if (error) throw error
  return data === true
}

async function consumeLoginLimit(admin: ReturnType<typeof clients>['admin'], rateKey: string, seconds: number, max: number) {
  const { data, error } = await admin.rpc('consume_login_rate_limit', { p_rate_key: await sha256Hex(rateKey),
    p_window_seconds: seconds, p_max_hits: max })
  if (error) throw error
  return data === true
}

async function clearLoginLimit(admin: ReturnType<typeof clients>['admin'], rateKey: string) {
  const { error } = await admin.rpc('clear_login_rate_limit', { p_rate_key: await sha256Hex(rateKey) })
  if (error) throw error
}

function requestIp(request: Request) {
  const address = request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || 'unknown'
  return address.trim().slice(0, 100)
}

function invoiceLines(row: Record<string, unknown>) {
  const value = row.line_items
  if (Array.isArray(value)) return value as Array<Record<string, unknown>>
  if (typeof value === 'string') { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : [] } catch { return [] } }
  return []
}

function invoiceLinesForIncome(value: unknown) {
  let lines: Array<Record<string, unknown>> = []
  if (Array.isArray(value)) lines = value as Array<Record<string, unknown>>
  else if (typeof value === 'string') { try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) lines = parsed } catch { /* Ignore malformed legacy snapshots. */ } }
  return lines.map((line) => ({ ...line, subjectId: String(line.subjectId || ''), finalAmount: Number(line.finalAmount) || 0 }))
}

function teacherIncomeStatus(expectedValue: unknown, collectedValue: unknown, contributionValue: unknown, payableValue: unknown, paidValue: unknown) {
  const expected = Number(expectedValue) || 0, collected = Number(collectedValue) || 0
  const contribution = Number(contributionValue) || 0, payable = Number(payableValue) || 0, paid = Number(paidValue) || 0
  if (paid > 0.005) return paid + 0.005 >= payable ? 'PAID' : 'PARTIAL'
  if (payable > 0.005) return 'PENDING'
  if (collected > 0.005 && contribution + 0.005 >= collected) return 'NO_PAYOUT_DUE'
  if (expected > collected + 0.005) return 'AWAITING_COLLECTION'
  return 'NO_PAYOUT_DUE'
}

function normalizedInvoiceLines(row: Record<string, unknown>) {
  const lines = invoiceLines(row)
  const tracksPaid = lines.some((line) => line.paidAmount !== undefined && line.paidAmount !== null)
  let remainingPaid = tracksPaid ? 0 : Number(row.paid_amount) || 0
  return lines.map((line) => {
    const finalAmount = Number(line.finalAmount) || 0
    const paidAmount = tracksPaid ? Number(line.paidAmount) || 0 : Math.min(finalAmount, remainingPaid)
    if (!tracksPaid) remainingPaid = Math.max(0, remainingPaid - paidAmount)
    return { ...line, standardAmount: Number(line.standardAmount) || 0, discountAmount: Number(line.discountAmount) || 0,
      finalAmount, paidAmount, balanceAmount: Math.max(0, finalAmount - paidAmount) }
  })
}

function invoiceStatus(totalValue: unknown, paidValue: unknown, dueValue: unknown, storedValue: unknown) {
  const stored = String(storedValue || '').toUpperCase()
  if (stored === 'CANCELLED') return 'CANCELLED'
  const total = Number(totalValue) || 0, paid = Number(paidValue) || 0
  const balance = Math.max(0, total - paid)
  if (total === 0 || balance <= 0) return 'PAID'
  const due = dueValue ? String(dueValue).slice(0, 10) : ''
  if (due && due < todayDate()) return 'OVERDUE'
  return paid > 0 ? 'PARTIAL' : 'UNPAID'
}

function todayDate() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const part = (type: string) => parts.find((p) => p.type === type)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function validIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function dateWeekday(value: string) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' })
    .format(new Date(`${value}T12:00:00.000Z`)).toUpperCase()
}

function timeMinutes(value: string) {
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value)
  if (!match) return -1
  const hours = Number(match[1]), minutes = Number(match[2])
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : -1
}

function monthLabel(month: string) {
  const hit = /^(\d{4})-(\d{2})$/.exec(month)
  if (!hit) return month
  const date = new Date(Number(hit[1]), Number(hit[2]) - 1, 1)
  return new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric' }).format(date)
}

function allocationsFromPayment(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.map((x: any) => ({ subjectId: String(x?.subjectId || ''), subjectName: String(x?.subjectName || ''), amount: Number(x?.amount) || 0 }))
}

// Shared by the "Generate invoices" button and the monthly scheduled job.
async function generateInvoices(admin: ReturnType<typeof clients>['admin'], payload: Record<string, any>) {
  const month = requireText(payload.month, 'Month', 7, true)
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month)
  if (!match) throw new ApiFault('BAD_REQUEST', 'Pick a valid month (YYYY-MM).')
  const monthStart = `${month}-01`
  const monthEnd = new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).toISOString().slice(0, 10)
  const studentFilter = requireText(payload.studentId, 'Student ID', 40)
  // Every page is read (no silent 1,000-row cut-off). Assignments are narrowed in
  // the database to those that can overlap this month; the exact rules below
  // still decide what is billed (rows without a start date are kept and checked).
  const [students, assignments, { data: feeRows, error: feeError }, studentFeeRows, { data: settingRows }] = await Promise.all([
    fetchAll(() => {
      let q = admin.from('students').select('id,name,status').order('id')
      return studentFilter ? q.eq('id', studentFilter) : q
    }),
    fetchAll(() => {
      let q = admin.from('student_subjects').select('*').in('status', ['ACTIVE', 'ENDED'])
        .or(`start_date.is.null,start_date.lte.${monthEnd}`).or(`end_date.is.null,end_date.gte.${monthStart}`)
        .order('created_at').order('id') // oldest first, so invoice lines keep their usual order
      return studentFilter ? q.eq('student_id', studentFilter) : q
    }),
    admin.from('fee_structure').select('*').eq('item_type', 'SUBJECT').eq('status', 'Active'),
    fetchAll(() => admin.from('student_fees').select('*').eq('status', 'Active').is('effective_to', null).order('id')),
    admin.from('settings').select('setting_key,value').in('setting_key', ['ACADEMIC_YEAR','INVOICE_DUE_DAY']),
  ])
  if (feeError) throw feeError
  const settings = Object.fromEntries((settingRows || []).map((r) => [r.setting_key, r.value]))
  const academicYear = settings.ACADEMIC_YEAR || '2026-27'
  const dueDay = Math.min(28, Math.max(1, Number.parseInt(settings.INVOICE_DUE_DAY || '10', 10) || 10))
  const dueDate = `${month}-${String(dueDay).padStart(2, '0')}`
  const eligible = (students || []).filter((s) => (!studentFilter || s.id === studentFilter) && String(s.status).toUpperCase() === 'ACTIVE')
  if (!eligible.length) throw new ApiFault('BAD_REQUEST', 'No eligible students found.')
  const existingRows = await fetchAll(() => admin.from('invoices').select('id,student_id,status').eq('month', month).eq('academic_year', academicYear).order('id'))
  const already = new Set((existingRows || []).filter((r) => String(r.status).toUpperCase() !== 'CANCELLED').map((r) => r.student_id))
  const subjectNames = new Map<string, string>()
  const assignedSubjectIds = [...new Set((assignments || []).map((a) => a.subject_id))]
  const { data: subjects } = await admin.from('subjects').select('id,name').in('id', assignedSubjectIds.length ? assignedSubjectIds : ['__none__'])
  for (const s of subjects || []) subjectNames.set(s.id, s.name)
  const standardByKey = new Map((feeRows || []).filter((f) => f.academic_year === academicYear).map((f) => [f.subject_id, Number(f.amount)]))
  const overrideByKey = new Map((studentFeeRows || []).filter((r) => r.effective_from <= todayDate())
    .map((r) => [`${r.student_id}|${r.subject_id}`, r]))
  const assignmentByStudent = new Map<string, any[]>()
  for (const a of assignments || []) {
    // Bill only for months when this student was actually assigned the
    // subject. This also allows a past month to be generated after a
    // subject has ended, while excluding future starts from earlier bills.
    // Older rows may have no start_date; created_at is the safest available
    // fallback so a newly-created assignment cannot be billed retroactively.
    const assignmentStart = a.start_date
      ? String(a.start_date).slice(0, 10)
      : a.created_at
        ? (() => {
          const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' })
            .formatToParts(new Date(a.created_at))
          const part = (type: string) => parts.find((item) => item.type === type)?.value || ''
          return `${part('year')}-${part('month')}-${part('day')}`
        })()
        : ''
    const assignmentEnd = a.end_date ? String(a.end_date).slice(0, 10) : ''
    if ((assignmentStart && assignmentStart > monthEnd) || (assignmentEnd && assignmentEnd < monthStart)) continue
    // A subject ended on (or before) the day it started was given by mistake;
    // it never ran, so it must not be billed.
    if (String(a.status).toUpperCase() === 'ENDED' && assignmentStart && assignmentEnd && assignmentEnd <= assignmentStart) continue
    a._start = assignmentStart
    assignmentByStudent.set(a.student_id, [...(assignmentByStudent.get(a.student_id) || []), a])
  }
  // Bill each subject at most once per month. When a subject was ended and
  // given again (for example to correct its start date), keep the current
  // assignment: ACTIVE first, then the latest start, then the newest record.
  for (const [studentId, rows] of assignmentByStudent) {
    const bySubject = new Map<string, any>()
    for (const a of rows) {
      const prior = bySubject.get(a.subject_id)
      const rank = (x: any) => [String(x.status).toUpperCase() === 'ACTIVE' ? 1 : 0, String(x._start || ''), String(x.created_at || '')]
      if (!prior) { bySubject.set(a.subject_id, a); continue }
      const [pa, ps, pc] = rank(prior), [na, ns, nc] = rank(a)
      if (na > pa || (na === pa && (ns > ps || (ns === ps && nc > pc)))) bySubject.set(a.subject_id, a)
    }
    assignmentByStudent.set(studentId, [...bySubject.values()])
  }
  const result = { generated: 0, skippedExisting: 0, skippedEmpty: 0, total: 0, details: [] as Array<Record<string, unknown>> }
  // 1) Work out every invoice first (pure calculation, same rules as before).
  const planned: Array<{ student: any, lines: any[], total: number }> = []
  for (const student of eligible) {
    if (already.has(student.id)) { result.skippedExisting++; continue }
    const active = assignmentByStudent.get(student.id) || []
    const lines = active.map((a) => {
      const feeOverride = overrideByKey.get(`${student.id}|${a.subject_id}`)
      const standard = feeOverride ? Number(feeOverride.standard_amount) : a.fee_override !== null ? Number(a.fee_override) : standardByKey.get(a.subject_id) || 0
      const discount = feeOverride ? Number(feeOverride.discount_amount) : 0
      return { subjectId: a.subject_id, subjectName: subjectNames.get(a.subject_id) || a.subject_id,
        teacherId: a.teacher_id || '', batchId: a.batch_id || '',
        standardAmount: standard, discountAmount: discount, finalAmount: Math.max(0, standard - discount), paidAmount: 0 }
    }).filter((line) => line.finalAmount > 0)
    if (!lines.length) { result.skippedEmpty++; continue }
    planned.push({ student, lines, total: Math.round(lines.reduce((sum, line) => sum + line.finalAmount, 0) * 100) / 100 })
  }
  // 2) Reserve all invoice numbers in one call, then save in batches of 100.
  const ids = await newIds(admin, 'invoices', `INV-${month.replace('-', '')}-`, 4, planned.length)
  const record = (p: typeof planned[number], id: string) => {
    already.add(p.student.id)
    result.generated++; result.total = Math.round((result.total + p.total) * 100) / 100
    result.details.push({ studentId: p.student.id, name: p.student.name, invoiceId: id, amount: p.total })
  }
  for (let i = 0; i < planned.length; i += 100) {
    const chunk = planned.slice(i, i + 100)
    const rows = chunk.map((p, k) => ({ id: ids[i + k], student_id: p.student.id, month, academic_year: academicYear,
      line_items: p.lines, total_amount: p.total, paid_amount: 0, balance_amount: p.total, status: 'UNPAID', due_date: dueDate }))
    const { error } = await admin.from('invoices').insert(rows)
    if (!error) { chunk.forEach((p, k) => record(p, ids[i + k])); continue }
    if (error.code !== '23505') throw error
    // Someone created an invoice at the same moment: save this batch one by one
    // (exactly the old behaviour) so only the duplicates are skipped.
    for (let k = 0; k < chunk.length; k++) {
      const { error: oneError } = await admin.from('invoices').insert(rows[k])
      if (oneError?.code === '23505') { result.skippedExisting++; continue }
      if (oneError) throw oneError
      record(chunk[k], ids[i + k])
    }
  }
  return { month, result }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (request.method !== 'POST') return response(fail('METHOD_NOT_ALLOWED', 'Use POST.'))

  let action = ''
  try {
    const body = await request.json()
    action = String(body?.action || '')
    const payload = body?.payload && typeof body.payload === 'object' ? body.payload : {}
    const { auth, admin } = clients()

    if (action === 'public.config') {
      const { data } = await admin.from('settings').select('setting_key,value')
      const settings = Object.fromEntries((data || []).map((r) => [r.setting_key, r.value]))
      return response({ ok: true, data: {
        centreName: settings.CENTRE_NAME || 'Creative Math Zone', tagline: settings.TAGLINE || '',
        logoUrl: settings.LOGO_URL || '', academicYear: settings.ACADEMIC_YEAR || '',
        sessionTimeoutMinutes: Number(settings.SESSION_TIMEOUT_MINUTES || 30),
        registrationEnabled: String(settings.REGISTRATION_ENABLED || 'TRUE').toUpperCase() === 'TRUE', version: '1.0.0',
      } })
    }

    if (action === 'public.landingNotices') {
      const { data: settings, error: settingsError } = await admin.from('settings').select('setting_key,value')
      if (settingsError) throw settingsError
      const publicIds = (settings || [])
        .filter((r) => String(r.setting_key).startsWith('PUBLIC_LANDING_NOTICE_') && String(r.value).toUpperCase() === 'TRUE')
        .map((r) => String(r.setting_key).slice('PUBLIC_LANDING_NOTICE_'.length))
        .filter(Boolean)
      if (!publicIds.length) return response({ ok: true, data: [] })
      const { data, error } = await admin.from('notices').select('id,title,body,audience,posted_at,expires_at')
        .in('id', publicIds).eq('status', 'Active').eq('audience', 'ALL').order('posted_at', { ascending: false }).limit(50)
      if (error) throw error
      const today = todayDate()
      return response({ ok: true, data: (data || []).filter((r) => !r.expires_at || r.expires_at >= today).slice(0, 8)
        .map((r) => ({ Title: r.title, Body: r.body, PostedAt: r.posted_at })) })
    }

    if (action === 'public.registerOptions') {
      const [{ data: settings, error: settingsError }, { data: subjects, error: subjectsError }, { data: batches, error: batchesError }] = await Promise.all([
        admin.from('settings').select('setting_key,value').in('setting_key', ['REGISTRATION_ENABLED', 'SUBJECT_BLOCKED_PAIRS']),
        admin.from('subjects').select('id,name').eq('status', 'Active').order('name'),
        admin.from('batches').select('class').eq('status', 'Active').order('class'),
      ])
      if (settingsError || subjectsError || batchesError) throw settingsError || subjectsError || batchesError
      const values = Object.fromEntries((settings || []).map((r) => [r.setting_key, r.value]))
      const classes = [...new Set((batches || []).map((r) => String(r.class).toUpperCase()).filter(Boolean))]
      const blockedPairs = String(values.SUBJECT_BLOCKED_PAIRS || '').split(';').map((pair) => pair.split('|').map((id) => id.trim()))
        .filter((pair) => pair.length === 2 && pair[0] && pair[1])
      return response({ ok: true, data: { enabled: String(values.REGISTRATION_ENABLED || 'TRUE').toUpperCase() === 'TRUE',
        classes, subjects: (subjects || []).map((s) => ({ id: s.id, name: s.name })), blockedPairs } })
    }

    if (action === 'public.register') {
      if (String(payload.website || '').trim()) return response({ ok: true, data: { requestId: 'REG-00000' } })
      const { data: settingRows, error: settingError } = await admin.from('settings').select('setting_key,value')
        .in('setting_key', ['REGISTRATION_ENABLED', 'REGISTRATION_MAX_PER_HOUR', 'SUBJECT_BLOCKED_PAIRS'])
      if (settingError) throw settingError
      const settings = Object.fromEntries((settingRows || []).map((r) => [r.setting_key, r.value]))
      if (String(settings.REGISTRATION_ENABLED || 'TRUE').toUpperCase() !== 'TRUE') throw new ApiFault('CLOSED', 'Online registration is closed. Please contact the centre.')
      const rawStudent = payload.student && typeof payload.student === 'object' && !Array.isArray(payload.student) ? payload.student : null
      if (!rawStudent) throw new ApiFault('BAD_REQUEST', 'Provide the student and parent details.')
      const row = validateRegistrationInput(rawStudent)
      const password = String(payload.password || '')
      if (password.length < 8 || password.length > 100) throw new ApiFault('BAD_PASSWORD', 'Choose a password with at least 8 characters.')
      const subjectIds = Array.isArray(payload.subjects) ? [...new Set(payload.subjects.map((x: unknown) => String(x)))] : []
      if (subjectIds.length > 6) throw new ApiFault('BAD_REQUEST', 'Choose no more than 6 subjects.')
      const [{ data: batches }, { data: subjects }] = await Promise.all([
        admin.from('batches').select('id,class').eq('status', 'Active'),
        admin.from('subjects').select('id,status').in('id', subjectIds.length ? subjectIds : ['__none__']),
      ])
      if (!(batches || []).some((b) => String(b.class).toUpperCase() === row.current_class)) throw new ApiFault('BAD_REQUEST', 'Please choose a class that has an active batch.')
      if ((subjects || []).length !== subjectIds.length || (subjects || []).some((s) => s.status !== 'Active')) throw new ApiFault('BAD_REQUEST', 'One of the chosen subjects is not available.')
      const blockedPairs = String(settings.SUBJECT_BLOCKED_PAIRS || '').split(';').map((x) => x.split('|').map((y) => y.trim()))
      if (blockedPairs.some((pair) => pair.length === 2 && subjectIds.includes(pair[0]) && subjectIds.includes(pair[1]))) throw new ApiFault('RULE_VIOLATION', 'This combination of subjects is not allowed.')
      const maxPerHour = Math.min(Math.max(Number.parseInt(settings.REGISTRATION_MAX_PER_HOUR || '15', 10) || 15, 1), 200)
      const ip = requestIp(request)
      if (!await consumeRegistrationLimit(admin, `submit-ip:${ip}`, 3600, maxPerHour)) throw new ApiFault('RATE_LIMIT', 'Many requests are coming in right now. Please try again in a little while.')
      if (!await consumeRegistrationLimit(admin, `submit-parent:${row.parent_mobile}`, 21600, 5)) throw new ApiFault('RATE_LIMIT', 'Too many requests from this mobile number. Please contact the centre.')
      const { count: pendingCount, error: pendingError } = await admin.from('registrations').select('id', { count: 'exact', head: true }).eq('status', 'PENDING')
      if (pendingError) throw pendingError
      if ((pendingCount || 0) >= 300) throw new ApiFault('RATE_LIMIT', 'Registration is paused for now. Please contact the centre.')
      const possibleMobiles = [...new Set([row.mobile, row.parent_mobile, row.parent_whatsapp].filter(Boolean))]
      const normalizedName = String(row.name).toLowerCase()
      for (const mobile of possibleMobiles) {
        const [{ data: existingStudents }, { data: existingRequests }] = await Promise.all([
          admin.from('students').select('id,name,mobile,parent_mobile,parent_whatsapp').or(`mobile.eq.${mobile},parent_mobile.eq.${mobile},parent_whatsapp.eq.${mobile}`),
          admin.from('registrations').select('id,name,mobile,parent_mobile,parent_whatsapp').eq('status', 'PENDING').or(`mobile.eq.${mobile},parent_mobile.eq.${mobile},parent_whatsapp.eq.${mobile}`),
        ])
        if ([...(existingStudents || []), ...(existingRequests || [])].some((candidate) => String(candidate.name).toLowerCase() === normalizedName)) {
          throw new ApiFault('DUPLICATE', 'This looks like a duplicate of an existing record. Please contact the centre.')
        }
      }
      const id = await newId(admin, 'registrations', 'REG-', 5)
      const { data: authRecord, error: authCreateError } = await admin.auth.admin.createUser({
        email: authEmailForUsername(id), password, email_confirm: true,
      })
      if (authCreateError || !authRecord.user) throw new ApiFault('ACCOUNT_CREATE_FAILED', 'Could not securely save the sign-in password. Please try again.')
      const { error: insertError } = await admin.from('registrations').insert({ ...row, id, status: 'PENDING',
        requested_subjects: subjectIds, registration_auth_user_id: authRecord.user.id })
      if (insertError) {
        await admin.auth.admin.deleteUser(authRecord.user.id)
        if (insertError.code === '23505') throw new ApiFault('DUPLICATE', 'This request was already received.')
        throw insertError
      }
      await admin.from('admin_logs').insert({ id: `LOG-${crypto.randomUUID()}`, username: 'public', role: '',
        action: 'REGISTRATION_SUBMITTED', entity_type: 'REGISTRATION', entity_id: id,
        details: JSON.stringify({ name: row.name, currentClass: row.current_class }), result: 'OK' })
      return response({ ok: true, data: { requestId: id } })
    }

    if (action === 'public.registerStatus') {
      const id = String(payload.requestId || '').trim().toUpperCase()
      const mobile = String(payload.mobile || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '').replace(/^0(?=\d{10}$)/, '')
      if (!/^REG-\d{5}$/.test(id) || !/^[6-9]\d{9}$/.test(mobile)) throw new ApiFault('NOT_FOUND', 'No request found for those details. Check the request ID and mobile number.')
      if (!await consumeRegistrationLimit(admin, `status-ip:${requestIp(request)}`, 3600, 10)) throw new ApiFault('RATE_LIMIT', 'Too many attempts. Please try again later.')
      const { data: reg, error } = await admin.from('registrations').select('id,name,status,submitted_at,mobile,parent_mobile,student_id,reject_reason').eq('id', id).maybeSingle()
      if (error) throw error
      if (!reg || ![reg.mobile, reg.parent_mobile].includes(mobile)) throw new ApiFault('NOT_FOUND', 'No request found for those details. Check the request ID and mobile number.')
      return response({ ok: true, data: { RegistrationID: reg.id, Name: reg.name, Status: reg.status,
        SubmittedAt: reg.submitted_at, StudentID: reg.status === 'APPROVED' ? reg.student_id || '' : '',
        RejectReason: reg.status === 'REJECTED' ? reg.reject_reason : '' } })
    }

    if (action === 'auth.login') {
      const username = String(payload.username || '').trim()
      const password = String(payload.password || '')
      const portal = String(payload.portal || '').toUpperCase()
      if (!username || !password || username.length > 60 || password.length > 200) return response(fail('BAD_LOGIN', 'Username or password is incorrect.'))
      const { data: loginSettings, error: loginSettingsError } = await admin.from('settings').select('setting_key,value')
        .in('setting_key', ['LOGIN_MAX_ATTEMPTS', 'LOGIN_LOCK_MINUTES'])
      if (loginSettingsError) throw loginSettingsError
      const loginSettingsByKey = Object.fromEntries((loginSettings || []).map((row) => [row.setting_key, row.value]))
      const maxAttempts = Math.min(20, Math.max(3, Number.parseInt(loginSettingsByKey.LOGIN_MAX_ATTEMPTS || '5', 10) || 5))
      const lockMinutes = Math.min(240, Math.max(1, Number.parseInt(loginSettingsByKey.LOGIN_LOCK_MINUTES || '15', 10) || 15))
      const loginRateKey = `login:${username.toLowerCase()}`
      if (!await consumeLoginLimit(admin, loginRateKey, lockMinutes * 60, maxAttempts)) {
        return response(fail('LOCKED', 'Too many login attempts. Please try again later.'))
      }
      const { data: user } = await admin.from('app_users').select('*').ilike('username', username).maybeSingle()
      if (!user || !user.auth_user_id) return response(fail('BAD_LOGIN', 'Username or password is incorrect.'))
      const { data: authUser } = await admin.auth.admin.getUserById(user.auth_user_id)
      const email = authUser.user?.email
      if (!email) return response(fail('BAD_LOGIN', 'Username or password is incorrect.'))
      const { data: session, error } = await auth.auth.signInWithPassword({ email, password })
      if (error || !session.session) return response(fail('BAD_LOGIN', 'Username or password is incorrect.'))
      await clearLoginLimit(admin, loginRateKey)
      if (user.status.toUpperCase() !== 'ACTIVE') {
        await auth.auth.signOut({ scope: 'local' })
        return response(fail('DISABLED', 'This account is disabled. Please contact the centre.'))
      }
      if (portal !== user.user_type) {
        await auth.auth.signOut({ scope: 'local' })
        return response(fail('WRONG_PORTAL', `This account belongs to the ${String(user.user_type).toLowerCase()} portal.`))
      }
      await admin.from('app_users').update({ last_login: new Date().toISOString() }).eq('id', user.id)
      return response({ ok: true, data: {
        token: session.session.access_token, refreshToken: session.session.refresh_token,
        sessionTimeoutMinutes: 30,
        user: { userId: user.id, username: user.username, userType: user.user_type, role: user.role,
          linkedId: user.linked_id, displayName: user.username,
          mustChangePassword: user.must_change_password, permissions: permissionsFor(user) },
      } })
    }

    // Monthly scheduled job (pg_cron on the 1st): generate this month's invoices.
    // Authenticated by the private archive secret, never by a browser.
    if (action === 'cron.autoInvoices') {
      const secret = Deno.env.get('HOMEWORK_ARCHIVE_CRON_SECRET')
      if (!secret || request.headers.get('x-archive-secret') !== secret) return response(fail('FORBIDDEN', 'Unauthorized scheduled job.'))
      const { data: flag } = await admin.from('settings').select('value').eq('setting_key', 'AUTO_INVOICE_ENABLED').maybeSingle()
      if (String(flag?.value || 'TRUE').toUpperCase() !== 'TRUE') return response({ ok: true, data: { skipped: 'AUTO_INVOICE_ENABLED is FALSE' } })
      const month = todayDate().slice(0, 7)
      let outcome: Record<string, unknown>
      try {
        const { result } = await generateInvoices(admin, { month })
        outcome = { generated: result.generated, skipped: result.skippedExisting + result.skippedEmpty, total: result.total }
      } catch (e) {
        outcome = { error: e instanceof Error ? e.message : String(e) }
      }
      await admin.from('admin_logs').insert({ id: `LOG-${crypto.randomUUID()}`, user_id: null, username: 'system', role: 'SYSTEM',
        action: 'AUTO_GENERATE_INVOICES', entity_type: 'INVOICES', entity_id: month, details: JSON.stringify(outcome), result: outcome.error ? 'FAILED' : 'OK' })
      return response({ ok: !outcome.error, data: { month, ...outcome } })
    }

    const token = String(body?.token || request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') || '')
    if (!token) return response(fail('AUTH_REQUIRED', 'Please sign in.'))
    const { data: authData, error: authError } = await auth.auth.getUser(token)
    if (authError || !authData.user) return response(fail('SESSION_EXPIRED', 'Your session has expired. Please sign in again.'))
    const { data: user, error: userError } = await admin.from('app_users').select('*').eq('auth_user_id', authData.user.id).maybeSingle()
    if (userError || !user || user.status.toUpperCase() !== 'ACTIVE') return response(fail('SESSION_REVOKED', 'This account is unavailable. Please contact the centre.'))
    if (user.password_changed_at) {
      const cutoff = Math.floor(new Date(user.password_changed_at).getTime() / 1000)
      const issuedAt = verifiedTokenIssuedAt(token)
      if (!Number.isFinite(cutoff) || issuedAt === null || issuedAt < cutoff) {
        return response(fail('SESSION_REVOKED', 'Your password or account recovery details changed. Sign in again with your current password.'))
      }
    }
    if (user.must_change_password && action !== 'auth.me' && action !== 'auth.changePassword' && action !== 'auth.logout') {
      return response(fail('PASSWORD_CHANGE_REQUIRED', 'Please change your temporary password first.'))
    }

    if (action === 'auth.me') {
      let profile = null
      if (user.user_type === 'STUDENT' && user.linked_id) {
        const { data } = await admin.from('students').select('*').eq('id', user.linked_id).maybeSingle()
        profile = data ? legacyStudent(data) : null
      }
      if (user.user_type === 'TEACHER' && user.linked_id) {
        const { data } = await admin.from('teachers').select('*').eq('id', user.linked_id).maybeSingle()
        profile = data ? { ...data, TeacherID: data.id, Name: data.name, Mobile: data.mobile, Email: data.email } : null
      }
      return response({ ok: true, data: { userId: user.id, username: user.username, userType: user.user_type,
        role: user.role, linkedId: user.linked_id, mustChangePassword: user.must_change_password,
        permissions: permissionsFor(user), profile } })
    }

    if (action === 'auth.logout') {
      await userClient(token).auth.signOut()
      await admin.from('app_users').update({ last_logout: new Date().toISOString() }).eq('id', user.id)
      return response({ ok: true, data: { loggedOut: true } })
    }

    if (action === 'auth.changePassword') {
      const oldPassword = String(payload.oldPassword || '')
      const newPassword = String(payload.newPassword || '')
      if (!oldPassword || newPassword.length < 8 || newPassword.length > 200) {
        return response(fail('BAD_PASSWORD', 'New password must be at least 8 characters.'))
      }
      const { data: authUser } = await admin.auth.admin.getUserById(authData.user.id)
      const email = authUser.user?.email
      if (!email) return response(fail('BAD_PASSWORD', 'Current password is incorrect.'))
      const { error: verifyError } = await auth.auth.signInWithPassword({ email, password: oldPassword })
      if (verifyError) return response(fail('BAD_PASSWORD', 'Current password is incorrect.'))
      const { error: updateError } = await admin.auth.admin.updateUserById(authData.user.id, { password: newPassword })
      if (updateError) return response(fail('BAD_PASSWORD', 'Could not update the password.'))
      const changedAt = new Date().toISOString()
      const { error: appUserUpdateError } = await admin.from('app_users').update({ must_change_password: false, password_changed_at: changedAt }).eq('id', user.id)
      if (appUserUpdateError) throw appUserUpdateError
      // Return a fresh token issued after the cutoff; the old token (and older
      // tokens on other devices) will no longer pass the API's iat check.
      const { data: refreshed, error: signInError } = await auth.auth.signInWithPassword({ email, password: newPassword })
      if (signInError || !refreshed.session) throw new ApiFault('PASSWORD_UPDATED_SIGN_IN_FAILED', 'Password changed. Sign in again with your new password.')
      return response({ ok: true, data: { token: refreshed.session.access_token, refreshToken: refreshed.session.refresh_token, mustChangePassword: false } })
    }

    if (action === 'auth.ping') return response({ ok: true, data: { alive: true, serverTime: new Date().toISOString() } })

    const needed: Record<string, string> = {
      'settings.get': 'SETTINGS_VIEW', 'subjects.list': 'MASTER_VIEW', 'batches.list': 'MASTER_VIEW',
      'rooms.list': 'MASTER_VIEW', 'teachers.list': 'TEACHER_VIEW', 'users.list': 'USER_MANAGE',
      'users.createAdmin': 'USER_MANAGE', 'users.setStatus': 'USER_MANAGE', 'users.resetPassword': 'USER_MANAGE',
      'users.setPermissions': 'USER_MANAGE', 'logs.list': 'LOG_VIEW',
      'subjects.add': 'MASTER_EDIT', 'subjects.update': 'MASTER_EDIT',
      'batches.add': 'MASTER_EDIT', 'batches.update': 'MASTER_EDIT',
      'rooms.add': 'MASTER_EDIT', 'rooms.update': 'MASTER_EDIT',
      'students.list': 'STUDENT_VIEW', 'students.get': 'STUDENT_VIEW',
      'students.add': 'STUDENT_EDIT', 'students.update': 'STUDENT_EDIT',
      'promotions.preview': 'STUDENT_EDIT', 'promotions.fees.list': 'STUDENT_EDIT',
      'promotions.fees.save': 'STUDENT_EDIT', 'promotions.fees.delete': 'STUDENT_EDIT', 'promotions.apply': 'STUDENT_EDIT',
      'students.resetPassword': 'STUDENT_EDIT',
      'studentSubjects.assign': 'STUDENT_EDIT', 'studentSubjects.end': 'STUDENT_EDIT', 'studentSubjects.updateFee': 'STUDENT_EDIT',
      'studentSubjects.updateStart': 'STUDENT_EDIT', 'students.finance': 'FINANCE_VIEW',
      'students.delete': 'STUDENT_EDIT', 'settings.studentDelete.get': 'SETTINGS_VIEW', 'settings.studentDelete.set': 'SETTINGS_EDIT',
      'ai.status': 'SETTINGS_VIEW', 'ai.setKey': 'SETTINGS_EDIT',
      'push.subscribe': 'SELF_VIEW', 'push.unsubscribe': 'SELF_VIEW', 'reminders.list': 'STUDENT_VIEW', 'reminders.mark': 'STUDENT_VIEW',
      'doubts.list': 'SELF_VIEW', 'doubts.get': 'SELF_VIEW', 'doubts.create': 'SELF_VIEW', 'doubts.answer': 'SELF_VIEW',
      'doubts.claim': 'SELF_VIEW', 'doubts.review': 'SELF_VIEW', 'doubts.resolve': 'SELF_VIEW', 'doubts.meToo': 'SELF_VIEW',
      'doubts.hide': 'SELF_VIEW', 'doubts.leaderboard': 'SELF_VIEW', 'doubts.stats': 'SELF_VIEW',
      'changes.list': 'STUDENT_VIEW',
      'teachers.add': 'TEACHER_EDIT', 'teachers.update': 'TEACHER_EDIT',
      'teachers.resetPassword': 'TEACHER_EDIT',
      'settings.update': 'SETTINGS_EDIT',
      'timetable.list': 'MASTER_VIEW', 'timetable.add': 'MASTER_EDIT', 'timetable.update': 'MASTER_EDIT',
      'timetable.setStatus': 'MASTER_EDIT', 'notices.adminList': 'NOTICE_VIEW',
      'notices.add': 'NOTICE_EDIT', 'notices.update': 'NOTICE_EDIT', 'notices.setStatus': 'NOTICE_EDIT',
      'notices.list': 'NOTICE_VIEW',
      'registrations.list': 'STUDENT_VIEW', 'registrations.pendingCount': 'STUDENT_VIEW',
      'registrations.update': 'STUDENT_EDIT', 'registrations.approve': 'STUDENT_EDIT', 'registrations.reject': 'STUDENT_EDIT',
      'finance.feeStructure.list': 'FINANCE_VIEW', 'finance.feeStructure.add': 'FINANCE_EDIT',
      'finance.feeStructure.update': 'FINANCE_EDIT', 'finance.studentFee.list': 'FINANCE_VIEW',
      'finance.studentFee.set': 'FINANCE_EDIT', 'finance.studentFee.remove': 'FINANCE_EDIT',
      'invoices.list': 'FINANCE_VIEW', 'invoices.get': 'FINANCE_VIEW',
      'invoices.generate': 'FINANCE_EDIT', 'invoices.cancel': 'FINANCE_EDIT',
      'payments.record': 'FINANCE_EDIT', 'receipts.list': 'FINANCE_VIEW',
      'receipts.get': 'FINANCE_VIEW', 'receipts.void': 'FINANCE_EDIT',
      'teacher.paymentMethods.list': 'SELF_VIEW', 'teacher.paymentMethods.save': 'SELF_VIEW',
      'paymentMethods.adminList': 'FINANCE_VIEW', 'paymentMethods.review': 'FINANCE_EDIT',
      'student.paymentSubmit': 'SELF_VIEW', 'paymentSubmissions.adminList': 'FINANCE_VIEW', 'paymentSubmissions.review': 'FINANCE_EDIT',
      'student.invoices': 'SELF_VIEW', 'student.receipt': 'SELF_VIEW', 'student.invoiceDoc': 'SELF_VIEW',
      'teacher.homework.list': 'SELF_VIEW', 'teacher.homework.create': 'CLASS_RUN', 'teacher.homework.review': 'CLASS_RUN',
      'student.homework.list': 'SELF_VIEW', 'student.homework.submit': 'SELF_VIEW',
      'homework.files.upload': 'SELF_VIEW', 'homework.files.register': 'SELF_VIEW', 'homework.files.delete': 'SELF_VIEW',
      'drive.connections.list': 'SETTINGS_VIEW', 'drive.oauthStart': 'SETTINGS_EDIT',
      'teacher.classMaterials.upload': 'CLASS_RUN', 'teacher.classMaterials.register': 'CLASS_RUN', 'teacher.classMaterials.list': 'SELF_VIEW',
      'student.classMaterials.list': 'SELF_VIEW',
      'teacher.dashboard': 'SELF_VIEW', 'teacher.timetable': 'SELF_VIEW', 'teacher.students': 'SELF_VIEW', 'teacher.studentProfile': 'SELF_VIEW',
      'teacher.startClass': 'CLASS_RUN', 'teacher.regenerateCode': 'CLASS_RUN', 'teacher.classStatus': 'CLASS_RUN',
      'teacher.rescheduleClass': 'CLASS_RUN',
      'teacher.manualAttendance': 'ATTENDANCE_MARK', 'teacher.markAll': 'ATTENDANCE_MARK',
      'teacher.closeClass': 'CLASS_RUN', 'teacher.sessions': 'SELF_VIEW', 'teacher.notices': 'NOTICE_VIEW',
      'student.dashboard': 'SELF_VIEW', 'student.subjects': 'SELF_VIEW', 'student.timetable': 'SELF_VIEW', 'student.classChanges': 'SELF_VIEW',
      'student.attendance': 'SELF_VIEW', 'student.updateProfile': 'SELF_VIEW', 'student.enterCode': 'ATTENDANCE_SELF',
      'attendance.sessions': 'STUDENT_VIEW', 'attendance.detail': 'STUDENT_VIEW', 'attendance.correct': 'ATTENDANCE_CORRECT',
      'teacher.income': 'TEACHER_INCOME_VIEW',
      'teacherIncome.list': 'TEACHER_INCOME_MANAGE', 'teacherIncome.get': 'TEACHER_INCOME_MANAGE',
      'teacherIncome.adjust': 'TEACHER_INCOME_MANAGE', 'teacherIncome.pay': 'TEACHER_INCOME_MANAGE', 'teacherIncome.generate': 'TEACHER_INCOME_MANAGE',
      'reports.collection': 'REPORT_VIEW', 'reports.dues': 'REPORT_VIEW', 'reports.attendance': 'REPORT_VIEW', 'reports.teacherPay': 'REPORT_VIEW',
      'sync.version': 'SELF_VIEW',
    }
    const permission = needed[action]
    const granted = permissionsFor(user)
    if (!permission) return response(fail('UNKNOWN_ACTION', 'This action has not been migrated yet.'))
    if (!granted.includes('*') && !granted.includes(permission)) return response(fail('FORBIDDEN', 'You do not have permission to perform this action.'))

    if (action === 'sync.version') {
      const { data, error } = await admin.from('admin_logs').select('logged_at').order('logged_at', { ascending: false }).limit(1).maybeSingle()
      if (error) throw error
      const stamp = data?.logged_at || '0'
      return response({ ok: true, data: { v: stamp, l: stamp } })
    }

    if (action === 'homework.files.upload' || action === 'homework.files.register' || action === 'homework.files.delete') {
      if (!['TEACHER','STUDENT'].includes(user.user_type) || !user.linked_id) throw new ApiFault('FORBIDDEN', 'A linked teacher or student account is required.')
      const homeworkId = requireText(payload.homeworkId, 'Homework', 60, true)
      const { data: hw, error: hwError } = await admin.from('homework').select('id,teacher_id,batch_id,due_at,status').eq('id', homeworkId).maybeSingle()
      if (hwError) throw hwError
      if (!hw || hw.status !== 'Active') throw new ApiFault('NOT_FOUND', 'Homework not found.')
      if(action!=='homework.files.delete'&&hw.due_at&&new Date(hw.due_at).getTime()<=Date.now())throw new ApiFault('EXPIRED','The homework deadline has passed; uploads are closed.')
      let ownerType: 'TEACHER'|'STUDENT' = user.user_type
      if (ownerType === 'TEACHER' && hw.teacher_id !== user.linked_id) throw new ApiFault('FORBIDDEN', 'You can manage files only for your own homework.')
      if (ownerType === 'STUDENT') {
        const { data: student, error } = await admin.from('students').select('id,current_batch_id').eq('id', user.linked_id).maybeSingle()
        if (error) throw error
        const { data: assignments } = await admin.from('student_subjects').select('batch_id').eq('student_id', user.linked_id).ilike('status','active')
        if (!student || ![student.current_batch_id, ...(assignments||[]).map((x)=>x.batch_id)].includes(hw.batch_id)) throw new ApiFault('NOT_FOUND','Homework not found for your class.')
        if (hw.due_at && new Date(hw.due_at).getTime() <= Date.now()) throw new ApiFault('EXPIRED','The homework deadline has passed; uploads are closed.')
      }
      if (action === 'homework.files.upload' || action === 'homework.files.register') {
        const fileName = requireText(payload.fileName, 'File name', 180, true).replace(/[\\/\u0000-\u001f]/g, '_')
        const mimeType = requireText(payload.mimeType, 'File type', 150, true).toLowerCase()
        const fileSize = Number(payload.fileSize)
        const allowed = new Set(['application/pdf','image/jpeg','image/png','application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
        const extension = fileName.split('.').pop()?.toLowerCase() || ''
        const extensionMime: Record<string,string> = {pdf:'application/pdf',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}
        if (!allowed.has(mimeType) || extensionMime[extension] !== mimeType) throw new ApiFault('BAD_REQUEST','Use a PDF, JPG, PNG, or DOCX file.')
        if (!Number.isFinite(fileSize) || fileSize < 1 || fileSize > 10*1024*1024) throw new ApiFault('BAD_REQUEST','Each file must be 10 MB or smaller.')
        if (action === 'homework.files.upload') {
          const { count } = await admin.from('homework_files').select('id',{count:'exact',head:true}).eq('homework_id',homeworkId).eq('uploaded_by_type',ownerType).eq('uploaded_by_id',user.linked_id)
          if ((count || 0) >= 5) throw new ApiFault('BAD_REQUEST','You can attach up to five files here.')
          const safe = fileName.normalize('NFKD').replace(/[^A-Za-z0-9._-]/g,'_').slice(-120) || 'homework-file'
          const path = `${homeworkId}/${ownerType.toLowerCase()}/${user.linked_id}/${crypto.randomUUID()}-${safe}`
          const { data: signed, error } = await admin.storage.from('homework-files').createSignedUploadUrl(path)
          if (error || !signed) throw error || new ApiFault('UPLOAD_FAILED','Could not prepare the file upload.')
          return response({ok:true,data:{path,uploadUrl:signed.signedUrl}})
        }
        const path = requireText(payload.path,'File path',600,true)
        const prefix = `${homeworkId}/${ownerType.toLowerCase()}/${user.linked_id}/`
        if (!path.startsWith(prefix) || path.includes('..')) throw new ApiFault('BAD_REQUEST','Invalid homework file path.')
        const objectName = path.slice(path.lastIndexOf('/')+1)
        const {data: objects,error:listError}=await admin.storage.from('homework-files').list(path.slice(0,path.lastIndexOf('/')),{search:objectName})
        if(listError)throw listError
        if(!(objects||[]).some((x)=>x.name===objectName))throw new ApiFault('UPLOAD_FAILED','The uploaded file was not found. Please try again.')
        let submissionIdToStore: string|null = null
        if(ownerType==='STUDENT'){
          const {data:sub,error:subError}=await admin.from('homework_submissions').select('id').eq('homework_id',homeworkId).eq('student_id',user.linked_id).maybeSingle()
          if(subError)throw subError
          if(!sub)throw new ApiFault('BAD_REQUEST','Submit your answer before adding files.')
          submissionIdToStore=sub.id
        }
        const {error:insertError}=await admin.from('homework_files').insert({id:`HWF-${crypto.randomUUID()}`,homework_id:homeworkId,submission_id:submissionIdToStore,uploaded_by_type:ownerType,uploaded_by_id:user.linked_id,file_path:path,file_name:fileName,mime_type:mimeType,file_size:fileSize})
        if(insertError){await admin.storage.from('homework-files').remove([path]);throw insertError}
        return response({ok:true,data:{registered:true}})
      }
      const fileId = requireText(payload.fileId,'File',100,true)
      let query=admin.from('homework_files').select('id,file_path,homework_id,uploaded_by_type,uploaded_by_id,drive_file_id,drive_connection_id').eq('id',fileId)
      if(ownerType==='STUDENT') query=query.eq('uploaded_by_type','STUDENT').eq('uploaded_by_id',user.linked_id)
      const {data:file,error}=await query.maybeSingle()
      if(error)throw error
      if(!file)throw new ApiFault('NOT_FOUND','File not found.')
      if(ownerType==='TEACHER'){
        const {data:owned,error:ownedError}=await admin.from('homework').select('id').eq('id',file.homework_id).eq('teacher_id',user.linked_id).maybeSingle()
        if(ownedError)throw ownedError
        if(!owned)throw new ApiFault('FORBIDDEN','You can delete files only from your own homework.')
      }
      const secrets=JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS')||'{}')
      const deletion=await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/homework-drive`,{method:'POST',headers:{'Content-Type':'application/json','apikey':secrets.default,Authorization:`Bearer ${token}`},body:JSON.stringify({action:'delete',fileId})})
      const result=await deletion.json()
      if(!deletion.ok)throw new ApiFault('DELETE_FAILED',result.error||'Could not delete the file.')
      return response({ok:true,data:result})
    }

    if (action === 'drive.connections.list' || action === 'drive.oauthStart') {
      if(user.user_type!=='ADMIN'||user.role!=='SUPER_ADMIN')throw new ApiFault('FORBIDDEN','Only the Super Admin can manage the centre Google Drive connection.')
      if(action==='drive.oauthStart'){
        const clientId=Deno.env.get('GOOGLE_DRIVE_CLIENT_ID')
        const callback=Deno.env.get('GOOGLE_DRIVE_REDIRECT_URI')
        if(!clientId||!callback)throw new ApiFault('SETUP','Set GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_REDIRECT_URI in Supabase function secrets first.')
        const state=crypto.randomUUID()+crypto.randomUUID()
        const {error}=await admin.from('google_drive_oauth_states').insert({state,app_user_id:user.id})
        if(error)throw error
        const url=new URL('https://accounts.google.com/o/oauth2/v2/auth')
        url.searchParams.set('client_id',clientId);url.searchParams.set('redirect_uri',callback);url.searchParams.set('response_type','code')
        url.searchParams.set('scope','openid email https://www.googleapis.com/auth/drive.file');url.searchParams.set('access_type','offline');url.searchParams.set('prompt','consent');url.searchParams.set('state',state)
        return response({ok:true,data:{url:url.toString()}})
      }
      const {data,error}=await admin.from('google_drive_connections').select('id,account_email,created_at,is_primary,disconnected_at').is('disconnected_at',null).order('created_at',{ascending:false})
      if(error)throw error
      return response({ok:true,data:data||[]})
    }

    if (action === 'teacher.homework.list' || action === 'teacher.homework.create' || action === 'teacher.homework.review') {
      if (user.user_type !== 'TEACHER' || !user.linked_id) throw new ApiFault('FORBIDDEN', 'This action is only available to a linked teacher account.')
      if (action === 'teacher.homework.create') {
        const title = requireText(payload.title, 'Title', 150, true)
        const instructions = requireText(payload.instructions, 'Instructions', 5000)
        const batchId = requireText(payload.batchId, 'Batch', 60, true)
        const subjectId = requireText(payload.subjectId, 'Subject', 60)
        const dueText = requireText(payload.dueAt, 'Due date and time', 50, true)
        const dueAt = new Date(dueText)
        if (!Number.isFinite(dueAt.getTime())) throw new ApiFault('BAD_REQUEST', 'Enter a valid due date and time.')
        if (dueAt.getTime() <= Date.now()) throw new ApiFault('BAD_REQUEST', 'The due time must be in the future.')
        const materials = Array.isArray(payload.materials) ? payload.materials.slice(0, 5).map((v: unknown) => {
          const url = requireText(v, 'Material link', 500, true)
          let parsed: URL
          try { parsed = new URL(url) } catch { throw new ApiFault('BAD_REQUEST', 'Material links must be valid http or https URLs.') }
          if (!['http:', 'https:'].includes(parsed.protocol)) throw new ApiFault('BAD_REQUEST', 'Material links must use http or https.')
          return url
        }) : []
        const [{ data: teacher }, { data: slots }, { data: assigned }] = await Promise.all([
          admin.from('teachers').select('id').eq('id', user.linked_id).maybeSingle(),
          admin.from('timetable').select('id,subject_id,co_subject_id').eq('teacher_id', user.linked_id).eq('batch_id', batchId).ilike('status', 'active'),
          admin.from('student_subjects').select('subject_id').eq('teacher_id', user.linked_id).eq('batch_id', batchId).ilike('status', 'active'),
        ])
        if (!teacher) throw new ApiFault('NOT_FOUND', 'Teacher record not found.')
        const allowedSubjects = new Set([...(slots || []).flatMap((s) => [s.subject_id, s.co_subject_id]), ...(assigned || []).map((s) => s.subject_id)])
        if (!(slots || []).length && !(assigned || []).length) throw new ApiFault('FORBIDDEN', 'You are not assigned to this batch.')
        if (subjectId && !allowedSubjects.has(subjectId)) throw new ApiFault('FORBIDDEN', 'You are not assigned to this subject in the selected batch.')
        const id = await newId(admin, 'homework', 'HW-', 5)
        const { error } = await admin.from('homework').insert({ id, teacher_id: user.linked_id, batch_id: batchId,
          subject_id: subjectId || null, title, instructions, materials, due_at: dueAt?.toISOString() || null })
        if (error) throw error
        await logAction(admin, user, 'CREATE_HOMEWORK', 'HOMEWORK', id, { batchId, subjectId, dueAt: dueAt?.toISOString() || null })
        return response({ ok: true, data: { id } })
      }
      if (action === 'teacher.homework.review') {
        const homeworkId = requireText(payload.homeworkId, 'Homework', 60, true)
        const submissionId = requireText(payload.submissionId, 'Submission', 60, true)
        const feedback = requireText(payload.feedback, 'Feedback', 2000)
        const { data: hw, error: hwError } = await admin.from('homework').select('id').eq('id', homeworkId).eq('teacher_id', user.linked_id).maybeSingle()
        if (hwError) throw hwError
        if (!hw) throw new ApiFault('NOT_FOUND', 'Homework not found.')
        const { data: submission, error } = await admin.from('homework_submissions').update({ feedback, status: 'REVIEWED', reviewed_at: new Date().toISOString() })
          .eq('id', submissionId).eq('homework_id', homeworkId).select('id').maybeSingle()
        if (error) throw error
        if (!submission) throw new ApiFault('NOT_FOUND', 'Submission not found.')
        return response({ ok: true, data: { reviewed: true } })
      }
      const { data: rows, error } = await admin.from('homework').select('*').eq('teacher_id', user.linked_id).order('created_at', { ascending: false }).limit(300)
      if (error) throw error
      const list = rows || []
      const batchIds = [...new Set(list.map((x) => x.batch_id))], subjectIds = [...new Set(list.map((x) => x.subject_id).filter(Boolean))]
      const ids = list.map((x) => x.id)
      const [{ data: batches }, { data: subjects }, { data: submissions }] = await Promise.all([
        batchIds.length ? admin.from('batches').select('id,name').in('id', batchIds) : Promise.resolve({ data: [] }),
        subjectIds.length ? admin.from('subjects').select('id,name').in('id', subjectIds) : Promise.resolve({ data: [] }),
        ids.length ? admin.from('homework_submissions').select('*').in('homework_id', ids).order('submitted_at', { ascending: false }) : Promise.resolve({ data: [] }),
      ])
      const studentIds = [...new Set((submissions || []).map((x) => x.student_id))]
      const { data: students } = studentIds.length ? await admin.from('students').select('id,name').in('id', studentIds) : { data: [] }
      const bm = new Map((batches || []).map((x) => [x.id, x.name])), sm = new Map((subjects || []).map((x) => [x.id, x.name])), stm = new Map((students || []).map((x) => [x.id, x.name]))
      const { data: files, error: filesError } = ids.length ? await admin.from('homework_files').select('id,homework_id,submission_id,uploaded_by_type,uploaded_by_id,file_name,mime_type,file_size,archived_at,drive_file_id,archive_error').in('homework_id',ids) : { data: [], error: null }
      if(filesError)throw filesError
      const fileMap = new Map<string, any[]>()
      for(const f of files||[]) fileMap.set(f.submission_id || f.homework_id,[...(fileMap.get(f.submission_id || f.homework_id)||[]),{FileID:f.id,FileName:f.file_name,MimeType:f.mime_type,Size:f.file_size,Archived:!!f.archived_at,ArchiveError:f.archive_error||'',UploaderType:f.uploaded_by_type}])
      const subMap = new Map<string, any[]>()
      for (const row of submissions || []) subMap.set(row.homework_id, [...(subMap.get(row.homework_id) || []), {
        SubmissionID: row.id, StudentID: row.student_id, StudentName: stm.get(row.student_id) || row.student_id,
        Answer: row.answer, AttachmentURL: row.attachment_url, Files:fileMap.get(row.id)||[], Status: row.status, Feedback: row.feedback, SubmittedAt: row.submitted_at }])
      return response({ ok: true, data: list.map((r) => ({ HomeworkID: r.id, Title: r.title, Instructions: r.instructions,
        BatchID: r.batch_id, BatchName: bm.get(r.batch_id) || r.batch_id, SubjectID: r.subject_id || '', SubjectName: sm.get(r.subject_id) || '',
        Materials: Array.isArray(r.materials) ? r.materials : [], DueAt: r.due_at || '', Status: r.status,
        Files:fileMap.get(r.id)||[], Expired: !!r.due_at && new Date(r.due_at).getTime() <= Date.now(), Submissions: subMap.get(r.id) || [] })) })
    }

    if (action === 'teacher.classMaterials.upload' || action === 'teacher.classMaterials.register' || action === 'teacher.classMaterials.list' || action === 'student.classMaterials.list') {
      const now = new Date()
      if (action === 'teacher.classMaterials.upload') {
        if (user.user_type !== 'TEACHER' || !user.linked_id) throw new ApiFault('FORBIDDEN', 'Only a linked teacher can upload class materials.')
        const sessionId = requireText(payload.sessionId, 'Class session', 80, true)
        const fileName = requireText(payload.fileName, 'PDF filename', 180, true).replace(/[\\/\u0000-\u001f]/g, '_')
        const fileSize = Number(payload.fileSize)
        if (!fileName.toLowerCase().endsWith('.pdf') || String(payload.contentType || '').toLowerCase() !== 'application/pdf') throw new ApiFault('BAD_REQUEST', 'Choose a PDF file.')
        if (!Number.isFinite(fileSize) || fileSize < 1 || fileSize > 10 * 1024 * 1024) throw new ApiFault('BAD_REQUEST', 'PDFs must be smaller than 10 MB.')
        const { data: session, error: sessionError } = await admin.from('class_sessions').select('id,teacher_id').eq('id', sessionId).maybeSingle()
        if (sessionError) throw sessionError
        if (!session || session.teacher_id !== user.linked_id) throw new ApiFault('FORBIDDEN', 'You can upload materials only for your own classes.')
        const safeName = fileName.normalize('NFKD').replace(/[^A-Za-z0-9._-]/g, '_').slice(-120) || 'class.pdf'
        const path = `${user.linked_id}/${sessionId}/${crypto.randomUUID()}-${safeName}`
        const { data: signed, error: signError } = await admin.storage.from('class-materials').createSignedUploadUrl(path)
        if (signError || !signed) throw signError || new ApiFault('UPLOAD_FAILED', 'Could not prepare the PDF upload.')
        return response({ ok: true, data: { path, uploadUrl: signed.signedUrl } })
      }
      if (action === 'teacher.classMaterials.register') {
        if (user.user_type !== 'TEACHER' || !user.linked_id) throw new ApiFault('FORBIDDEN', 'Only a linked teacher can register class materials.')
        const sessionId = requireText(payload.sessionId, 'Class session', 80, true)
        const path = requireText(payload.path, 'PDF path', 500, true)
        const fileName = requireText(payload.fileName, 'PDF filename', 180, true)
        const expectedPrefix = `${user.linked_id}/${sessionId}/`
        if (!path.startsWith(expectedPrefix) || path.includes('..') || !fileName.toLowerCase().endsWith('.pdf')) throw new ApiFault('BAD_REQUEST', 'Invalid class PDF upload.')
        const { data: session, error: sessionError } = await admin.from('class_sessions').select('id,teacher_id').eq('id', sessionId).maybeSingle()
        if (sessionError) throw sessionError
        if (!session || session.teacher_id !== user.linked_id) throw new ApiFault('FORBIDDEN', 'You can upload materials only for your own classes.')
        const objectName = path.slice(path.lastIndexOf('/') + 1)
        const { data: files, error: fileError } = await admin.storage.from('class-materials').list(`${user.linked_id}/${sessionId}`, { search: objectName })
        if (fileError) throw fileError
        if (!(files || []).some((file) => file.name === objectName)) throw new ApiFault('UPLOAD_FAILED', 'The PDF upload could not be found. Please retry the upload.')
        const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
        const { error: insertError } = await admin.from('class_materials').insert({ id: `MAT-${crypto.randomUUID()}`, session_id: sessionId,
          teacher_id: user.linked_id, file_path: path, file_name: fileName, created_at: now.toISOString(), expires_at: expiresAt })
        if (insertError) { await admin.storage.from('class-materials').remove([path]); throw insertError }
        return response({ ok: true, data: { expiresAt } })
      }

      let sessionIds: string[] = []
      if (action === 'teacher.classMaterials.list') {
        if (user.user_type !== 'TEACHER' || !user.linked_id) throw new ApiFault('FORBIDDEN', 'Only a linked teacher can view class materials.')
        const sessionId = requireText(payload.sessionId, 'Class session', 80, true)
        const { data: session, error } = await admin.from('class_sessions').select('id,teacher_id').eq('id', sessionId).maybeSingle()
        if (error) throw error
        if (!session || session.teacher_id !== user.linked_id) throw new ApiFault('FORBIDDEN', 'You can view materials only for your own classes.')
        sessionIds = [sessionId]
      } else {
        if (user.user_type !== 'STUDENT' || !user.linked_id) throw new ApiFault('FORBIDDEN', 'Only a linked student can view class materials.')
        const { data: assignments, error: assignmentError } = await admin.from('student_subjects').select('subject_id,batch_id').eq('student_id', user.linked_id).ilike('status', 'active')
        if (assignmentError) throw assignmentError
        const batchIds = [...new Set((assignments || []).map((r) => r.batch_id))]
        if (batchIds.length) {
          const { data: sessions, error } = await admin.from('class_sessions').select('id,batch_id,subject_id,co_subject_id').in('batch_id', batchIds).order('session_date', { ascending: false }).limit(200)
          if (error) throw error
          const assigned = new Set((assignments || []).map((r) => `${r.batch_id}|${r.subject_id}`))
          sessionIds = (sessions || []).filter((s) => [s.subject_id, s.co_subject_id].filter(Boolean).some((subjectId) => assigned.has(`${s.batch_id}|${subjectId}`))).map((s) => s.id)
        }
      }
      if (!sessionIds.length) return response({ ok: true, data: [] })
      const { data: materials, error: materialError } = await admin.from('class_materials').select('id,session_id,file_path,file_name,created_at,expires_at')
        .in('session_id', sessionIds).gt('expires_at', now.toISOString()).order('created_at', { ascending: false }).limit(100)
      if (materialError) throw materialError
      const ids = [...new Set((materials || []).map((m) => m.session_id))]
      const [{ data: sessions, error: sessionsError }, { data: batches }, { data: subjects }] = await Promise.all([
        admin.from('class_sessions').select('id,session_date,start_time,end_time,batch_id,subject_id,co_subject_id').in('id', ids),
        admin.from('batches').select('id,name'), admin.from('subjects').select('id,name'),
      ])
      if (sessionsError) throw sessionsError
      const sm = new Map((subjects || []).map((s) => [s.id, s.name])), bm = new Map((batches || []).map((b) => [b.id, b.name]))
      return response({ ok: true, data: await Promise.all((materials || []).map(async (m) => {
        const secondsLeft = Math.max(1, Math.min(3600, Math.ceil((new Date(m.expires_at).getTime() - now.getTime()) / 1000)))
        const { data: signed, error } = await admin.storage.from('class-materials').createSignedUrl(m.file_path, secondsLeft, { download: m.file_name })
        if (error) throw error
        const session = (sessions || []).find((s) => s.id === m.session_id)
        return { MaterialID: m.id, SessionID: m.session_id, FileName: m.file_name, CreatedAt: m.created_at, ExpiresAt: m.expires_at,
          URL: signed.signedUrl, Date: session?.session_date || '', StartTime: session?.start_time || '', EndTime: session?.end_time || '',
          BatchName: bm.get(session?.batch_id) || '', SubjectName: [session?.subject_id, session?.co_subject_id].filter(Boolean).map((id) => sm.get(id) || id).join(' + ') }
      })) })
    }

    if (action === 'student.homework.list' || action === 'student.homework.submit') {
      if (user.user_type !== 'STUDENT' || !user.linked_id) throw new ApiFault('FORBIDDEN', 'This action is only available to a linked student account.')
      const { data: student, error: studentError } = await admin.from('students').select('id,current_batch_id').eq('id', user.linked_id).maybeSingle()
      if (studentError) throw studentError
      if (!student) throw new ApiFault('NOT_FOUND', 'Student record not found.')
      const { data: assigned } = await admin.from('student_subjects').select('batch_id').eq('student_id', student.id).ilike('status', 'active')
      const batchIds = [...new Set([student.current_batch_id, ...(assigned || []).map((x) => x.batch_id)].filter(Boolean))]
      if (action === 'student.homework.submit') {
        const homeworkId = requireText(payload.homeworkId, 'Homework', 60, true)
        const answer = requireText(payload.answer, 'Answer', 5000)
        const attachmentUrl = requireText(payload.attachmentUrl, 'Attachment link', 500, false)
        if (!answer && !attachmentUrl && !payload.hasFiles) throw new ApiFault('BAD_REQUEST', 'Write an answer, provide a submission link, or attach a file.')
        if (attachmentUrl) { let url: URL; try { url = new URL(attachmentUrl) } catch { throw new ApiFault('BAD_REQUEST', 'Submission link must be a valid http or https URL.') }; if (!['http:', 'https:'].includes(url.protocol)) throw new ApiFault('BAD_REQUEST', 'Submission links must use http or https.') }
        const { data: hw, error } = await admin.from('homework').select('id,due_at,batch_id,status').eq('id', homeworkId).eq('status', 'Active').maybeSingle()
        if (error) throw error
        if (!hw || !batchIds.includes(hw.batch_id)) throw new ApiFault('NOT_FOUND', 'Homework not found for your class.')
        if (hw.due_at && new Date(hw.due_at).getTime() <= Date.now()) throw new ApiFault('EXPIRED', 'The homework deadline has passed; submissions are closed.')
        const { data: prior } = await admin.from('homework_submissions').select('id').eq('homework_id', homeworkId).eq('student_id', student.id).maybeSingle()
        const values = { answer, attachment_url: attachmentUrl, status: 'SUBMITTED', feedback: '', submitted_at: new Date().toISOString(), reviewed_at: null }
        const result = prior
          ? await admin.from('homework_submissions').update(values).eq('id', prior.id).select('id').single()
          : await admin.from('homework_submissions').insert({ id: `HWS-${crypto.randomUUID()}`, homework_id: homeworkId, student_id: student.id, ...values }).select('id').single()
        if (result.error) throw result.error
        return response({ ok: true, data: { submitted: true } })
      }
      const { data: rows, error } = batchIds.length
        ? await admin.from('homework').select('*').in('batch_id', batchIds).eq('status', 'Active').order('due_at', { ascending: true }).limit(500)
        : { data: [], error: null }
      if (error) throw error
      const currentRows = (rows || []).filter((x) => !x.due_at || new Date(x.due_at).getTime() > Date.now())
      const ids = currentRows.map((x) => x.id)
      const { data: submissions } = ids.length ? await admin.from('homework_submissions').select('*').eq('student_id', student.id).in('homework_id', ids) : { data: [] }
      const subMap = new Map((submissions || []).map((x) => [x.homework_id, x]))
      const submissionIds=(submissions||[]).map((x)=>x.id)
      const {data: studentFiles,error:studentFilesError}=submissionIds.length?await admin.from('homework_files').select('id,homework_id,submission_id,file_name,mime_type,file_size,archived_at,archive_error').in('submission_id',submissionIds):{data:[],error:null}
      if(studentFilesError)throw studentFilesError
      const studentFileMap=new Map<string,any[]>()
      for(const f of studentFiles||[])studentFileMap.set(f.homework_id,[...(studentFileMap.get(f.homework_id)||[]),{FileID:f.id,FileName:f.file_name,MimeType:f.mime_type,Size:f.file_size,Archived:!!f.archived_at,ArchiveError:f.archive_error||''}])
      const {data: assignmentFiles,error:assignmentFilesError}=ids.length?await admin.from('homework_files').select('id,homework_id,file_name,mime_type,file_size,archived_at,archive_error').in('homework_id',ids).eq('uploaded_by_type','TEACHER').is('submission_id',null):{data:[],error:null}
      if(assignmentFilesError)throw assignmentFilesError
      const assignmentFileMap=new Map<string,any[]>()
      for(const f of assignmentFiles||[])assignmentFileMap.set(f.homework_id,[...(assignmentFileMap.get(f.homework_id)||[]),{FileID:f.id,FileName:f.file_name,MimeType:f.mime_type,Size:f.file_size,Archived:!!f.archived_at,ArchiveError:f.archive_error||''}])
      const teacherIds = [...new Set(currentRows.map((x) => x.teacher_id))], subjectIds = [...new Set(currentRows.map((x) => x.subject_id).filter(Boolean))]
      const [{ data: teachers }, { data: subjects }, { data: batches }] = await Promise.all([
        teacherIds.length ? admin.from('teachers').select('id,name').in('id', teacherIds) : Promise.resolve({ data: [] }),
        subjectIds.length ? admin.from('subjects').select('id,name').in('id', subjectIds) : Promise.resolve({ data: [] }),
        batchIds.length ? admin.from('batches').select('id,name').in('id', batchIds) : Promise.resolve({ data: [] }),
      ])
      const tm = new Map((teachers || []).map((x) => [x.id, x.name])), sm = new Map((subjects || []).map((x) => [x.id, x.name])), bm = new Map((batches || []).map((x) => [x.id, x.name]))
      return response({ ok: true, data: currentRows.map((r) => { const sub = subMap.get(r.id); return { HomeworkID: r.id, Title: r.title,
        Instructions: r.instructions, WorksheetID: r.worksheet_id || '', TeacherName: tm.get(r.teacher_id) || '', SubjectName: sm.get(r.subject_id) || '', BatchName: bm.get(r.batch_id) || '',
        Materials: Array.isArray(r.materials) ? r.materials : [], Files:assignmentFileMap.get(r.id)||[], DueAt: r.due_at || '', Submission: sub ? { Answer: sub.answer,
          AttachmentURL: sub.attachment_url, Files:studentFileMap.get(r.id)||[], Status: sub.status, Feedback: sub.feedback, SubmittedAt: sub.submitted_at } : null } }) })
    }

    if (action === 'subjects.list') {
      const { data, error } = await admin.from('subjects').select('*').order('name')
      if (error) throw error
      return response({ ok: true, data: (data || []).map((r) => ({ SubjectID: r.id, SubjectName: r.name, Status: r.status })) })
    }

    if (action === 'settings.get') {
      const { data, error } = await admin.from('settings').select('*').order('setting_key')
      if (error) throw error
      return response({ ok: true, data: (data || []).filter((r) => !String(r.setting_key).startsWith('PUBLIC_LANDING_NOTICE_') && r.setting_key !== 'STUDENT_DELETE_ENABLED').map((r) => ({ key: r.setting_key, value: r.value,
        description: r.description, updatedAt: r.updated_at, updatedBy: r.updated_by })) })
    }

    if (action === 'batches.list') {
      const { data, error } = await admin.from('batches').select('*').order('name')
      if (error) throw error
      return response({ ok: true, data: (data || []).map((r) => ({ BatchID: r.id, BatchName: r.name,
        Class: r.class, Section: r.section, AcademicYear: r.academic_year, Status: r.status })) })
    }

    if (action === 'rooms.list') {
      const { data, error } = await admin.from('rooms').select('*').order('name')
      if (error) throw error
      return response({ ok: true, data: (data || []).map((r) => ({ RoomID: r.id, RoomName: r.name,
        Capacity: r.capacity, Status: r.status })) })
    }

    if (action === 'timetable.list') {
      let query = admin.from('timetable').select('*').order('day').order('start_time')
      if (payload.day) query = query.eq('day', String(payload.day).toUpperCase())
      if (payload.batchId) query = query.eq('batch_id', String(payload.batchId))
      if (payload.teacherId) query = query.eq('teacher_id', String(payload.teacherId))
      const { data, error } = await query
      if (error) throw error
      const [{ data: batches }, { data: subjects }, { data: teachers }, { data: rooms }] = await Promise.all([
        admin.from('batches').select('id,name'), admin.from('subjects').select('id,name'),
        admin.from('teachers').select('id,name'), admin.from('rooms').select('id,name'),
      ])
      const names = (rows: Array<Record<string, string>> | null) => new Map((rows || []).map((r) => [r.id, r.name]))
      const batchNames = names(batches), subjectNames = names(subjects), teacherNames = names(teachers), roomNames = names(rooms)
      return response({ ok: true, data: (data || []).map((r) => ({ TimetableID: r.id, Day: r.day,
        StartTime: String(r.start_time).slice(0, 5), EndTime: String(r.end_time).slice(0, 5), BatchID: r.batch_id,
        BatchName: batchNames.get(r.batch_id) || r.batch_id, SubjectID: r.subject_id,
        SubjectName: subjectNames.get(r.subject_id) || r.subject_id,
        CoSubjectID: r.co_subject_id || '', CoSubjectName: r.co_subject_id ? subjectNames.get(r.co_subject_id) || r.co_subject_id : '', TeacherID: r.teacher_id,
        TeacherName: teacherNames.get(r.teacher_id) || r.teacher_id, RoomID: r.room_id || '',
        RoomName: r.room_id ? roomNames.get(r.room_id) || r.room_id : '', Status: r.status })) })
    }

    if (action === 'timetable.add' || action === 'timetable.update') {
      const isUpdate = action.endsWith('.update')
      const input = isUpdate ? payload.changes : payload.item
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiFault('BAD_REQUEST', 'Provide the timetable fields.')
      const map: Record<string, string> = { Day: 'day', StartTime: 'start_time', EndTime: 'end_time', BatchID: 'batch_id',
        SubjectID: 'subject_id', CoSubjectID: 'co_subject_id', TeacherID: 'teacher_id', RoomID: 'room_id', Status: 'status' }
      const allowed = isUpdate ? Object.keys(map) : Object.keys(map).filter((x) => x !== 'Status')
      const row: Record<string, unknown> = {}
      for (const [key, raw] of Object.entries(input)) {
        if (!allowed.includes(key)) throw new ApiFault('BAD_REQUEST', `Unknown timetable field: ${key}`)
        const column = map[key]
        if (key === 'Day') {
          const day = requireText(raw, key, 12, true).toUpperCase()
          if (!['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY','SUNDAY'].includes(day)) throw new ApiFault('BAD_REQUEST', 'Choose a valid day.')
          row[column] = day
        } else if (key === 'StartTime' || key === 'EndTime') {
          const time = requireText(raw, key, 8, true)
          if (!/^\d{2}:\d{2}(:\d{2})?$/.test(time)) throw new ApiFault('BAD_REQUEST', `${key} must be a valid time.`)
          row[column] = time.length === 5 ? `${time}:00` : time
        } else if (key === 'Status') {
          const status = requireText(raw, key, 10, true)
          if (!['Active', 'Inactive'].includes(status)) throw new ApiFault('BAD_REQUEST', 'Status must be Active or Inactive.')
          row[column] = status
        } else {
          const value = requireText(raw, key, 50, !['RoomID', 'CoSubjectID'].includes(key))
          row[column] = ['RoomID', 'CoSubjectID'].includes(key) && !value ? null : value
        }
      }
      const id = isUpdate ? requireText(payload.id, 'Timetable ID', 40, true) : await newId(admin, 'timetable', 'TT-', 4)
      let before: Record<string, unknown> = {}
      if (isUpdate) {
        const { data: existing, error } = await admin.from('timetable').select('*').eq('id', id).maybeSingle()
        if (error) throw error
        if (!existing) throw new ApiFault('NOT_FOUND', 'Timetable entry not found.')
        before = existing
      }
      const merged = { ...before, ...row }
      for (const key of ['day','start_time','end_time','batch_id','subject_id','teacher_id']) if (!merged[key]) throw new ApiFault('BAD_REQUEST', `${key} is required.`)
      if (String(merged.end_time) <= String(merged.start_time)) throw new ApiFault('BAD_REQUEST', 'End time must be after start time.')
      const [{ data: batch }, { data: subject }, { data: teacherRow }, { data: room }, { data: coSubject }] = await Promise.all([
        admin.from('batches').select('id,status').eq('id', merged.batch_id).maybeSingle(),
        admin.from('subjects').select('id,name,status').eq('id', merged.subject_id).maybeSingle(),
        admin.from('teachers').select('id,status').eq('id', merged.teacher_id).maybeSingle(),
        merged.room_id ? admin.from('rooms').select('id,status').eq('id', merged.room_id).maybeSingle() : Promise.resolve({ data: null }),
        merged.co_subject_id ? admin.from('subjects').select('id,name,status').eq('id', merged.co_subject_id).maybeSingle() : Promise.resolve({ data: null }),
      ])
      if (!batch || batch.status !== 'Active' || !subject || subject.status !== 'Active' || !teacherRow || teacherRow.status !== 'Active') throw new ApiFault('BAD_REQUEST', 'Choose active batch, subject and teacher records.')
      if (merged.room_id && (!room || room.status !== 'Active')) throw new ApiFault('BAD_REQUEST', 'Choose an active room.')
      if (merged.co_subject_id) {
        if (!coSubject || coSubject.status !== 'Active' || coSubject.id === subject.id) throw new ApiFault('BAD_REQUEST', 'Choose a different active second subject.')
        const rawNames = [String(subject.name), String(coSubject.name)]
        const pair = rawNames.map((n) => n.toLowerCase().replace(/[^a-z0-9]+/g, ''))
        const computerPair = pair.some((n) => n.includes('computerscience')) && pair.some((n) => n.includes('computerapplication'))
        const hasStandaloneMath = pair.some((n) => n === 'math' || n === 'mathematics')
        const hasWbjeeMath = rawNames.some((n) => /wbjee|math_/i.test(n))
        const wbjeePair = hasStandaloneMath && hasWbjeeMath
        if (!computerPair && !wbjeePair) throw new ApiFault('BAD_REQUEST', 'Combined classes are limited to Computer Science + Computer Application or Math + WBJEE Math.')
      }
      if (String(merged.status || 'Active') === 'Active') {
        const { data: peers, error } = await admin.from('timetable').select('id,day,start_time,end_time,batch_id,teacher_id,room_id,status').eq('day', merged.day).eq('status', 'Active')
        if (error) throw error
        const conflict = (peers || []).find((p) => p.id !== id && String(merged.start_time) < String(p.end_time) && String(merged.end_time) > String(p.start_time) &&
          (p.teacher_id === merged.teacher_id || p.batch_id === merged.batch_id || (!!merged.room_id && p.room_id === merged.room_id)))
        if (conflict) throw new ApiFault('CONFLICT', 'This time overlaps another class for the same teacher, batch or room.')
      }
      if (!isUpdate) {
        const { data: setting } = await admin.from('settings').select('value').eq('setting_key', 'ACADEMIC_YEAR').maybeSingle()
        row.id = id; row.academic_year = setting?.value || '2026-27'; row.status = 'Active'
      }
      const { data: saved, error } = isUpdate
        ? await admin.from('timetable').update(row).eq('id', id).select('*').single()
        : await admin.from('timetable').insert(row).select('*').single()
      if (error) throw error
      await logAction(admin, user, isUpdate ? 'EDIT_TIMETABLE' : 'ADD_TIMETABLE', 'TIMETABLE', id, row)
      return response({ ok: true, data: { TimetableID: saved.id, Day: saved.day, StartTime: String(saved.start_time).slice(0, 5),
        EndTime: String(saved.end_time).slice(0, 5), BatchID: saved.batch_id, SubjectID: saved.subject_id, CoSubjectID: saved.co_subject_id || '',
        TeacherID: saved.teacher_id, RoomID: saved.room_id || '', Status: saved.status } })
    }

    if (action === 'timetable.setStatus') {
      const id = requireText(payload.id, 'Timetable ID', 40, true)
      const status = requireText(payload.status, 'Status', 10, true)
      if (!['Active', 'Inactive'].includes(status)) throw new ApiFault('BAD_REQUEST', 'Status must be Active or Inactive.')
      const { data, error } = await admin.from('timetable').update({ status }).eq('id', id).select('id').maybeSingle()
      if (error) throw error
      if (!data) throw new ApiFault('NOT_FOUND', 'Timetable entry not found.')
      await logAction(admin, user, 'SET_TIMETABLE_STATUS', 'TIMETABLE', id, { status })
      return response({ ok: true, data: { id, status } })
    }

    if (action === 'notices.adminList') {
      const { data, error } = await admin.from('notices').select('*').order('posted_at', { ascending: false }).limit(500)
      if (error) throw error
      const [{ data: batches }, { data: publicSettings, error: publicSettingsError }] = await Promise.all([
        admin.from('batches').select('id,name'), admin.from('settings').select('setting_key,value'),
      ])
      if (publicSettingsError) throw publicSettingsError
      const batchNames = new Map((batches || []).map((b) => [b.id, b.name]))
      const publicIds = new Set((publicSettings || []).filter((r) => String(r.setting_key).startsWith('PUBLIC_LANDING_NOTICE_') && String(r.value).toUpperCase() === 'TRUE')
        .map((r) => String(r.setting_key).slice('PUBLIC_LANDING_NOTICE_'.length)))
      return response({ ok: true, data: (data || []).map((r) => ({ NoticeID: r.id, Title: r.title, Body: r.body,
        Audience: r.audience, BatchID: r.batch_id || '', BatchName: r.batch_id ? batchNames.get(r.batch_id) || '' : '',
        PostedBy: r.posted_by, PostedAt: r.posted_at, ExpiresAt: r.expires_at || '', Status: r.status,
        ShowOnLandingPage: publicIds.has(r.id) && r.audience === 'ALL' })) })
    }

    if (action === 'notices.add' || action === 'notices.update') {
      const isUpdate = action.endsWith('.update')
      const input = isUpdate ? payload.changes : payload.item
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiFault('BAD_REQUEST', 'Provide the notice fields.')
      const map: Record<string, string> = { Title: 'title', Body: 'body', Audience: 'audience', BatchID: 'batch_id', ExpiresAt: 'expires_at', Status: 'status' }
      const allowed = Object.keys(map)
      const row: Record<string, unknown> = {}
      let showOnLandingPage: boolean | null = null
      for (const [key, raw] of Object.entries(input)) {
        if (key === 'ShowOnLandingPage') {
          const selected = requireText(raw, key, 5, true).toUpperCase()
          if (!['TRUE', 'FALSE'].includes(selected)) throw new ApiFault('BAD_REQUEST', 'ShowOnLandingPage must be TRUE or FALSE.')
          showOnLandingPage = selected === 'TRUE'
          continue
        }
        if (!allowed.includes(key)) throw new ApiFault('BAD_REQUEST', `Unknown notice field: ${key}`)
        if (key === 'Audience') {
          const audience = requireText(raw, key, 20, true).toUpperCase()
          if (!['STUDENTS','TEACHERS','BATCH','ALL'].includes(audience)) throw new ApiFault('BAD_REQUEST', 'Choose a valid audience.')
          row.audience = audience
        } else if (key === 'Status') {
          const status = requireText(raw, key, 10, true)
          if (!['Active','Inactive'].includes(status)) throw new ApiFault('BAD_REQUEST', 'Status must be Active or Inactive.')
          row.status = status
        } else if (key === 'ExpiresAt') {
          const date = requireText(raw, key, 10)
          if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiFault('BAD_REQUEST', 'ExpiresAt must use yyyy-mm-dd.')
          row.expires_at = date || null
        } else if (key === 'BatchID') {
          const id = requireText(raw, key, 40)
          row.batch_id = id || null
        } else row[map[key]] = requireText(raw, key, key === 'Title' ? 150 : 10000, true)
      }
      const id = isUpdate ? requireText(payload.id, 'Notice ID', 40, true) : await newId(admin, 'notices', 'N-', 4)
      const merged = { audience: 'ALL', batch_id: null, ...row }
      if (isUpdate) {
        const { data: old, error } = await admin.from('notices').select('id,audience,batch_id').eq('id', id).maybeSingle()
        if (error) throw error
        if (!old) throw new ApiFault('NOT_FOUND', 'Notice not found.')
        Object.assign(merged, old, row)
      }
      if (merged.audience === 'BATCH' && !merged.batch_id) throw new ApiFault('BAD_REQUEST', 'Choose a batch for a batch notice.')
      if (showOnLandingPage === true && merged.audience !== 'ALL') throw new ApiFault('BAD_REQUEST', 'Only notices for Everyone can be shown on the public landing page.')
      if (merged.audience === 'BATCH') {
        const { data: batch } = await admin.from('batches').select('id,status').eq('id', merged.batch_id).maybeSingle()
        if (!batch || batch.status !== 'Active') throw new ApiFault('BAD_REQUEST', 'Choose an active batch for this notice.')
      }
      if (merged.audience !== 'BATCH' && 'audience' in row && !('batch_id' in row)) row.batch_id = null
      if (!isUpdate) {
        const { data: setting } = await admin.from('settings').select('value').eq('setting_key', 'ACADEMIC_YEAR').maybeSingle()
        row.id = id; row.posted_by = user.id; row.academic_year = setting?.value || '2026-27'; row.status = row.status || 'Active'
      }
      const { data: saved, error } = isUpdate
        ? await admin.from('notices').update(row).eq('id', id).select('*').single()
        : await admin.from('notices').insert(row).select('*').single()
      if (error) throw error
      if (showOnLandingPage !== null) {
        const { error: publicFlagError } = await admin.from('settings').upsert({
          setting_key: `PUBLIC_LANDING_NOTICE_${id}`, value: showOnLandingPage ? 'TRUE' : 'FALSE',
          description: 'Whether notice ' + id + ' is shown on the public landing page.', updated_at: new Date().toISOString(), updated_by: user.id,
        }, { onConflict: 'setting_key' })
        if (publicFlagError) throw publicFlagError
      }
      await logAction(admin, user, isUpdate ? 'EDIT_NOTICE' : 'ADD_NOTICE', 'NOTICE', id, row)
      return response({ ok: true, data: { NoticeID: saved.id, Title: saved.title, Body: saved.body, Audience: saved.audience,
        BatchID: saved.batch_id || '', PostedAt: saved.posted_at, ExpiresAt: saved.expires_at || '', Status: saved.status,
        ShowOnLandingPage: showOnLandingPage === true && saved.audience === 'ALL' } })
    }

    if (action === 'notices.setStatus') {
      const id = requireText(payload.id, 'Notice ID', 40, true)
      const status = requireText(payload.status, 'Status', 10, true)
      if (!['Active','Inactive'].includes(status)) throw new ApiFault('BAD_REQUEST', 'Status must be Active or Inactive.')
      const { data, error } = await admin.from('notices').update({ status }).eq('id', id).select('id').maybeSingle()
      if (error) throw error
      if (!data) throw new ApiFault('NOT_FOUND', 'Notice not found.')
      await logAction(admin, user, 'SET_NOTICE_STATUS', 'NOTICE', id, { status })
      return response({ ok: true, data: { id, status } })
    }

    if (action === 'notices.list' || action === 'teacher.notices') {
      const today = todayDate()
      const { data: all, error } = await admin.from('notices').select('*').eq('status', 'Active').order('posted_at', { ascending: false }).limit(300)
      if (error) throw error
      let linkedBatches = new Set<string>()
      if (user.user_type === 'STUDENT' && user.linked_id) {
        const { data: student } = await admin.from('students').select('current_batch_id').eq('id', user.linked_id).maybeSingle()
        if (student?.current_batch_id) linkedBatches.add(student.current_batch_id)
      } else if (user.user_type === 'TEACHER' && user.linked_id) {
        const [{ data: timetableRows }, { data: assignedRows }] = await Promise.all([
          admin.from('timetable').select('batch_id').eq('teacher_id', user.linked_id).eq('status', 'Active'),
          admin.from('student_subjects').select('batch_id').eq('teacher_id', user.linked_id).eq('status', 'ACTIVE'),
        ])
        for (const row of [...(timetableRows || []), ...(assignedRows || [])]) if (row.batch_id) linkedBatches.add(row.batch_id)
      }
      const eligible = (all || []).filter((n) => (!n.expires_at || n.expires_at >= today) &&
        (n.audience === 'ALL' || (user.user_type === 'STUDENT' && n.audience === 'STUDENTS') ||
          (user.user_type === 'TEACHER' && n.audience === 'TEACHERS') || (n.audience === 'BATCH' && linkedBatches.has(n.batch_id))))
      const { data: batches } = await admin.from('batches').select('id,name')
      const batchNames = new Map((batches || []).map((b) => [b.id, b.name]))
      return response({ ok: true, data: eligible.slice(0, 100).map((r) => ({ NoticeID: r.id, Title: r.title, Body: r.body,
        Audience: r.audience, BatchID: r.batch_id || '', BatchName: r.batch_id ? batchNames.get(r.batch_id) || '' : '',
        PostedAt: r.posted_at, ExpiresAt: r.expires_at || '' })) })
    }

    if (action === 'teachers.list') {
      const { data, error } = await admin.from('teachers').select('*').order('name')
      if (error) throw error
      return response({ ok: true, data: (data || []).map(legacyTeacher) })
    }

    if (action === 'teachers.add') {
      const input = payload.teacher && typeof payload.teacher === 'object' && !Array.isArray(payload.teacher) ? payload.teacher : null
      if (!input) throw new ApiFault('BAD_REQUEST', 'Provide the teacher details.')
      const username = requireText(input.Username, 'Username', 30, true)
      if (!/^[A-Za-z0-9._-]{3,30}$/.test(username)) throw new ApiFault('BAD_REQUEST', 'Username must be 3–30 letters, numbers, dots, dashes or underscores.')
      const { data: duplicateUser } = await admin.from('app_users').select('id').ilike('username', username).maybeSingle()
      if (duplicateUser) throw new ApiFault('DUPLICATE', 'That username is already taken.')
      const fields = { ...input }; delete fields.Username
      const row = validateTeacherInput(fields, false)
      const granted = permissionsFor(user)
      if (('income_method' in row || 'default_rate_per_student' in row) && !granted.includes('*') && !granted.includes('TEACHER_INCOME_MANAGE')) throw new ApiFault('FORBIDDEN', 'You cannot change teacher pay settings.')
      if ('income_visible_to_teacher' in row && !granted.includes('*') && !granted.includes('TEACHER_INCOME_GRANT')) throw new ApiFault('FORBIDDEN', 'You cannot change teacher income visibility.')
      const id = await newId(admin, 'teachers', 'T-')
      const tempPassword = payload.password ? String(payload.password) : passwordTemp()
      if (tempPassword.length < 8 || tempPassword.length > 200) throw new ApiFault('BAD_PASSWORD', 'Password must be at least 8 characters.')
      const { data: created, error: authCreateError } = await admin.auth.admin.createUser({ email: authEmailForUsername(username), password: tempPassword, email_confirm: true })
      if (authCreateError || !created.user) throw new ApiFault('ACCOUNT_CREATE_FAILED', 'Could not create the teacher login account.')
      const now = new Date().toISOString()
      const teacherRow: Record<string, unknown> = { id, username, status: 'Active', photo_url: '', mobile: '', email: '', address: '', qualification: '',
        joining_date: now.slice(0, 10), income_method: 'PER_STUDENT_MONTH', default_rate_per_student: 0,
        income_visible_to_teacher: false, ...row, created_at: now, updated_at: now }
      const { error: teacherError } = await admin.from('teachers').insert(teacherRow)
      if (teacherError) { await admin.auth.admin.deleteUser(created.user.id); if (teacherError.code === '23505') throw new ApiFault('DUPLICATE', 'A teacher with these details already exists.'); throw teacherError }
      const { error: linkError } = await admin.from('app_users').insert({ auth_user_id: created.user.id, username,
        user_type: 'TEACHER', role: 'TEACHER', linked_id: id, status: 'Active', must_change_password: !payload.password })
      if (linkError) {
        await admin.from('teachers').delete().eq('id', id); await admin.auth.admin.deleteUser(created.user.id)
        if (linkError.code === '23505') throw new ApiFault('DUPLICATE', 'That username is already taken.')
        throw linkError
      }
      await logAction(admin, user, 'ADD_TEACHER', 'TEACHER', id, { name: teacherRow.name, username })
      return response({ ok: true, data: { teacherId: id, username, tempPassword: !payload.password ? tempPassword : undefined } })
    }

    if (action === 'teachers.update') {
      const id = requireText(payload.teacherId, 'Teacher ID', 40, true)
      const changes = payload.changes && typeof payload.changes === 'object' && !Array.isArray(payload.changes) ? validateTeacherInput(payload.changes, true) : {}
      if (!Object.keys(changes).length) throw new ApiFault('BAD_REQUEST', 'Nothing to update.')
      const granted = permissionsFor(user)
      if (('income_method' in changes || 'default_rate_per_student' in changes) && !granted.includes('*') && !granted.includes('TEACHER_INCOME_MANAGE')) throw new ApiFault('FORBIDDEN', 'You cannot change teacher pay settings.')
      if ('income_visible_to_teacher' in changes && !granted.includes('*') && !granted.includes('TEACHER_INCOME_GRANT')) throw new ApiFault('FORBIDDEN', 'You cannot change teacher income visibility.')
      const { data: oldTeacher, error: readError } = await admin.from('teachers').select('*').eq('id', id).maybeSingle()
      if (readError) throw readError
      if (!oldTeacher) throw new ApiFault('NOT_FOUND', 'Teacher not found.')
      changes.updated_at = new Date().toISOString()
      const { error } = await admin.from('teachers').update(changes).eq('id', id)
      if (error) throw error
      if ('status' in changes) await admin.from('app_users').update({ status: changes.status }).eq('user_type', 'TEACHER').eq('linked_id', id)
      await logAction(admin, user, 'EDIT_TEACHER', 'TEACHER', id, changes)
      return response({ ok: true, data: { changed: Object.keys(changes).filter((x) => x !== 'updated_at') } })
    }

    if (action === 'users.list') {
      const { data, error } = await admin.from('app_users').select('id,username,user_type,role,linked_id,status,must_change_password,extra_permissions,last_login,last_logout,created_at').order('username')
      if (error) throw error
      return response({ ok: true, data: (data || []).map((r) => ({ UserID: r.id, Username: r.username,
        UserType: r.user_type, Role: r.role, LinkedID: r.linked_id, Status: r.status,
        MustChangePassword: r.must_change_password, ExtraPermissions: r.extra_permissions,
        LastLogin: r.last_login, LastLogout: r.last_logout, CreatedDate: r.created_at })) })
    }

    if (action === 'users.createAdmin') {
      const username = requireText(payload.username, 'Username', 30, true)
      if (!/^[A-Za-z0-9._-]{3,30}$/.test(username)) throw new ApiFault('BAD_REQUEST', 'Username must be 3–30 letters, numbers, dots, dashes or underscores.')
      const { data: duplicate } = await admin.from('app_users').select('id').ilike('username', username).maybeSingle()
      if (duplicate) throw new ApiFault('DUPLICATE', `Username "${username}" is already taken.`)
      const tempPassword = payload.password ? String(payload.password) : passwordTemp()
      if (tempPassword.length < 8 || tempPassword.length > 200) throw new ApiFault('BAD_PASSWORD', 'Password must be at least 8 characters.')
      const { data: created, error: authCreateError } = await admin.auth.admin.createUser({ email: authEmailForUsername(username), password: tempPassword, email_confirm: true })
      if (authCreateError || !created.user) throw new ApiFault('ACCOUNT_CREATE_FAILED', 'Could not create the admin login account.')
      const { data: appUser, error } = await admin.from('app_users').insert({ auth_user_id: created.user.id, username,
        user_type: 'ADMIN', role: 'ACCOUNTS_ADMIN', status: 'Active', must_change_password: !payload.password }).select('id').single()
      if (error) {
        await admin.auth.admin.deleteUser(created.user.id)
        if (error.code === '23505') throw new ApiFault('DUPLICATE', `Username "${username}" is already taken.`)
        throw error
      }
      await logAction(admin, user, 'CREATE_ADMIN', 'USER', appUser.id, { username, role: 'ACCOUNTS_ADMIN' })
      return response({ ok: true, data: { userId: appUser.id, username, role: 'ACCOUNTS_ADMIN', tempPassword: !payload.password ? tempPassword : undefined } })
    }

    if (action === 'users.setStatus') {
      const id = requireText(payload.userId, 'User ID', 60, true)
      if (id === user.id) throw new ApiFault('BAD_REQUEST', 'You cannot change your own status.')
      const status = requireText(payload.status, 'Status', 20, true)
      if (!['Active', 'Inactive'].includes(status)) throw new ApiFault('BAD_REQUEST', 'Status must be Active or Inactive.')
      const { data: target, error: targetError } = await admin.from('app_users').select('id,username,user_type,role').eq('id', id).maybeSingle()
      if (targetError) throw targetError
      if (!target) throw new ApiFault('NOT_FOUND', 'User not found.')
      if (target.role === 'SUPER_ADMIN') throw new ApiFault('BAD_REQUEST', 'The Super Admin account cannot be changed here.')
      const { error } = await admin.from('app_users').update({ status }).eq('id', id)
      if (error) throw error
      await logAction(admin, user, status === 'Inactive' && target.user_type === 'ADMIN' ? 'DISABLE_ADMIN' : 'SET_USER_STATUS', 'USER', id, { username: target.username, status })
      return response({ ok: true, data: { userId: id, status } })
    }

    if (action === 'users.resetPassword') {
      const id = requireText(payload.userId, 'User ID', 60, true)
      const { data: target, error: lookupError } = await admin.from('app_users').select('id,auth_user_id,username').eq('id', id).maybeSingle()
      if (lookupError) throw lookupError
      if (!target?.auth_user_id) throw new ApiFault('NOT_FOUND', 'User login account was not found.')
      const { data: authTarget } = await admin.auth.admin.getUserById(target.auth_user_id)
      const email = authTarget.user?.email
      if (!email) throw new ApiFault('NOT_FOUND', 'User login account was not found.')
      const tempPassword = payload.password ? String(payload.password) : passwordTemp()
      if (tempPassword.length < 8 || tempPassword.length > 200) throw new ApiFault('BAD_PASSWORD', 'Password must be at least 8 characters.')
      await revokeUserPasskeys(admin, target.auth_user_id)
      const { error } = await admin.auth.admin.updateUserById(target.auth_user_id, { password: tempPassword })
      if (error) throw new ApiFault('PASSWORD_UPDATE_FAILED', 'Could not reset this password.')
      const { error: appUserUpdateError } = await admin.from('app_users').update({ must_change_password: true, password_changed_at: new Date().toISOString() }).eq('id', id)
      if (appUserUpdateError) throw appUserUpdateError
      const sessionsRevoked = await revokeUserSessions(auth, admin, email, tempPassword)
      await logAction(admin, user, 'RESET_PASSWORD', 'USER', id, { username: target.username })
      return response({ ok: true, data: { username: target.username, tempPassword, sessionsRevoked } })
    }

    if (action === 'users.setPermissions') {
      const id = requireText(payload.userId, 'User ID', 60, true)
      if (!Array.isArray(payload.extraPermissions)) throw new ApiFault('BAD_REQUEST', 'extraPermissions must be a list.')
      const allowedPermissions = new Set<string>(Object.keys(PERMISSION_LABELS))
      const extra: string[] = [...new Set((payload.extraPermissions as unknown[]).map((x: unknown) => String(x)))]
      const invalid = extra.find((x) => !allowedPermissions.has(x))
      if (invalid) throw new ApiFault('BAD_REQUEST', `Unknown permission: ${invalid}`)
      const { data: target, error: lookupError } = await admin.from('app_users').select('id,username,role').eq('id', id).maybeSingle()
      if (lookupError) throw lookupError
      if (!target) throw new ApiFault('NOT_FOUND', 'User not found.')
      if (target.role === 'SUPER_ADMIN') throw new ApiFault('BAD_REQUEST', 'Super Admin already has every permission.')
      const { error } = await admin.from('app_users').update({ extra_permissions: extra }).eq('id', id)
      if (error) throw error
      await logAction(admin, user, 'CHANGE_PERMISSIONS', 'USER', id, { username: target.username, extra })
      return response({ ok: true, data: { userId: id, extraPermissions: extra } })
    }

    if (action === 'logs.list') {
      const limit = Math.min(Math.max(Number.parseInt(payload.limit, 10) || 100, 1), 500)
      let query = admin.from('admin_logs').select('*').order('logged_at', { ascending: false }).limit(limit)
      if (payload.action) query = query.ilike('action', String(payload.action))
      if (payload.username) query = query.ilike('username', String(payload.username))
      const { data, error } = await query
      if (error) throw error
      return response({ ok: true, data: (data || []).map((r) => ({ LogID: r.id, Timestamp: r.logged_at, UserID: r.user_id,
        Username: r.username, Role: r.role, Action: r.action, EntityType: r.entity_type, EntityID: r.entity_id,
        Details: r.details, Result: r.result })) })
    }

    const masterActions: Record<string, { table: string; idName: string; nameName: string; dbName: string; prefix: string }> = {
      'subjects.add': { table: 'subjects', idName: 'SubjectID', nameName: 'SubjectName', dbName: 'name', prefix: 'SUB' },
      'subjects.update': { table: 'subjects', idName: 'SubjectID', nameName: 'SubjectName', dbName: 'name', prefix: 'SUB' },
      'batches.add': { table: 'batches', idName: 'BatchID', nameName: 'BatchName', dbName: 'name', prefix: 'B' },
      'batches.update': { table: 'batches', idName: 'BatchID', nameName: 'BatchName', dbName: 'name', prefix: 'B' },
      'rooms.add': { table: 'rooms', idName: 'RoomID', nameName: 'RoomName', dbName: 'name', prefix: 'R' },
      'rooms.update': { table: 'rooms', idName: 'RoomID', nameName: 'RoomName', dbName: 'name', prefix: 'R' },
    }
    if (masterActions[action]) {
      const config = masterActions[action]
      const isUpdate = action.endsWith('.update')
      const input = (isUpdate ? payload.changes : payload.item) || {}
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiFault('BAD_REQUEST', 'Provide the master record fields.')
      const row: Record<string, unknown> = {}
      const allowed: Record<string, string> = {
        [config.nameName]: 'name', Status: 'status', Class: 'class', Section: 'section',
        AcademicYear: 'academic_year', Capacity: 'capacity',
      }
      for (const key of Object.keys(input)) {
        if (!allowed[key] || (config.table === 'subjects' && !['SubjectName', 'Status'].includes(key)) ||
          (config.table === 'batches' && !['BatchName', 'Class', 'Section', 'AcademicYear', 'Status'].includes(key)) ||
          (config.table === 'rooms' && !['RoomName', 'Capacity', 'Status'].includes(key))) {
          throw new ApiFault('BAD_REQUEST', `Unknown field: ${key}`)
        }
        const column = allowed[key]
        if (key === 'Capacity') {
          const capacity = Number(input[key])
          if (!Number.isInteger(capacity) || capacity < 1 || capacity > 500) throw new ApiFault('BAD_REQUEST', 'Capacity must be a whole number from 1 to 500.')
          row[column] = capacity
        } else {
          const max = key === 'Class' ? 10 : key === 'Section' ? 5 : key === 'AcademicYear' ? 10 : 60
          row[column] = requireText(input[key], key, max, !isUpdate && [config.nameName, 'Class'].includes(key))
          if (key === 'Status') {
            const status = String(row[column]).toLowerCase()
            if (!['active', 'inactive'].includes(status)) throw new ApiFault('BAD_REQUEST', 'Status must be Active or Inactive.')
            row[column] = status === 'active' ? 'Active' : 'Inactive'
          }
          if (key === 'Class' || key === 'Section') row[column] = String(row[column]).toUpperCase()
        }
      }
      if (!isUpdate) {
        const name = requireText(input[config.nameName], config.nameName, config.table === 'rooms' ? 40 : 60, true)
        row.name = name
        if (row.status === undefined) row.status = 'Active'
        if (config.table === 'batches') {
          row.academic_year ||= requireText(input.AcademicYear || '2026-27', 'AcademicYear', 10, true)
          if (!row.class) throw new ApiFault('BAD_REQUEST', 'Class is required.')
        }
        if (config.table === 'rooms' && row.capacity === undefined) throw new ApiFault('BAD_REQUEST', 'Capacity is required.')
        const id = await newId(admin, config.table, config.prefix)
        const { data, error } = await admin.from(config.table).insert({ id, ...row }).select('*').single()
        if (error?.code === '23505') throw new ApiFault('DUPLICATE', `${config.nameName} already exists.`)
        if (error) throw error
        await logAction(admin, user, `ADD_${config.table.toUpperCase()}`, config.table.toUpperCase(), id, row)
        return response({ ok: true, data: mapMaster(config.table, data) })
      }
      const id = requireText(payload.id, config.idName, 40, true)
      if (!Object.keys(row).length) throw new ApiFault('BAD_REQUEST', 'Nothing to update.')
      const { data, error } = await admin.from(config.table).update(row).eq('id', id).select('*').maybeSingle()
      if (error?.code === '23505') throw new ApiFault('DUPLICATE', `${config.nameName} already exists.`)
      if (error) throw error
      if (!data) throw new ApiFault('NOT_FOUND', 'Record not found.')
      await logAction(admin, user, `EDIT_${config.table.toUpperCase()}`, config.table.toUpperCase(), id, row)
      return response({ ok: true, data: { changed: Object.keys(row).map((k) => Object.keys(allowed).find((key) => allowed[key] === k) || k) } })
    }

    if (action === 'students.list') {
      const limit = Math.min(Math.max(Number.parseInt(payload.limit, 10) || 200, 1), 1000)
      let subjectStudentIds: string[] | null = null
      if (payload.subjectId) {
        const subjectId = requireText(payload.subjectId, 'Subject', 40, true)
        const { data: assignments, error: assignmentError } = await admin.from('student_subjects')
          .select('student_id').eq('subject_id', subjectId).ilike('status', 'ACTIVE')
        if (assignmentError) throw assignmentError
        subjectStudentIds = [...new Set((assignments || []).map((row) => String(row.student_id)).filter(Boolean))]
        if (!subjectStudentIds.length) return response({ ok: true, data: { total: 0, students: [] } })
      }
      let query = admin.from('students').select('*', { count: 'exact' }).order('name').limit(limit)
      if (payload.status) query = query.ilike('status', String(payload.status))
      if (payload.batchId) query = query.eq('current_batch_id', String(payload.batchId))
      if (subjectStudentIds) query = query.in('id', subjectStudentIds)
      if (payload.search) {
        const search = String(payload.search).replace(/[^a-zA-Z0-9 -]/g, '').trim()
        if (search) query = query.or(`name.ilike.%${search}%,id.eq.${search}`)
      }
      const { data, count, error } = await query
      if (error) throw error
      return response({ ok: true, data: { total: count || 0, students: (data || []).map(legacyStudent) } })
    }

    if (action === 'registrations.list') {
      const status = String(payload.status || '').toUpperCase()
      const [{ data: all, error }, { data: subjects, error: subjectsError }] = await Promise.all([
        admin.from('registrations').select('id,submitted_at,status,name,current_class,dob,gender,mobile,email,address,school,board,previous_percentage,parent_name,relationship,parent_mobile,parent_whatsapp,parent_email,requested_subjects,reviewed_by,reviewed_at,reject_reason,student_id').order('submitted_at', { ascending: false }).limit(500),
        admin.from('subjects').select('id,name'),
      ])
      if (error || subjectsError) throw error || subjectsError
      const subjectNames = new Map((subjects || []).map((s) => [s.id, s.name]))
      const counts = { PENDING: 0, APPROVED: 0, REJECTED: 0 }
      for (const reg of all || []) if (reg.status in counts) counts[reg.status as keyof typeof counts]++
      const rows = (all || []).filter((r) => !status || r.status === status).map((r) => {
        const requested = Array.isArray(r.requested_subjects) ? r.requested_subjects.map(String) : []
        return { RegistrationID: r.id, SubmittedAt: r.submitted_at, Status: r.status, Name: r.name,
          CurrentClass: r.current_class, DOB: r.dob, Gender: r.gender, Mobile: r.mobile, Email: r.email,
          Address: r.address, School: r.school, Board: r.board, PreviousPercentage: r.previous_percentage,
          ParentName: r.parent_name, Relationship: r.relationship, ParentMobile: r.parent_mobile,
          ParentWhatsApp: r.parent_whatsapp, ParentEmail: r.parent_email, RequestedSubjects: requested.join(','),
          SubjectNames: requested.map((id) => subjectNames.get(id) || id).join(', '), ReviewedBy: r.reviewed_by,
          ReviewedAt: r.reviewed_at, RejectReason: r.reject_reason, StudentID: r.student_id || '' }
      })
      return response({ ok: true, data: { rows, counts } })
    }

    if (action === 'registrations.pendingCount') {
      const { count, error } = await admin.from('registrations').select('id', { count: 'exact', head: true }).eq('status', 'PENDING')
      if (error) throw error
      return response({ ok: true, data: { count: count || 0 } })
    }

    if (action === 'registrations.update') {
      const id = requireText(payload.id, 'Request ID', 40, true)
      const input = payload.changes && typeof payload.changes === 'object' && !Array.isArray(payload.changes) ? payload.changes : null
      if (!input || !Object.keys(input).length) throw new ApiFault('BAD_REQUEST', 'Nothing to update.')
      const changes = validateRegistrationInput(input, true)
      if (changes.current_class) {
        const { data: batches } = await admin.from('batches').select('class').eq('status', 'Active')
        if (!(batches || []).some((b) => String(b.class).toUpperCase() === changes.current_class)) throw new ApiFault('BAD_REQUEST', 'Class must have an active batch.')
      }
      const { data: old, error: readError } = await admin.from('registrations').select('*').eq('id', id).maybeSingle()
      if (readError) throw readError
      if (!old) throw new ApiFault('NOT_FOUND', 'Request not found.')
      if (old.status !== 'PENDING') throw new ApiFault('BAD_REQUEST', 'Only pending requests can be edited.')
      const merged = { ...old, ...changes }
      if ('current_class' in changes || 'board' in changes) {
        changes.board = canonicalStudentBoard(merged.board, merged.current_class)
      }
      const { error } = await admin.from('registrations').update(changes).eq('id', id)
      if (error) throw error
      await logAction(admin, user, 'EDIT_REGISTRATION', 'REGISTRATION', id, changes)
      return response({ ok: true, data: { changed: Object.keys(changes) } })
    }

    if (action === 'registrations.reject') {
      const id = requireText(payload.id, 'Request ID', 40, true)
      const reason = requireText(payload.reason, 'Reason', 200, true)
      const { data: old, error: readError } = await admin.from('registrations').select('status,registration_auth_user_id').eq('id', id).maybeSingle()
      if (readError) throw readError
      if (!old) throw new ApiFault('NOT_FOUND', 'Request not found.')
      if (old.status !== 'PENDING') throw new ApiFault('BAD_REQUEST', `This request is already ${String(old.status).toLowerCase()}.`)
      const { error } = await admin.from('registrations').update({ status: 'REJECTED', reject_reason: reason,
        reviewed_by: user.id, reviewed_at: new Date().toISOString(), registration_auth_user_id: null }).eq('id', id)
      if (error) throw error
      if (old.registration_auth_user_id) await admin.auth.admin.deleteUser(old.registration_auth_user_id)
      await logAction(admin, user, 'REJECT_REGISTRATION', 'REGISTRATION', id, { reason })
      return response({ ok: true, data: { ok: true } })
    }

    if (action === 'registrations.approve') {
      const registrationId = requireText(payload.id, 'Request ID', 40, true)
      const batchId = requireText(payload.batchId, 'Batch', 40, true)
      const startDate = requireText(payload.startDate || todayDate(), 'Start date', 10, true)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new ApiFault('BAD_REQUEST', 'Start date must use yyyy-mm-dd.')
      const picks: Array<Record<string, unknown>> = Array.isArray(payload.subjects) ? payload.subjects as Array<Record<string, unknown>> : []
      if (picks.length > 6) throw new ApiFault('BAD_REQUEST', 'Choose no more than 6 subjects.')
      const seen = new Set<string>()
      for (const pick of picks) {
        if (!pick || !pick.subjectId || !pick.teacherId) throw new ApiFault('BAD_REQUEST', 'Choose a teacher for every selected subject.')
        if (seen.has(String(pick.subjectId))) throw new ApiFault('BAD_REQUEST', 'A subject was selected twice.')
        seen.add(String(pick.subjectId))
      }
      const { data: reg, error: regError } = await admin.from('registrations').select('*').eq('id', registrationId).maybeSingle()
      if (regError) throw regError
      if (!reg) throw new ApiFault('NOT_FOUND', 'Request not found.')
      if (reg.status !== 'PENDING') throw new ApiFault('BAD_REQUEST', `This request is already ${String(reg.status).toLowerCase()}.`)
      if (!reg.registration_auth_user_id) throw new ApiFault('BAD_REQUEST', 'This request has no saved sign-in account. Ask the applicant to register again.')
      const [{ data: batch }, { data: allSubjects }, { data: allTeachers }, { data: settingRows }] = await Promise.all([
        admin.from('batches').select('id,name,class,status').eq('id', batchId).maybeSingle(),
        admin.from('subjects').select('id,name,status'), admin.from('teachers').select('id,name,status'),
        admin.from('settings').select('setting_key,value').in('setting_key', ['ACADEMIC_YEAR','STUDENT_ID_PREFIX','SUBJECT_BLOCKED_PAIRS']),
      ])
      if (!batch || batch.status !== 'Active' || String(batch.class).toUpperCase() !== String(reg.current_class).toUpperCase()) throw new ApiFault('BAD_REQUEST', 'Choose an active batch for the applicant’s class.')
      const subjectsById = new Map((allSubjects || []).map((s) => [s.id, s]))
      const teachersById = new Map((allTeachers || []).map((t) => [t.id, t]))
      for (const pick of picks) {
        if (subjectsById.get(String(pick.subjectId))?.status !== 'Active') throw new ApiFault('BAD_REQUEST', 'A selected subject is not available.')
        if (teachersById.get(String(pick.teacherId))?.status !== 'Active') throw new ApiFault('BAD_REQUEST', 'A selected teacher is not available.')
      }
      const chosenSubjectIds = picks.map((p) => String(p.subjectId))
      const settingMap = Object.fromEntries((settingRows || []).map((r) => [r.setting_key, r.value]))
      const blockedPairs = String(settingMap.SUBJECT_BLOCKED_PAIRS || '').split(';').map((x) => x.split('|').map((y) => y.trim()))
      if (blockedPairs.some((pair) => pair.length === 2 && chosenSubjectIds.includes(pair[0]) && chosenSubjectIds.includes(pair[1]))) throw new ApiFault('RULE_VIOLATION', 'This combination of subjects is not allowed.')
      const studentInput: Record<string, unknown> = { Name: reg.name, CurrentClass: reg.current_class, CurrentBatch: batchId }
      const regFieldMap: Record<string, string> = { dob: 'DOB', gender: 'Gender', mobile: 'Mobile', email: 'Email', address: 'Address',
        school: 'School', board: 'Board', parent_name: 'ParentName', relationship: 'Relationship', parent_mobile: 'ParentMobile',
        parent_whatsapp: 'ParentWhatsApp', parent_email: 'ParentEmail', previous_percentage: 'PreviousPercentage' }
      for (const [dbField, apiField] of Object.entries(regFieldMap)) if (reg[dbField] !== null && reg[dbField] !== '') studentInput[apiField] = reg[dbField]
      const studentFields = validateStudentInput(studentInput, false)
      const year = new Date().getFullYear()
      const prefix = `${settingMap.STUDENT_ID_PREFIX || 'CMZ'}-${year}-`
      const studentId = await newId(admin, 'students', prefix)
      const { data: authIdentity, error: authError } = await admin.auth.admin.getUserById(reg.registration_auth_user_id)
      if (authError || !authIdentity.user) throw new ApiFault('BAD_REQUEST', 'The applicant’s saved sign-in account is no longer available.')
      const now = new Date().toISOString()
      const newStudent = { ...studentFields, id: studentId, registration_year: String(year), registration_date: now.slice(0, 10),
        roll_no: studentId.slice(prefix.length), status: 'ACTIVE', academic_year: settingMap.ACADEMIC_YEAR || `${year}-${String(year + 1).slice(-2)}`,
        created_at: now, updated_at: now }
      const { error: studentInsertError } = await admin.from('students').insert(newStudent)
      if (studentInsertError) throw studentInsertError
      const { error: appUserError } = await admin.from('app_users').insert({ auth_user_id: reg.registration_auth_user_id,
        username: studentId, user_type: 'STUDENT', role: 'STUDENT', linked_id: studentId, status: 'Active', must_change_password: false })
      if (appUserError) { await admin.from('students').delete().eq('id', studentId); if (appUserError.code === '23505') throw new ApiFault('DUPLICATE', 'Could not link this applicant’s login.'); throw appUserError }
      try {
        for (const pick of picks) {
          const subject = subjectsById.get(String(pick.subjectId))!, teacherRow = teachersById.get(String(pick.teacherId))!
          const subjectLinkId = await newId(admin, 'student_subjects', 'SS-', 4)
          const { error } = await admin.from('student_subjects').insert({ id: subjectLinkId, student_id: studentId,
            subject_id: String(pick.subjectId), teacher_id: String(pick.teacherId), batch_id: batchId,
            start_date: startDate, status: 'ACTIVE', academic_year: newStudent.academic_year })
          if (error) throw error
          await admin.from('change_history').insert({ id: `CHG-${crypto.randomUUID()}`, student_id: studentId, field: 'Subject',
            old_value: '', new_value: `${subject.name} / ${teacherRow.name} / ${batch.name}`, changed_by: user.id,
            reason: `Online registration ${registrationId}`, academic_year: newStudent.academic_year })
        }
      } catch (error) {
        await admin.from('app_users').delete().eq('auth_user_id', reg.registration_auth_user_id)
        await admin.from('students').delete().eq('id', studentId)
        throw error
      }
      const { error: finishError } = await admin.from('registrations').update({ status: 'APPROVED', reviewed_by: user.id,
        reviewed_at: now, student_id: studentId, registration_auth_user_id: null }).eq('id', registrationId)
      if (finishError) {
        await admin.from('app_users').delete().eq('auth_user_id', reg.registration_auth_user_id)
        await admin.from('students').delete().eq('id', studentId)
        throw finishError
      }
      await logAction(admin, user, 'APPROVE_REGISTRATION', 'REGISTRATION', registrationId, { studentId, batchId, subjects: chosenSubjectIds })
      return response({ ok: true, data: { studentId, username: studentId, tempPassword: '', warnings: [], portalUrl: '' } })
    }

    if (action === 'finance.feeStructure.list') {
      const { data, error } = await admin.from('fee_structure').select('*').order('item_type').order('description')
      if (error) throw error
      const { data: subjects } = await admin.from('subjects').select('id,name')
      const subjectNames = new Map((subjects || []).map((s) => [s.id, s.name]))
      return response({ ok: true, data: (data || []).map((r) => ({ FeeID: r.id, ItemType: r.item_type,
        SubjectID: r.subject_id || '', SubjectName: r.subject_id ? subjectNames.get(r.subject_id) || '' : '',
        Description: r.description, Amount: Number(r.amount), AcademicYear: r.academic_year, Status: r.status })) })
    }

    if (action === 'finance.feeStructure.add') {
      const item = payload.item
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ApiFault('BAD_REQUEST', 'Provide the fee item details.')
      const itemType = requireText(item.ItemType, 'ItemType', 20, true).toUpperCase()
      if (!['SUBJECT','REGISTRATION','OTHER'].includes(itemType)) throw new ApiFault('BAD_REQUEST', 'Choose a valid fee type.')
      const description = requireText(item.Description, 'Description', 150, true)
      const amount = Number(item.Amount)
      if (!Number.isFinite(amount) || amount < 0 || amount > 10000000) throw new ApiFault('BAD_REQUEST', 'Amount must be from 0 to 10000000.')
      const subjectId = requireText(item.SubjectID, 'Subject', 40)
      if (itemType === 'SUBJECT' && !subjectId) throw new ApiFault('BAD_REQUEST', 'Choose a subject for this monthly fee.')
      if (subjectId) {
        const { data: subject } = await admin.from('subjects').select('id').eq('id', subjectId).maybeSingle()
        if (!subject) throw new ApiFault('BAD_REQUEST', 'Subject not found.')
      }
      const { data: yearSetting } = await admin.from('settings').select('value').eq('setting_key', 'ACADEMIC_YEAR').maybeSingle()
      const academicYear = yearSetting?.value || '2026-27'
      if (itemType === 'SUBJECT') {
        const { data: duplicate } = await admin.from('fee_structure').select('id').eq('item_type', 'SUBJECT')
          .eq('subject_id', subjectId).eq('academic_year', academicYear).eq('status', 'Active').maybeSingle()
        if (duplicate) throw new ApiFault('DUPLICATE', 'An active fee already exists for this subject and academic year.')
      }
      const id = await newId(admin, 'fee_structure', 'FEE-', 4)
      const { error } = await admin.from('fee_structure').insert({ id, item_type: itemType, subject_id: subjectId || null,
        description, amount, academic_year: academicYear, status: 'Active' })
      if (error) throw error
      await logAction(admin, user, 'ADD_FEE_STRUCTURE', 'FEE_STRUCTURE', id, { itemType, subjectId, amount, academicYear })
      return response({ ok: true, data: { FeeID: id } })
    }

    if (action === 'finance.feeStructure.update') {
      const id = requireText(payload.id, 'Fee ID', 40, true)
      const input = payload.changes
      if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length) throw new ApiFault('BAD_REQUEST', 'Nothing to update.')
      const row: Record<string, unknown> = {}
      for (const [key, raw] of Object.entries(input)) {
        if (key === 'Description') row.description = requireText(raw, key, 150, true)
        else if (key === 'Amount') {
          const amount = Number(raw)
          if (!Number.isFinite(amount) || amount < 0 || amount > 10000000) throw new ApiFault('BAD_REQUEST', 'Amount must be from 0 to 10000000.')
          row.amount = amount
        } else if (key === 'Status') {
          const status = requireText(raw, key, 10, true)
          if (!['Active','Inactive'].includes(status)) throw new ApiFault('BAD_REQUEST', 'Status must be Active or Inactive.')
          row.status = status
        } else throw new ApiFault('BAD_REQUEST', `Unknown fee field: ${key}`)
      }
      const { data, error } = await admin.from('fee_structure').update(row).eq('id', id).select('id').maybeSingle()
      if (error) throw error
      if (!data) throw new ApiFault('NOT_FOUND', 'Fee item not found.')
      await logAction(admin, user, 'EDIT_FEE_STRUCTURE', 'FEE_STRUCTURE', id, row)
      return response({ ok: true, data: { changed: Object.keys(row).map((key) => key === 'description' ? 'Description' : key === 'amount' ? 'Amount' : 'Status') } })
    }

    if (action === 'finance.studentFee.list') {
      const studentId = requireText(payload.studentId, 'Student ID', 40, true)
      const [{ data: assignments, error }, { data: feeRows, error: feeError }, { data: activeFees, error: activeFeeError }, { data: subjects }, { data: teachers }, { data: yearSetting }] = await Promise.all([
        admin.from('student_subjects').select('*').eq('student_id', studentId).eq('status', 'ACTIVE'),
        admin.from('fee_structure').select('*').eq('item_type', 'SUBJECT').eq('status', 'Active'),
        admin.from('student_fees').select('*').eq('student_id', studentId).eq('status', 'Active').is('effective_to', null),
        admin.from('subjects').select('id,name'), admin.from('teachers').select('id,name'),
        admin.from('settings').select('value').eq('setting_key', 'ACADEMIC_YEAR').maybeSingle(),
      ])
      if (error || feeError || activeFeeError) throw error || feeError || activeFeeError
      const academicYear = yearSetting?.value || '2026-27'
      const subjectNames = new Map((subjects || []).map((s) => [s.id, s.name]))
      const teacherNames = new Map((teachers || []).map((t) => [t.id, t.name]))
      const standardBySubject = new Map((feeRows || []).filter((r) => r.academic_year === academicYear).map((r) => [r.subject_id, Number(r.amount)]))
      const overrides = new Map((activeFees || []).map((r) => [r.subject_id, r]))
      const lines = (assignments || []).map((a) => {
        const standard = a.fee_override !== null && a.fee_override !== undefined ? Number(a.fee_override) : standardBySubject.get(a.subject_id) || 0
        const override = overrides.get(a.subject_id)
        const discount = override ? Number(override.discount_amount) : 0
        return { StudentID: studentId, SubjectID: a.subject_id, SubjectName: subjectNames.get(a.subject_id) || a.subject_id,
          TeacherID: a.teacher_id || '', TeacherName: a.teacher_id ? teacherNames.get(a.teacher_id) || a.teacher_id : '',
          StandardAmount: standard, DiscountAmount: discount, FinalAmount: Math.max(0, standard - discount),
          HasOverride: !!override, Reason: override?.reason || '' }
      })
      const [{ data: registrationItems }, { data: otherItems }] = await Promise.all([
        admin.from('fee_structure').select('amount').eq('item_type', 'REGISTRATION').eq('status', 'Active').eq('academic_year', academicYear),
        admin.from('fee_structure').select('amount').eq('item_type', 'OTHER').eq('status', 'Active').eq('academic_year', academicYear),
      ])
      const monthlyTotal = lines.reduce((sum, line) => sum + line.FinalAmount, 0)
      const registration = registrationItems?.reduce((sum, item) => sum + Number(item.amount), 0) || 0
      const other = otherItems?.reduce((sum, item) => sum + Number(item.amount), 0) || 0
      return response({ ok: true, data: { lines, monthlyTotal, registration, other, academicYear } })
    }

    if (action === 'finance.studentFee.set') {
      const studentId = requireText(payload.studentId, 'Student ID', 40, true)
      const subjectId = requireText(payload.subjectId, 'Subject', 40, true)
      const discountAmount = Number(payload.discountAmount)
      if (!Number.isFinite(discountAmount) || discountAmount < 0 || discountAmount > 10000000) throw new ApiFault('BAD_REQUEST', 'Enter a valid discount amount.')
      const [{ data: assignment }, { data: yearSetting }] = await Promise.all([
        admin.from('student_subjects').select('subject_id,fee_override,academic_year').eq('student_id', studentId).eq('subject_id', subjectId).eq('status', 'ACTIVE').maybeSingle(),
        admin.from('settings').select('value').eq('setting_key', 'ACADEMIC_YEAR').maybeSingle(),
      ])
      if (!assignment) throw new ApiFault('NOT_FOUND', 'The student does not currently take this subject.')
      const academicYear = yearSetting?.value || '2026-27'
      let standardAmount = assignment.fee_override === null ? null : Number(assignment.fee_override)
      if (standardAmount === null) {
        const { data: fee } = await admin.from('fee_structure').select('amount').eq('item_type', 'SUBJECT').eq('subject_id', subjectId)
          .eq('academic_year', academicYear).eq('status', 'Active').maybeSingle()
        standardAmount = fee ? Number(fee.amount) : 0
      }
      if (discountAmount > standardAmount) throw new ApiFault('BAD_REQUEST', 'Discount cannot exceed the standard fee.')
      const reason = requireText(payload.reason, 'Reason', 200)
      const today = todayDate()
      const { data: current, error: currentError } = await admin.from('student_fees').select('id').eq('student_id', studentId)
        .eq('subject_id', subjectId).eq('status', 'Active').is('effective_to', null)
      if (currentError) throw currentError
      if (current?.length) await admin.from('student_fees').update({ status: 'Inactive', effective_to: today }).in('id', current.map((r) => r.id))
      const id = await newId(admin, 'student_fees', 'SF-', 4)
      const { error } = await admin.from('student_fees').insert({ id, student_id: studentId, subject_id: subjectId,
        standard_amount: standardAmount, discount_amount: discountAmount, final_amount: Math.max(0, standardAmount - discountAmount),
        effective_from: today, effective_to: null, academic_year: academicYear, status: 'Active', reason })
      if (error) throw error
      await logAction(admin, user, 'SET_STUDENT_DISCOUNT', 'STUDENT_FEE', id, { studentId, subjectId, discountAmount, reason })
      return response({ ok: true, data: { feeId: id } })
    }

    if (action === 'finance.studentFee.remove') {
      const studentId = requireText(payload.studentId, 'Student ID', 40, true)
      const subjectId = requireText(payload.subjectId, 'Subject', 40, true)
      const today = todayDate()
      const { data, error } = await admin.from('student_fees').update({ status: 'Inactive', effective_to: today })
        .eq('student_id', studentId).eq('subject_id', subjectId).eq('status', 'Active').is('effective_to', null).select('id')
      if (error) throw error
      if (!data?.length) throw new ApiFault('NOT_FOUND', 'No active fee discount was found.')
      await logAction(admin, user, 'REMOVE_STUDENT_DISCOUNT', 'STUDENT_FEE', data[0].id, { studentId, subjectId })
      return response({ ok: true, data: { removed: true } })
    }

    if (action === 'invoices.generate') {
      const { month, result } = await generateInvoices(admin, payload)
      await logAction(admin, user, 'GENERATE_INVOICES', 'INVOICES', month,
        { generated: result.generated, skipped: result.skippedExisting + result.skippedEmpty })
      return response({ ok: true, data: result })
    }

    if (action === 'invoices.list') {
      const month = requireText(payload.month, 'Month', 7)
      const statusFilter = String(payload.status || '').toUpperCase()
      const search = String(payload.search || '').trim().toLowerCase().slice(0, 100)
      const batchFilter = String(payload.batchId || '').trim()
      const subjectFilter = String(payload.subjectId || '').trim()
      const limit = Math.min(Math.max(Number.parseInt(payload.limit, 10) || 500, 1), 2000)
      // Only the columns this list needs, every page (newest first, up to 5,000 as before).
      const data = await fetchAll(() => {
        let query = admin.from('invoices').select('id,student_id,month,line_items,total_amount,paid_amount,due_date,status')
          .order('month', { ascending: false }).order('id', { ascending: false })
        return month ? query.eq('month', month) : query
      }, 1000, 5000)
      const students = await selectIn((data || []).map((r) => r.student_id),
        (chunk) => admin.from('students').select('id,name,current_class,current_batch_id').in('id', chunk))
      const studentMap = new Map((students || []).map((s) => [s.id, s]))
      const linesByInvoice = new Map((data || []).map((r) => [r.id, normalizedInvoiceLines(r)]))
      const invoiceBatchIds = (data || []).flatMap((r) => (linesByInvoice.get(r.id) || []).map((line) => String(line.batchId || '').trim()).filter(Boolean))
      const batchIds = [...new Set([...(students || []).map((s) => String(s.current_batch_id || '').trim()), ...invoiceBatchIds].filter(Boolean))]
      const subjectIds = [...new Set((data || []).flatMap((r) => (linesByInvoice.get(r.id) || [])
        .map((line) => String(line.subjectId || '').trim()).filter(Boolean)))]
      const [{ data: batches, error: batchesError }, { data: subjects, error: subjectsError }] = await Promise.all([
        batchIds.length ? admin.from('batches').select('id,name').in('id', batchIds) : Promise.resolve({ data: [], error: null }),
        subjectIds.length ? admin.from('subjects').select('id,name').in('id', subjectIds) : Promise.resolve({ data: [], error: null }),
      ])
      if (batchesError || subjectsError) throw batchesError || subjectsError
      const batchNames = new Map((batches || []).map((b) => [b.id, b.name]))
      const subjectNames = new Map((subjects || []).map((s) => [String(s.id), s.name]))
      const batchOptions = new Map<string, string>()
      const subjectOptions = new Map<string, string>()
      let rows = (data || []).map((r) => {
        const student = studentMap.get(r.student_id)
        const currentBatchId = String(student?.current_batch_id || '').trim()
        const lines = (linesByInvoice.get(r.id) || []).map((line) => {
          const subjectName = String(line.subjectName || subjectNames.get(String(line.subjectId || '')) || line.subjectId || '').trim()
          const subjectId = String(line.subjectId || '').trim() || (subjectName ? `legacy-subject:${subjectName.toLowerCase()}` : '')
          const batchId = String(line.batchId || '').trim() || currentBatchId
          const batchName = String(batchNames.get(batchId) || (batchId === currentBatchId ? batchNames.get(currentBatchId) : '') || batchId).trim()
          if (subjectId && subjectName) subjectOptions.set(subjectId, subjectName)
          return { subjectId, subjectName: subjectName || 'Unspecified', batchId, batchName }
        })
        const rowBatchIds = [...new Set(lines.map((line) => line.batchId).filter(Boolean))]
        if (currentBatchId) {
          batchOptions.set(currentBatchId, String(batchNames.get(currentBatchId) || currentBatchId))
        }
        const rowSubjectIds = [...new Set(lines.map((line) => line.subjectId).filter(Boolean))]
        return { InvoiceID: r.id, StudentID: r.student_id, StudentName: student?.name || r.student_id,
          CurrentClass: student?.current_class || '', CurrentBatchID: currentBatchId,
          CurrentBatchName: batchNames.get(currentBatchId) || '', Month: r.month, MonthLabel: monthLabel(r.month),
          Classes: lines.map((line) => line.subjectName).join(', '), BatchIDs: rowBatchIds, SubjectIDs: rowSubjectIds,
          TotalAmount: Number(r.total_amount) || 0, PaidAmount: Number(r.paid_amount) || 0,
          BalanceAmount: Math.max(0, Number(r.total_amount) - Number(r.paid_amount)), DueDate: r.due_date,
          Status: invoiceStatus(r.total_amount, r.paid_amount, r.due_date, r.status), StoredStatus: r.status }
      })
      const batchFilterOptions = [...batchOptions].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
      const subjectFilterOptions = [...subjectOptions].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
      if (statusFilter) rows = rows.filter((r) => r.Status === statusFilter)
      if (search) rows = rows.filter((r) => r.StudentName.toLowerCase().includes(search) || r.StudentID.toLowerCase().includes(search) || r.InvoiceID.toLowerCase().includes(search))
      if (batchFilter) rows = rows.filter((r) => r.CurrentBatchID === batchFilter)
      if (subjectFilter) rows = rows.filter((r) => r.SubjectIDs.includes(subjectFilter))
      const totals = { count: 0, billed: 0, paid: 0, balance: 0, overdue: 0 }
      for (const row of rows) if (row.Status !== 'CANCELLED') {
        totals.count++; totals.billed += row.TotalAmount; totals.paid += row.PaidAmount; totals.balance += row.BalanceAmount
        if (row.Status === 'OVERDUE') totals.overdue += row.BalanceAmount
      }
      return response({ ok: true, data: { rows: rows.slice(0, limit), totals,
        batchOptions: batchFilterOptions, subjectOptions: subjectFilterOptions } })
    }

    if (action === 'invoices.get') {
      const id = requireText(payload.invoiceId, 'Invoice ID', 60, true)
      const [{ data: invoice, error }, { data: payments, error: paymentsError }] = await Promise.all([
        admin.from('invoices').select('*').eq('id', id).maybeSingle(),
        admin.from('payments').select('*').eq('invoice_id', id).order('payment_date', { ascending: false }),
      ])
      if (error || paymentsError) throw error || paymentsError
      if (!invoice) throw new ApiFault('NOT_FOUND', 'Invoice not found.')
      const [{ data: student }, { data: subjects }] = await Promise.all([
        admin.from('students').select('name,current_class,current_batch_id').eq('id', invoice.student_id).maybeSingle(),
        admin.from('subjects').select('id,name'),
      ])
      const { data: currentBatch } = student?.current_batch_id
        ? await admin.from('batches').select('name').eq('id', student.current_batch_id).maybeSingle() : { data: null }
      const subjectNames = new Map((subjects || []).map((s) => [s.id, s.name]))
      const lines = normalizedInvoiceLines(invoice).map((line) => ({ ...line,
        subjectName: line.subjectName || subjectNames.get(String(line.subjectId)) || String(line.subjectId || '') }))
      const total = Number(invoice.total_amount) || 0, paid = Number(invoice.paid_amount) || 0
      return response({ ok: true, data: { invoice: { InvoiceID: invoice.id, StudentID: invoice.student_id,
        StudentName: student?.name || invoice.student_id, CurrentClass: student?.current_class || '',
        CurrentBatchName: currentBatch?.name || '', Month: invoice.month,
        MonthLabel: monthLabel(invoice.month), TotalAmount: total, PaidAmount: paid, BalanceAmount: Math.max(0, total - paid),
        DueDate: invoice.due_date, Status: invoiceStatus(total, paid, invoice.due_date, invoice.status),
        CreatedAt: invoice.created_at, UpdatedAt: invoice.updated_at }, lines,
        payments: (payments || []).map((p) => ({ PaymentID: p.id, Amount: Number(p.amount), PaymentDate: p.payment_date,
          PaymentMode: p.payment_mode, TransactionReference: p.transaction_reference, Status: p.status,
          ReceiptID: p.receipt_id, Notes: p.notes, Allocations: allocationsFromPayment(p.allocations) })) } })
    }

    if (action === 'invoices.cancel') {
      const id = requireText(payload.invoiceId, 'Invoice ID', 60, true)
      const reason = requireText(payload.reason, 'Reason', 200)
      const { data, error } = await admin.rpc('cancel_invoice_transaction', { p_invoice_id: id })
      if (error) {
        if (error.message.includes('not found')) throw new ApiFault('NOT_FOUND', 'Invoice not found.')
        if (error.message.includes('already has payments')) throw new ApiFault('BAD_REQUEST', 'Cannot cancel an invoice that already has payments.')
        throw error
      }
      if (data?.unchanged) return response({ ok: true, data: { ok: true, unchanged: true } })
      await logAction(admin, user, 'CANCEL_INVOICE', 'INVOICE', id, { reason })
      return response({ ok: true, data: { ok: true } })
    }

    if (action === 'payments.record') {
      const invoiceId = requireText(payload.invoiceId, 'Invoice ID', 60, true)
      const mode = requireText(payload.mode, 'Payment mode', 30, true).toUpperCase()
      if (!['CASH','UPI','BANK_TRANSFER','CHEQUE'].includes(mode)) throw new ApiFault('BAD_REQUEST', 'Choose a valid payment mode.')
      const paymentDate = requireText(payload.paymentDate || todayDate(), 'Payment date', 10, true)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) throw new ApiFault('BAD_REQUEST', 'Payment date must use yyyy-mm-dd.')
      const { data: invoice, error: invoiceError } = await admin.from('invoices').select('*').eq('id', invoiceId).maybeSingle()
      if (invoiceError) throw invoiceError
      if (!invoice) throw new ApiFault('NOT_FOUND', 'Invoice not found.')
      if (String(invoice.status).toUpperCase() === 'CANCELLED') throw new ApiFault('BAD_REQUEST', 'This invoice is cancelled.')
      const total = Number(invoice.total_amount) || 0, paid = Number(invoice.paid_amount) || 0
      const balance = Math.max(0, total - paid)
      if (balance <= 0) throw new ApiFault('BAD_REQUEST', 'This invoice is already fully paid.')
      const lines = normalizedInvoiceLines(invoice)
      const requested = Array.isArray(payload.allocations) && payload.allocations.length ? payload.allocations : null
      const allocations: Array<{ subjectId: string; subjectName: string; amount: number }> = []
      if (requested) {
        const seen = new Set<string>()
        for (const raw of requested) {
          const subjectId = requireText(raw?.subjectId, 'Subject ID', 40, true)
          const amount = Math.round(Number(raw?.amount) * 100) / 100
          if (!Number.isFinite(amount) || amount <= 0) continue
          if (seen.has(subjectId)) throw new ApiFault('BAD_REQUEST', 'A subject appears twice.')
          seen.add(subjectId)
          const line = lines.find((x) => String(x.subjectId) === subjectId)
          if (!line) throw new ApiFault('BAD_REQUEST', 'That subject is not on this invoice.')
          if (amount > Number(line.balanceAmount) + 0.005) throw new ApiFault('BAD_REQUEST', `${line.subjectName}: amount is more than its balance.`)
          allocations.push({ subjectId, subjectName: String(line.subjectName || subjectId), amount })
        }
        if (!allocations.length) throw new ApiFault('BAD_REQUEST', 'Enter an amount for at least one subject.')
      } else {
        const wanted = Math.round(Number(payload.amount) * 100) / 100
        if (!Number.isFinite(wanted) || wanted < 1 || wanted > 10000000) throw new ApiFault('BAD_REQUEST', 'Enter a valid payment amount.')
        if (wanted > balance + 0.005) throw new ApiFault('BAD_REQUEST', 'Amount exceeds the invoice balance.')
        let remaining = wanted
        for (const line of lines) {
          if (remaining <= 0 || Number(line.balanceAmount) <= 0) continue
          const amount = Math.round(Math.min(remaining, Number(line.balanceAmount)) * 100) / 100
          allocations.push({ subjectId: String(line.subjectId), subjectName: String(line.subjectName || line.subjectId), amount })
          remaining = Math.round((remaining - amount) * 100) / 100
        }
        if (remaining > 0.005) throw new ApiFault('BAD_REQUEST', 'Amount exceeds the invoice balance.')
      }
      const amount = Math.round(allocations.reduce((sum, a) => sum + a.amount, 0) * 100) / 100
      if (amount < 1 || amount > balance + 0.005) throw new ApiFault('BAD_REQUEST', 'Payment total is outside the invoice balance.')
      let reissueOf = ''
      if (payload.reissueReceiptId) {
        reissueOf = requireText(payload.reissueReceiptId, 'Previous receipt', 60, true)
        const { data: previous, error: previousError } = await admin.from('receipts').select('id,student_id,payment_id,status').eq('id', reissueOf).maybeSingle()
        if (previousError) throw previousError
        if (!previous || String(previous.status).toUpperCase() !== 'VOID' || previous.student_id !== invoice.student_id) throw new ApiFault('BAD_REQUEST', 'Choose a voided receipt for this student.')
        const { data: previousPayment } = await admin.from('payments').select('invoice_id').eq('id', previous.payment_id).maybeSingle()
        if (previousPayment?.invoice_id !== invoiceId) throw new ApiFault('BAD_REQUEST', 'The voided receipt belongs to a different invoice.')
      }
      const paymentId = await newId(admin, 'payments', 'PAY-', 5)
      const receiptId = await newId(admin, 'receipts', `CMZ-${paymentDate.replaceAll('-', '')}-`, 3)
      const { data, error } = await admin.rpc('record_payment_transaction', { p_payment_id: paymentId, p_receipt_id: receiptId,
        p_invoice_id: invoiceId, p_payment_date: paymentDate, p_payment_mode: mode,
        p_transaction_reference: requireText(payload.reference, 'Reference', 100), p_notes: requireText(payload.notes, 'Notes', 500),
        p_academic_year: invoice.academic_year || '2026-27', p_received_by: user.id, p_allocations: allocations, p_receipt_format: 'A5' })
      if (error) {
        if (error.message.includes('not found')) throw new ApiFault('NOT_FOUND', 'Invoice not found.')
        if (error.message.includes('cancelled')) throw new ApiFault('BAD_REQUEST', 'This invoice is cancelled.')
        if (error.message.includes('balance') || error.message.includes('paid')) throw new ApiFault('BAD_REQUEST', 'The invoice balance changed. Refresh the invoice and try again.')
        throw error
      }
      if (reissueOf) {
        const { error: linkError } = await admin.from('receipts').update({ reissue_of: reissueOf }).eq('id', receiptId)
        if (linkError) throw linkError
        await admin.from('receipts').update({ reissued_by: receiptId }).eq('id', reissueOf)
      }
      await logAction(admin, user, 'ADD_PAYMENT', 'PAYMENT', paymentId, { invoiceId, amount, mode, receiptId, allocations })
      await logAction(admin, user, 'CREATE_RECEIPT', 'RECEIPT', receiptId, { paymentId, amount })
      return response({ ok: true, data })
    }

    if (action === 'teacher.paymentMethods.list' || action === 'teacher.paymentMethods.save') {
      if (user.user_type !== 'TEACHER' || !user.linked_id) throw new ApiFault('FORBIDDEN', 'This action is only available in the teacher portal.')
      if (action === 'teacher.paymentMethods.list') {
        const { data: rows, error } = await admin.from('teacher_payment_methods').select('*').eq('teacher_id', user.linked_id).order('created_at', { ascending: false })
        if (error) throw error
        const { data: assigned, error: assignedError } = await admin.from('student_subjects').select('subject_id').eq('teacher_id', user.linked_id).ilike('status', 'active')
        if (assignedError) throw assignedError
        const subjectIds = [...new Set([...(rows || []).flatMap((r) => Array.isArray(r.subject_ids) && r.subject_ids.length ? r.subject_ids : [r.subject_id]), ...(assigned || []).map((r) => r.subject_id)])]
        const { data: subjects } = subjectIds.length ? await admin.from('subjects').select('id,name').in('id', subjectIds) : { data: [] }
        const subjectNames = new Map((subjects || []).map((s) => [s.id, s.name]))
        const result = await Promise.all((rows || []).map(async (r) => {
          const signed = r.qr_path ? await admin.storage.from('teacher-payment-qr').createSignedUrl(r.qr_path, 3600) : { data: null }
          const methodSubjectIds: string[] = Array.isArray(r.subject_ids) && r.subject_ids.length ? r.subject_ids as string[] : [r.subject_id]
          const methodSubjectNames = methodSubjectIds.map((id: string) => subjectNames.get(id) || id)
          return { MethodID: r.id, SubjectID: r.subject_id, SubjectName: methodSubjectNames[0] || r.subject_id,
            SubjectIDs: methodSubjectIds, SubjectNames: methodSubjectNames,
            UpiID: r.upi_id, PaymentLink: r.payment_link, QRPath: r.qr_path, QRUrl: signed.data?.signedUrl || '',
            Status: r.status, ReviewNote: r.review_note, CreatedAt: r.created_at }
        }))
        return response({ ok: true, data: { subjects: (subjects || []).map((s) => ({ SubjectID: s.id, SubjectName: s.name })), methods: result } })
      }
      const rawSubjectIds: unknown[] = Array.isArray(payload.subjectIds) ? payload.subjectIds : [payload.subjectId]
      const subjectIds: string[] = [...new Set(rawSubjectIds.map((id: unknown) => String(id || '').trim()).filter(Boolean))]
      if (!subjectIds.length || subjectIds.length > 50 || subjectIds.some((id) => id.length > 40)) throw new ApiFault('BAD_REQUEST', 'Select one or more subjects.')
      const { data: assignments, error: assignmentError } = await admin.from('student_subjects').select('subject_id').eq('teacher_id', user.linked_id).in('subject_id', subjectIds).ilike('status', 'active')
      if (assignmentError) throw assignmentError
      const assignedIds = new Set((assignments || []).map((row) => row.subject_id))
      if (subjectIds.some((id) => !assignedIds.has(id))) throw new ApiFault('BAD_REQUEST', 'Choose only subjects currently assigned to you.')
      const upiId = String(payload.upiId || '').trim().slice(0, 100)
      const paymentLink = String(payload.paymentLink || '').trim().slice(0, 500)
      if (paymentLink && !/^(https:\/\/|upi:\/\/)/i.test(paymentLink)) throw new ApiFault('BAD_REQUEST', 'Payment link must start with https:// or upi://.')
      let qrPath = ''
      if (payload.qrBase64) {
        const mime = String(payload.qrMime || '').toLowerCase()
        const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as Record<string, string>)[mime]
        if (!ext) throw new ApiFault('BAD_REQUEST', 'QR image must be PNG, JPG, or WebP.')
        const encoded = String(payload.qrBase64).replace(/^data:[^,]+,/, '')
        if (encoded.length > 2100000) throw new ApiFault('BAD_REQUEST', 'QR image must be 1.5 MB or smaller.')
        let bytes: Uint8Array
        try { bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)) } catch { throw new ApiFault('BAD_REQUEST', 'The QR image could not be read.') }
        if (bytes.length > 1572864) throw new ApiFault('BAD_REQUEST', 'QR image must be 1.5 MB or smaller.')
        qrPath = `${user.linked_id}/${crypto.randomUUID()}.${ext}`
        const { error: uploadError } = await admin.storage.from('teacher-payment-qr').upload(qrPath, bytes, { contentType: mime, upsert: false })
        if (uploadError) throw uploadError
      }
      if (!upiId && !paymentLink && !qrPath) throw new ApiFault('BAD_REQUEST', 'Enter a UPI ID, payment link, or upload a QR image.')
      const { data, error } = await admin.from('teacher_payment_methods').insert({ teacher_id: user.linked_id, subject_id: subjectIds[0], subject_ids: subjectIds,
        upi_id: upiId, payment_link: paymentLink, qr_path: qrPath, status: 'PENDING' }).select('id,status').single()
      if (error) throw error
      await logAction(admin, user, 'SUBMIT_PAYMENT_METHOD', 'TEACHER_PAYMENT_METHOD', data.id, { subjectIds })
      return response({ ok: true, data: { MethodID: data.id, Status: data.status } })
    }

    if (action === 'paymentMethods.adminList') {
      const { data: rows, error } = await admin.from('teacher_payment_methods').select('*').order('created_at', { ascending: false }).limit(500)
      if (error) throw error
      const teacherIds = [...new Set((rows || []).map((r) => r.teacher_id))], subjectIds = [...new Set((rows || []).flatMap((r) => Array.isArray(r.subject_ids) && r.subject_ids.length ? r.subject_ids : [r.subject_id]))]
      const [{ data: teachers }, { data: subjects }] = await Promise.all([
        teacherIds.length ? admin.from('teachers').select('id,name').in('id', teacherIds) : { data: [] },
        subjectIds.length ? admin.from('subjects').select('id,name').in('id', subjectIds) : { data: [] },
      ])
      const tm = new Map((teachers || []).map((x) => [x.id, x.name])), sm = new Map((subjects || []).map((x) => [x.id, x.name]))
      const result = await Promise.all((rows || []).map(async (r) => {
        const signed = r.qr_path ? await admin.storage.from('teacher-payment-qr').createSignedUrl(r.qr_path, 3600) : { data: null }
        const methodSubjectIds: string[] = Array.isArray(r.subject_ids) && r.subject_ids.length ? r.subject_ids as string[] : [r.subject_id]
        const methodSubjectNames = methodSubjectIds.map((id: string) => sm.get(id) || id)
        return { MethodID: r.id, TeacherID: r.teacher_id, TeacherName: tm.get(r.teacher_id) || r.teacher_id,
          SubjectID: r.subject_id, SubjectName: methodSubjectNames[0] || r.subject_id, SubjectIDs: methodSubjectIds, SubjectNames: methodSubjectNames, UpiID: r.upi_id,
          PaymentLink: r.payment_link, QRUrl: signed.data?.signedUrl || '', Status: r.status,
          ReviewNote: r.review_note, CreatedAt: r.created_at }
      }))
      return response({ ok: true, data: result })
    }

    if (action === 'paymentMethods.review') {
      const id = requireText(payload.methodId, 'Payment option', 60, true), decision = String(payload.decision || '').toUpperCase()
      if (!['APPROVED','REJECTED'].includes(decision)) throw new ApiFault('BAD_REQUEST', 'Choose approve or reject.')
      const { data: method, error: methodError } = await admin.from('teacher_payment_methods').select('teacher_id,subject_id,subject_ids').eq('id', id).eq('status', 'PENDING').maybeSingle()
      if (methodError) throw methodError
      if (!method) throw new ApiFault('CONFLICT', 'This payment option has already been reviewed. Refresh the list.')
      const { data, error } = await admin.from('teacher_payment_methods').update({ status: decision, review_note: String(payload.note || '').trim().slice(0, 300), reviewed_by: user.id, reviewed_at: new Date().toISOString() })
        .eq('id', id).eq('status', 'PENDING').select('id').maybeSingle()
      if (error) throw error
      if (!data) throw new ApiFault('CONFLICT', 'This payment option has already been reviewed. Refresh the list.')
      if (decision === 'APPROVED') {
        const coveredSubjectIds = Array.isArray(method.subject_ids) && method.subject_ids.length ? method.subject_ids : [method.subject_id]
        const { data: overlapping, error: overlapError } = await admin.from('teacher_payment_methods').select('id,subject_id,subject_ids')
          .eq('teacher_id', method.teacher_id).overlaps('subject_ids', coveredSubjectIds).eq('status', 'APPROVED').neq('id', id)
        if (overlapError) throw overlapError
        for (const previous of overlapping || []) {
          const previousSubjects = Array.isArray(previous.subject_ids) && previous.subject_ids.length ? previous.subject_ids : [previous.subject_id]
          const remainingSubjects = previousSubjects.filter((subjectId) => !coveredSubjectIds.includes(subjectId))
          const replacement = remainingSubjects.length
            ? { subject_ids: remainingSubjects, subject_id: remainingSubjects[0] }
            : { status: 'REJECTED', review_note: 'Replaced by a newer approved option.', reviewed_by: user.id, reviewed_at: new Date().toISOString() }
          const { error: updateError } = await admin.from('teacher_payment_methods').update(replacement).eq('id', previous.id).eq('status', 'APPROVED')
          if (updateError) throw updateError
        }
      }
      await logAction(admin, user, `PAYMENT_METHOD_${decision}`, 'TEACHER_PAYMENT_METHOD', id, {})
      return response({ ok: true, data: { ok: true } })
    }

    if (action === 'student.paymentSubmit') {
      if (user.user_type !== 'STUDENT' || !user.linked_id) throw new ApiFault('FORBIDDEN', 'This action is only available in the student portal.')
      const invoiceId = requireText(payload.invoiceId, 'Invoice', 60, true), methodId = requireText(payload.methodId, 'Payment option', 60, true)
      const reference = requireText(payload.reference, 'Transaction reference', 100, true)
      const submitted: Array<{ subjectId: string; amount: number }> = Array.isArray(payload.allocations) && payload.allocations.length
        ? payload.allocations.map((value: unknown) => {
          const item = value && typeof value === 'object' ? value as Record<string, unknown> : {}
          return {
            subjectId: requireText(item.subjectId, 'Subject', 40, true),
            amount: Math.round(Number(item.amount) * 100) / 100,
          }
        })
        : [{ subjectId: requireText(payload.subjectId, 'Subject', 40, true), amount: Math.round(Number(payload.amount) * 100) / 100 }]
      if (submitted.length > 20 || submitted.some((item) => !Number.isFinite(item.amount) || item.amount < 1) ||
          new Set(submitted.map((item) => item.subjectId)).size !== submitted.length)
        throw new ApiFault('BAD_REQUEST', 'Select unique subjects and enter a valid amount for each.')
      const [{ data: invoice }, { data: method }, { data: pending }] = await Promise.all([
        admin.from('invoices').select('*').eq('id', invoiceId).eq('student_id', user.linked_id).maybeSingle(),
        admin.from('teacher_payment_methods').select('id,teacher_id,subject_id,subject_ids,status').eq('id', methodId).maybeSingle(),
        admin.from('payment_submissions').select('id,allocations').eq('invoice_id', invoiceId).eq('student_id', user.linked_id).eq('status', 'PENDING').limit(100),
      ])
      if (!invoice || String(invoice.status).toUpperCase() === 'CANCELLED') throw new ApiFault('NOT_FOUND', 'Invoice not found.')
      const methodSubjectIds = method && Array.isArray(method.subject_ids) && method.subject_ids.length ? method.subject_ids : (method ? [method.subject_id] : [])
      const subjectIds = submitted.map((item) => item.subjectId)
      if (!method || method.status !== 'APPROVED' || subjectIds.some((subjectId) => !methodSubjectIds.includes(subjectId)))
        throw new ApiFault('BAD_REQUEST', 'This payment option is no longer available for one or more selected subjects. Refresh the invoice.')
      const { data: assignments, error: assignmentError } = await admin.from('student_subjects').select('subject_id')
        .eq('student_id', user.linked_id).eq('teacher_id', method.teacher_id).in('subject_id', subjectIds).ilike('status', 'active')
      if (assignmentError) throw assignmentError
      const assignedSubjects = new Set((assignments || []).map((row) => String(row.subject_id)))
      if (subjectIds.some((subjectId) => !assignedSubjects.has(subjectId)))
        throw new ApiFault('BAD_REQUEST', 'One or more subjects are not currently assigned to this teacher for you.')
      if ((pending || []).some((claim) => allocationsFromPayment(claim.allocations).some((allocation) => subjectIds.includes(String(allocation.subjectId)))))
        throw new ApiFault('CONFLICT', 'A payment for one or more selected subjects is already awaiting review.')
      const invoiceLines = normalizedInvoiceLines(invoice)
      const allocations = submitted.map((item) => {
        const line = invoiceLines.find((row) => String(row.subjectId) === item.subjectId)
        if (!line || item.amount > Number(line.balanceAmount) + 0.005)
          throw new ApiFault('BAD_REQUEST', 'An amount exceeds its subject balance. Refresh the invoice and try again.')
        return { subjectId: item.subjectId, subjectName: String(line.subjectName || item.subjectId), amount: item.amount }
      })
      const amount = Math.round(allocations.reduce((sum, allocation) => sum + allocation.amount, 0) * 100) / 100
      const { data, error } = await admin.from('payment_submissions').insert({ invoice_id: invoiceId, student_id: user.linked_id,
        amount, payment_mode: String(payload.mode || 'UPI').toUpperCase() === 'BANK_TRANSFER' ? 'BANK_TRANSFER' : 'UPI',
        transaction_reference: reference, allocations, status: 'PENDING' }).select('id').single()
      if (error) throw error
      return response({ ok: true, data: { SubmissionID: data.id, Status: 'PENDING' } })
    }

    if (action === 'paymentSubmissions.adminList') {
      let query = admin.from('payment_submissions').select('*').order('created_at', { ascending: false }).limit(500)
      if (payload.status) query = query.eq('status', String(payload.status).toUpperCase())
      const { data: rows, error } = await query
      if (error) throw error
      const studentIds = [...new Set((rows || []).map((r) => r.student_id))], invoiceIds = [...new Set((rows || []).map((r) => r.invoice_id))]
      const [{ data: students }, { data: invoices }] = await Promise.all([
        studentIds.length ? admin.from('students').select('id,name,current_class,current_batch_id').in('id', studentIds) : { data: [] },
        invoiceIds.length ? admin.from('invoices').select('id,month').in('id', invoiceIds) : { data: [] },
      ])
      const batchIds = [...new Set((students || []).map((s) => s.current_batch_id).filter(Boolean))]
      const { data: batches } = batchIds.length ? await admin.from('batches').select('id,name').in('id', batchIds) : { data: [] }
      const sm = new Map((students || []).map((x) => [x.id, x])), im = new Map((invoices || []).map((x) => [x.id, x])), bm = new Map((batches || []).map((x) => [x.id, x.name]))
      return response({ ok: true, data: (rows || []).map((r) => { const s = sm.get(r.student_id); return { SubmissionID: r.id,
        InvoiceID: r.invoice_id, Month: im.get(r.invoice_id)?.month || '', StudentID: r.student_id, StudentName: s?.name || r.student_id,
        Class: s?.current_class || '', BatchName: bm.get(s?.current_batch_id) || '', Amount: Number(r.amount), Mode: r.payment_mode,
        Reference: r.transaction_reference, Allocations: allocationsFromPayment(r.allocations), Status: r.status, ReviewNote: r.review_note, CreatedAt: r.created_at } }) })
    }

    if (action === 'paymentSubmissions.review') {
      const id = requireText(payload.submissionId, 'Submission', 60, true), decision = String(payload.decision || '').toUpperCase()
      if (!['APPROVED','REJECTED'].includes(decision)) throw new ApiFault('BAD_REQUEST', 'Choose approve or reject.')
      const { data: claim, error: claimError } = await admin.from('payment_submissions').update({ status: decision === 'APPROVED' ? 'PROCESSING' : 'REJECTED',
        review_note: String(payload.note || '').trim().slice(0, 300), reviewed_by: user.id, reviewed_at: new Date().toISOString() })
        .eq('id', id).eq('status', 'PENDING').select('*').maybeSingle()
      if (claimError) throw claimError
      if (!claim) throw new ApiFault('CONFLICT', 'This submission has already been reviewed. Refresh the list.')
      if (decision === 'REJECTED') return response({ ok: true, data: { Status: 'REJECTED' } })
      try {
        const { data: invoice } = await admin.from('invoices').select('academic_year').eq('id', claim.invoice_id).maybeSingle()
        const paymentId = await newId(admin, 'payments', 'PAY-', 5), receiptId = await newId(admin, 'receipts', `CMZ-${todayDate().replaceAll('-', '')}-`, 3)
        const { data: result, error } = await admin.rpc('record_payment_transaction', { p_payment_id: paymentId, p_receipt_id: receiptId,
          p_invoice_id: claim.invoice_id, p_payment_date: todayDate(), p_payment_mode: claim.payment_mode,
          p_transaction_reference: claim.transaction_reference, p_notes: '', p_academic_year: invoice?.academic_year || '2026-27',
          p_received_by: user.id, p_allocations: claim.allocations, p_receipt_format: 'A5' })
        if (error) throw error
        const { error: updateError } = await admin.from('payment_submissions').update({ status: 'APPROVED', payment_id: paymentId,
          reviewed_at: new Date().toISOString() }).eq('id', id).eq('status', 'PROCESSING')
        if (updateError) throw updateError
        await logAction(admin, user, 'VERIFY_STUDENT_PAYMENT', 'PAYMENT_SUBMISSION', id, { paymentId, receiptId })
        return response({ ok: true, data: { Status: 'APPROVED', PaymentID: paymentId, ReceiptID: receiptId, ...result } })
      } catch (error) {
        await admin.from('payment_submissions').update({ status: 'PENDING', reviewed_by: null, reviewed_at: null }).eq('id', id).eq('status', 'PROCESSING')
        throw error
      }
    }

    if (action === 'receipts.list') {
      const search = String(payload.search || '').trim().toLowerCase().slice(0, 100)
      const from = requireText(payload.from, 'From date', 10), to = requireText(payload.to, 'To date', 10)
      const limit = Math.min(Math.max(Number.parseInt(payload.limit, 10) || 200, 1), 1000)
      // Narrow by search in the database first (receipt number, or students whose
      // name/ID matches); the exact text match below still decides the result.
      const term = safeSearch(search)
      let matchedStudentIds: string[] | null = null
      if (term) {
        const hits = await fetchAll(() => admin.from('students').select('id')
          .or(`name.ilike."%${term}%",id.ilike."%${term}%"`).order('id'), 1000, 2000)
        matchedStudentIds = hits.length <= 300 ? hits.map((s) => s.id) : null // too many: skip the shortcut
      }
      const data = await fetchAll(() => {
        let query = admin.from('receipts').select('id,payment_id,student_id,receipt_date,amount,status,created_by')
          .order('receipt_date', { ascending: false }).order('id', { ascending: false })
        if (from) query = query.gte('receipt_date', from)
        if (to) query = query.lte('receipt_date', to)
        if (term && matchedStudentIds) query = query.or(matchedStudentIds.length
          ? `id.ilike."%${term}%",student_id.in.(${matchedStudentIds.map((id) => `"${id}"`).join(',')})` : `id.ilike."%${term}%"`)
        return query
      }, 1000, 5000)
      const allStudents = await selectIn((data || []).map((r) => r.student_id),
        (chunk) => admin.from('students').select('id,name,current_batch_id').in('id', chunk))
      const names = new Map(allStudents.map((s) => [s.id, s.name]))
      const rows = (data || []).filter((r) => !search || r.id.toLowerCase().includes(search) || r.student_id.toLowerCase().includes(search) ||
        String(names.get(r.student_id) || '').toLowerCase().includes(search)).slice(0, limit)
      // Only now load the extra details, and only for the rows actually shown.
      const payments = await selectIn(rows.map((r) => r.payment_id), (chunk) => admin.from('payments').select('id,allocations').in('id', chunk))
      const students = allStudents.filter((s) => rows.some((r) => r.student_id === s.id))
      const batchIds = [...new Set(students.map((s) => s.current_batch_id).filter(Boolean))]
      const batches = await selectIn(batchIds, (chunk) => admin.from('batches').select('id,name').in('id', chunk))
      const studentMap = new Map(students.map((s) => [s.id, s]))
      const batchNames = new Map(batches.map((b) => [b.id, b.name]))
      const allocationLabels = new Map((payments || []).map((p) => [p.id, allocationsFromPayment(p.allocations).map((a) => a.subjectName).join(', ')]))
      return response({ ok: true, data: rows.map((r) => ({ ReceiptID: r.id, StudentID: r.student_id,
        StudentName: names.get(r.student_id) || r.student_id,
        CurrentBatchName: batchNames.get(studentMap.get(r.student_id)?.current_batch_id) || '', ReceiptDate: r.receipt_date, Amount: Number(r.amount),
        Classes: allocationLabels.get(r.payment_id) || '', Status: r.status, CreatedBy: r.created_by || '' })) })
    }

    if (action === 'receipts.get') {
      const id = requireText(payload.receiptId, 'Receipt ID', 60, true)
      const { data: receipt, error } = await admin.from('receipts').select('*').eq('id', id).maybeSingle()
      if (error) throw error
      if (!receipt) throw new ApiFault('NOT_FOUND', 'Receipt not found.')
      const [{ data: payment }, { data: student }, { data: settings }] = await Promise.all([
        admin.from('payments').select('*').eq('id', receipt.payment_id).maybeSingle(),
        admin.from('students').select('*').eq('id', receipt.student_id).maybeSingle(),
        admin.from('settings').select('setting_key,value').in('setting_key', ['CENTRE_NAME','TAGLINE','ADDRESS','MOBILE','EMAIL','WEBSITE','ACADEMIC_YEAR']),
      ])
      const creatorId = receipt.created_by || payment?.received_by || null
      const { data: creator } = creatorId
        ? await admin.from('app_users').select('username,user_type,linked_id').eq('id', creatorId).maybeSingle()
        : { data: null }
      let creatorName = creator?.username || ''
      if (creator?.user_type === 'TEACHER' && creator.linked_id) {
        const { data: teacher } = await admin.from('teachers').select('name').eq('id', creator.linked_id).maybeSingle()
        creatorName = teacher?.name || creatorName
      }
      const { data: currentBatch } = student?.current_batch_id
        ? await admin.from('batches').select('name').eq('id', student.current_batch_id).maybeSingle() : { data: null }
      const settingMap = Object.fromEntries((settings || []).map((r) => [r.setting_key, r.value]))
      let invoiceData = null
      if (payment?.invoice_id) {
        const { data: inv } = await admin.from('invoices').select('*').eq('id', payment.invoice_id).maybeSingle()
        if (inv) invoiceData = { InvoiceID: inv.id, Month: inv.month, MonthLabel: monthLabel(inv.month),
          LineItems: normalizedInvoiceLines(inv), TotalAmount: Number(inv.total_amount), PaidAmount: Number(inv.paid_amount), BalanceAmount: Number(inv.balance_amount) }
      }
      const [{ data: replacement }, { data: original }] = await Promise.all([
        admin.from('receipts').select('id').eq('reissue_of', id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
        receipt.reissue_of ? admin.from('receipts').select('id').eq('id', receipt.reissue_of).maybeSingle() : Promise.resolve({ data: null }),
      ])
      return response({ ok: true, data: { receipt: { ReceiptID: receipt.id, ReceiptDate: receipt.receipt_date,
        Amount: Number(receipt.amount), Status: receipt.status, Format: receipt.format, CreatedBy: creatorName,
        CreatedAt: receipt.created_at, VoidedBy: receipt.voided_by, VoidDate: receipt.void_date, VoidReason: receipt.void_reason,
        ReissueOf: original?.id || '', ReissuedBy: replacement?.id || '' },
        payment: payment ? { PaymentID: payment.id, Mode: payment.payment_mode, Reference: payment.transaction_reference,
          Notes: payment.notes, PaymentDate: payment.payment_date, Allocations: allocationsFromPayment(payment.allocations) } : null,
        invoice: invoiceData, student: student ? { StudentID: student.id, Name: student.name, CurrentClass: student.current_class,
          CurrentBatch: student.current_batch_id, CurrentBatchName: currentBatch?.name || '', ParentName: student.parent_name,
          ParentMobile: student.parent_mobile || '', ParentWhatsApp: student.parent_whatsapp || '', Mobile: student.mobile || student.parent_mobile } : null,
        centre: { name: settingMap.CENTRE_NAME || 'Creative Math Zone', tagline: settingMap.TAGLINE || '', address: settingMap.ADDRESS || '',
          mobile: settingMap.MOBILE || '', email: settingMap.EMAIL || '', website: settingMap.WEBSITE || '',
          academicYear: settingMap.ACADEMIC_YEAR || '2026-27' } } })
    }

    if (action === 'receipts.void') {
      const id = requireText(payload.receiptId, 'Receipt ID', 60, true)
      const reason = requireText(payload.reason, 'Reason', 200, true)
      const { data, error } = await admin.rpc('void_receipt_transaction', { p_receipt_id: id, p_voided_by: user.id, p_reason: reason })
      if (error) {
        if (error.message.includes('not found')) throw new ApiFault('NOT_FOUND', 'Receipt not found.')
        if (error.message.includes('reason')) throw new ApiFault('BAD_REQUEST', 'Please give a reason for voiding.')
        throw error
      }
      if (!data?.unchanged) {
        await logAction(admin, user, 'VOID_PAYMENT', 'PAYMENT', String(data?.paymentId || id), { reason })
        await logAction(admin, user, 'VOID_RECEIPT', 'RECEIPT', id, { reason })
      }
      return response({ ok: true, data: { ok: true, unchanged: !!data?.unchanged } })
    }

    if (action === 'student.invoices') {
      if (user.user_type !== 'STUDENT' || !user.linked_id) throw new ApiFault('FORBIDDEN', 'This action is only available in the student portal.')
      const [{ data: invoices, error }, { data: payments, error: paymentsError }] = await Promise.all([
        admin.from('invoices').select('*').eq('student_id', user.linked_id).order('month', { ascending: false }).limit(500),
        admin.from('payments').select('*').eq('student_id', user.linked_id).neq('status', 'VOID').order('payment_date', { ascending: false }).limit(1000),
      ])
      if (error || paymentsError) throw error || paymentsError
      const paymentsByInvoice = new Map<string, any[]>()
      for (const p of payments || []) if (p.invoice_id) paymentsByInvoice.set(p.invoice_id, [...(paymentsByInvoice.get(p.invoice_id) || []), p])
      const rows = (invoices || []).filter((inv) => String(inv.status).toUpperCase() !== 'CANCELLED').map((inv) => {
        const total = Number(inv.total_amount) || 0, paid = Number(inv.paid_amount) || 0
        return { InvoiceID: inv.id, Month: inv.month, MonthLabel: monthLabel(inv.month), TotalAmount: total,
          PaidAmount: paid, BalanceAmount: Math.max(0, total - paid), DueDate: inv.due_date,
          Status: invoiceStatus(total, paid, inv.due_date, inv.status), Lines: normalizedInvoiceLines(inv),
          Payments: (paymentsByInvoice.get(inv.id) || []).map((p) => ({ PaymentDate: p.payment_date, Amount: Number(p.amount) || 0,
            PaymentMode: p.payment_mode, ReceiptID: p.receipt_id, Allocations: allocationsFromPayment(p.allocations) })) }
      })
      const totals = { billed: 0, paid: 0, balance: 0, overdue: 0 }
      for (const row of rows) {
        totals.billed += row.TotalAmount; totals.paid += row.PaidAmount; totals.balance += row.BalanceAmount
        if (row.Status === 'OVERDUE') totals.overdue += row.BalanceAmount
      }
      return response({ ok: true, data: { rows, totals } })
    }

    if (action === 'student.receipt') {
      if (user.user_type !== 'STUDENT' || !user.linked_id) throw new ApiFault('FORBIDDEN', 'This action is only available in the student portal.')
      const id = requireText(payload.receiptId, 'Receipt ID', 60, true)
      const { data: receipt, error } = await admin.from('receipts').select('*').eq('id', id).eq('student_id', user.linked_id).maybeSingle()
      if (error) throw error
      if (!receipt || String(receipt.status).toUpperCase() === 'VOID') throw new ApiFault('NOT_FOUND', 'Receipt not found.')
      const [{ data: payment }, { data: student }, { data: settings }] = await Promise.all([
        admin.from('payments').select('*').eq('id', receipt.payment_id).maybeSingle(),
        admin.from('students').select('*').eq('id', receipt.student_id).maybeSingle(),
        admin.from('settings').select('setting_key,value').in('setting_key', ['CENTRE_NAME','TAGLINE','ADDRESS','MOBILE','EMAIL','WEBSITE','ACADEMIC_YEAR']),
      ])
      const values = Object.fromEntries((settings || []).map((r) => [r.setting_key, r.value]))
      let invoice = null
      if (payment?.invoice_id) {
        const { data: inv } = await admin.from('invoices').select('*').eq('id', payment.invoice_id).maybeSingle()
        if (inv && String(inv.status).toUpperCase() !== 'CANCELLED') invoice = { InvoiceID: inv.id, Month: inv.month,
          MonthLabel: monthLabel(inv.month), LineItems: normalizedInvoiceLines(inv), TotalAmount: Number(inv.total_amount),
          PaidAmount: Number(inv.paid_amount), BalanceAmount: Number(inv.balance_amount) }
      }
      return response({ ok: true, data: { receipt: { ReceiptID: receipt.id, ReceiptDate: receipt.receipt_date,
        Amount: Number(receipt.amount), Status: receipt.status, Format: receipt.format, CreatedBy: '', CreatedAt: receipt.created_at,
        VoidedBy: '', VoidDate: '', VoidReason: '' }, payment: payment ? { PaymentID: payment.id,
          Mode: payment.payment_mode, Reference: payment.transaction_reference,
          PaymentDate: payment.payment_date, Allocations: allocationsFromPayment(payment.allocations) } : null,
        invoice, student: student ? { StudentID: student.id, Name: student.name, CurrentClass: student.current_class,
          CurrentBatch: student.current_batch_id, ParentName: student.parent_name, Mobile: student.mobile || student.parent_mobile } : null,
        centre: { name: values.CENTRE_NAME || 'Creative Math Zone', tagline: values.TAGLINE || '', address: values.ADDRESS || '',
          mobile: values.MOBILE || '', email: values.EMAIL || '', website: values.WEBSITE || '', academicYear: values.ACADEMIC_YEAR || '2026-27' } } })
    }

    if (action === 'student.invoiceDoc') {
      if (user.user_type !== 'STUDENT' || !user.linked_id) throw new ApiFault('FORBIDDEN', 'This action is only available in the student portal.')
      const id = requireText(payload.invoiceId, 'Invoice ID', 60, true)
      const [{ data: invoice, error }, { data: payments, error: paymentsError }, { data: student }, { data: settings }, { data: pendingSubmissions, error: pendingError }] = await Promise.all([
        admin.from('invoices').select('*').eq('id', id).eq('student_id', user.linked_id).maybeSingle(),
        admin.from('payments').select('*').eq('invoice_id', id).eq('student_id', user.linked_id).neq('status', 'VOID').order('payment_date'),
        admin.from('students').select('id,name,current_class,parent_name').eq('id', user.linked_id).maybeSingle(),
        admin.from('settings').select('setting_key,value').in('setting_key', ['CENTRE_NAME','TAGLINE','ADDRESS','MOBILE','EMAIL','WEBSITE','ACADEMIC_YEAR']),
        admin.from('payment_submissions').select('allocations,amount,transaction_reference,created_at').eq('invoice_id', id).eq('student_id', user.linked_id).eq('status', 'PENDING'),
      ])
      if (error || paymentsError || pendingError) throw error || paymentsError || pendingError
      if (!invoice || String(invoice.status).toUpperCase() === 'CANCELLED') throw new ApiFault('NOT_FOUND', 'Invoice not found.')
      const total = Number(invoice.total_amount) || 0, paid = Number(invoice.paid_amount) || 0
      const values = Object.fromEntries((settings || []).map((r) => [r.setting_key, r.value]))
      const subjectIds = normalizedInvoiceLines(invoice).map((l) => String(l.subjectId)).filter(Boolean)
      const { data: assignments, error: assignmentError } = await admin.from('student_subjects').select('subject_id,teacher_id')
        .eq('student_id', user.linked_id).in('subject_id', subjectIds.length ? subjectIds : ['__none__']).ilike('status', 'active')
      if (assignmentError) throw assignmentError
      const pairs = [...new Map((assignments || []).filter((a) => a.teacher_id).map((a) => [`${a.teacher_id}:${a.subject_id}`, a])).values()]
      const { data: methods, error: methodsError } = pairs.length
        ? await admin.from('teacher_payment_methods').select('id,teacher_id,subject_id,subject_ids,upi_id,payment_link,qr_path,status').eq('status', 'APPROVED')
          .in('teacher_id', [...new Set(pairs.map((a) => a.teacher_id))]).overlaps('subject_ids', [...new Set(pairs.map((a) => a.subject_id))])
        : { data: [], error: null }
      if (methodsError) throw methodsError
      const pairSet = new Set(pairs.map((a) => `${a.teacher_id}:${a.subject_id}`))
      const { data: teachers } = pairs.length ? await admin.from('teachers').select('id,name').in('id', [...new Set(pairs.map((a) => a.teacher_id))]) : { data: [] }
      const teacherNames = new Map((teachers || []).map((t) => [t.id, t.name]))
      const paymentOptions = await Promise.all((methods || []).filter((m) => (Array.isArray(m.subject_ids) && m.subject_ids.length ? m.subject_ids : [m.subject_id]).some((subjectId) => pairSet.has(`${m.teacher_id}:${subjectId}`))).map(async (m) => {
        const signed = m.qr_path ? await admin.storage.from('teacher-payment-qr').createSignedUrl(m.qr_path, 3600) : { data: null }
        const coveredSubjectIds = Array.isArray(m.subject_ids) && m.subject_ids.length ? m.subject_ids : [m.subject_id]
        return { MethodID: m.id, SubjectID: m.subject_id, SubjectIDs: coveredSubjectIds, TeacherID: m.teacher_id, TeacherName: teacherNames.get(m.teacher_id) || '',
          UpiID: m.upi_id, PaymentLink: m.payment_link, QRUrl: signed.data?.signedUrl || '' }
      }))
      return response({ ok: true, data: { invoice: { InvoiceID: invoice.id, Month: invoice.month, MonthLabel: monthLabel(invoice.month),
        DueDate: invoice.due_date, Status: invoiceStatus(total, paid, invoice.due_date, invoice.status), TotalAmount: total,
        PaidAmount: paid, BalanceAmount: Math.max(0, total - paid) }, lines: normalizedInvoiceLines(invoice),
        payments: (payments || []).map((p) => ({ PaymentDate: p.payment_date, Amount: Number(p.amount) || 0,
          PaymentMode: p.payment_mode, ReceiptID: p.receipt_id, Allocations: allocationsFromPayment(p.allocations) })),
        pendingSubmissions: (pendingSubmissions || []).map((p) => ({ Amount: Number(p.amount) || 0, Reference: p.transaction_reference,
          CreatedAt: p.created_at, Allocations: allocationsFromPayment(p.allocations) })),
        paymentOptions,
        student: student ? { StudentID: student.id, Name: student.name, CurrentClass: student.current_class, ParentName: student.parent_name } : null,
        centre: { name: values.CENTRE_NAME || 'Creative Math Zone', tagline: values.TAGLINE || '', address: values.ADDRESS || '',
          mobile: values.MOBILE || '', email: values.EMAIL || '', website: values.WEBSITE || '', academicYear: values.ACADEMIC_YEAR || '2026-27' } } })
    }

    if (action === 'promotions.fees.list') {
      const board = requireText(payload.board, 'Board', 30, true)
      const targetClass = requireText(payload.targetClass, 'Target class', 10, true)
      const academicYear = requireText(payload.academicYear, 'Academic year', 10, true)
      const { data, error } = await admin.from('promotion_fee_rates').select('id,board,target_class,subject_id,academic_year,amount')
        .ilike('board', board).ilike('target_class', targetClass).eq('academic_year', academicYear)
      if (error) throw error
      return response({ ok: true, data: (data || []).map(r => ({ RateID: r.id, Board: r.board, TargetClass: r.target_class,
        SubjectID: r.subject_id, AcademicYear: r.academic_year, Amount: Number(r.amount) })) })
    }

    if (action === 'promotions.fees.save') {
      const board = requireText(payload.board, 'Board', 30, true).toUpperCase()
      const targetClass = requireText(payload.targetClass, 'Target class', 10, true).toUpperCase()
      const academicYear = requireText(payload.academicYear, 'Academic year', 10, true)
      const subjectId = requireText(payload.subjectId, 'Subject', 40, true)
      const amount = Number(payload.amount)
      if (!Number.isFinite(amount) || amount < 0 || amount > 100000) throw new ApiFault('BAD_REQUEST', 'Suggested fee must be from 0 to 100000.')
      const { data: subject, error: subjectError } = await admin.from('subjects').select('id').eq('id', subjectId).maybeSingle()
      if (subjectError) throw subjectError
      if (!subject) throw new ApiFault('NOT_FOUND', 'Subject not found.')
      const { error } = await admin.from('promotion_fee_rates').upsert({ id: `PFR-${crypto.randomUUID()}`,
        board, target_class: targetClass, subject_id: subjectId, academic_year: academicYear, amount, updated_at: new Date().toISOString() },
        { onConflict: 'board,target_class,subject_id,academic_year' })
      if (error) throw error
      await logAction(admin, user, 'SET_PROMOTION_FEE', 'PROMOTION_FEE', `${board}:${targetClass}:${subjectId}:${academicYear}`, { amount })
      return response({ ok: true, data: { saved: true } })
    }

    if (action === 'promotions.fees.delete') {
      const board = requireText(payload.board, 'Board', 30, true).toUpperCase()
      const targetClass = requireText(payload.targetClass, 'Target class', 10, true).toUpperCase()
      const academicYear = requireText(payload.academicYear, 'Academic year', 10, true)
      const subjectId = requireText(payload.subjectId, 'Subject', 40, true)
      const { error } = await admin.from('promotion_fee_rates').delete().ilike('board', board)
        .ilike('target_class', targetClass).eq('academic_year', academicYear).eq('subject_id', subjectId)
      if (error) throw error
      await logAction(admin, user, 'CLEAR_PROMOTION_FEE', 'PROMOTION_FEE', `${board}:${targetClass}:${subjectId}:${academicYear}`, {})
      return response({ ok: true, data: { deleted: true } })
    }

    if (action === 'promotions.preview') {
      const board = requireText(payload.board, 'Board', 30, true)
      const sourceClass = requireText(payload.sourceClass, 'Current class', 10, true)
      const targetClass = requireText(payload.targetClass, 'Target class', 10, true)
      const academicYear = requireText(payload.academicYear, 'Academic year', 10, true)
      const [{ data: candidateStudents, error }, { data: subjects, error: subjectError },
        { data: rates, error: rateError }, { data: feeRows, error: feeError }, { data: currentYear }] = await Promise.all([
        admin.from('students').select('id,name,board,current_class,current_batch_id,academic_year,status')
          .ilike('current_class', sourceClass).ilike('status', 'ACTIVE').order('name').limit(5000),
        admin.from('subjects').select('id,name,status'),
        admin.from('promotion_fee_rates').select('subject_id,amount').in('board', [board, 'CBSE']).ilike('target_class', targetClass).eq('academic_year', academicYear),
        admin.from('fee_structure').select('subject_id,amount,academic_year').eq('item_type', 'SUBJECT').eq('status', 'Active'),
        admin.from('settings').select('value').eq('setting_key', 'ACADEMIC_YEAR').maybeSingle(),
      ])
      if (error || subjectError || rateError || feeError) throw error || subjectError || rateError || feeError
      const students = (candidateStudents || []).filter(s => {
        try { return canonicalStudentBoard(s.board, s.current_class).toUpperCase() === board.toUpperCase() } catch { return false }
      })
      const studentCount = students.length
      if ((studentCount || 0) > 500) throw new ApiFault('PROMOTION_LIMIT', `This group has ${studentCount} active students, above the 500-student limit. Narrow the promotion group or contact support before applying it.`)
      const studentIds = (students || []).map(s => s.id)
      let assignments: any[] = []
      let discounts: any[] = []
      if (studentIds.length) {
        const [{ data, error: assignmentError }, { data: discountRows, error: discountError }] = await Promise.all([
          admin.from('student_subjects').select('id,student_id,subject_id,teacher_id,batch_id,fee_override,teacher_rate_override,academic_year')
            .in('student_id', studentIds).ilike('status', 'ACTIVE').limit(30000),
          admin.from('student_fees').select('student_id,subject_id,discount_amount').in('student_id', studentIds)
            .eq('status', 'Active').is('effective_to', null),
        ])
        if (assignmentError || discountError) throw assignmentError || discountError
        assignments = data || []
        discounts = discountRows || []
      }
      const subjectNames = new Map((subjects || []).map(s => [s.id, s.name]))
      const suggestions = new Map((rates || []).map(r => [r.subject_id, Number(r.amount)]))
      const standardFees = new Map((feeRows || []).filter(r => r.academic_year === (currentYear?.value || '2026-27')).map(r => [r.subject_id, Number(r.amount)]))
      const discountByKey = new Map(discounts.map(r => [`${r.student_id}:${r.subject_id}`, Number(r.discount_amount) || 0]))
      const rows = (students || []).map(student => ({ StudentID: student.id, Name: student.name, Board: student.board,
        CurrentClass: student.current_class, CurrentBatch: student.current_batch_id || '', AcademicYear: student.academic_year || '',
        Subjects: (assignments || []).filter(a => a.student_id === student.id).map(a => ({ StudentSubjectID: a.id,
          SubjectID: a.subject_id, SubjectName: subjectNames.get(a.subject_id) || a.subject_id, TeacherID: a.teacher_id || '',
          BatchID: a.batch_id || '', CurrentFee: a.fee_override === null ? (standardFees.get(a.subject_id) || 0) : Number(a.fee_override),
          CurrentDiscount: discountByKey.get(`${student.id}:${a.subject_id}`) || 0,
          SuggestedFee: suggestions.has(a.subject_id) ? suggestions.get(a.subject_id) : null }))
      }))
      return response({ ok: true, data: { students: rows, subjects: (subjects || []).filter(s => s.status === 'Active')
        .map(s => ({ SubjectID: s.id, SubjectName: s.name })), feeRates: [...suggestions.entries()].map(([SubjectID, Amount]) => ({ SubjectID, Amount })) } })
    }

    if (action === 'promotions.apply') {
      const board = requireText(payload.board, 'Board', 30, true).toUpperCase()
      const sourceClass = requireText(payload.sourceClass, 'Current class', 10, true).toUpperCase()
      const targetClass = requireText(payload.targetClass, 'Target class', 10, true).toUpperCase()
      const batchId = requireText(payload.targetBatchId, 'Target batch', 40, true)
      const academicYear = requireText(payload.academicYear, 'Academic year', 10, true)
      const startDate = requireText(payload.startDate, 'Effective date', 10, true)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new ApiFault('BAD_REQUEST', 'Effective date must use yyyy-mm-dd.')
      if (!Array.isArray(payload.promotions) || !payload.promotions.length || payload.promotions.length > 500) throw new ApiFault('BAD_REQUEST', 'Select between 1 and 500 students.')
      const seen = new Set<string>()
      const promotions = payload.promotions.map((item: any) => {
        const studentId = requireText(item?.studentId, 'Student ID', 40, true)
        if (seen.has(studentId)) throw new ApiFault('BAD_REQUEST', 'A student was selected more than once.')
        seen.add(studentId)
        if (!Array.isArray(item.fees) || item.fees.length > 30) throw new ApiFault('BAD_REQUEST', 'Promotion fee details are invalid.')
        const feeIds = new Set<string>()
        const fees = item.fees.map((fee: any) => {
          const studentSubjectId = requireText(fee?.studentSubjectId, 'Subject assignment', 60, true)
          if (feeIds.has(studentSubjectId)) throw new ApiFault('BAD_REQUEST', 'A subject fee was repeated.')
          feeIds.add(studentSubjectId)
          const rawAmount = String(fee?.amount ?? '').trim()
          if (!rawAmount) throw new ApiFault('BAD_REQUEST', 'Enter a fee for every active subject. Use 0 when that subject is free.')
          const amount = Number(rawAmount)
          if (!Number.isFinite(amount) || amount < 0 || amount > 100000) throw new ApiFault('BAD_REQUEST', 'Each suggested fee must be from 0 to 100000.')
          return { studentSubjectId, amount }
        })
        return { studentId, fees }
      })
      if (sourceClass === targetClass) throw new ApiFault('BAD_REQUEST', 'Choose a different target class from the current class.')
      const { data: batch, error: batchError } = await admin.from('batches').select('id,class,status,academic_year').eq('id', batchId).maybeSingle()
      if (batchError) throw batchError
      if (!batch || batch.status !== 'Active' || String(batch.class).trim().toUpperCase() !== targetClass) throw new ApiFault('BAD_REQUEST', 'Choose an active batch for the target class.')
      if (String(batch.academic_year || '') !== academicYear) throw new ApiFault('BAD_REQUEST', 'The target batch academic year must match the promotion academic year.')
      const { data, error } = await admin.rpc('apply_student_promotions', { p_board: board, p_source_class: sourceClass,
        p_target_class: targetClass, p_target_batch_id: batchId, p_academic_year: academicYear, p_start_date: startDate,
        p_promotions: promotions, p_changed_by: user.id })
      if (error) throw new ApiFault('PROMOTION_FAILED', error.message || 'The promotion could not be applied. No changes were saved.')
      await logAction(admin, user, 'PROMOTE_STUDENTS', 'STUDENT', `${board}:${sourceClass}->${targetClass}`,
        { count: Number(data) || promotions.length, batchId, academicYear, startDate })
      return response({ ok: true, data: { promoted: Number(data) || promotions.length } })
    }

    if (action === 'students.get') {
      const id = String(payload.studentId || '').trim()
      if (!id) return response(fail('BAD_REQUEST', 'Student ID is required.'))
      const [{ data: student, error }, { data: subjects, error: subjectsError }, { data: linkedUser }] = await Promise.all([
        admin.from('students').select('*').eq('id', id).maybeSingle(),
        admin.from('student_subjects').select('*').eq('student_id', id).order('created_at', { ascending: false }),
        admin.from('app_users').select('id,username,user_type,role,status,linked_id').eq('user_type', 'STUDENT').eq('linked_id', id).maybeSingle(),
      ])
      if (error || subjectsError) throw error || subjectsError
      if (!student) return response(fail('NOT_FOUND', 'Student not found.'))
      return response({ ok: true, data: { student: legacyStudent(student),
        subjects: (subjects || []).map((r) => ({ StudentSubjectID: r.id, StudentID: r.student_id,
          SubjectID: r.subject_id, TeacherID: r.teacher_id, BatchID: r.batch_id, StartDate: r.start_date,
          EndDate: r.end_date, Status: r.status, FeeOverride: r.fee_override,
          TeacherRateOverride: r.teacher_rate_override, AcademicYear: r.academic_year, CreatedAt: r.created_at })),
        user: linkedUser ? { UserID: linkedUser.id, Username: linkedUser.username, UserType: linkedUser.user_type,
          Role: linkedUser.role, Status: linkedUser.status, LinkedID: linkedUser.linked_id } : null } })
    }

    if (action === 'students.add') {
      const input = payload.student && typeof payload.student === 'object' && !Array.isArray(payload.student) ? payload.student : null
      if (!input) throw new ApiFault('BAD_REQUEST', 'Provide the student details.')
      const row = validateStudentInput(input, false)
      if (row.current_batch_id) {
        const { data: batch } = await admin.from('batches').select('id,class,status').eq('id', row.current_batch_id).maybeSingle()
        if (!batch || batch.status !== 'Active') throw new ApiFault('BAD_REQUEST', 'Choose an active batch.')
        if (String(batch.class).toUpperCase() !== String(row.current_class).toUpperCase()) throw new ApiFault('BAD_REQUEST', 'The selected batch is for a different class.')
      }
      const { data: existing } = await admin.from('students').select('id').ilike('name', String(row.name)).eq('mobile', row.mobile || '').limit(1)
      if (existing?.length) throw new ApiFault('DUPLICATE', `A student with this name and mobile already exists (${existing[0].id}).`)
      const year = new Date().getFullYear()
      const { data: studentSettings } = await admin.from('settings').select('setting_key,value').in('setting_key', ['STUDENT_ID_PREFIX', 'ACADEMIC_YEAR'])
      const studentSettingMap = Object.fromEntries((studentSettings || []).map((r) => [r.setting_key, r.value]))
      const prefix = `${studentSettingMap.STUDENT_ID_PREFIX || 'CMZ'}-${year}-`
      const id = await newId(admin, 'students', prefix)
      const tempPassword = payload.password ? String(payload.password) : passwordTemp()
      if (tempPassword.length < 8 || tempPassword.length > 200) throw new ApiFault('BAD_PASSWORD', 'Password must be at least 8 characters.')
      const email = authEmailForUsername(id)
      const { data: created, error: authCreateError } = await admin.auth.admin.createUser({ email, password: tempPassword, email_confirm: true })
      if (authCreateError || !created.user) throw new ApiFault('ACCOUNT_CREATE_FAILED', 'Could not create the student login account.')
      const now = new Date().toISOString()
      const studentRow: Record<string, unknown> = { ...row, id, registration_year: String(year), registration_date: now.slice(0, 10),
        roll_no: row.roll_no || id.slice(prefix.length), status: 'ACTIVE', academic_year: studentSettingMap.ACADEMIC_YEAR || `${year}-${String(year + 1).slice(-2)}`,
        created_at: now, updated_at: now }
      const { error: studentError } = await admin.from('students').insert(studentRow)
      if (studentError) { await admin.auth.admin.deleteUser(created.user.id); if (studentError.code === '23505') throw new ApiFault('DUPLICATE', 'A student with these details already exists.'); throw studentError }
      const { data: appUser, error: linkError } = await admin.from('app_users').insert({ auth_user_id: created.user.id,
        username: id, user_type: 'STUDENT', role: 'STUDENT', linked_id: id, status: 'Active', must_change_password: !payload.password })
        .select('id').single()
      if (linkError) {
        await admin.from('students').delete().eq('id', id)
        await admin.auth.admin.deleteUser(created.user.id)
        if (linkError.code === '23505') throw new ApiFault('DUPLICATE', 'The student login already exists.')
        throw linkError
      }
      await logAction(admin, user, 'ADD_STUDENT', 'STUDENT', id, { name: studentRow.name, class: studentRow.current_class, batch: studentRow.current_batch_id })
      return response({ ok: true, data: { studentId: id, username: id, tempPassword: !payload.password ? tempPassword : undefined, userId: appUser.id } })
    }

    if (action === 'students.update') {
      const id = requireText(payload.studentId, 'Student ID', 40, true)
      const changes = payload.changes && typeof payload.changes === 'object' && !Array.isArray(payload.changes) ? validateStudentInput(payload.changes, true) : {}
      if (!Object.keys(changes).length) throw new ApiFault('BAD_REQUEST', 'Nothing to update.')
      const { data: existing, error: readError } = await admin.from('students').select('*').eq('id', id).maybeSingle()
      if (readError) throw readError
      if (!existing) throw new ApiFault('NOT_FOUND', 'Student not found.')
      const merged = { ...existing, ...changes }
      if ('current_class' in changes || 'board' in changes) {
        changes.board = canonicalStudentBoard(merged.board, merged.current_class)
        merged.board = changes.board
      }
      if (('current_class' in changes || 'current_batch_id' in changes) && merged.current_batch_id) {
        const { data: batch } = await admin.from('batches').select('id,class,status').eq('id', merged.current_batch_id).maybeSingle()
        if (!batch || batch.status !== 'Active') throw new ApiFault('BAD_REQUEST', 'Choose an active batch.')
        if (String(batch.class).toUpperCase() !== String(merged.current_class).toUpperCase()) throw new ApiFault('BAD_REQUEST', 'The selected batch is for a different class.')
      }
      changes.updated_at = new Date().toISOString()
      const { data: updated, error } = await admin.from('students').update(changes).eq('id', id).select('*').single()
      if (error?.code === '23505') throw new ApiFault('DUPLICATE', 'A student with these details already exists.')
      if (error) throw error
      if ('status' in changes) {
        const accountStatus = ['ACTIVE', 'COMPLETED'].includes(String(changes.status)) ? 'Active' : 'Inactive'
        await admin.from('app_users').update({ status: accountStatus }).eq('user_type', 'STUDENT').eq('linked_id', id)
      }
      for (const field of ['current_class', 'current_batch_id', 'status']) {
        if (field in changes && String(existing[field] ?? '') !== String(changes[field] ?? '')) {
          await admin.from('change_history').insert({ id: `CHG-${crypto.randomUUID()}`, student_id: id, field,
            old_value: String(existing[field] ?? ''), new_value: String(changes[field] ?? ''), changed_by: user.id,
            reason: requireText(payload.reason, 'Reason', 200), academic_year: updated.academic_year || '' })
        }
      }
      await logAction(admin, user, 'EDIT_STUDENT', 'STUDENT', id, changes)
      return response({ ok: true, data: { changed: Object.keys(changes).filter((x) => x !== 'updated_at') } })
    }

    if (action === 'students.resetPassword' || action === 'teachers.resetPassword') {
      const isStudent = action.startsWith('students.')
      const linkedId = requireText(isStudent ? payload.studentId : payload.teacherId, isStudent ? 'Student ID' : 'Teacher ID', 40, true)
      const { data: linkedUser, error: userLookupError } = await admin.from('app_users').select('id,auth_user_id,username')
        .eq('user_type', isStudent ? 'STUDENT' : 'TEACHER').eq('linked_id', linkedId).maybeSingle()
      if (userLookupError) throw userLookupError
      if (!linkedUser?.auth_user_id) throw new ApiFault('NOT_FOUND', 'No login account found for this record.')
      const { data: authTarget } = await admin.auth.admin.getUserById(linkedUser.auth_user_id)
      const email = authTarget.user?.email
      if (!email) throw new ApiFault('NOT_FOUND', 'No login account found for this record.')
      const tempPassword = payload.password ? String(payload.password) : passwordTemp()
      if (tempPassword.length < 8 || tempPassword.length > 200) throw new ApiFault('BAD_PASSWORD', 'Password must be at least 8 characters.')
      await revokeUserPasskeys(admin, linkedUser.auth_user_id)
      const { error } = await admin.auth.admin.updateUserById(linkedUser.auth_user_id, { password: tempPassword })
      if (error) throw new ApiFault('PASSWORD_UPDATE_FAILED', 'Could not reset this password.')
      const { error: appUserUpdateError } = await admin.from('app_users').update({ must_change_password: true, password_changed_at: new Date().toISOString() }).eq('id', linkedUser.id)
      if (appUserUpdateError) throw appUserUpdateError
      const sessionsRevoked = await revokeUserSessions(auth, admin, email, tempPassword)
      await logAction(admin, user, 'RESET_PASSWORD', isStudent ? 'STUDENT' : 'TEACHER', linkedId, { username: linkedUser.username })
      return response({ ok: true, data: { username: linkedUser.username, tempPassword, sessionsRevoked } })
    }

    if (action === 'changes.list') {
      const id = requireText(payload.studentId, 'Student ID', 40, true)
      const { data, error } = await admin.from('change_history').select('*').eq('student_id', id).order('changed_at', { ascending: false }).limit(200)
      if (error) throw error
      return response({ ok: true, data: (data || []).map((r) => ({ ChangeID: r.id, StudentID: r.student_id, Field: r.field,
        OldValue: r.old_value, NewValue: r.new_value, ChangedBy: r.changed_by, ChangedAt: r.changed_at,
        Reason: r.reason, AcademicYear: r.academic_year })) })
    }

    if (action === 'studentSubjects.assign') {
      const studentId = requireText(payload.studentId, 'Student ID', 40, true)
      const subjectId = requireText(payload.subjectId, 'Subject', 40, true)
      const teacherId = requireText(payload.teacherId, 'Teacher', 40, true)
      const batchId = requireText(payload.batchId, 'Batch', 40, true)
      const startDate = requireText(payload.startDate || todayDate(), 'Start date', 10, true)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new ApiFault('BAD_REQUEST', 'Start date must use yyyy-mm-dd.')
      const amount = (raw: unknown, label: string) => {
        if (raw === undefined || raw === null || raw === '') return null
        const value = Number(raw)
        if (!Number.isFinite(value) || value < 0 || value > 100000) throw new ApiFault('BAD_REQUEST', `${label} must be from 0 to 100000.`)
        return value
      }
      const [{ data: student }, { data: subject }, { data: teacherRow }, { data: batch }] = await Promise.all([
        admin.from('students').select('id,status').eq('id', studentId).maybeSingle(),
        admin.from('subjects').select('id,name,status').eq('id', subjectId).maybeSingle(),
        admin.from('teachers').select('id,name,status').eq('id', teacherId).maybeSingle(),
        admin.from('batches').select('id,name,status').eq('id', batchId).maybeSingle(),
      ])
      if (!student) throw new ApiFault('NOT_FOUND', 'Student not found.')
      if (student.status !== 'ACTIVE') throw new ApiFault('BAD_REQUEST', 'Student is not active.')
      if (!subject || subject.status !== 'Active') throw new ApiFault('BAD_REQUEST', 'Subject is not available.')
      if (!teacherRow || teacherRow.status !== 'Active') throw new ApiFault('BAD_REQUEST', 'Teacher is not available.')
      if (!batch || batch.status !== 'Active') throw new ApiFault('BAD_REQUEST', 'Batch is not available.')
      const { data: current, error: currentError } = await admin.from('student_subjects').select('subject_id').eq('student_id', studentId).ilike('status', 'ACTIVE')
      if (currentError) throw currentError
      if ((current || []).some((r) => r.subject_id === subjectId)) throw new ApiFault('DUPLICATE', 'Student already takes this subject.')
      // Block a new period that overlaps an earlier (ended) period of the same
      // subject; otherwise the same months look doubly assigned.
      const { data: earlier, error: earlierError } = await admin.from('student_subjects').select('start_date,end_date')
        .eq('student_id', studentId).eq('subject_id', subjectId).eq('status', 'ENDED')
      if (earlierError) throw earlierError
      const clash = (earlier || []).find((r) => r.end_date && r.start_date && r.end_date > r.start_date && String(r.end_date) > startDate)
      if (clash) {
        const shown = (v: string) => `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}`
        throw new ApiFault('OVERLAP', `This subject was already given from ${shown(String(clash.start_date))} to ${shown(String(clash.end_date))}. ` +
          `Choose a start date on or after ${shown(String(clash.end_date))}, or remove the old entry with “Remove (mistake)” first.`)
      }
      const { data: settings } = await admin.from('settings').select('setting_key,value').in('setting_key', ['ACADEMIC_YEAR', 'SUBJECT_BLOCKED_PAIRS'])
      const settingMap = Object.fromEntries((settings || []).map((r) => [r.setting_key, r.value]))
      const selected = [...(current || []).map((r) => r.subject_id), subjectId]
      for (const pair of String(settingMap.SUBJECT_BLOCKED_PAIRS || '').split(';').map((x) => x.trim()).filter(Boolean)) {
        const [a, b] = pair.split('|').map((x) => x.trim())
        if (selected.includes(a) && selected.includes(b)) throw new ApiFault('RULE_VIOLATION', 'This combination of subjects is not allowed.')
      }
      const id = await newId(admin, 'student_subjects', 'SS-', 4)
      const { data: created, error } = await admin.from('student_subjects').insert({ id, student_id: studentId, subject_id: subjectId,
        teacher_id: teacherId, batch_id: batchId, start_date: startDate, status: 'ACTIVE',
        fee_override: amount(payload.feeOverride, 'Fee override'), teacher_rate_override: amount(payload.teacherRateOverride, 'Teacher rate override'),
        academic_year: settingMap.ACADEMIC_YEAR || `${new Date().getFullYear()}-${String(new Date().getFullYear() + 1).slice(-2)}` })
        .select('*').single()
      if (error?.code === '23505') throw new ApiFault('DUPLICATE', 'This subject already has an active assignment for the academic year.')
      if (error) throw error
      const reason = requireText(payload.reason, 'Reason', 200)
      await admin.from('change_history').insert({ id: `CHG-${crypto.randomUUID()}`, student_id: studentId, field: 'Subject',
        old_value: '', new_value: `${subject.name} / ${teacherRow.name} / ${batch.name}`, changed_by: user.id,
        reason, academic_year: created.academic_year })
      await logAction(admin, user, 'ASSIGN_STUDENT_SUBJECT', 'STUDENT_SUBJECT', id, { studentId, subjectId, teacherId, batchId })
      return response({ ok: true, data: { StudentSubjectID: created.id, StudentID: created.student_id, SubjectID: created.subject_id,
        TeacherID: created.teacher_id, BatchID: created.batch_id, StartDate: created.start_date, EndDate: created.end_date,
        Status: created.status, FeeOverride: created.fee_override, TeacherRateOverride: created.teacher_rate_override,
        AcademicYear: created.academic_year, CreatedAt: created.created_at } })
    }

    if (action === 'studentSubjects.end') {
      const id = requireText(payload.studentSubjectId, 'Student subject ID', 40, true)
      const endDate = requireText(payload.endDate || todayDate(), 'End date', 10, true)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) throw new ApiFault('BAD_REQUEST', 'End date must use yyyy-mm-dd.')
      const { data: row, error: findError } = await admin.from('student_subjects').select('*').eq('id', id).maybeSingle()
      if (findError) throw findError
      if (!row) throw new ApiFault('NOT_FOUND', 'Record not found.')
      // "Given by mistake" removes the assignment completely from billing,
      // teacher income and the student's subject list. It can also clean up
      // an already-ended row that was a mistake.
      const removeMistake = payload.removeMistake === true
      const currentStatus = String(row.status).toUpperCase()
      if (removeMistake) {
        if (currentStatus === 'REMOVED') throw new ApiFault('BAD_REQUEST', 'This subject is already removed.')
        const { data: billed, error: billedError } = await admin.from('invoices').select('id,line_items,status,paid_amount')
          .eq('student_id', row.student_id).neq('status', 'CANCELLED')
        if (billedError) throw billedError
        const paidForSubject = (billed || []).some((inv) => Number(inv.paid_amount) > 0 &&
          normalizedInvoiceLines(inv).some((line) => String(line.subjectId) === String(row.subject_id) && Number(line.paidAmount) > 0))
        if (paidForSubject && currentStatus === 'ACTIVE' && payload.force !== true) {
          throw new ApiFault('BAD_REQUEST', 'Payments were already received for this subject. End it with an end date instead of removing it.')
        }
        const { error } = await admin.from('student_subjects').update({ status: 'REMOVED', end_date: row.start_date || todayDate() }).eq('id', id)
        if (error) throw error
        await admin.from('change_history').insert({ id: `CHG-${crypto.randomUUID()}`, student_id: row.student_id, field: 'Subject',
          old_value: `${row.subject_id} / ${row.teacher_id || ''} / ${row.batch_id || ''}`, new_value: 'REMOVED (given by mistake)', changed_by: user.id,
          reason: requireText(payload.reason, 'Reason', 200), academic_year: row.academic_year || '' })
        await logAction(admin, user, 'REMOVE_STUDENT_SUBJECT', 'STUDENT_SUBJECT', id, { previousStatus: currentStatus })
        return response({ ok: true, data: { removed: true } })
      }
      if (currentStatus !== 'ACTIVE') throw new ApiFault('BAD_REQUEST', 'This subject is already ended.')
      if (row.start_date && endDate < row.start_date) throw new ApiFault('BAD_REQUEST', 'End date cannot be before the start date.')
      const { error } = await admin.from('student_subjects').update({ end_date: endDate, status: 'ENDED' }).eq('id', id)
      if (error) throw error
      await admin.from('change_history').insert({ id: `CHG-${crypto.randomUUID()}`, student_id: row.student_id, field: 'Subject',
        old_value: `${row.subject_id} / ${row.teacher_id || ''} / ${row.batch_id || ''}`, new_value: 'ENDED', changed_by: user.id,
        reason: requireText(payload.reason, 'Reason', 200), academic_year: row.academic_year || '' })
      await logAction(admin, user, 'END_STUDENT_SUBJECT', 'STUDENT_SUBJECT', id, { endDate })
      return response({ ok: true, data: { ended: true } })
    }

    if (action === 'studentSubjects.updateStart') {
      const id = requireText(payload.studentSubjectId, 'Student subject ID', 40, true)
      const startDate = requireText(payload.startDate, 'Start date', 10, true)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new ApiFault('BAD_REQUEST', 'Start date must use yyyy-mm-dd.')
      const { data: row, error: findError } = await admin.from('student_subjects').select('*').eq('id', id).maybeSingle()
      if (findError) throw findError
      if (!row) throw new ApiFault('NOT_FOUND', 'Subject assignment not found.')
      if (String(row.status).toUpperCase() !== 'ACTIVE') throw new ApiFault('BAD_REQUEST', 'Only an active subject can have its start date changed.')
      if (startDate > todayDate()) throw new ApiFault('BAD_REQUEST', 'Start date cannot be in the future.')
      if (String(row.start_date || '') === startDate) return response({ ok: true, data: { unchanged: true } })
      // Do not let the corrected period overlap an earlier assignment of the
      // same subject, otherwise the same month would look doubly assigned.
      const { data: others, error: othersError } = await admin.from('student_subjects').select('id,start_date,end_date,status')
        .eq('student_id', row.student_id).eq('subject_id', row.subject_id).neq('id', id).eq('status', 'ENDED')
      if (othersError) throw othersError
      const overlap = (others || []).find((o) => o.end_date && o.start_date && o.end_date > o.start_date && String(o.end_date) > startDate)
      if (overlap) throw new ApiFault('BAD_REQUEST', `This subject was already running until ${overlap.end_date}. Pick a later start date, or remove that older entry as “given by mistake” first.`)
      const { error } = await admin.from('student_subjects').update({ start_date: startDate }).eq('id', id)
      if (error) throw error
      await admin.from('change_history').insert({ id: `CHG-${crypto.randomUUID()}`, student_id: row.student_id, field: 'Subject start date',
        old_value: String(row.start_date || ''), new_value: startDate, changed_by: user.id,
        reason: requireText(payload.reason, 'Reason', 200), academic_year: row.academic_year || '' })
      await logAction(admin, user, 'EDIT_STUDENT_SUBJECT_START', 'STUDENT_SUBJECT', id, { from: row.start_date, to: startDate })
      return response({ ok: true, data: { startDate } })
    }

    if (action === 'students.finance') {
      const studentId = requireText(payload.studentId, 'Student ID', 40, true)
      const [{ data: invoices, error: invoiceError }, { data: receipts, error: receiptError }] = await Promise.all([
        admin.from('invoices').select('*').eq('student_id', studentId).order('month', { ascending: false }).limit(500),
        admin.from('receipts').select('id,payment_id,receipt_date,amount,status').eq('student_id', studentId)
          .order('receipt_date', { ascending: false }).order('id', { ascending: false }).limit(500),
      ])
      if (invoiceError || receiptError) throw invoiceError || receiptError
      const paymentIds = [...new Set((receipts || []).map((r) => r.payment_id).filter(Boolean))]
      const { data: payments, error: paymentError } = paymentIds.length
        ? await admin.from('payments').select('id,invoice_id,payment_mode,allocations').in('id', paymentIds) : { data: [], error: null }
      if (paymentError) throw paymentError
      const paymentMap = new Map((payments || []).map((p) => [p.id, p]))
      return response({ ok: true, data: {
        invoices: (invoices || []).map((r) => {
          const total = Number(r.total_amount) || 0, paid = Number(r.paid_amount) || 0
          return { InvoiceID: r.id, Month: r.month, MonthLabel: monthLabel(r.month),
            Classes: normalizedInvoiceLines(r).map((line) => line.subjectName || line.subjectId).filter(Boolean).join(', '),
            TotalAmount: total, PaidAmount: paid, BalanceAmount: Math.max(0, total - paid), DueDate: r.due_date,
            Status: invoiceStatus(r.total_amount, r.paid_amount, r.due_date, r.status) }
        }),
        receipts: (receipts || []).map((r) => {
          const p = paymentMap.get(r.payment_id)
          return { ReceiptID: r.id, ReceiptDate: r.receipt_date, Amount: Number(r.amount), Status: r.status,
            InvoiceID: p?.invoice_id || '', PaymentMode: p?.payment_mode || '',
            Classes: p ? allocationsFromPayment(p.allocations).map((a) => a.subjectName).join(', ') : '' }
        }) } })
    }

    /* ---------------- Free AI assistant (Gemini key + usage) ---------------- */
    if (action === 'ai.status' || action === 'ai.setKey') {
      if (user.user_type !== 'ADMIN' || user.role !== 'SUPER_ADMIN') throw new ApiFault('FORBIDDEN', 'Only the Super Admin can manage the AI assistant.')
      if (action === 'ai.setKey') {
        const remove = payload.remove === true
        if (remove) {
          await admin.from('app_secrets').delete().eq('key', 'GEMINI_API_KEY')
          await logAction(admin, user, 'AI_KEY_REMOVED', 'SETTING', 'GEMINI_API_KEY', {})
          return response({ ok: true, data: { configured: !!Deno.env.get('GEMINI_API_KEY') } })
        }
        const key = requireText(payload.key, 'AI key', 200, true)
        // Google issues both older "AIza…" keys and newer "AQ.…" keys (which contain dots).
        if (!/^[A-Za-z0-9_.\-]{20,300}$/.test(key)) throw new ApiFault('BAD_REQUEST', 'That does not look like a Gemini API key. Copy it again with the Copy key button.')
        // Check the key with Google before saving it (free call, lists available models).
        const check = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': key } })
        if (!check.ok) throw new ApiFault('BAD_REQUEST', 'Google rejected this key. Create a new one at aistudio.google.com and paste it again.')
        const { error } = await admin.from('app_secrets').upsert({ key: 'GEMINI_API_KEY', value: key }, { onConflict: 'key' })
        if (error) throw error
        await logAction(admin, user, 'AI_KEY_SET', 'SETTING', 'GEMINI_API_KEY', {})
        return response({ ok: true, data: { configured: true } })
      }
      const [{ data: stored }, { data: usage }, { data: settingRows }, featureUsage] = await Promise.all([
        admin.from('app_secrets').select('key,created_at').eq('key', 'GEMINI_API_KEY').maybeSingle(),
        admin.from('ai_usage').select('calls').eq('day', todayDate()).maybeSingle(),
        admin.from('settings').select('setting_key,value').in('setting_key', ['AI_DOUBT_DRAFTS_ENABLED', 'AI_DAILY_LIMIT', 'AI_MODEL', 'AI_SEARCH_ENABLED', 'AI_LIMIT_SEARCH', 'AI_LIMIT_WORKSHEETS', 'AI_LIMIT_DOUBTS']),
        admin.from('ai_feature_usage').select('feature,calls').eq('day', todayDate()),
      ])
      const s = Object.fromEntries((settingRows || []).map((r) => [r.setting_key, r.value]))
      const used = new Map(((featureUsage.error ? [] : featureUsage.data) || []).map((r: any) => [r.feature, r.calls]))
      const features = featureUsage.error ? [] : [['SEARCH', 'Search bar'], ['WORKSHEETS', 'Worksheets'], ['DOUBTS', 'Doubt drafts']]
        .filter(([k]) => s[`AI_LIMIT_${k}`] != null).map(([k, label]) => ({ key: k, label, used: used.get(k) || 0, limit: Number(s[`AI_LIMIT_${k}`]) || 0 }))
      return response({ ok: true, data: { configured: !!(Deno.env.get('GEMINI_API_KEY') || stored), fromServerSecret: !!Deno.env.get('GEMINI_API_KEY'),
        enabled: String(s.AI_DOUBT_DRAFTS_ENABLED || 'TRUE').toUpperCase() === 'TRUE', limit: Number(s.AI_DAILY_LIMIT || 40),
        searchEnabled: String(s.AI_SEARCH_ENABLED || 'TRUE').toUpperCase() === 'TRUE', features,
        usedToday: usage?.calls || 0, model: s.AI_MODEL || 'gemini-flash-latest' } })
    }

    /* ---------------- Push notifications & reminder list ---------------- */
    if (action === 'push.subscribe' || action === 'push.unsubscribe') {
      const sub = payload.subscription && typeof payload.subscription === 'object' ? payload.subscription : {}
      const endpoint = requireText(sub.endpoint ?? payload.endpoint, 'Endpoint', 1000, true)
      if (!/^https:\/\//.test(endpoint)) throw new ApiFault('BAD_REQUEST', 'Invalid notification endpoint.')
      if (action === 'push.unsubscribe') {
        await admin.from('push_subscriptions').delete().eq('endpoint', endpoint).eq('app_user_id', user.id)
        return response({ ok: true, data: { removed: true } })
      }
      const p256dh = requireText(sub.keys?.p256dh, 'Key', 200, true), authKey = requireText(sub.keys?.auth, 'Key', 100, true)
      const { error } = await admin.from('push_subscriptions').upsert({ app_user_id: user.id,
        student_id: user.user_type === 'STUDENT' ? user.linked_id : null, endpoint, p256dh, auth: authKey,
        user_agent: String(request.headers.get('user-agent') || '').slice(0, 300), fail_count: 0 }, { onConflict: 'endpoint' })
      if (error) throw error
      return response({ ok: true, data: { subscribed: true } })
    }

    if (action === 'reminders.list') {
      const status = String(payload.status || 'PENDING').toUpperCase()
      const kind = String(payload.kind || '').toUpperCase()
      let query = admin.from('reminder_log').select('*').order('created_at', { ascending: false }).limit(300)
      if (status === 'PENDING') query = query.eq('whatsapp_status', 'PENDING')
      else query = query.neq('whatsapp_status', 'PENDING').gte('created_at', new Date(Date.now() - 14 * 86400000).toISOString())
      if (['FEE', 'ABSENT'].includes(kind)) query = query.eq('kind', kind)
      const { data, error } = await query
      if (error) throw error
      const ids = [...new Set((data || []).map((r) => r.student_id))]
      const { data: students } = await admin.from('students').select('id,name,current_class').in('id', ids.length ? ids : ['__none__'])
      const sm = new Map((students || []).map((s) => [s.id, s]))
      const { count: pendingCount } = await admin.from('reminder_log').select('id', { count: 'exact', head: true }).eq('whatsapp_status', 'PENDING')
      return response({ ok: true, data: { pending: pendingCount || 0, rows: (data || []).map((r) => ({ ID: r.id, Kind: r.kind, Stage: r.stage,
        StudentID: r.student_id, StudentName: sm.get(r.student_id)?.name || r.student_id, ClassName: sm.get(r.student_id)?.current_class || '',
        Title: r.title, Message: r.message, Phone: r.phone, PushDevices: r.push_devices, PushDelivered: r.push_delivered,
        WhatsApp: r.whatsapp_status, CreatedAt: r.created_at, HandledAt: r.handled_at })) } })
    }

    if (action === 'reminders.mark') {
      const ids = Array.isArray(payload.ids) ? payload.ids.map((x: unknown) => String(x)).slice(0, 300) : [requireText(payload.id, 'Reminder', 60, true)]
      const status = String(payload.status || '').toUpperCase()
      if (!['SENT', 'SKIPPED', 'PENDING'].includes(status)) throw new ApiFault('BAD_REQUEST', 'Choose SENT, SKIPPED or PENDING.')
      const { error } = await admin.from('reminder_log').update({ whatsapp_status: status,
        handled_at: status === 'PENDING' ? null : new Date().toISOString(), handled_by: status === 'PENDING' ? null : user.id }).in('id', ids)
      if (error) throw error
      return response({ ok: true, data: { updated: ids.length } })
    }

    /* ---------------- Doubt portal ---------------- */
    if (action.startsWith('doubts.')) {
      const isStudent = user.user_type === 'STUDENT', isTeacher = user.user_type === 'TEACHER', isAdmin = user.user_type === 'ADMIN'
      if ((isStudent || isTeacher) && !user.linked_id) throw new ApiFault('FORBIDDEN', 'Your account is not linked to a student or teacher record.')
      const me = String(user.linked_id || '')
      const studentCtx = async () => {
        const [{ data: st, error }, { data: subs, error: subError }] = await Promise.all([
          admin.from('students').select('id,name,current_class,status').eq('id', me).maybeSingle(),
          admin.from('student_subjects').select('subject_id').eq('student_id', me).ilike('status', 'active'),
        ])
        if (error || subError) throw error || subError
        if (!st) throw new ApiFault('NOT_FOUND', 'Student record not found.')
        return { cls: String(st.current_class || ''), subjects: new Set<string>((subs || []).map((r) => String(r.subject_id))),
          active: String(st.status).toUpperCase() === 'ACTIVE' }
      }
      const teacherSubjects = async () => {
        const [{ data: slots, error: e1 }, { data: assigned, error: e2 }] = await Promise.all([
          admin.from('timetable').select('subject_id,co_subject_id').eq('teacher_id', me).ilike('status', 'active'),
          admin.from('student_subjects').select('subject_id').eq('teacher_id', me).ilike('status', 'active'),
        ])
        if (e1 || e2) throw e1 || e2
        return new Set<string>([...(slots || []).flatMap((s) => [s.subject_id, s.co_subject_id]), ...(assigned || []).map((s) => s.subject_id)]
          .filter(Boolean).map(String))
      }
      const sCtx = isStudent ? await studentCtx() : null
      const tSubs = isTeacher ? await teacherSubjects() : null
      const canSee = (d: any) => isAdmin || isTeacher || d.student_id === me ||
        (!!sCtx && !d.hidden && d.class_name === sCtx.cls && sCtx.subjects.has(String(d.subject_id)))
      const teachesIt = (d: any) => !!tSubs && tSubs.has(String(d.subject_id))
      const canModerate = (d: any) => (isAdmin && user.role === 'SUPER_ADMIN') || teachesIt(d)
      const loadDoubt = async (id: unknown) => {
        const doubtId = requireText(id, 'Doubt', 60, true)
        const { data: d, error } = await admin.from('doubts').select('*').eq('id', doubtId).maybeSingle()
        if (error) throw error
        if (!d || !canSee(d)) throw new ApiFault('NOT_FOUND', 'Doubt not found.')
        return d
      }
      const nameMaps = async (studentIds: string[], teacherIds: string[], subjectIds: string[]) => {
        const none = ['__none__']
        const [{ data: st }, { data: te }, { data: su }] = await Promise.all([
          admin.from('students').select('id,name').in('id', studentIds.length ? studentIds : none),
          admin.from('teachers').select('id,name').in('id', teacherIds.length ? teacherIds : none),
          admin.from('subjects').select('id,name').in('id', subjectIds.length ? subjectIds : none),
        ])
        return { students: new Map((st || []).map((r) => [r.id, r.name])), teachers: new Map((te || []).map((r) => [r.id, r.name])),
          subjects: new Map((su || []).map((r) => [r.id, r.name])) }
      }
      const settingNumber = async (key: string, fallback: number) => {
        const { data } = await admin.from('settings').select('value').eq('setting_key', key).maybeSingle()
        const n = Number.parseInt(String(data?.value ?? ''), 10)
        return Number.isFinite(n) && n >= 0 ? n : fallback
      }
      const touch = (id: string, changes: Record<string, unknown>) =>
        admin.from('doubts').update({ ...changes, updated_at: new Date().toISOString() }).eq('id', id)

      if (action === 'doubts.list') {
        const scope = String(payload.scope || 'feed')
        const subjectFilter = String(payload.subjectId || '').trim()
        const statusFilter = String(payload.status || '').toUpperCase()
        const search = String(payload.search || '').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().slice(0, 60)
        let query = admin.from('doubts').select('*').order('created_at', { ascending: false }).limit(300)
        if (isStudent && scope === 'mine') query = query.eq('student_id', me)
        else if (isStudent) {
          const subs = [...sCtx!.subjects]
          query = query.eq('class_name', sCtx!.cls).eq('hidden', false).in('subject_id', subs.length ? subs : ['__none__'])
        } else if (isTeacher && scope !== 'all') {
          const subs = [...tSubs!]
          query = query.in('subject_id', subs.length ? subs : ['__none__'])
        }
        if (subjectFilter) query = query.eq('subject_id', subjectFilter)
        if (['OPEN', 'CLAIMED', 'ANSWERED', 'RESOLVED'].includes(statusFilter)) query = query.eq('status', statusFilter)
        if (search) query = query.or(`title.ilike."%${search}%",chapter.ilike."%${search}%"`)
        const { data: doubts, error } = await query
        if (error) throw error
        const ids = (doubts || []).map((d) => d.id)
        const none = ['__none__']
        const [{ data: answers }, { data: files }, { data: mine }] = await Promise.all([
          admin.from('doubt_answers').select('doubt_id,status,is_follow_up').in('doubt_id', ids.length ? ids : none),
          admin.from('doubt_files').select('doubt_id').is('answer_id', null).is('expired_at', null).in('doubt_id', ids.length ? ids : none),
          isStudent ? admin.from('doubt_me_too').select('doubt_id').eq('student_id', me).in('doubt_id', ids.length ? ids : none) : Promise.resolve({ data: [] }),
        ])
        const count = (rows: any[] | null, pick: (r: any) => boolean) => {
          const m = new Map<string, number>()
          for (const r of rows || []) if (pick(r)) m.set(r.doubt_id, (m.get(r.doubt_id) || 0) + 1)
          return m
        }
        const approved = count(answers, (r) => r.status === 'APPROVED' && !r.is_follow_up)
        const pending = count(answers, (r) => r.status === 'PENDING')
        const photos = count(files, () => true)
        const meToo = new Set((mine || []).map((r: any) => r.doubt_id))
        let rows = doubts || []
        if (isTeacher && scope === 'pending') rows = rows.filter((d) => (pending.get(d.id) || 0) > 0)
        const names = await nameMaps([...new Set(rows.map((d) => d.student_id))],
          [...new Set(rows.map((d) => d.claimed_by).filter(Boolean))], [...new Set(rows.map((d) => d.subject_id))])
        const rank: Record<string, number> = { OPEN: 0, CLAIMED: 1, ANSWERED: 2, RESOLVED: 3 }
        if (!isStudent || scope !== 'mine') rows = rows.slice().sort((a, b) =>
          (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || b.me_too_count - a.me_too_count || String(b.created_at).localeCompare(String(a.created_at)))
        // Filter options: subjects this user can browse.
        const optionIds = isStudent ? [...sCtx!.subjects] : isTeacher ? [...tSubs!] : [...new Set(rows.map((d) => d.subject_id))]
        const optionNames = await nameMaps([], [], optionIds)
        return response({ ok: true, data: {
          rows: rows.map((d) => ({ DoubtID: d.id, Title: d.title, Chapter: d.chapter, SubjectID: d.subject_id,
            SubjectName: names.subjects.get(d.subject_id) || d.subject_id, ClassName: d.class_name,
            StudentName: names.students.get(d.student_id) || 'Student', IsMine: d.student_id === me && isStudent,
            Status: d.status, Hidden: d.hidden, MeToo: d.me_too_count, MeTooMine: meToo.has(d.id),
            Answers: approved.get(d.id) || 0, Pending: isStudent ? 0 : pending.get(d.id) || 0, Photos: photos.get(d.id) || 0,
            ClaimedBy: d.claimed_by ? names.teachers.get(d.claimed_by) || '' : '', CreatedAt: d.created_at })),
          subjects: optionIds.map((id) => ({ id, name: optionNames.subjects.get(id) || id })).sort((a, b) => a.name.localeCompare(b.name)),
          canAsk: isStudent && !!sCtx?.active && sCtx.subjects.size > 0 } })
      }

      if (action === 'doubts.get') {
        const d = await loadDoubt(payload.doubtId)
        const [{ data: answers, error: aError }, { data: files, error: fError }, { data: mt }] = await Promise.all([
          admin.from('doubt_answers').select('*').eq('doubt_id', d.id).order('created_at'),
          admin.from('doubt_files').select('id,answer_id,file_name,drive_file_id,storage_path,expired_at').eq('doubt_id', d.id).order('created_at'),
          isStudent ? admin.from('doubt_me_too').select('doubt_id').eq('doubt_id', d.id).eq('student_id', me).maybeSingle() : Promise.resolve({ data: null }),
        ])
        if (aError || fError) throw aError || fError
        // AI drafts are for teachers/admin only; students never receive them.
        let ai: Record<string, unknown> | null = null
        const aiAllowed = teachesIt(d) || (isAdmin && user.role === 'SUPER_ADMIN')
        if (aiAllowed) {
          const [{ data: draft }, { data: flag }, { data: storedKey }] = await Promise.all([
            admin.from('doubt_ai_drafts').select('*').eq('doubt_id', d.id).maybeSingle(),
            admin.from('settings').select('value').eq('setting_key', 'AI_DOUBT_DRAFTS_ENABLED').maybeSingle(),
            admin.from('app_secrets').select('key').eq('key', 'GEMINI_API_KEY').maybeSingle(),
          ])
          const enabled = String(flag?.value || 'TRUE').toUpperCase() === 'TRUE'
          ai = { enabled, configured: !!(Deno.env.get('GEMINI_API_KEY') || storedKey),
            draft: draft && draft.status === 'OK' ? { Body: draft.body, Model: draft.model, CreatedAt: draft.created_at } : null }
        }
        const visible = (answers || []).filter((a) => isTeacher || isAdmin || a.status === 'APPROVED' ||
          (a.author_type === 'STUDENT' && a.author_id === me))
        const names = await nameMaps([...new Set([d.student_id, ...visible.filter((a) => a.author_type === 'STUDENT').map((a) => a.author_id)])],
          [...new Set([d.claimed_by, d.first_answered_by, ...visible.filter((a) => a.author_type === 'TEACHER').map((a) => a.author_id), ...visible.map((a) => a.reviewed_by)].filter(Boolean))],
          [d.subject_id])
        const fileRow = (f: any) => ({ FileID: f.id, FileName: f.file_name, Expired: !!f.expired_at, InDrive: !!f.drive_file_id })
        const resolvedDoubt = d.status === 'RESOLVED'
        return response({ ok: true, data: {
          doubt: { DoubtID: d.id, Title: d.title, Body: d.body, Chapter: d.chapter, SubjectID: d.subject_id,
            SubjectName: names.subjects.get(d.subject_id) || d.subject_id, ClassName: d.class_name,
            StudentName: names.students.get(d.student_id) || 'Student', IsMine: isStudent && d.student_id === me,
            Status: d.status, Hidden: d.hidden, MeToo: d.me_too_count, MeTooMine: !!mt,
            ClaimedBy: d.claimed_by ? names.teachers.get(d.claimed_by) || '' : '', ClaimedByMe: isTeacher && d.claimed_by === me,
            CreatedAt: d.created_at, ResolvedAt: d.resolved_at,
            Files: (files || []).filter((f) => !f.answer_id).map(fileRow) },
          answers: visible.map((a) => ({ AnswerID: a.id, AuthorType: a.author_type, IsMine: a.author_id === me && a.author_type === user.user_type,
            AuthorName: a.author_type === 'TEACHER' ? names.teachers.get(a.author_id) || 'Teacher' : names.students.get(a.author_id) || 'Student',
            Body: a.body, Status: a.status, FollowUp: a.is_follow_up, ReviewNote: a.review_note, Points: a.points_awarded,
            ReviewedBy: a.reviewed_by ? names.teachers.get(a.reviewed_by) || '' : '', CreatedAt: a.created_at,
            Files: (files || []).filter((f) => f.answer_id === a.id).map(fileRow) })),
          ai,
          can: {
            answer: !d.hidden && (teachesIt(d) || (isStudent && !resolvedDoubt)),
            claim: teachesIt(d) && d.status === 'OPEN', release: isTeacher && d.claimed_by === me && d.status === 'CLAIMED',
            review: teachesIt(d), resolve: isStudent && d.student_id === me, meToo: isStudent && d.student_id !== me && !d.hidden,
            hide: canModerate(d),
          } } })
      }

      if (action === 'doubts.create') {
        if (!isStudent) throw new ApiFault('FORBIDDEN', 'Only students can post doubts.')
        if (!sCtx!.active) throw new ApiFault('FORBIDDEN', 'Only active students can post doubts.')
        const subjectId = requireText(payload.subjectId, 'Subject', 60, true)
        if (!sCtx!.subjects.has(subjectId)) throw new ApiFault('BAD_REQUEST', 'Choose one of your own subjects.')
        if (!sCtx!.cls) throw new ApiFault('BAD_REQUEST', 'Your class is not set. Ask the office to update your profile.')
        const title = requireText(payload.title, 'Question title', 200, true)
        if (title.length < 3) throw new ApiFault('BAD_REQUEST', 'Write a short title for your doubt.')
        const body = requireText(payload.body, 'Details', 4000)
        const chapter = requireText(payload.chapter, 'Chapter', 120)
        const limit = await settingNumber('DOUBT_DAILY_LIMIT', 5)
        const { count, error: countError } = await admin.from('doubts').select('id', { count: 'exact', head: true })
          .eq('student_id', me).gte('created_at', `${todayDate()}T00:00:00+05:30`)
        if (countError) throw countError
        if ((count || 0) >= limit) throw new ApiFault('LIMIT', `You can post up to ${limit} doubts a day. Try again tomorrow.`)
        const { data: year } = await admin.from('settings').select('value').eq('setting_key', 'ACADEMIC_YEAR').maybeSingle()
        const id = await newId(admin, 'doubts', 'DBT-', 6)
        const { error } = await admin.from('doubts').insert({ id, student_id: me, subject_id: subjectId, class_name: sCtx!.cls,
          chapter, title, body, academic_year: year?.value || '' })
        if (error) throw error
        return response({ ok: true, data: { DoubtID: id } })
      }

      if (action === 'doubts.answer') {
        const d = await loadDoubt(payload.doubtId)
        const body = requireText(payload.body, 'Answer', 6000)
        if (!body && payload.hasPhotos !== true) throw new ApiFault('BAD_REQUEST', 'Write an answer or add a photo.')
        if (d.hidden) throw new ApiFault('BAD_REQUEST', 'This doubt has been hidden.')
        const id = await newId(admin, 'doubt_answers', 'ANS-', 7)
        const now = new Date().toISOString()
        if (isTeacher) {
          if (!teachesIt(d)) throw new ApiFault('FORBIDDEN', 'Only teachers of this subject can answer it.')
          const { error } = await admin.from('doubt_answers').insert({ id, doubt_id: d.id, author_type: 'TEACHER', author_id: me, body, status: 'APPROVED' })
          if (error) throw error
          const changes: Record<string, unknown> = {}
          if (d.status !== 'RESOLVED') changes.status = 'ANSWERED'
          if (!d.first_teacher_answer_at) { changes.first_teacher_answer_at = now; changes.first_answered_by = me }
          await touch(d.id, changes)
          return response({ ok: true, data: { AnswerID: id, status: 'APPROVED' } })
        }
        if (!isStudent) throw new ApiFault('FORBIDDEN', 'Only students and subject teachers can answer doubts.')
        if (d.student_id === me) {
          // The asker's follow-up ("still confused…") reopens the doubt.
          const { error } = await admin.from('doubt_answers').insert({ id, doubt_id: d.id, author_type: 'STUDENT', author_id: me, body, status: 'APPROVED', is_follow_up: true })
          if (error) throw error
          if (d.status === 'ANSWERED' || d.status === 'RESOLVED') await touch(d.id, { status: 'OPEN', resolved_at: null })
          else await touch(d.id, {})
          return response({ ok: true, data: { AnswerID: id, status: 'APPROVED', followUp: true } })
        }
        if (d.status === 'RESOLVED') throw new ApiFault('BAD_REQUEST', 'This doubt is already resolved.')
        const { count } = await admin.from('doubt_answers').select('id', { count: 'exact', head: true })
          .eq('doubt_id', d.id).eq('author_type', 'STUDENT').eq('author_id', me).eq('status', 'PENDING')
        if ((count || 0) > 0) throw new ApiFault('BAD_REQUEST', 'Your earlier answer is still waiting for teacher approval.')
        const { error } = await admin.from('doubt_answers').insert({ id, doubt_id: d.id, author_type: 'STUDENT', author_id: me, body, status: 'PENDING' })
        if (error) throw error
        return response({ ok: true, data: { AnswerID: id, status: 'PENDING' } })
      }

      if (action === 'doubts.claim') {
        const d = await loadDoubt(payload.doubtId)
        if (!teachesIt(d)) throw new ApiFault('FORBIDDEN', 'Only teachers of this subject can take this doubt.')
        if (payload.release === true) {
          if (d.claimed_by !== me) throw new ApiFault('BAD_REQUEST', 'You have not taken this doubt.')
          const { error } = await touch(d.id, { claimed_by: null, claimed_at: null, ...(d.status === 'CLAIMED' ? { status: 'OPEN' } : {}) })
          if (error) throw error
          return response({ ok: true, data: { released: true } })
        }
        if (d.status !== 'OPEN') throw new ApiFault('BAD_REQUEST', d.status === 'CLAIMED' ? 'Another teacher is already solving this doubt.' : 'This doubt is not open.')
        const { data: updated, error } = await admin.from('doubts').update({ status: 'CLAIMED', claimed_by: me, claimed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('id', d.id).eq('status', 'OPEN').select('id')
        if (error) throw error
        if (!updated?.length) throw new ApiFault('BAD_REQUEST', 'Another teacher just took this doubt.')
        return response({ ok: true, data: { claimed: true } })
      }

      if (action === 'doubts.review') {
        const answerId = requireText(payload.answerId, 'Answer', 60, true)
        const { data: a, error: aError } = await admin.from('doubt_answers').select('*').eq('id', answerId).maybeSingle()
        if (aError) throw aError
        if (!a) throw new ApiFault('NOT_FOUND', 'Answer not found.')
        const d = await loadDoubt(a.doubt_id)
        if (!teachesIt(d)) throw new ApiFault('FORBIDDEN', 'Only teachers of this subject can review answers.')
        if (a.status !== 'PENDING') throw new ApiFault('BAD_REQUEST', 'This answer has already been reviewed.')
        const approve = payload.approve === true
        const note = requireText(payload.note, 'Note', 500)
        if (!approve && !note) throw new ApiFault('BAD_REQUEST', 'Tell the student why the answer is not correct.')
        const points = approve ? await settingNumber('DOUBT_APPROVAL_POINTS', 10) : 0
        const { data: changed, error } = await admin.from('doubt_answers').update({ status: approve ? 'APPROVED' : 'REJECTED', review_note: note,
          reviewed_by: me, reviewed_at: new Date().toISOString(), points_awarded: points }).eq('id', a.id).eq('status', 'PENDING').select('id')
        if (error) throw error
        if (!changed?.length) throw new ApiFault('BAD_REQUEST', 'This answer has already been reviewed.')
        if (approve && d.status !== 'RESOLVED') await touch(d.id, { status: 'ANSWERED' })
        return response({ ok: true, data: { approved: approve, points } })
      }

      if (action === 'doubts.resolve') {
        const d = await loadDoubt(payload.doubtId)
        if (!isStudent || d.student_id !== me) throw new ApiFault('FORBIDDEN', 'Only the student who asked can mark this doubt.')
        const resolved = payload.resolved === true
        const { error } = await touch(d.id, resolved ? { status: 'RESOLVED', resolved_at: new Date().toISOString() }
          : { status: d.first_teacher_answer_at ? 'ANSWERED' : 'OPEN', resolved_at: null })
        if (error) throw error
        return response({ ok: true, data: { resolved } })
      }

      if (action === 'doubts.meToo') {
        const d = await loadDoubt(payload.doubtId)
        if (!isStudent || d.student_id === me) throw new ApiFault('BAD_REQUEST', 'You cannot add “me too” to this doubt.')
        const { data, error } = await admin.rpc('toggle_doubt_me_too', { p_doubt_id: d.id, p_student_id: me })
        if (error) throw error
        return response({ ok: true, data })
      }

      if (action === 'doubts.hide') {
        const hidden = payload.hidden === true
        if (payload.answerId) {
          const { data: a } = await admin.from('doubt_answers').select('*').eq('id', requireText(payload.answerId, 'Answer', 60, true)).maybeSingle()
          if (!a) throw new ApiFault('NOT_FOUND', 'Answer not found.')
          const d = await loadDoubt(a.doubt_id)
          if (!canModerate(d)) throw new ApiFault('FORBIDDEN', 'Only subject teachers or the Super Admin can hide answers.')
          const { error } = await admin.from('doubt_answers').update({ status: hidden ? 'HIDDEN' : 'APPROVED', points_awarded: hidden ? 0 : a.points_awarded }).eq('id', a.id)
          if (error) throw error
          await logAction(admin, user, hidden ? 'HIDE_DOUBT_ANSWER' : 'UNHIDE_DOUBT_ANSWER', 'DOUBT_ANSWER', a.id, { doubtId: d.id })
          return response({ ok: true, data: { hidden } })
        }
        const d = await loadDoubt(payload.doubtId)
        if (!canModerate(d)) throw new ApiFault('FORBIDDEN', 'Only subject teachers or the Super Admin can hide doubts.')
        const { error } = await touch(d.id, { hidden })
        if (error) throw error
        await logAction(admin, user, hidden ? 'HIDE_DOUBT' : 'UNHIDE_DOUBT', 'DOUBT', d.id, {})
        return response({ ok: true, data: { hidden } })
      }

      if (action === 'doubts.leaderboard') {
        const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(payload.month || '')) ? String(payload.month) : todayDate().slice(0, 7)
        const start = `${month}-01T00:00:00+05:30`
        const next = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 10)
        const { data: rows, error } = await admin.from('doubt_answers').select('author_id,points_awarded')
          .eq('author_type', 'STUDENT').eq('status', 'APPROVED').gt('points_awarded', 0)
          .gte('reviewed_at', start).lt('reviewed_at', `${next}T00:00:00+05:30`)
        if (error) throw error
        const totals = new Map<string, { points: number, answers: number }>()
        for (const r of rows || []) {
          const t = totals.get(r.author_id) || { points: 0, answers: 0 }
          t.points += Number(r.points_awarded) || 0; t.answers++; totals.set(r.author_id, t)
        }
        const ids = [...totals.keys()]
        const { data: students } = await admin.from('students').select('id,name,current_class').in('id', ids.length ? ids : ['__none__'])
        let list = (students || []).map((s) => ({ StudentID: s.id, Name: s.name, ClassName: s.current_class || '',
          Points: totals.get(s.id)!.points, Answers: totals.get(s.id)!.answers, IsMe: isStudent && s.id === me }))
        if (isStudent) list = list.filter((s) => s.ClassName === sCtx!.cls)
        list.sort((a, b) => b.Points - a.Points || b.Answers - a.Answers || a.Name.localeCompare(b.Name))
        const myPoints = isStudent ? totals.get(me)?.points || 0 : 0
        return response({ ok: true, data: { month, monthLabel: monthLabel(month), rows: list.slice(0, 20).map((r, i) => ({ Rank: i + 1, ...r,
          StudentID: isStudent ? undefined : r.StudentID })), myPoints, className: sCtx?.cls || '' } })
      }

      if (action === 'doubts.stats') {
        if (!isAdmin) throw new ApiFault('FORBIDDEN', 'Only admins can view doubt statistics.')
        const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(payload.month || '')) ? String(payload.month) : todayDate().slice(0, 7)
        const start = `${month}-01T00:00:00+05:30`
        const next = `${new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 10)}T00:00:00+05:30`
        const [{ data: doubts, error: dError }, { data: answers, error: aError }, { data: reviews, error: rError }] = await Promise.all([
          admin.from('doubts').select('id,status,created_at,first_teacher_answer_at,first_answered_by').gte('created_at', start).lt('created_at', next),
          admin.from('doubt_answers').select('author_id').eq('author_type', 'TEACHER').eq('status', 'APPROVED').gte('created_at', start).lt('created_at', next),
          admin.from('doubt_answers').select('reviewed_by').eq('author_type', 'STUDENT').not('reviewed_by', 'is', null).gte('reviewed_at', start).lt('reviewed_at', next),
        ])
        if (dError || aError || rError) throw dError || aError || rError
        const per = new Map<string, { answers: number, reviews: number, firstAnswers: number, hours: number }>()
        const get = (id: string) => { const v = per.get(id) || { answers: 0, reviews: 0, firstAnswers: 0, hours: 0 }; per.set(id, v); return v }
        for (const a of answers || []) get(a.author_id).answers++
        for (const r of reviews || []) get(r.reviewed_by).reviews++
        let answeredHours = 0, answeredCount = 0
        for (const d of doubts || []) {
          if (!d.first_teacher_answer_at) continue
          const h = (new Date(d.first_teacher_answer_at).getTime() - new Date(d.created_at).getTime()) / 3600000
          answeredHours += h; answeredCount++
          if (d.first_answered_by) { const v = get(d.first_answered_by); v.firstAnswers++; v.hours += h }
        }
        const names = await nameMaps([], [...per.keys()], [])
        const by = (s: string) => (doubts || []).filter((d) => d.status === s).length
        return response({ ok: true, data: { month, monthLabel: monthLabel(month),
          totals: { posted: (doubts || []).length, open: by('OPEN') + by('CLAIMED'), answered: by('ANSWERED'), resolved: by('RESOLVED'),
            avgResponseHours: answeredCount ? Math.round(answeredHours / answeredCount * 10) / 10 : null },
          teachers: [...per].map(([id, v]) => ({ TeacherID: id, Name: names.teachers.get(id) || id, Answers: v.answers, Reviews: v.reviews,
            AvgFirstResponseHours: v.firstAnswers ? Math.round(v.hours / v.firstAnswers * 10) / 10 : null }))
            .sort((a, b) => b.Answers - a.Answers || b.Reviews - a.Reviews) } })
      }
    }

    if (action === 'settings.studentDelete.get' || action === 'settings.studentDelete.set' || action === 'students.delete') {
      if (user.user_type !== 'ADMIN' || user.role !== 'SUPER_ADMIN') throw new ApiFault('FORBIDDEN', 'Only the Super Admin can use permanent student deletion.')
      const verifyPassword = async (password: unknown) => {
        const value = String(password || '')
        if (!value || value.length > 200) throw new ApiFault('BAD_PASSWORD', 'Enter your admin password.')
        const { data: authUser } = await admin.auth.admin.getUserById(authData.user.id)
        const email = authUser.user?.email
        if (!email) throw new ApiFault('BAD_PASSWORD', 'Admin password is incorrect.')
        const { data: check, error: checkError } = await auth.auth.signInWithPassword({ email, password: value })
        if (checkError || !check.session) throw new ApiFault('BAD_PASSWORD', 'Admin password is incorrect.')
        // Close the session that was opened only to check the password.
        await (admin.auth.admin as any).signOut(check.session.access_token, 'local').catch(() => null)
      }
      const { data: flag } = await admin.from('settings').select('value').eq('setting_key', 'STUDENT_DELETE_ENABLED').maybeSingle()
      const enabled = String(flag?.value || '').toUpperCase() === 'TRUE'
      if (action === 'settings.studentDelete.get') return response({ ok: true, data: { enabled } })
      if (action === 'settings.studentDelete.set') {
        const nextEnabled = payload.enabled === true
        await verifyPassword(payload.password)
        const { error } = await admin.from('settings').upsert({ setting_key: 'STUDENT_DELETE_ENABLED', value: nextEnabled ? 'TRUE' : 'FALSE',
          description: 'Allow the Super Admin to permanently delete students (changed only with the admin password).',
          updated_at: new Date().toISOString(), updated_by: user.id }, { onConflict: 'setting_key' })
        if (error) throw error
        await logAction(admin, user, nextEnabled ? 'ENABLE_STUDENT_DELETE' : 'DISABLE_STUDENT_DELETE', 'SETTING', 'STUDENT_DELETE_ENABLED', {})
        return response({ ok: true, data: { enabled: nextEnabled } })
      }
      // students.delete
      if (!enabled) throw new ApiFault('FORBIDDEN', 'Permanent student deletion is switched off. Turn it on in Settings first.')
      const studentId = requireText(payload.studentId, 'Student ID', 40, true)
      if (String(payload.confirmStudentId || '').trim() !== studentId) throw new ApiFault('BAD_REQUEST', 'Type the student ID exactly to confirm.')
      await verifyPassword(payload.password)
      const { data: student, error: studentError } = await admin.from('students').select('id,name').eq('id', studentId).maybeSingle()
      if (studentError) throw studentError
      if (!student) throw new ApiFault('NOT_FOUND', 'Student not found.')
      const { data: loginRows } = await admin.from('app_users').select('id,auth_user_id').eq('user_type', 'STUDENT').eq('linked_id', studentId)
      // Uploaded homework files in storage are removed after the database rows.
      const { data: submissions } = await admin.from('homework_submissions').select('id').eq('student_id', studentId)
      const submissionIds = (submissions || []).map((s) => s.id)
      const { data: files } = submissionIds.length
        ? await admin.from('homework_files').select('file_path').in('submission_id', submissionIds) : { data: [] }
      const { data: result, error: deleteError } = await admin.rpc('delete_student_permanently', { p_student_id: studentId })
      if (deleteError) throw deleteError
      const paths = (files || []).map((f) => f.file_path).filter(Boolean)
      if (paths.length) await admin.storage.from('homework-files').remove(paths).catch(() => null)
      for (const login of loginRows || []) {
        if (login.auth_user_id) await admin.auth.admin.deleteUser(login.auth_user_id).catch(() => null)
      }
      await logAction(admin, user, 'DELETE_STUDENT_PERMANENTLY', 'STUDENT', studentId, { name: student.name, removed: result })
      return response({ ok: true, data: { deleted: true, studentId, name: student.name } })
    }

    if (action === 'studentSubjects.updateFee') {
      const id = requireText(payload.studentSubjectId, 'Student subject ID', 40, true)
      const raw = payload.feeOverride
      let feeOverride: number | null = null
      if (raw !== undefined && raw !== null && raw !== '') {
        feeOverride = Number(raw)
        if (!Number.isFinite(feeOverride) || feeOverride < 0 || feeOverride > 100000) {
          throw new ApiFault('BAD_REQUEST', 'Special monthly fee must be from 0 to 100000.')
        }
      }
      const { data: current, error: findError } = await admin.from('student_subjects').select('*').eq('id', id).maybeSingle()
      if (findError) throw findError
      if (!current) throw new ApiFault('NOT_FOUND', 'Subject assignment not found.')
      if (String(current.status).toUpperCase() !== 'ACTIVE') throw new ApiFault('BAD_REQUEST', 'Only an active subject assignment can be edited.')
      const { error } = await admin.from('student_subjects').update({ fee_override: feeOverride }).eq('id', id)
      if (error) throw error
      const displayFee = (value: number | null) => value === null ? 'Standard fee' : String(value)
      const reason = requireText(payload.reason, 'Reason', 200) || 'Special monthly fee updated'
      await admin.from('change_history').insert({ id: `CHG-${crypto.randomUUID()}`, student_id: current.student_id,
        field: 'Special monthly fee', old_value: displayFee(current.fee_override === null ? null : Number(current.fee_override)),
        new_value: displayFee(feeOverride), changed_by: user.id, reason, academic_year: current.academic_year || '' })
      await logAction(admin, user, 'UPDATE_STUDENT_SUBJECT_FEE', 'STUDENT_SUBJECT', id,
        { oldFeeOverride: current.fee_override, feeOverride, reason })
      return response({ ok: true, data: { feeOverride } })
    }

    if (action === 'teacher.rescheduleClass') {
      if (user.user_type !== 'TEACHER' || !user.linked_id) throw new ApiFault('FORBIDDEN', 'Only a linked teacher can reschedule a class.')
      const timetableId = requireText(payload.timetableId, 'Class', 60, true)
      const originalDate = requireText(payload.originalDate, 'Original date', 10, true)
      const rescheduledDate = requireText(payload.rescheduledDate, 'New date', 10, true)
      const startTime = requireText(payload.startTime, 'New start time', 8, true)
      const endTime = requireText(payload.endTime, 'New end time', 8, true)
      const reason = requireText(payload.reason, 'Reason', 240)
      if (!validIsoDate(originalDate) || !validIsoDate(rescheduledDate)) throw new ApiFault('BAD_REQUEST', 'Choose valid class dates.')
      if (originalDate < todayDate() || rescheduledDate < todayDate()) throw new ApiFault('BAD_REQUEST', 'Only today or future classes can be rescheduled.')
      if (originalDate === rescheduledDate) throw new ApiFault('BAD_REQUEST', 'Choose a different date for the moved class.')
      const startMinute = timeMinutes(startTime), endMinute = timeMinutes(endTime)
      if (startMinute < 0 || endMinute <= startMinute) throw new ApiFault('BAD_REQUEST', 'Choose a valid time range.')

      const { data: slot, error: slotError } = await admin.from('timetable').select('*').eq('id', timetableId).maybeSingle()
      if (slotError) throw slotError
      if (!slot || slot.teacher_id !== user.linked_id) throw new ApiFault('FORBIDDEN', 'This is not your timetable class.')
      if (String(slot.status).toUpperCase() !== 'ACTIVE') throw new ApiFault('BAD_REQUEST', 'This timetable class is no longer active.')
      if (dateWeekday(originalDate) !== String(slot.day).toUpperCase()) throw new ApiFault('BAD_REQUEST', 'The original date does not match this weekly timetable class.')
      if (dateWeekday(rescheduledDate) === String(slot.day).toUpperCase()) throw new ApiFault('BAD_REQUEST', 'Choose a different weekday so this one-off class does not overlap the regular weekly class.')

      const { data: sessionRows, error: sessionError } = await admin.from('class_sessions').select('id,status')
        .eq('timetable_id', timetableId).eq('session_date', originalDate).limit(1)
      if (sessionError) throw sessionError
      if ((sessionRows || []).length) throw new ApiFault('BAD_REQUEST', 'This class has already started or finished, so it can no longer be moved.')

      const [existingResult, sameTeacherResult, sameBatchResult, targetMovesResult] = await Promise.all([
        admin.from('class_reschedules').select('id,status').eq('timetable_id', timetableId).eq('original_date', originalDate).maybeSingle(),
        admin.from('timetable').select('id,day,start_time,end_time,teacher_id,batch_id,status').eq('teacher_id', slot.teacher_id).ilike('status', 'active').neq('id', timetableId),
        admin.from('timetable').select('id,day,start_time,end_time,teacher_id,batch_id,status').eq('batch_id', slot.batch_id).ilike('status', 'active').neq('id', timetableId),
        admin.from('class_reschedules').select('id,timetable_id,start_time,end_time,teacher_id,batch_id,status').eq('rescheduled_date', rescheduledDate).eq('status', 'ACTIVE'),
      ])
      if (existingResult.error) throw existingResult.error
      if (sameTeacherResult.error) throw sameTeacherResult.error
      if (sameBatchResult.error) throw sameBatchResult.error
      if (targetMovesResult.error) throw targetMovesResult.error
      const existing = existingResult.data
      const peerSlots = new Map<string, any>()
      for (const peer of [...(sameTeacherResult.data || []), ...(sameBatchResult.data || [])]) peerSlots.set(peer.id, peer)
      const overlaps = (from: number, to: number, otherFrom: string, otherTo: string) => {
        const otherStart = timeMinutes(otherFrom), otherEnd = timeMinutes(otherTo)
        return otherStart >= 0 && otherEnd > otherStart && from < otherEnd && otherStart < to
      }
      for (const peer of peerSlots.values()) {
        if (String(peer.day).toUpperCase() === dateWeekday(rescheduledDate) && overlaps(startMinute, endMinute, peer.start_time, peer.end_time)) {
          throw new ApiFault('BAD_REQUEST', 'That time conflicts with another class for you or this batch. Choose another time.')
        }
      }
      for (const move of targetMovesResult.data || []) {
        if (move.id === existing?.id) continue
        if (move.timetable_id === timetableId) throw new ApiFault('BAD_REQUEST', 'This same timetable class already has another occurrence moved to that date.')
        if ((move.teacher_id === slot.teacher_id || move.batch_id === slot.batch_id) && overlaps(startMinute, endMinute, move.start_time, move.end_time)) {
          throw new ApiFault('BAD_REQUEST', 'That time conflicts with another rescheduled class. Choose another time.')
        }
      }

      const id = existing?.id || await newId(admin, 'class_reschedules', 'SHIFT-', 5)
      const row = { id, timetable_id: timetableId, teacher_id: slot.teacher_id, batch_id: slot.batch_id,
        subject_id: slot.subject_id, co_subject_id: slot.co_subject_id || null, room_id: slot.room_id || null,
        original_date: originalDate, rescheduled_date: rescheduledDate, start_time: startTime, end_time: endTime,
        reason, status: 'ACTIVE', created_by: user.id, updated_at: new Date().toISOString() }
      const { data: saved, error: saveError } = await admin.from('class_reschedules').upsert(row, { onConflict: 'timetable_id,original_date' }).select('*').single()
      if (saveError) throw saveError
      const [{ data: subjects }, { data: batches }] = await Promise.all([
        admin.from('subjects').select('id,name').in('id', [slot.subject_id, slot.co_subject_id].filter(Boolean)),
        admin.from('batches').select('id,name').eq('id', slot.batch_id).maybeSingle(),
      ])
      const subjectNames = new Map((subjects || []).map((x) => [x.id, x.name]))
      const subjectName = [subjectNames.get(slot.subject_id) || slot.subject_id, slot.co_subject_id ? subjectNames.get(slot.co_subject_id) || slot.co_subject_id : ''].filter(Boolean).join(' + ')
      await logAction(admin, user, 'RESCHEDULE_CLASS_OCCURRENCE', 'CLASS_RESCHEDULE', saved.id,
        { timetableId, originalDate, rescheduledDate, startTime, endTime, reason })
      return response({ ok: true, data: { RescheduleID: saved.id, TimetableID: timetableId, OriginalDate: originalDate,
        RescheduledDate: rescheduledDate, StartTime: saved.start_time, EndTime: saved.end_time, SubjectName: subjectName,
        BatchName: batches?.name || slot.batch_id, Reason: reason, UpdatedAt: saved.updated_at } })
    }

    if (action === 'student.classChanges') {
      if (user.user_type !== 'STUDENT' || !user.linked_id) throw new ApiFault('FORBIDDEN', 'Only a linked student can view class changes.')
      const { data: student, error: studentError } = await admin.from('students').select('current_batch_id').eq('id', user.linked_id).maybeSingle()
      if (studentError) throw studentError
      if (!student) throw new ApiFault('NOT_FOUND', 'Student record not found.')
      if (!student.current_batch_id) return response({ ok: true, data: [] })
      const since = new Date(Date.now() - 30 * 86400000).toISOString()
      const { data: changes, error } = await admin.from('class_reschedules').select('id,timetable_id,original_date,rescheduled_date,start_time,end_time,reason,created_at,updated_at,subject_id,co_subject_id,teacher_id')
        .eq('batch_id', student.current_batch_id).eq('status', 'ACTIVE').gte('updated_at', since).order('updated_at', { ascending: false }).limit(30)
      if (error) throw error
      const rows = changes || []
      if (!rows.length) return response({ ok: true, data: [] })
      const [subjects, teachers] = await Promise.all([
        admin.from('subjects').select('id,name').in('id', [...new Set(rows.flatMap((r) => [r.subject_id, r.co_subject_id].filter(Boolean)))]),
        admin.from('teachers').select('id,name').in('id', [...new Set(rows.map((r) => r.teacher_id))]),
      ])
      const subjectNames = new Map((subjects.data || []).map((x) => [x.id, x.name]))
      const teacherNames = new Map((teachers.data || []).map((x) => [x.id, x.name]))
      return response({ ok: true, data: rows.map((r) => ({ RescheduleID: r.id, TimetableID: r.timetable_id,
        OriginalDate: r.original_date, RescheduledDate: r.rescheduled_date, StartTime: r.start_time, EndTime: r.end_time,
        SubjectName: [subjectNames.get(r.subject_id) || r.subject_id, r.co_subject_id ? subjectNames.get(r.co_subject_id) || r.co_subject_id : ''].filter(Boolean).join(' + '),
        TeacherName: teacherNames.get(r.teacher_id) || r.teacher_id, Reason: r.reason, CreatedAt: r.created_at, UpdatedAt: r.updated_at })) })
    }

    if (action === 'student.subjects' || action === 'student.timetable' || action === 'student.attendance' || action === 'student.dashboard') {
      if (!user.linked_id) throw new ApiFault('NOT_FOUND', 'Student account is not linked to a student record.')
      const { data: student, error: studentError } = await admin.from('students').select('*').eq('id', user.linked_id).maybeSingle()
      if (studentError) throw studentError
      if (!student) throw new ApiFault('NOT_FOUND', 'Student record not found.')
      const { data: subjects, error: subjectsError } = await admin.from('student_subjects').select('*').eq('student_id', student.id).order('start_date', { ascending: false })
      if (subjectsError) throw subjectsError
      const subjectRows = (subjects || []).filter((r) => String(r.status).toUpperCase() !== 'REMOVED')
      if (action === 'student.subjects') {
        if (!subjectRows.length) return response({ ok: true, data: [] })
        const [{ data: sub }, { data: teachers }, { data: batches }] = await Promise.all([
          admin.from('subjects').select('id,name').in('id', subjectRows.map((r) => r.subject_id)),
          admin.from('teachers').select('id,name').in('id', subjectRows.map((r) => r.teacher_id).filter(Boolean)),
          admin.from('batches').select('id,name').in('id', subjectRows.map((r) => r.batch_id).filter(Boolean)),
        ])
        const sm = new Map((sub || []).map((x) => [x.id, x.name])), tm = new Map((teachers || []).map((x) => [x.id, x.name])), bm = new Map((batches || []).map((x) => [x.id, x.name]))
        return response({ ok: true, data: subjectRows.map((r) => ({ StudentSubjectID: r.id, SubjectID: r.subject_id, SubjectName: sm.get(r.subject_id) || r.subject_id,
          TeacherID: r.teacher_id, TeacherName: tm.get(r.teacher_id) || r.teacher_id, BatchID: r.batch_id, BatchName: bm.get(r.batch_id) || r.batch_id,
          StartDate: r.start_date, EndDate: r.end_date, Status: r.status })) })
      }
      const { data: timetable, error: ttError } = await admin.from('timetable').select('*').eq('batch_id', student.current_batch_id).ilike('status', 'active').order('day').order('start_time')
      if (ttError) throw ttError
      if (action === 'student.timetable') {
        if (!(timetable || []).length) return response({ ok: true, data: [] })
        const [sub, teachers, rooms] = await Promise.all([
          admin.from('subjects').select('id,name').in('id', [...new Set((timetable || []).flatMap((r) => [r.subject_id, r.co_subject_id].filter(Boolean)))]),
          admin.from('teachers').select('id,name').in('id', (timetable || []).map((r) => r.teacher_id)),
          admin.from('rooms').select('id,name').in('id', (timetable || []).map((r) => r.room_id).filter(Boolean)),
        ])
        const sm = new Map((sub.data || []).map((x) => [x.id, x.name])), tm = new Map((teachers.data || []).map((x) => [x.id, x.name])), rm = new Map((rooms.data || []).map((x) => [x.id, x.name]))
        return response({ ok: true, data: (timetable || []).map((r) => ({ TimetableID: r.id, Day: r.day, StartTime: r.start_time, EndTime: r.end_time,
          SubjectName: [sm.get(r.subject_id) || r.subject_id, r.co_subject_id ? sm.get(r.co_subject_id) || r.co_subject_id : ''].filter(Boolean).join(' + '),
          TeacherName: tm.get(r.teacher_id) || r.teacher_id, RoomName: rm.get(r.room_id) || r.room_id })) })
      }
      const days = action === 'student.dashboard' ? 30 : Math.min(Math.max(Number(payload.days) || 60, 1), 400)
      const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
      const { data: marks, error: markError } = await admin.from('attendance').select('*').eq('student_id', student.id).gte('session_date', from).order('session_date', { ascending: false }).limit(1000)
      if (markError) throw markError
      const rows = marks || []
      const present = rows.filter((r) => r.status === 'PRESENT').length, late = rows.filter((r) => r.status === 'LATE').length, absent = rows.filter((r) => r.status === 'ABSENT').length
      if (action === 'student.attendance') {
        const subIds = [...new Set(rows.map((r) => r.subject_id))], batchIds = [...new Set(rows.map((r) => r.batch_id))]
        const [sub, batches] = await Promise.all([admin.from('subjects').select('id,name').in('id', subIds), admin.from('batches').select('id,name').in('id', batchIds)])
        const sm = new Map((sub.data || []).map((x) => [x.id, x.name])), bm = new Map((batches.data || []).map((x) => [x.id, x.name]))
        return response({ ok: true, data: { from, rows: rows.map((r) => ({ AttendanceID: r.id, Date: r.session_date, SubjectName: sm.get(r.subject_id) || r.subject_id,
          BatchName: bm.get(r.batch_id) || r.batch_id, Status: r.status, Method: r.method, MarkedAt: r.marked_at })),
          summary: { present, late, absent, total: rows.length, pct: rows.length ? Math.round((present + late * 0.5) / rows.length * 100) : 0 } } })
      }
      const today = todayDate()
      const dayName = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long' }).format(new Date()).toUpperCase()
      const [{ data: sub }, { data: teachers }, { data: rooms }, { data: sessions }, { data: notices }, originalMoves, destinationMoves] = await Promise.all([
        admin.from('subjects').select('id,name').in('id', [...new Set((timetable || []).flatMap((r) => [r.subject_id, r.co_subject_id].filter(Boolean)))]),
        admin.from('teachers').select('id,name').in('id', (timetable || []).map((r) => r.teacher_id)),
        admin.from('rooms').select('id,name').in('id', (timetable || []).map((r) => r.room_id).filter(Boolean)),
        admin.from('class_sessions').select('id,timetable_id,status').eq('session_date', today),
        admin.from('notices').select('*').ilike('status', 'active').order('posted_at', { ascending: false }).limit(100),
        student.current_batch_id ? admin.from('class_reschedules').select('*').eq('batch_id', student.current_batch_id).eq('original_date', today).eq('status', 'ACTIVE') : Promise.resolve({ data: [], error: null }),
        student.current_batch_id ? admin.from('class_reschedules').select('*').eq('batch_id', student.current_batch_id).eq('rescheduled_date', today).eq('status', 'ACTIVE') : Promise.resolve({ data: [], error: null }),
      ])
      if (originalMoves.error) throw originalMoves.error
      if (destinationMoves.error) throw destinationMoves.error
      const sm = new Map((sub || []).map((x) => [x.id, x.name])), tm = new Map((teachers || []).map((x) => [x.id, x.name])), rm = new Map((rooms || []).map((x) => [x.id, x.name]))
      const activeSubjects = subjectRows.filter((r) => r.status.toUpperCase() === 'ACTIVE').length
      const movedAway = new Set((originalMoves.data || []).map((r) => r.timetable_id))
      const todaySlots = new Map<string, { slot: any; move: any | null }>()
      for (const slot of timetable || []) {
        if (slot.day.toUpperCase() === dayName && !movedAway.has(slot.id)) todaySlots.set(slot.id, { slot, move: null })
      }
      for (const move of destinationMoves.data || []) {
        const slot = (timetable || []).find((r) => r.id === move.timetable_id)
        if (slot) todaySlots.set(slot.id, { slot, move })
      }
      const todayClasses = [...todaySlots.values()].sort((a, b) => String(a.move?.start_time || a.slot.start_time).localeCompare(String(b.move?.start_time || b.slot.start_time))).map(({ slot: r, move }) => {
        const ses = (sessions || []).find((s) => s.timetable_id === r.id && s.status === 'OPEN')
        return { TimetableID: r.id, StartTime: move?.start_time || r.start_time, EndTime: move?.end_time || r.end_time,
          SubjectName: [sm.get(r.subject_id) || r.subject_id, r.co_subject_id ? sm.get(r.co_subject_id) || r.co_subject_id : ''].filter(Boolean).join(' + '),
          TeacherName: tm.get(r.teacher_id) || r.teacher_id, RoomName: rm.get(r.room_id) || r.room_id, ActiveSessionID: ses?.id || null,
          IsRescheduled: !!move, OriginalDate: move?.original_date || null }
      })
      const recentNotices = (notices || []).filter((n) => !n.expires_at || n.expires_at >= today).filter((n) =>
        ['ALL', 'STUDENTS'].includes(String(n.audience).toUpperCase()) || (String(n.audience).toUpperCase() === 'BATCH' && n.batch_id === student.current_batch_id))
        .slice(0, 3).map((n) => ({ NoticeID: n.id, Title: n.title, Body: n.body, Audience: n.audience, PostedAt: n.posted_at, ExpiresAt: n.expires_at }))
      return response({ ok: true, data: { student: legacyStudent(student), stats: { activeSubjects, attendancePct: rows.length ? Math.round((present + late * 0.5) / rows.length * 100) : 0,
        present, late, absent, totalSessions: rows.length }, todayClasses, recentNotices } })
    }

    if (action === 'teacher.dashboard' || action === 'teacher.timetable' || action === 'teacher.students' || action === 'teacher.studentProfile' || action === 'teacher.sessions') {
      if (action === 'teacher.studentProfile' && user.user_type !== 'TEACHER') throw new ApiFault('FORBIDDEN', 'Teacher access is required.')
      if (!user.linked_id) throw new ApiFault('NOT_FOUND', 'Teacher account is not linked to a teacher record.')
      const { data: teacher, error: tError } = await admin.from('teachers').select('*').eq('id', user.linked_id).maybeSingle()
      if (tError) throw tError
      if (!teacher) throw new ApiFault('NOT_FOUND', 'Teacher record not found.')
      const { data: timetable, error: ttError } = await admin.from('timetable').select('*').eq('teacher_id', teacher.id).ilike('status', 'active').order('day').order('start_time')
      if (ttError) throw ttError
      const tt = timetable || []
      if (action === 'teacher.timetable') {
        const [sub, batches, rooms] = await Promise.all([admin.from('subjects').select('id,name').in('id', [...new Set(tt.flatMap((r) => [r.subject_id, r.co_subject_id].filter(Boolean)))]),
          admin.from('batches').select('id,name').in('id', tt.map((r) => r.batch_id)), admin.from('rooms').select('id,name').in('id', tt.map((r) => r.room_id).filter(Boolean))])
        const sm = new Map((sub.data || []).map((x) => [x.id, x.name])), bm = new Map((batches.data || []).map((x) => [x.id, x.name])), rm = new Map((rooms.data || []).map((x) => [x.id, x.name]))
        return response({ ok: true, data: tt.map((r) => ({ TimetableID: r.id, Day: r.day, StartTime: r.start_time, EndTime: r.end_time,
          BatchID: r.batch_id, BatchName: bm.get(r.batch_id) || r.batch_id, SubjectID: r.subject_id, CoSubjectID: r.co_subject_id || '',
          SubjectOptions: [r.subject_id, r.co_subject_id].filter(Boolean).map((id) => ({ id, name: sm.get(id) || id })),
          SubjectName: [sm.get(r.subject_id) || r.subject_id, r.co_subject_id ? sm.get(r.co_subject_id) || r.co_subject_id : ''].filter(Boolean).join(' + '),
          RoomID: r.room_id, RoomName: rm.get(r.room_id) || r.room_id })) })
      }
      if (action === 'teacher.students') {
        const { data: assignments, error } = await admin.from('student_subjects').select('*').eq('teacher_id', teacher.id).ilike('status', 'active')
        if (error) throw error
        const [students, subjects, batches] = await Promise.all([admin.from('students').select('id,name,roll_no,status').in('id', [...new Set((assignments || []).map((r) => r.student_id))]),
          admin.from('subjects').select('id,name'), admin.from('batches').select('id,name')])
        const sm = new Map((subjects.data || []).map((x) => [x.id, x.name])), bm = new Map((batches.data || []).map((x) => [x.id, x.name])), stu = new Map((students.data || []).map((x) => [x.id, x]))
        const groups = new Map<string, Record<string, unknown>>()
        for (const r of assignments || []) {
          const key = `${r.subject_id}|${r.batch_id}`
          if (!groups.has(key)) groups.set(key, { subjectId: r.subject_id, subjectName: sm.get(r.subject_id) || r.subject_id, batchId: r.batch_id, batchName: bm.get(r.batch_id) || r.batch_id, students: [] })
          const s = stu.get(r.student_id)
          if (s && s.status.toUpperCase() === 'ACTIVE') (groups.get(key)!.students as unknown[]).push({ StudentID: s.id, Name: s.name, RollNo: s.roll_no || '' })
        }
        return response({ ok: true, data: [...groups.values()] })
      }
      if (action === 'teacher.studentProfile') {
        const studentId = requireText(payload.studentId, 'Student ID', 60, true)
        const { data: assignedRows, error: assignedError } = await admin.from('student_subjects')
          .select('subject_id,batch_id,status,start_date,end_date,academic_year')
          .eq('teacher_id', teacher.id).eq('student_id', studentId).neq('status', 'REMOVED').order('start_date', { ascending: false })
        if (assignedError) throw assignedError
        if (!assignedRows?.length) throw new ApiFault('FORBIDDEN', 'This student is not assigned to your classes.')
        const { data: student, error: studentError } = await admin.from('students')
          .select('id,name,roll_no,status,current_class,current_batch_id').eq('id', studentId).maybeSingle()
        if (studentError) throw studentError
        if (!student) throw new ApiFault('NOT_FOUND', 'Student not found.')
        const subjectIds = [...new Set(assignedRows.map((r) => r.subject_id))]
        const batchIds = [...new Set(assignedRows.map((r) => r.batch_id))]
        const [{ data: subjects, error: subjectsError }, { data: batches, error: batchesError }] = await Promise.all([
          admin.from('subjects').select('id,name').in('id', subjectIds),
          admin.from('batches').select('id,name').in('id', batchIds),
        ])
        if (subjectsError) throw subjectsError
        if (batchesError) throw batchesError
        const subjectNames = new Map((subjects || []).map((r) => [r.id, r.name]))
        const batchNames = new Map((batches || []).map((r) => [r.id, r.name]))
        return response({ ok: true, data: { student: { StudentID: student.id, Name: student.name, RollNo: student.roll_no || '',
          Status: student.status, CurrentClass: student.current_class || '', CurrentBatchName: batchNames.get(student.current_batch_id) || '' },
          assignments: assignedRows.map((r) => ({ SubjectName: subjectNames.get(r.subject_id) || r.subject_id,
            BatchName: batchNames.get(r.batch_id) || r.batch_id, Status: r.status, StartDate: r.start_date || '',
            EndDate: r.end_date || '', AcademicYear: r.academic_year || '' })) } })
      }
      if (action === 'teacher.sessions') {
        const limit = Math.min(Math.max(Number(payload.limit) || 30, 1), 200)
        const { data: sessions, error } = await admin.from('class_sessions').select('*').eq('teacher_id', teacher.id).order('started_at', { ascending: false }).limit(limit)
        if (error) throw error
        const ids = (sessions || []).map((s) => s.id)
        const { data: marks, error: mError } = ids.length ? await admin.from('attendance').select('session_id,status').in('session_id', ids) : { data: [], error: null }
        if (mError) throw mError
        const [subjects, batches] = await Promise.all([admin.from('subjects').select('id,name'), admin.from('batches').select('id,name')])
        const sm = new Map((subjects.data || []).map((x) => [x.id, x.name])), bm = new Map((batches.data || []).map((x) => [x.id, x.name]))
        const sessionIds = (sessions || []).map((s) => s.id)
        const { data: classMaterials, error: classMaterialsError } = sessionIds.length
          ? await admin.from('class_materials').select('id,session_id,file_path,file_name,expires_at').in('session_id', sessionIds).gt('expires_at', new Date().toISOString())
          : { data: [], error: null }
        if (classMaterialsError) throw classMaterialsError
        const materialLinks = await Promise.all((classMaterials || []).map(async (x) => {
          const secondsLeft = Math.max(1, Math.min(3600, Math.ceil((new Date(x.expires_at).getTime() - Date.now()) / 1000)))
          const { data: signed, error } = await admin.storage.from('class-materials').createSignedUrl(x.file_path, secondsLeft, { download: x.file_name })
          if (error) throw error
          return { MaterialID: x.id, SessionID: x.session_id, FileName: x.file_name, ExpiresAt: x.expires_at, URL: signed.signedUrl }
        }))
        const bySession = new Map<string, any[]>()
        for (const material of materialLinks) bySession.set(material.SessionID, [...(bySession.get(material.SessionID) || []), material])
        return response({ ok: true, data: (sessions || []).map((s) => { const m = (marks || []).filter((x) => x.session_id === s.id); return { SessionID: s.id,
          Date: s.session_date, StartTime: s.start_time, EndTime: s.end_time, BatchName: bm.get(s.batch_id) || s.batch_id,
          SubjectName: [sm.get(s.subject_id) || s.subject_id, s.co_subject_id ? sm.get(s.co_subject_id) || s.co_subject_id : ''].filter(Boolean).join(' + '),
          Status: s.status, Present: m.filter((x) => x.status === 'PRESENT').length, Late: m.filter((x) => x.status === 'LATE').length,
          Absent: m.filter((x) => x.status === 'ABSENT').length, Total: m.length, Materials: bySession.get(s.id) || [] } }) })
      }
      const today = todayDate()
      const [{ data: assignments }, { data: subjects }, { data: batches }, { data: rooms }, { data: sessions }, originalMoves, destinationMoves] = await Promise.all([
        admin.from('student_subjects').select('student_id,subject_id,batch_id,status').eq('teacher_id', teacher.id).ilike('status', 'active'),
        admin.from('subjects').select('id,name'), admin.from('batches').select('id,name'), admin.from('rooms').select('id,name'),
        admin.from('class_sessions').select('id,timetable_id,status').eq('session_date', today),
        admin.from('class_reschedules').select('*').eq('teacher_id', teacher.id).eq('original_date', today).eq('status', 'ACTIVE'),
        admin.from('class_reschedules').select('*').eq('teacher_id', teacher.id).eq('rescheduled_date', today).eq('status', 'ACTIVE'),
      ])
      if (originalMoves.error) throw originalMoves.error
      if (destinationMoves.error) throw destinationMoves.error
      const activeAssignments = assignments || []
      const sm = new Map((subjects || []).map((x) => [x.id, x.name]))
      const bm = new Map((batches || []).map((x) => [x.id, x.name]))
      const rm = new Map((rooms || []).map((x) => [x.id, x.name]))
      const dayName = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long' }).format(new Date()).toUpperCase()
      const movedAway = new Set((originalMoves.data || []).map((r) => r.timetable_id))
      const todaySlots = new Map<string, { slot: any; move: any | null }>()
      for (const slot of tt) {
        if (slot.day.toUpperCase() === dayName && !movedAway.has(slot.id)) todaySlots.set(slot.id, { slot, move: null })
      }
      for (const move of destinationMoves.data || []) {
        const slot = tt.find((r) => r.id === move.timetable_id)
        if (slot) todaySlots.set(slot.id, { slot, move })
      }
      const todays = [...todaySlots.values()].sort((a, b) => String(a.move?.start_time || a.slot.start_time).localeCompare(String(b.move?.start_time || b.slot.start_time)))
      const sessionRows = (sessions || [])
      return response({ ok: true, data: { teacher: { TeacherID: teacher.id, Name: teacher.name, Mobile: teacher.mobile, Email: teacher.email },
        stats: { students: new Set(activeAssignments.map((r) => r.student_id)).size, subjects: new Set(activeAssignments.map((r) => r.subject_id)).size, todayClasses: todays.length },
        todayClasses: todays.map(({ slot: r, move }) => { const ses = sessionRows.find((x) => x.timetable_id === r.id && x.status === 'OPEN');
          const closed = sessionRows.find((x) => x.timetable_id === r.id && x.status === 'CLOSED');
          return { TimetableID: r.id, StartTime: move?.start_time || r.start_time, EndTime: move?.end_time || r.end_time,
            BatchID: r.batch_id, BatchName: bm.get(r.batch_id) || r.batch_id, SubjectID: r.subject_id, CoSubjectID: r.co_subject_id || '',
            SubjectName: [sm.get(r.subject_id) || r.subject_id, r.co_subject_id ? sm.get(r.co_subject_id) || r.co_subject_id : ''].filter(Boolean).join(' + '),
            RoomID: r.room_id, RoomName: rm.get(r.room_id) || r.room_id, ActiveSessionID: ses?.id || null, ClosedSessionID: closed?.id || null,
            IsRescheduled: !!move, OriginalDate: move?.original_date || null } }) } })
    }

    if (action === 'teacher.startClass' || action === 'teacher.regenerateCode' || action === 'student.enterCode') {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
      const now = new Date()
      if (action === 'teacher.startClass') {
        const id = requireText(payload.timetableId, 'Timetable ID', 60, true)
        const { data: slot, error } = await admin.from('timetable').select('*').eq('id', id).maybeSingle()
        if (error) throw error
        if (!slot) throw new ApiFault('NOT_FOUND', 'Timetable entry not found.')
        if (slot.teacher_id !== user.linked_id) throw new ApiFault('FORBIDDEN', 'This is not your class.')
        const [movesAway, movesHere] = await Promise.all([
          admin.from('class_reschedules').select('id').eq('timetable_id', id).eq('original_date', today).eq('status', 'ACTIVE').limit(1),
          admin.from('class_reschedules').select('start_time,end_time').eq('timetable_id', id).eq('rescheduled_date', today).eq('status', 'ACTIVE').maybeSingle(),
        ])
        if (movesAway.error) throw movesAway.error
        if (movesHere.error) throw movesHere.error
        if ((movesAway.data || []).length) throw new ApiFault('BAD_REQUEST', 'This class was moved to another date and cannot be started today.')
        const startTime = movesHere.data?.start_time || slot.start_time
        const endTime = movesHere.data?.end_time || slot.end_time
        const { data: existing, error: findError } = await admin.from('class_sessions').select('*').eq('timetable_id', id).eq('session_date', today).eq('status', 'OPEN').maybeSingle()
        if (findError && findError.code !== 'PGRST116') throw findError
        if (existing) return response({ ok: true, data: { sessionId: existing.id, code: existing.attendance_code, reused: true } })
        let code = String(Math.floor(1000 + Math.random() * 9000))
        const { data: active } = await admin.from('class_sessions').select('attendance_code').eq('status', 'OPEN')
        for (let tries = 0; tries < 20 && (active || []).some((s) => s.attendance_code === code); tries++) code = String(Math.floor(1000 + Math.random() * 9000))
        const { data: settings } = await admin.from('settings').select('setting_key,value').eq('setting_key', 'ATTENDANCE_CODE_MINUTES').maybeSingle()
        const minutes = Math.min(Math.max(Number(settings?.value) || 5, 1), 30)
        const expires = new Date(now.getTime() + minutes * 60000).toISOString()
        const sessionId = await newId(admin, 'class_sessions', `SESSION-${today.replaceAll('-', '')}-`, 3)
        const { error: insertError } = await admin.from('class_sessions').insert({ id: sessionId, timetable_id: slot.id, session_date: today,
          start_time: startTime, end_time: endTime, teacher_id: slot.teacher_id, batch_id: slot.batch_id, subject_id: slot.subject_id,
          room_id: slot.room_id, co_subject_id: slot.co_subject_id || null, attendance_code: code, code_created_at: now.toISOString(), code_expires_at: expires, status: 'OPEN',
          started_at: now.toISOString(), academic_year: slot.academic_year })
        if (insertError) {
          if (insertError.code === '23505') return response(fail('CLASS_ALREADY_OPEN', 'A class session is already open for this timetable slot. Refresh the page.'))
          throw insertError
        }
        await logAction(admin, user, 'START_CLASS', 'CLASS_SESSION', sessionId, { batch: slot.batch_id, subject: slot.subject_id })
        return response({ ok: true, data: { sessionId, code, reused: false } })
      }
      if (action === 'teacher.regenerateCode') {
        const sid = requireText(payload.sessionId, 'Session ID', 60, true)
        const { data: s, error } = await admin.from('class_sessions').select('*').eq('id', sid).maybeSingle()
        if (error) throw error
        if (!s) throw new ApiFault('NOT_FOUND', 'Session not found.')
        if (s.teacher_id !== user.linked_id) throw new ApiFault('FORBIDDEN', 'Not your class.')
        if (s.status !== 'OPEN') throw new ApiFault('BAD_REQUEST', 'This class is closed.')
        const code = String(Math.floor(1000 + Math.random() * 9000))
        const { data: settings } = await admin.from('settings').select('value').eq('setting_key', 'ATTENDANCE_CODE_MINUTES').maybeSingle()
        const expires = new Date(now.getTime() + Math.min(Math.max(Number(settings?.value) || 5, 1), 30) * 60000).toISOString()
        const { error: updateError } = await admin.from('class_sessions').update({ attendance_code: code, code_created_at: now.toISOString(), code_expires_at: expires }).eq('id', sid).eq('status', 'OPEN')
        if (updateError) throw updateError
        return response({ ok: true, data: { code, expiresAt: expires } })
      }
      const code = requireText(payload.code, 'Attendance code', 4, true)
      if (!/^\d{4}$/.test(code)) throw new ApiFault('BAD_CODE', 'Enter the 4-digit code shown by your teacher.')
      if (!user.linked_id) throw new ApiFault('NOT_FOUND', 'Student account is not linked to a student record.')
      const { data: matches, error: matchError } = await admin.from('class_sessions').select('*').eq('attendance_code', code).eq('status', 'OPEN').gte('code_expires_at', now.toISOString())
      if (matchError) throw matchError
      let chosen: any = null
      for (const s of matches || []) {
        const subjectIds = [s.subject_id, s.co_subject_id].filter(Boolean)
        const { data: roster, error: rosterError } = await admin.from('student_subjects').select('id,subject_id').eq('student_id', user.linked_id).in('subject_id', subjectIds).eq('batch_id', s.batch_id).ilike('status', 'active')
        if (rosterError && rosterError.code !== 'PGRST116') throw rosterError
        const enrollment = (roster || []).find((r) => r.subject_id === s.subject_id) || (roster || [])[0]
        if (enrollment) { chosen = { ...s, attendance_subject_id: enrollment.subject_id }; break }
      }
      if (!chosen) throw new ApiFault(matches?.length ? 'NOT_IN_CLASS' : 'BAD_CODE', matches?.length ? 'That class is not one of your subjects.' : 'That code is wrong or has expired. Ask your teacher for the current code.')
      const { data: existing, error: existingError } = await admin.from('attendance').select('status,marked_at,subject_id').eq('session_id', chosen.id).eq('student_id', user.linked_id).maybeSingle()
      if (existingError) throw existingError
      if (existing) return response({ ok: true, data: { ok: true, alreadyMarked: true, status: existing.status,
        subjectName: (await admin.from('subjects').select('name').eq('id', existing.subject_id).maybeSingle()).data?.name || existing.subject_id, markedAt: existing.marked_at } })
      const late = now.getTime() - new Date(chosen.code_created_at || now).getTime() > 120000
      const attendanceId = await newId(admin, 'attendance', 'ATT-', 5)
      const { error: markError } = await admin.from('attendance').insert({ id: attendanceId, session_id: chosen.id, student_id: user.linked_id,
        subject_id: chosen.attendance_subject_id, batch_id: chosen.batch_id, session_date: chosen.session_date, status: late ? 'LATE' : 'PRESENT', marked_by: user.id,
        method: 'CODE', academic_year: chosen.academic_year })
      if (markError && markError.code !== '23505') throw markError
      const subject = await admin.from('subjects').select('name').eq('id', chosen.attendance_subject_id).maybeSingle()
      const { data: saved } = await admin.from('attendance').select('status,marked_at').eq('session_id', chosen.id).eq('student_id', user.linked_id).single()
      if (!saved) throw new ApiFault('SERVER_ERROR', 'Attendance was saved but could not be read back. Refresh and check your attendance.')
      return response({ ok: true, data: { ok: true, alreadyMarked: !!markError, status: saved.status, subjectName: subject.data?.name || chosen.attendance_subject_id, markedAt: saved.marked_at } })
    }

    if (action === 'attendance.sessions') {
      const from = requireText(payload.from, 'From date', 10), to = requireText(payload.to, 'To date', 10)
      let query = admin.from('class_sessions').select('*').order('session_date', { ascending: false }).order('start_time', { ascending: false }).limit(300)
      if (from) query = query.gte('session_date', from)
      if (to) query = query.lte('session_date', to)
      if (payload.batchId) query = query.eq('batch_id', String(payload.batchId))
      if (payload.teacherId) query = query.eq('teacher_id', String(payload.teacherId))
      const { data: sessions, error } = await query
      if (error) throw error
      const ids = (sessions || []).map((x) => x.id)
      const [marks, subjects, batches, teachers, rooms] = await Promise.all([
        ids.length ? admin.from('attendance').select('session_id,status').in('session_id', ids) : Promise.resolve({ data: [], error: null }),
        admin.from('subjects').select('id,name'), admin.from('batches').select('id,name'), admin.from('teachers').select('id,name'), admin.from('rooms').select('id,name'),
      ])
      if (marks.error) throw marks.error
      const sm = new Map((subjects.data || []).map((x) => [x.id, x.name])), bm = new Map((batches.data || []).map((x) => [x.id, x.name]))
      const tm = new Map((teachers.data || []).map((x) => [x.id, x.name])), rm = new Map((rooms.data || []).map((x) => [x.id, x.name]))
      return response({ ok: true, data: (sessions || []).map((s) => { const m = (marks.data || []).filter((x) => x.session_id === s.id); return {
        SessionID: s.id, Date: s.session_date, StartTime: s.start_time, EndTime: s.end_time, BatchName: bm.get(s.batch_id) || s.batch_id,
        SubjectName: [sm.get(s.subject_id) || s.subject_id, s.co_subject_id ? sm.get(s.co_subject_id) || s.co_subject_id : ''].filter(Boolean).join(' + '),
        TeacherName: tm.get(s.teacher_id) || s.teacher_id, RoomName: rm.get(s.room_id) || '', Status: s.status,
        Present: m.filter((x) => x.status === 'PRESENT').length, Late: m.filter((x) => x.status === 'LATE').length, Absent: m.filter((x) => x.status === 'ABSENT').length,
      } }) })
    }

    if (action === 'teacher.classStatus' || action === 'teacher.manualAttendance' || action === 'teacher.markAll' || action === 'teacher.closeClass' || action === 'attendance.detail' || action === 'attendance.correct') {
      const sid = requireText(payload.sessionId, 'Session ID', 60, true)
      const { data: s, error: sError } = await admin.from('class_sessions').select('*').eq('id', sid).maybeSingle()
      if (sError) throw sError
      if (!s) throw new ApiFault('NOT_FOUND', 'Class session not found.')
      const teacherOwns = user.user_type === 'TEACHER' && s.teacher_id === user.linked_id
      if (action.startsWith('teacher.') && !teacherOwns) throw new ApiFault('FORBIDDEN', 'This is not your class.')
      if (action === 'attendance.detail' && !permissionsFor(user).includes('*') && !permissionsFor(user).includes('STUDENT_VIEW')) throw new ApiFault('FORBIDDEN', 'You do not have permission to view attendance.')
      if (action === 'teacher.manualAttendance' || action === 'attendance.correct') {
        const studentId = requireText(payload.studentId, 'Student ID', 60, true)
        let attendanceSubjectId = s.subject_id
        const status = requireText(payload.status, 'Status', 10, true).toUpperCase()
        if (!['PRESENT', 'LATE', 'ABSENT'].includes(status)) throw new ApiFault('BAD_REQUEST', 'Status must be PRESENT, LATE, or ABSENT.')
        const reason = String(payload.reason || '').trim().slice(0, 200)
        if (action === 'attendance.correct' && !reason) throw new ApiFault('BAD_REQUEST', 'Please give a reason for the correction.')
        if (action === 'teacher.manualAttendance' && s.status !== 'OPEN') throw new ApiFault('BAD_REQUEST', 'This class is closed.')
        if (action === 'teacher.manualAttendance') {
          const classSubjectIds = [s.subject_id, s.co_subject_id].filter(Boolean)
          const { data: roster, error: rosterError } = await admin.from('student_subjects').select('id,subject_id').eq('student_id', studentId)
            .in('subject_id', classSubjectIds).eq('batch_id', s.batch_id).eq('teacher_id', s.teacher_id).ilike('status', 'active')
          if (rosterError) throw rosterError
          if (!roster?.length) throw new ApiFault('BAD_REQUEST', 'This student is not on the class roster.')
          attendanceSubjectId = roster.find((r) => r.subject_id === s.subject_id)?.subject_id || roster[0].subject_id
        }
        const { data: old, error: oldError } = await admin.from('attendance').select('*').eq('session_id', sid).eq('student_id', studentId).maybeSingle()
        if (oldError) throw oldError
        if (action === 'attendance.correct' && old?.subject_id) attendanceSubjectId = old.subject_id
        if (old?.status === status) return response({ ok: true, data: { ok: true, unchanged: true } })
        const attendanceId = old?.id || await newId(admin, 'attendance', 'ATT-', 5)
        const { error: saveError } = await admin.from('attendance').upsert({ id: attendanceId, session_id: sid, student_id: studentId, subject_id: attendanceSubjectId,
          batch_id: s.batch_id, session_date: s.session_date, status, marked_by: user.id, marked_at: new Date().toISOString(),
          method: action === 'attendance.correct' ? 'ADMIN_CORRECTION' : 'TEACHER_MANUAL', academic_year: s.academic_year }, { onConflict: 'session_id,student_id' })
        if (saveError) throw saveError
        if (old || action === 'attendance.correct') await admin.from('attendance_logs').insert({ id: `AL-${crypto.randomUUID()}`, attendance_id: attendanceId,
          session_id: sid, student_id: studentId, old_status: old?.status || '', new_status: status, changed_by: user.id, reason })
        await logAction(admin, user, action === 'attendance.correct' ? 'CORRECT_ATTENDANCE' : 'MARK_ATTENDANCE', 'ATTENDANCE', attendanceId, { from: old?.status || '', to: status, reason })
        return response({ ok: true, data: { ok: true, changed: !!old, created: !old } })
      }
      if (action === 'teacher.markAll' || action === 'teacher.closeClass') {
        if (s.status !== 'OPEN') return response({ ok: true, data: { ok: true, alreadyClosed: true } })
        const classSubjectIds = [s.subject_id, s.co_subject_id].filter(Boolean)
        const { data: rosterRows, error: rosterError } = await admin.from('student_subjects').select('student_id,subject_id').eq('teacher_id', s.teacher_id).eq('batch_id', s.batch_id).in('subject_id', classSubjectIds).ilike('status', 'active')
        if (rosterError) throw rosterError
        const { data: activeStudents, error: activeError } = await admin.from('students').select('id').in('id', [...new Set((rosterRows || []).map((r) => r.student_id))]).ilike('status', 'active')
        if (activeError) throw activeError
        const { data: existing, error: existingError } = await admin.from('attendance').select('student_id').eq('session_id', sid)
        if (existingError) throw existingError
        const have = new Set((existing || []).map((r) => r.student_id))
        const markAbsent = action === 'teacher.closeClass' && payload.markAbsent !== false
        const status = action === 'teacher.markAll' ? (String(payload.status || 'PRESENT').toUpperCase()) : 'ABSENT'
        if (!['PRESENT', 'LATE', 'ABSENT'].includes(status)) throw new ApiFault('BAD_REQUEST', 'Invalid attendance status.')
        const remaining = (activeStudents || []).filter((r) => !have.has(r.id))
        const assignedSubject = new Map<string, string>()
        for (const r of rosterRows || []) {
          if (!assignedSubject.has(r.student_id) || r.subject_id === s.subject_id) assignedSubject.set(r.student_id, r.subject_id)
        }
        const rows = (action === 'teacher.markAll' || markAbsent) ? remaining.map((r) => ({ id: `ATT-${crypto.randomUUID()}`, session_id: sid, student_id: r.id,
          subject_id: assignedSubject.get(r.id) || s.subject_id, batch_id: s.batch_id, session_date: s.session_date, status, marked_by: user.id, method: 'TEACHER_MANUAL', academic_year: s.academic_year })) : []
        for (let i = 0; i < rows.length; i += 200) {
          const { error } = await admin.from('attendance').upsert(rows.slice(i, i + 200), { onConflict: 'session_id,student_id', ignoreDuplicates: true })
          if (error) throw error
        }
        if (action === 'teacher.closeClass') {
          const { error } = await admin.from('class_sessions').update({ status: 'CLOSED', closed_at: new Date().toISOString() }).eq('id', sid).eq('status', 'OPEN')
          if (error) throw error
        }
        await logAction(admin, user, action === 'teacher.closeClass' ? 'CLOSE_CLASS' : 'MARK_ALL_ATTENDANCE', 'CLASS_SESSION', sid, { marked: rows.length, status })
        return response({ ok: true, data: action === 'teacher.closeClass' ? { ok: true, markedAbsent: rows.length } : { ok: true, marked: rows.length, status } })
      }
      const { data: marks, error: marksError } = await admin.from('attendance').select('*').eq('session_id', sid)
      if (marksError) throw marksError
      const [{ data: rosterRows }, { data: students }, { data: subjects }, { data: batches }, { data: teachers }, { data: rooms }] = await Promise.all([
        admin.from('student_subjects').select('student_id').eq('teacher_id', s.teacher_id).eq('batch_id', s.batch_id).in('subject_id', [s.subject_id, s.co_subject_id].filter(Boolean)).ilike('status', 'active'),
        admin.from('students').select('id,name,roll_no'), admin.from('subjects').select('id,name').in('id', [s.subject_id, s.co_subject_id].filter(Boolean)),
        admin.from('batches').select('id,name').eq('id', s.batch_id), admin.from('teachers').select('id,name').eq('id', s.teacher_id), admin.from('rooms').select('id,name').eq('id', s.room_id || ''),
      ])
      const rosterIds = new Set((rosterRows || []).map((r) => r.student_id)), marked = new Map((marks || []).map((r) => [r.student_id, r]))
      const roster = (students || []).filter((r) => rosterIds.has(r.id) || marked.has(r.id)).sort((a, b) => String(a.roll_no || a.name).localeCompare(String(b.roll_no || b.name)))
      const byStatus = { PRESENT: 0, LATE: 0, ABSENT: 0 }; for (const r of marks || []) if (r.status in byStatus) byStatus[r.status as keyof typeof byStatus]++
      const studentData = roster.map((r) => { const a = marked.get(r.id); return { StudentID: r.id, Name: r.name, RollNo: r.roll_no || '', Status: a?.status || null, Method: a?.method || null, MarkedAt: a?.marked_at || null } })
      if (action === 'teacher.classStatus') return response({ ok: true, data: { session: { SessionID: sid, Date: s.session_date, StartTime: s.start_time, EndTime: s.end_time,
        BatchName: batches?.[0]?.name || s.batch_id, SubjectName: [s.subject_id, s.co_subject_id].filter(Boolean).map((id) => (subjects || []).find((x) => x.id === id)?.name || id).join(' + '), RoomName: rooms?.[0]?.name || '', Status: s.status,
        AttendanceCode: s.attendance_code, CodeExpiresAt: s.code_expires_at, CodeSecondsLeft: Math.max(0, Math.ceil((new Date(s.code_expires_at || 0).getTime() - Date.now()) / 1000)), StartedAt: s.started_at, ClosedAt: s.closed_at }, students: studentData,
        counts: { total: roster.length, present: byStatus.PRESENT, late: byStatus.LATE, absent: byStatus.ABSENT, unmarked: Math.max(0, roster.length - (byStatus.PRESENT + byStatus.LATE + byStatus.ABSENT)) } } })
      if (action === 'attendance.detail') return response({ ok: true, data: { session: { SessionID: sid, Date: s.session_date, StartTime: s.start_time, EndTime: s.end_time,
        BatchName: batches?.[0]?.name || s.batch_id, SubjectName: [s.subject_id, s.co_subject_id].filter(Boolean).map((id) => (subjects || []).find((x) => x.id === id)?.name || id).join(' + '),
        TeacherName: teachers?.[0]?.name || s.teacher_id, RoomName: rooms?.[0]?.name || '', Status: s.status }, students: studentData } })
      throw new ApiFault('BAD_REQUEST', 'Unsupported attendance action.')
    }

    if (action === 'reports.collection' || action === 'reports.dues' || action === 'reports.attendance' || action === 'reports.teacherPay') {
      const from = requireText(payload.from, 'From date', 10), to = requireText(payload.to, 'To date', 10)
      if ((from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) || (to && !/^\d{4}-\d{2}-\d{2}$/.test(to))) throw new ApiFault('BAD_REQUEST', 'Report dates must use yyyy-mm-dd.')
      if (action === 'reports.collection') {
        if (!permissionsFor(user).includes('*') && !permissionsFor(user).includes('FINANCE_VIEW')) throw new ApiFault('FORBIDDEN', 'Finance view permission is required.')
        const data = await fetchAll(() => {
          let query = admin.from('payments').select('id,payment_date,amount,payment_mode,status').neq('status', 'VOID').order('payment_date').order('id')
          if (from) query = query.gte('payment_date', from)
          if (to) query = query.lte('payment_date', to)
          return query
        })
        const byMonth = new Map<string, number>(), byMode = new Map<string, number>()
        let total = 0
        for (const p of data || []) { const amount = Number(p.amount) || 0, month = p.payment_date.slice(0, 7), mode = p.payment_mode || 'Other'
          byMonth.set(month, (byMonth.get(month) || 0) + amount); byMode.set(mode, (byMode.get(mode) || 0) + amount); total += amount }
        return response({ ok: true, data: { total, count: (data || []).length, months: [...byMonth].sort(([a], [b]) => a.localeCompare(b)).map(([Month, Amount]) => ({ Month, MonthLabel: monthLabel(Month), Amount })),
          modes: [...byMode].sort(([a], [b]) => a.localeCompare(b)).map(([Mode, Amount]) => ({ Mode, Amount })) } })
      }
      if (action === 'reports.dues') {
        if (!permissionsFor(user).includes('*') && !permissionsFor(user).includes('FINANCE_VIEW')) throw new ApiFault('FORBIDDEN', 'Finance view permission is required.')
        const month = requireText(payload.month, 'Month', 7)
        const invoices = await fetchAll(() => {
          let query = admin.from('invoices').select('*').neq('status', 'CANCELLED').order('due_date').order('id')
          return month ? query.eq('month', month) : query
        })
        const eligible = (invoices || []).map((i) => ({ invoice: i, status: invoiceStatus(i.total_amount, i.paid_amount, i.due_date, i.status), balance: Math.max(0, Number(i.total_amount) - Number(i.paid_amount)) }))
          .filter((x) => x.status !== 'CANCELLED' && x.balance > 0)
        const ids = [...new Set(eligible.map((x) => x.invoice.student_id))]
        const students = await selectIn(ids, (chunk) => admin.from('students').select('id,name,current_class,mobile,parent_mobile').in('id', chunk))
        const names = new Map((students || []).map((s) => [s.id, s])), groups = new Map<string, { balance: number; overdue: number; invoices: number; oldestDue: string; subjects: Set<string> }>()
        for (const x of eligible) {
          const inv = x.invoice, g = groups.get(inv.student_id) || { balance: 0, overdue: 0, invoices: 0, oldestDue: '', subjects: new Set<string>() }
          g.balance += x.balance; g.invoices++; if (x.status === 'OVERDUE') g.overdue += x.balance
          if (inv.due_date && (!g.oldestDue || inv.due_date < g.oldestDue)) g.oldestDue = inv.due_date
          for (const line of normalizedInvoiceLines(inv)) if (line.balanceAmount > 0 && line.subjectName) g.subjects.add(String(line.subjectName))
          groups.set(inv.student_id, g)
        }
        const rows = [...groups].map(([id, g]) => { const s = names.get(id); return { StudentID: id, StudentName: s?.name || id, CurrentClass: s?.current_class || '',
          Phone: s?.parent_mobile || s?.mobile || '', Invoices: g.invoices, Balance: g.balance, Overdue: g.overdue, OldestDue: g.oldestDue, Subjects: [...g.subjects].join(', ') } })
          .sort((a, b) => b.Overdue - a.Overdue || b.Balance - a.Balance)
        return response({ ok: true, data: { rows, totals: { students: rows.length, balance: rows.reduce((v, x) => v + x.Balance, 0), overdue: rows.reduce((v, x) => v + x.Overdue, 0) } } })
      }
      if (action === 'reports.attendance') {
        if (!permissionsFor(user).includes('*') && !permissionsFor(user).includes('STUDENT_VIEW')) throw new ApiFault('FORBIDDEN', 'Student view permission is required.')
        const threshold = Math.min(Math.max(Number(payload.threshold) || 75, 1), 100)
        let query = admin.from('attendance').select('student_id,batch_id,status,session_date')
        if (from) query = query.gte('session_date', from); if (to) query = query.lte('session_date', to)
        const { data: marks, error } = await query.limit(20000); if (error) throw error
        const b = new Map<string, any>(), st = new Map<string, any>()
        for (const a of marks || []) {
          const score = a.status === 'PRESENT' ? 1 : a.status === 'LATE' ? 0.5 : 0
          const bg = b.get(a.batch_id) || { total: 0, score: 0, present: 0, late: 0, absent: 0 }; bg.total++; bg.score += score
          if (a.status === 'PRESENT') bg.present++; else if (a.status === 'LATE') bg.late++; else bg.absent++; b.set(a.batch_id, bg)
          const sg = st.get(a.student_id) || { total: 0, score: 0, absent: 0 }; sg.total++; sg.score += score; if (a.status === 'ABSENT') sg.absent++; st.set(a.student_id, sg)
        }
        const [{ data: batches, error: bError }, { data: students, error: stError }] = await Promise.all([admin.from('batches').select('id,name'), admin.from('students').select('id,name,current_class,status')])
        if (bError) throw bError; if (stError) throw stError
        const bn = new Map((batches || []).map((x) => [x.id, x.name])), sn = new Map((students || []).map((x) => [x.id, x]))
        const pct = (score: number, total: number) => total ? Math.round(score / total * 100) : 0
        const batchRows = [...b].map(([id, x]) => ({ BatchID: id, BatchName: bn.get(id) || id, Sessions: x.total, Present: x.present, Late: x.late, Absent: x.absent, Pct: pct(x.score, x.total) })).sort((x, y) => x.Pct - y.Pct)
        const lowStudents = [...st].map(([id, x]) => { const s = sn.get(id); return { StudentID: id, StudentName: s?.name || id, CurrentClass: s?.current_class || '', Status: s?.status || '', Sessions: x.total, Absent: x.absent, Pct: pct(x.score, x.total) } })
          .filter((x) => x.Pct < threshold && String(x.Status).toUpperCase() === 'ACTIVE').sort((x, y) => x.Pct - y.Pct).slice(0, 100)
        return response({ ok: true, data: { threshold, batches: batchRows, lowStudents } })
      }
      if (!permissionsFor(user).includes('*') && !permissionsFor(user).includes('TEACHER_INCOME_MANAGE')) throw new ApiFault('FORBIDDEN', 'Teacher pay permission is required.')
      const month = requireText(payload.month, 'Month', 7, true)
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ApiFault('BAD_REQUEST', 'Pick a valid month (YYYY-MM).')
      const [{ data: income, error: iError }, { data: payments, error: pError }, { data: teachers, error: tError }] = await Promise.all([
        admin.from('teacher_income').select('*').eq('month', month), admin.from('teacher_payments').select('income_id,amount').not('income_id', 'is', null), admin.from('teachers').select('id,name'),
      ])
      if (iError) throw iError; if (pError) throw pError; if (tError) throw tError
      const paid = new Map<string, number>(); for (const p of payments || []) if (p.income_id) paid.set(p.income_id, (paid.get(p.income_id) || 0) + Number(p.amount))
      const grouped = new Map<string, { payable: number; paid: number; students: number; subjects: number }>()
      for (const i of income || []) { const g = grouped.get(i.teacher_id) || { payable: 0, paid: 0, students: 0, subjects: 0 }; g.payable += Number(i.final_payable) || 0
        g.paid += paid.get(i.id) || 0; g.students += Number(i.student_count) || 0; g.subjects++; grouped.set(i.teacher_id, g) }
      const names = new Map((teachers || []).map((x) => [x.id, x.name])), rows = [...grouped].map(([id, g]) => ({ TeacherID: id, TeacherName: names.get(id) || id, Subjects: g.subjects,
        Students: g.students, Payable: g.payable, Paid: g.paid, Balance: Math.max(0, g.payable - g.paid) })).sort((a, b) => a.TeacherName.localeCompare(b.TeacherName))
      return response({ ok: true, data: { rows, totals: { payable: rows.reduce((v, x) => v + x.Payable, 0), paid: rows.reduce((v, x) => v + x.Paid, 0), balance: rows.reduce((v, x) => v + x.Balance, 0) } } })
    }

    if (action === 'student.updateProfile') {
      if (user.user_type !== 'STUDENT' || !user.linked_id) throw new ApiFault('FORBIDDEN', 'This action is only for a linked student account.')
      const changes = payload.changes
      if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new ApiFault('BAD_REQUEST', 'Provide profile changes.')
      const fields: Record<string, string> = { Mobile: 'mobile', Email: 'email', Address: 'address', ParentName: 'parent_name',
        ParentMobile: 'parent_mobile', ParentWhatsApp: 'parent_whatsapp', ParentEmail: 'parent_email' }
      const row: Record<string, unknown> = {}
      for (const [key, raw] of Object.entries(changes)) {
        const column = fields[key]
        if (!column) throw new ApiFault('BAD_REQUEST', `You cannot edit ${key}.`)
        const value = requireText(raw, key, key === 'Address' ? 300 : 100)
        if (['Mobile', 'ParentMobile', 'ParentWhatsApp'].includes(key) && value && !/^[+\d()\-\s]{7,20}$/.test(value)) throw new ApiFault('BAD_REQUEST', `${key} is not a valid phone number.`)
        if (['Email', 'ParentEmail'].includes(key) && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new ApiFault('BAD_REQUEST', `${key} is not a valid email address.`)
        row[column] = value
      }
      if (!Object.keys(row).length) throw new ApiFault('BAD_REQUEST', 'Nothing to update.')
      row.updated_at = new Date().toISOString()
      const { data, error } = await admin.from('students').update(row).eq('id', user.linked_id).select('id').maybeSingle()
      if (error) throw error
      if (!data) throw new ApiFault('NOT_FOUND', 'Student record not found.')
      await logAction(admin, user, 'STUDENT_SELF_EDIT', 'STUDENT', user.linked_id, { changed: Object.keys(changes) })
      return response({ ok: true, data: { changed: Object.keys(row).filter((k) => k !== 'updated_at').map((k) => Object.keys(fields).find((key) => fields[key] === k)) } })
    }

    if (action.startsWith('teacherIncome.')) {
      const paidMap = async (incomeIds: string[]) => {
        if (!incomeIds.length) return new Map<string, number>()
        const { data, error } = await admin.from('teacher_payments').select('income_id,amount').in('income_id', incomeIds)
        if (error) throw error
        const map = new Map<string, number>()
        for (const p of data || []) if (p.income_id) map.set(p.income_id, (map.get(p.income_id) || 0) + Number(p.amount))
        return map
      }
      if (action === 'teacherIncome.generate') {
        const month = requireText(payload.month, 'Month', 7, true)
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ApiFault('BAD_REQUEST', 'Pick a valid month (YYYY-MM).')
        const monthStart = `${month}-01`, monthEnd = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).toISOString().slice(0, 10)
        // Every page is read (no silent 1,000-row cut-off); assignments are narrowed
        // to those that can overlap the month, and the exact rules below still apply.
        const [{ data: teachers, error: tError }, assignments, students,
          { data: feeRows, error: feeError }, studentFees, { data: settings }] = await Promise.all([
          admin.from('teachers').select('id,status').eq('status', 'Active'),
          fetchAll(() => admin.from('student_subjects').select('*')
            .or(`start_date.is.null,start_date.lte.${monthEnd}`).or(`end_date.is.null,end_date.gte.${monthStart}`).order('id')),
          fetchAll(() => admin.from('students').select('id,name,status').order('id')),
          admin.from('fee_structure').select('subject_id,amount,academic_year,status').eq('item_type', 'SUBJECT').eq('status', 'Active'),
          fetchAll(() => admin.from('student_fees').select('*').eq('status', 'Active').order('id')),
          admin.from('settings').select('setting_key,value').eq('setting_key', 'ACADEMIC_YEAR').maybeSingle(),
        ])
        if (tError) throw tError
        if (feeError) throw feeError
        const academicYear = String(settings?.value || `${month.slice(0, 4)}-${Number(month.slice(0, 4)) + 1}`)
        const [existing, { data: subjects, error: subError }, { data: batches, error: batchError }, invoices] = await Promise.all([
          fetchAll(() => admin.from('teacher_income').select('*').eq('month', month).eq('academic_year', academicYear).order('id')),
          admin.from('subjects').select('id,name'), admin.from('batches').select('id,name'),
          fetchAll(() => admin.from('invoices').select('id,student_id,line_items,status').eq('month', month).eq('academic_year', academicYear).order('id')),
        ])
        if (subError) throw subError; if (batchError) throw batchError
        const activeStudentIds = new Set((students || []).filter((s) => String(s.status).toUpperCase() === 'ACTIVE').map((s) => s.id))
        const teacherIds = new Set((teachers || []).map((t) => t.id))
        const studentNames = new Map((students || []).map((s) => [s.id, s.name]))
        const subjectNames = new Map((subjects || []).map((s) => [s.id, s.name]))
        const batchNames = new Map((batches || []).map((b) => [b.id, b.name]))
        const standardBySubject = new Map((feeRows || []).filter((r) => r.academic_year === academicYear).map((r) => [r.subject_id, Number(r.amount) || 0]))
        const studentFeeByKey = new Map<string, any>()
        for (const fee of studentFees || []) {
          if (fee.effective_from > monthEnd || (fee.effective_to && fee.effective_to < monthStart)) continue
          const key = `${fee.student_id}|${fee.subject_id}`, prior = studentFeeByKey.get(key)
          if (!prior || String(fee.effective_from) > String(prior.effective_from)) studentFeeByKey.set(key, fee)
        }
        const candidates = (assignments || []).filter((a) => a.teacher_id && a.subject_id && activeStudentIds.has(a.student_id) && teacherIds.has(a.teacher_id) &&
          ['ACTIVE', 'ENDED'].includes(String(a.status).toUpperCase()) &&
          !(String(a.status).toUpperCase() === 'ENDED' && a.start_date && a.end_date && a.end_date <= a.start_date) &&
          (!a.start_date || a.start_date <= monthEnd) && (!a.end_date || a.end_date >= monthStart))
        // When a subject was reassigned during a month, attribute the monthly fee
        // once to the latest assignment overlapping that month.
        const assignmentByKey = new Map<string, any>()
        for (const a of candidates) {
          const key = `${a.student_id}|${a.subject_id}`, prior = assignmentByKey.get(key)
          if (!prior || String(a.start_date || '') > String(prior.start_date || '')) assignmentByKey.set(key, a)
        }
        const invoiceRows = (invoices || []).filter((r) => String(r.status).toUpperCase() !== 'CANCELLED')
        const invoiceByStudent = new Map(invoiceRows.map((r) => [r.student_id, r]))
        const subjectCollections = new Map<string, number>()
        for (const invoice of invoiceRows) {
          // Invoice line paid amounts are the accounting source of truth. This
          // includes the app's PAID payment status and already reflects voids.
          for (const line of normalizedInvoiceLines(invoice as Record<string, unknown>)) {
            const subjectId = String(line.subjectId || '')
            const assigned = assignmentByKey.get(`${invoice.student_id}|${subjectId}`)
            const teacherId = String(line.teacherId || assigned?.teacher_id || '')
            if (!teacherId || !subjectId) continue
            const key = `${teacherId}|${invoice.student_id}|${subjectId}`
            const amount = Math.min(Number(line.finalAmount) || 0, Number(line.paidAmount) || 0)
            subjectCollections.set(key, (subjectCollections.get(key) || 0) + amount)
          }
        }
        const groups = new Map<string, { details: any[]; students: Set<string>; expected: number; collected: number }>()
        for (const [key, a] of assignmentByKey) {
          const studentFee = studentFeeByKey.get(key)
          const assignedFee = studentFee ? Number(studentFee.final_amount) || 0 : a.fee_override !== null && a.fee_override !== undefined
            ? Number(a.fee_override) || 0 : standardBySubject.get(a.subject_id) || 0
          const invoice = invoiceByStudent.get(a.student_id)
          const invoiceLine: any = invoice ? invoiceLinesForIncome(invoice.line_items).find((line) => line.subjectId === a.subject_id) : null
          const teacherId = String(invoiceLine?.teacherId || a.teacher_id)
          const expected = invoiceLine ? Number(invoiceLine.finalAmount) || 0 : assignedFee
          const collected = subjectCollections.get(`${teacherId}|${a.student_id}|${a.subject_id}`) || 0
          const group = groups.get(teacherId) || { details: [], students: new Set<string>(), expected: 0, collected: 0 }
          group.students.add(a.student_id)
          group.expected += expected
          group.collected += Math.min(expected, collected)
          group.details.push({ studentId: a.student_id, studentName: studentNames.get(a.student_id) || a.student_id,
            subjectId: a.subject_id, subjectName: subjectNames.get(a.subject_id) || a.subject_id,
            batchId: a.batch_id || '', batchName: batchNames.get(a.batch_id) || '',
            expectedAmount: Math.round(expected * 100) / 100, collectedAmount: Math.round(Math.min(expected, collected) * 100) / 100,
            outstandingAmount: Math.max(0, Math.round((expected - Math.min(expected, collected)) * 100) / 100) })
          groups.set(teacherId, group)
        }
        const oldRows = existing || [], oldMonthly = new Map(oldRows.filter((r) => !r.subject_id).map((r) => [r.teacher_id, r]))
        const legacyByTeacher = new Map<string, any[]>()
        for (const row of oldRows.filter((r) => r.subject_id)) legacyByTeacher.set(row.teacher_id, [...(legacyByTeacher.get(row.teacher_id) || []), row])
        let created = 0, refreshed = 0
        const monthlyIds = new Map<string, string>()
        for (const [teacherId, g] of groups) {
          const old = oldMonthly.get(teacherId), id = old?.id || await newId(admin, 'teacher_income', 'TI-', 5)
          const expected = Math.round(g.expected * 100) / 100, collected = Math.round(g.collected * 100) / 100
          const contribution = Number(old?.institute_contribution) || 0
          const { error } = old
            ? await admin.from('teacher_income').update({ student_count: g.students.size, rate_per_student: 0, gross_income: expected,
                expected_amount: expected, collected_amount: collected, outstanding_amount: Math.max(0, expected - collected),
                institute_contribution: contribution, adjustment: -contribution, adjustment_reason: contribution ? 'Institute contribution' : '',
                final_payable: Math.max(0, collected - contribution), student_details: g.details, status: 'Pending' }).eq('id', id)
            : await admin.from('teacher_income').insert({ id, teacher_id: teacherId, subject_id: null, month,
                student_count: g.students.size, rate_per_student: 0, gross_income: expected, expected_amount: expected,
                collected_amount: collected, outstanding_amount: Math.max(0, expected - collected), institute_contribution: 0,
                adjustment: 0, adjustment_reason: '', final_payable: collected, student_details: g.details,
                status: 'Pending', academic_year: academicYear })
          if (error) throw error
          monthlyIds.set(teacherId, id)
          if (old) refreshed++; else created++
          // Keep historical teacher payments intact while moving them under the
          // single monthly record so they count against its remaining balance.
          const legacyIds = (legacyByTeacher.get(teacherId) || []).map((r) => r.id)
          if (legacyIds.length) {
            const { error: moveError } = await admin.from('teacher_payments').update({ income_id: id }).in('income_id', legacyIds)
            if (moveError) throw moveError
            await admin.from('teacher_income').update({ status: 'SUPERSEDED' }).in('id', legacyIds)
          }
          const { data: teacherPaymentRows, error: teacherPaymentError } = await admin.from('teacher_payments').select('amount').eq('income_id', id)
          if (teacherPaymentError) throw teacherPaymentError
          const alreadyPaid = (teacherPaymentRows || []).reduce((sum, p) => sum + Number(p.amount || 0), 0)
          const net = Math.max(alreadyPaid, Math.max(0, collected - contribution))
          const { error: payableError } = await admin.from('teacher_income').update({ final_payable: net,
            status: teacherIncomeStatus(expected, collected, contribution, net, alreadyPaid) }).eq('id', id)
          if (payableError) throw payableError
        }
        await logAction(admin, user, 'GENERATE_TEACHER_INCOME', 'TEACHER_INCOME', month, { created, refreshed, model: 'STUDENT_FEES_LESS_INSTITUTE_CONTRIBUTION' })
        return response({ ok: true, data: { created, refreshed, statementCount: monthlyIds.size } })
      }
      if (action === 'teacherIncome.list') {
        const month = requireText(payload.month, 'Month', 7), teacherId = requireText(payload.teacherId, 'Teacher ID', 60)
        const rows = await fetchAll(() => {
          let query = admin.from('teacher_income').select('*').order('month', { ascending: false }).order('teacher_id').order('id')
          if (month) query = query.eq('month', month); if (teacherId) query = query.eq('teacher_id', teacherId)
          return query
        })
        const incomeRows = rows || [], ids = incomeRows.map((r) => r.id), paid = await paidMap(ids)
        const [{ data: teachers }, { data: subjects }] = await Promise.all([admin.from('teachers').select('id,name'), admin.from('subjects').select('id,name')])
        const tm = new Map((teachers || []).map((x) => [x.id, x.name])), sm = new Map((subjects || []).map((x) => [x.id, x.name]))
        const monthlyKeys = new Set(incomeRows.filter((r) => !r.subject_id).map((r) => `${r.teacher_id}|${r.month}|${r.academic_year}`))
        const visibleRows = incomeRows.filter((r) => !r.subject_id || !monthlyKeys.has(`${r.teacher_id}|${r.month}|${r.academic_year}`))
        let payable = 0, paidTotal = 0, expectedTotal = 0, collectedTotal = 0, outstandingTotal = 0, contributionTotal = 0, projectedNetTotal = 0
        const result = visibleRows.map((r) => {
          const isMonthly = !r.subject_id, p = paid.get(r.id) || 0, f = Number(r.final_payable) || 0, balance = Math.max(0, f - p)
          const expected = isMonthly ? Number(r.expected_amount) || 0 : Number(r.gross_income) || 0
          const collected = isMonthly ? Number(r.collected_amount) || 0 : 0
          const outstanding = isMonthly ? Number(r.outstanding_amount) || 0 : 0
          const contribution = isMonthly ? Number(r.institute_contribution) || 0 : 0
          const projectedNet = Math.max(0, expected - contribution)
          payable += f; paidTotal += p
          if (isMonthly) { expectedTotal += expected; collectedTotal += collected; outstandingTotal += outstanding; contributionTotal += contribution; projectedNetTotal += projectedNet }
          return { IncomeID: r.id, TeacherID: r.teacher_id, TeacherName: tm.get(r.teacher_id) || r.teacher_id,
            SubjectID: r.subject_id, SubjectName: r.subject_id ? (sm.get(r.subject_id) || r.subject_id) : 'Monthly statement',
            RecordType: isMonthly ? 'MONTHLY' : 'LEGACY', Month: r.month, MonthLabel: monthLabel(r.month), StudentCount: r.student_count,
            RatePerStudent: r.rate_per_student, GrossIncome: r.gross_income, ExpectedAmount: expected, CollectedAmount: collected,
            OutstandingAmount: outstanding, InstituteContribution: contribution, NetCollected: Math.max(0, collected - contribution),
            ProjectedNet: projectedNet, Adjustment: r.adjustment, AdjustmentReason: r.adjustment_reason,
            FinalPayable: f, PaidAmount: p, BalanceAmount: balance,
            Status: isMonthly ? teacherIncomeStatus(expected, collected, contribution, f, p) : balance <= 0 ? 'PAID' : p > 0 ? 'PARTIAL' : 'PENDING' }
        })
        return response({ ok: true, data: { rows: result, totals: { count: result.length, payable, paid: paidTotal, balance: Math.max(0, payable - paidTotal),
          expected: expectedTotal, collected: collectedTotal, outstanding: outstandingTotal, contribution: contributionTotal, projectedNet: projectedNetTotal } } })
      }
      if (action === 'teacherIncome.contribution') {
        const teacherId = requireText(payload.teacherId, 'Teacher ID', 60, true)
        const month = requireText(payload.month, 'Month', 7, true)
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ApiFault('BAD_REQUEST', 'Pick a valid month (YYYY-MM).')
        const contribution = Number(payload.amount)
        if (!Number.isFinite(contribution) || contribution < 0 || contribution > 10000000) throw new ApiFault('BAD_REQUEST', 'Enter a valid contribution amount; 0 is allowed.')
        const { data: statement, error } = await admin.from('teacher_income').select('*').eq('teacher_id', teacherId).eq('month', month).is('subject_id', null).maybeSingle()
        if (error) throw error
        if (!statement) throw new ApiFault('NOT_FOUND', 'Generate this month’s statement before recording the institute contribution.')
        const { data: payments, error: paymentError } = await admin.from('teacher_payments').select('amount').eq('income_id', statement.id)
        if (paymentError) throw paymentError
        const alreadyPaid = (payments || []).reduce((sum, row) => sum + Number(row.amount || 0), 0)
        const netCollected = Math.max(0, (Number(statement.collected_amount) || 0) - contribution)
        if (alreadyPaid > netCollected) throw new ApiFault('BAD_REQUEST', 'This contribution would make the net lower than the amount already paid to the teacher.')
        const { error: updateError } = await admin.from('teacher_income').update({ institute_contribution: contribution,
          adjustment: -contribution, adjustment_reason: contribution ? 'Institute contribution' : '', final_payable: netCollected,
          status: teacherIncomeStatus(statement.expected_amount, statement.collected_amount, contribution, netCollected, alreadyPaid) }).eq('id', statement.id)
        if (updateError) throw updateError
        await logAction(admin, user, 'SET_TEACHER_INSTITUTE_CONTRIBUTION', 'TEACHER_INCOME', statement.id, { teacherId, month, contribution })
        return response({ ok: true, data: { contribution, netCollected } })
      }
      const incomeId = requireText(payload.incomeId, 'Income ID', 60, true)
      const { data: income, error: incomeError } = await admin.from('teacher_income').select('*').eq('id', incomeId).maybeSingle()
      if (incomeError) throw incomeError
      if (!income) throw new ApiFault('NOT_FOUND', 'Teacher income record not found.')
      const { data: payRows, error: payError } = await admin.from('teacher_payments').select('*').eq('income_id', incomeId).order('payment_date', { ascending: false })
      if (payError) throw payError
      const paid = (payRows || []).reduce((sum, p) => sum + Number(p.amount), 0), balance = Math.max(0, Number(income.final_payable) - paid)
      if (action === 'teacherIncome.get') {
        if (String(income.status).toUpperCase() === 'SUPERSEDED') throw new ApiFault('NOT_FOUND', 'This older income record has been replaced by the monthly statement.')
        const userIds = [...new Set((payRows || []).map((p) => p.paid_by).filter(Boolean))]
        if (!income.subject_id) {
          const { data: monthlyTeacher } = await admin.from('teachers').select('name').eq('id', income.teacher_id).maybeSingle()
          return response({ ok: true, data: { income: { IncomeID: income.id, TeacherID: income.teacher_id, TeacherName: monthlyTeacher?.name || income.teacher_id,
            Month: income.month, MonthLabel: monthLabel(income.month), RecordType: 'MONTHLY', StudentCount: income.student_count,
            ExpectedAmount: Number(income.expected_amount) || 0, CollectedAmount: Number(income.collected_amount) || 0,
            OutstandingAmount: Number(income.outstanding_amount) || 0, InstituteContribution: Number(income.institute_contribution) || 0,
            NetCollected: Math.max(0, (Number(income.collected_amount) || 0) - (Number(income.institute_contribution) || 0)),
            ProjectedNet: Math.max(0, (Number(income.expected_amount) || 0) - (Number(income.institute_contribution) || 0)),
            FinalPayable: Number(income.final_payable) || 0, PaidAmount: paid, BalanceAmount: balance,
            Status: teacherIncomeStatus(income.expected_amount, income.collected_amount, income.institute_contribution, income.final_payable, paid) },
            students: Array.isArray(income.student_details) ? income.student_details : [],
            payments: (payRows || []).map((p) => ({ PaymentID: p.id, PaymentDate: p.payment_date, Amount: p.amount,
              PaymentMode: p.payment_mode, UPIReference: p.upi_reference, PaidBy: '' })) } })
        }
        const [{ data: teacher }, { data: subject }, { data: users }] = await Promise.all([admin.from('teachers').select('name').eq('id', income.teacher_id).maybeSingle(),
          admin.from('subjects').select('name').eq('id', income.subject_id).maybeSingle(), userIds.length ? admin.from('app_users').select('id,username').in('id', userIds) : Promise.resolve({ data: [], error: null })])
        const un = new Map((users || []).map((u) => [u.id, u.username]))
        return response({ ok: true, data: { income: { IncomeID: income.id, TeacherID: income.teacher_id, TeacherName: teacher?.name || income.teacher_id,
          SubjectID: income.subject_id, SubjectName: subject?.name || income.subject_id, Month: income.month, MonthLabel: monthLabel(income.month),
          StudentCount: income.student_count, RatePerStudent: income.rate_per_student, GrossIncome: income.gross_income, Adjustment: income.adjustment,
          AdjustmentReason: income.adjustment_reason, FinalPayable: income.final_payable, PaidAmount: paid, BalanceAmount: balance, Status: balance <= 0 ? 'PAID' : paid > 0 ? 'PARTIAL' : 'PENDING' },
          payments: (payRows || []).map((p) => ({ PaymentID: p.id, PaymentDate: p.payment_date, Amount: p.amount, PaymentMode: p.payment_mode, UPIReference: p.upi_reference, PaidBy: un.get(p.paid_by) || '' })) } })
      }
      if (action === 'teacherIncome.adjust') {
        if (!income.subject_id) throw new ApiFault('BAD_REQUEST', 'Use Institute contribution for a monthly teacher statement.')
        if (String(income.status).toUpperCase() === 'SUPERSEDED') throw new ApiFault('NOT_FOUND', 'This older income record has been replaced by the monthly statement.')
        const adjustment = Number(payload.adjustment), reason = requireText(payload.reason, 'Reason', 200, true)
        if (!Number.isFinite(adjustment) || Math.abs(adjustment) > 10000000) throw new ApiFault('BAD_REQUEST', 'Enter a valid adjustment amount.')
        if (Number(income.gross_income) + adjustment < paid) throw new ApiFault('BAD_REQUEST', 'The payable amount cannot be less than what has already been paid.')
        const { error } = await admin.from('teacher_income').update({ adjustment, adjustment_reason: reason, final_payable: Number(income.gross_income) + adjustment,
          status: paid >= Number(income.gross_income) + adjustment ? 'Paid' : paid > 0 ? 'Partial' : 'Pending' }).eq('id', incomeId)
        if (error) throw error
        await logAction(admin, user, 'ADJUST_TEACHER_INCOME', 'TEACHER_INCOME', incomeId, { adjustment, reason })
        return response({ ok: true, data: { updated: true } })
      }
      if (action === 'teacherIncome.pay') {
        if (String(income.status).toUpperCase() === 'SUPERSEDED') throw new ApiFault('NOT_FOUND', 'This older income record has been replaced by the monthly statement.')
        const amount = Math.round(Number(payload.amount) * 100) / 100, mode = requireText(payload.mode, 'Payment mode', 20, true).toUpperCase()
        const paymentDate = requireText(payload.paymentDate || todayDate(), 'Payment date', 10, true), reference = requireText(payload.reference, 'Reference', 100), notes = requireText(payload.notes, 'Notes', 500)
        if (!Number.isFinite(amount) || amount <= 0 || amount > balance) throw new ApiFault('BAD_REQUEST', `Enter an amount up to the remaining balance (${balance}).`)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) throw new ApiFault('BAD_REQUEST', 'Payment date must use yyyy-mm-dd.')
        if (mode !== 'CASH' && !reference) throw new ApiFault('BAD_REQUEST', 'Please enter the reference.')
        const { data: paymentId, error } = await admin.rpc('record_teacher_payment', { p_income_id: incomeId, p_payment_date: paymentDate,
          p_amount: amount, p_payment_mode: mode, p_reference: reference, p_paid_by: user.id, p_notes: notes })
        if (error) { if (String(error.message).includes('remaining balance')) throw new ApiFault('BAD_REQUEST', 'Payment exceeds the remaining balance. Refresh the page and try again.'); throw error }
        await logAction(admin, user, 'PAY_TEACHER_INCOME', 'TEACHER_PAYMENT', String(paymentId), { incomeId, amount, mode })
        return response({ ok: true, data: { PaymentID: paymentId } })
      }
      throw new ApiFault('UNKNOWN_ACTION', 'Teacher income action not found.')
    }

    if (action === 'teacher.income') {
      if (user.user_type !== 'TEACHER' || !user.linked_id) throw new ApiFault('FORBIDDEN', 'This action is only for a linked teacher account.')
      if (!permissionsFor(user).includes('*') && !permissionsFor(user).includes('TEACHER_INCOME_VIEW')) throw new ApiFault('FORBIDDEN', 'Income view is not enabled for you.')
      const [{ data: teacher, error: teacherError }, { data: income, error: incomeError }, { data: payments, error: paymentsError }, { data: subjects, error: subjectsError }] = await Promise.all([
        admin.from('teachers').select('id,name,income_method,default_rate_per_student').eq('id', user.linked_id).maybeSingle(),
        admin.from('teacher_income').select('*').eq('teacher_id', user.linked_id).order('month', { ascending: false }).limit(300),
        admin.from('teacher_payments').select('*').eq('teacher_id', user.linked_id).order('payment_date', { ascending: false }).limit(300),
        admin.from('subjects').select('id,name'),
      ])
      if (teacherError) throw teacherError
      if (incomeError) throw incomeError
      if (paymentsError) throw paymentsError
      if (subjectsError) throw subjectsError
      if (!teacher) throw new ApiFault('NOT_FOUND', 'Teacher record not found.')
      const names = new Map((subjects || []).map((x) => [x.id, x.name]))
      const monthlyKeys = new Set((income || []).filter((r) => !r.subject_id).map((r) => `${r.month}|${r.academic_year}`))
      const visibleIncome = (income || []).filter((r) => !r.subject_id || !monthlyKeys.has(`${r.month}|${r.academic_year}`))
      const paidByIncome = new Map<string, number>()
      for (const payment of payments || []) if (payment.income_id) paidByIncome.set(payment.income_id, (paidByIncome.get(payment.income_id) || 0) + Number(payment.amount || 0))
      return response({ ok: true, data: { teacher: { Name: teacher.name },
        income: visibleIncome.map((r) => {
          const monthly = !r.subject_id
          const paid = paidByIncome.get(r.id) || 0, payable = Number(r.final_payable) || 0
          return { IncomeID: r.id, RecordType: monthly ? 'MONTHLY' : 'LEGACY', Month: r.month,
            SubjectName: monthly ? 'Monthly statement' : names.get(r.subject_id) || r.subject_id,
            StudentCount: r.student_count, Rate: r.rate_per_student, Gross: Number(r.gross_income) || 0,
            ExpectedAmount: monthly ? Number(r.expected_amount) || 0 : Number(r.gross_income) || 0,
            CollectedAmount: monthly ? Number(r.collected_amount) || 0 : 0,
            OutstandingAmount: monthly ? Number(r.outstanding_amount) || 0 : 0,
            InstituteContribution: monthly ? Number(r.institute_contribution) || 0 : 0,
            NetCollected: monthly ? Math.max(0, (Number(r.collected_amount) || 0) - (Number(r.institute_contribution) || 0)) : Number(r.final_payable) || 0,
            ProjectedNet: monthly ? Math.max(0, (Number(r.expected_amount) || 0) - (Number(r.institute_contribution) || 0)) : Number(r.final_payable) || 0,
            Adjustment: r.adjustment, FinalPayable: payable, PaidAmount: paid, BalanceAmount: Math.max(0, payable - paid),
            StudentDetails: monthly && Array.isArray(r.student_details) ? r.student_details : [],
            Status: monthly ? teacherIncomeStatus(r.expected_amount, r.collected_amount, r.institute_contribution, payable, paid) : r.status }
        }),
        payments: (payments || []).map((p) => ({ PaymentID: p.id, Date: p.payment_date, Amount: p.amount, Mode: p.payment_mode, Notes: p.notes })) } })
    }

    if (action === 'settings.update') {
      const changes = payload.changes
      if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) throw new ApiFault('BAD_REQUEST', 'Nothing to update.')
      const { data: known, error: knownError } = await admin.from('settings').select('setting_key,value')
      if (knownError) throw knownError
      const existing = new Map((known || []).map((r) => [r.setting_key, r.value]))
      const updated: string[] = []
      for (const [key, raw] of Object.entries(changes)) {
        if (!existing.has(key) || key === 'STUDENT_DELETE_ENABLED') throw new ApiFault('BAD_REQUEST', `Unknown setting: ${key}`)
        const value = requireText(raw, key, 300, key !== 'SUBJECT_BLOCKED_PAIRS')
        if ((key === 'AI_DAILY_LIMIT' || key.startsWith('AI_LIMIT_')) && !/^\d{1,4}$/.test(value)) throw new ApiFault('BAD_REQUEST', `${key} must be a number (for example 20).`)
        if (['REGISTRATION_ENABLED', 'AUTO_INVOICE_ENABLED', 'AUTO_BACKUP_ENABLED', 'FEE_REMINDERS_ENABLED', 'ABSENT_ALERTS_ENABLED', 'AI_DOUBT_DRAFTS_ENABLED', 'AI_SEARCH_ENABLED'].includes(key) && !['TRUE', 'FALSE'].includes(value.toUpperCase())) throw new ApiFault('BAD_REQUEST', `${key} must be TRUE or FALSE.`)
        if (value !== existing.get(key)) {
          const { error } = await admin.from('settings').update({ value, updated_at: new Date().toISOString(), updated_by: user.id }).eq('setting_key', key)
          if (error) throw error
          updated.push(key)
        }
      }
      if (updated.length) await logAction(admin, user, 'CHANGE_SETTING', 'SETTING', updated.join(','), changes)
      return response({ ok: true, data: { changed: updated } })
    }

    return response(fail('UNKNOWN_ACTION', 'This action has not been migrated yet.'))
  } catch (error) {
    console.error('API action failed:', action, error)
    if (error instanceof ApiFault) return response(fail(error.code, error.message))
    return response(fail('SERVER_ERROR', 'Something went wrong. Please try again.'))
  }
})
