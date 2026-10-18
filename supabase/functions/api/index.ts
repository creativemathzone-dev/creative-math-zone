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
  TEACHER_INCOME_MANAGE: 'Manage teacher pay rates', TEACHER_INCOME_GRANT: 'Allow teachers to see their income',
  REPORT_VIEW: 'View reports', NOTICE_EDIT: 'Post notices', ATTENDANCE_CORRECT: 'Correct attendance',
}

function clients() {
  const url = Deno.env.get('SUPABASE_URL')!
  const publishable = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}').default
  const secret = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default
  if (!url || !publishable || !secret) throw new Error('Supabase function keys are not configured.')
  return {
    auth: createClient(url, publishable, { auth: { persistSession: false, autoRefreshToken: false } }),
    admin: createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } }),
  }
}

function userClient(token: string) {
  const url = Deno.env.get('SUPABASE_URL')!
  const publishable = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}').default
  return createClient(url, publishable, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
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

function validateStudentInput(input: Record<string, unknown>, partial: boolean) {
  const fields: Record<string, { column: string; max?: number; required?: boolean; kind?: 'date' | 'number' | 'mobile' | 'email' | 'status' | 'gender' }> = {
    RollNo: { column: 'roll_no', max: 20 }, Name: { column: 'name', max: 100, required: !partial },
    PhotoURL: { column: 'photo_url', max: 500 }, DOB: { column: 'dob', kind: 'date' },
    Gender: { column: 'gender', kind: 'gender' }, Mobile: { column: 'mobile', kind: 'mobile' },
    Email: { column: 'email', kind: 'email' }, Address: { column: 'address', max: 300 },
    School: { column: 'school', max: 100 }, Board: { column: 'board', max: 30 },
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
    Board: { column: 'board', max: 30 }, PreviousPercentage: { column: 'previous_percentage', kind: 'number' },
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

    const token = String(body?.token || request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') || '')
    if (!token) return response(fail('AUTH_REQUIRED', 'Please sign in.'))
    const { data: authData, error: authError } = await auth.auth.getUser(token)
    if (authError || !authData.user) return response(fail('SESSION_EXPIRED', 'Your session has expired. Please sign in again.'))
    const { data: user, error: userError } = await admin.from('app_users').select('*').eq('auth_user_id', authData.user.id).maybeSingle()
    if (userError || !user || user.status.toUpperCase() !== 'ACTIVE') return response(fail('SESSION_REVOKED', 'This account is unavailable. Please contact the centre.'))
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
      await admin.from('app_users').update({ must_change_password: false, password_changed_at: new Date().toISOString() }).eq('id', user.id)
      return response({ ok: true, data: { token, mustChangePassword: false } })
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
      'students.resetPassword': 'STUDENT_EDIT',
      'studentSubjects.assign': 'STUDENT_EDIT', 'studentSubjects.end': 'STUDENT_EDIT',
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
      'student.invoices': 'SELF_VIEW', 'student.receipt': 'SELF_VIEW', 'student.invoiceDoc': 'SELF_VIEW',
      'teacher.homework.list': 'SELF_VIEW', 'teacher.homework.create': 'CLASS_RUN', 'teacher.homework.review': 'CLASS_RUN',
      'student.homework.list': 'SELF_VIEW', 'student.homework.submit': 'SELF_VIEW',
      'homework.files.upload': 'SELF_VIEW', 'homework.files.register': 'SELF_VIEW', 'homework.files.delete': 'SELF_VIEW',
      'drive.connections.list': 'SETTINGS_VIEW', 'drive.oauthStart': 'SETTINGS_EDIT',
      'teacher.classMaterials.upload': 'CLASS_RUN', 'teacher.classMaterials.register': 'CLASS_RUN', 'teacher.classMaterials.list': 'SELF_VIEW',
      'student.classMaterials.list': 'SELF_VIEW',
      'teacher.dashboard': 'SELF_VIEW', 'teacher.timetable': 'SELF_VIEW', 'teacher.students': 'SELF_VIEW',
      'teacher.startClass': 'CLASS_RUN', 'teacher.regenerateCode': 'CLASS_RUN', 'teacher.classStatus': 'CLASS_RUN',
      'teacher.manualAttendance': 'ATTENDANCE_MARK', 'teacher.markAll': 'ATTENDANCE_MARK',
      'teacher.closeClass': 'CLASS_RUN', 'teacher.sessions': 'SELF_VIEW', 'teacher.notices': 'NOTICE_VIEW',
      'student.dashboard': 'SELF_VIEW', 'student.subjects': 'SELF_VIEW', 'student.timetable': 'SELF_VIEW',
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
        Instructions: r.instructions, TeacherName: tm.get(r.teacher_id) || '', SubjectName: sm.get(r.subject_id) || '', BatchName: bm.get(r.batch_id) || '',
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
      return response({ ok: true, data: (data || []).map((r) => ({ key: r.setting_key, value: r.value,
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
      const { data: batches } = await admin.from('batches').select('id,name')
      const batchNames = new Map((batches || []).map((b) => [b.id, b.name]))
      return response({ ok: true, data: (data || []).map((r) => ({ NoticeID: r.id, Title: r.title, Body: r.body,
        Audience: r.audience, BatchID: r.batch_id || '', BatchName: r.batch_id ? batchNames.get(r.batch_id) || '' : '',
        PostedBy: r.posted_by, PostedAt: r.posted_at, ExpiresAt: r.expires_at || '', Status: r.status })) })
    }

    if (action === 'notices.add' || action === 'notices.update') {
      const isUpdate = action.endsWith('.update')
      const input = isUpdate ? payload.changes : payload.item
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiFault('BAD_REQUEST', 'Provide the notice fields.')
      const map: Record<string, string> = { Title: 'title', Body: 'body', Audience: 'audience', BatchID: 'batch_id', ExpiresAt: 'expires_at', Status: 'status' }
      const allowed = Object.keys(map)
      const row: Record<string, unknown> = {}
      for (const [key, raw] of Object.entries(input)) {
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
      await logAction(admin, user, isUpdate ? 'EDIT_NOTICE' : 'ADD_NOTICE', 'NOTICE', id, row)
      return response({ ok: true, data: { NoticeID: saved.id, Title: saved.title, Body: saved.body, Audience: saved.audience,
        BatchID: saved.batch_id || '', PostedAt: saved.posted_at, ExpiresAt: saved.expires_at || '', Status: saved.status } })
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
      const teacherRow = { id, username, status: 'Active', photo_url: '', mobile: '', email: '', address: '', qualification: '',
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
      const tempPassword = payload.password ? String(payload.password) : passwordTemp()
      if (tempPassword.length < 8 || tempPassword.length > 200) throw new ApiFault('BAD_PASSWORD', 'Password must be at least 8 characters.')
      const { error } = await admin.auth.admin.updateUserById(target.auth_user_id, { password: tempPassword })
      if (error) throw new ApiFault('PASSWORD_UPDATE_FAILED', 'Could not reset this password.')
      await admin.from('app_users').update({ must_change_password: true, password_changed_at: new Date().toISOString() }).eq('id', id)
      await logAction(admin, user, 'RESET_PASSWORD', 'USER', id, { username: target.username })
      return response({ ok: true, data: { username: target.username, tempPassword } })
    }

    if (action === 'users.setPermissions') {
      const id = requireText(payload.userId, 'User ID', 60, true)
      if (!Array.isArray(payload.extraPermissions)) throw new ApiFault('BAD_REQUEST', 'extraPermissions must be a list.')
      const allowedPermissions = new Set(Object.keys(PERMISSION_LABELS))
      const extra = [...new Set(payload.extraPermissions.map((x: unknown) => String(x)))]
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
      let query = admin.from('students').select('*', { count: 'exact' }).order('name').limit(limit)
      if (payload.status) query = query.ilike('status', String(payload.status))
      if (payload.batchId) query = query.eq('current_batch_id', String(payload.batchId))
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
      const picks = Array.isArray(payload.subjects) ? payload.subjects : []
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
      const month = requireText(payload.month, 'Month', 7, true)
      const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month)
      if (!match) throw new ApiFault('BAD_REQUEST', 'Pick a valid month (YYYY-MM).')
      const studentFilter = requireText(payload.studentId, 'Student ID', 40)
      const [{ data: students, error: studentError }, { data: assignments, error: assignmentError },
        { data: feeRows, error: feeError }, { data: studentFeeRows, error: studentFeeError }, { data: settingRows }] = await Promise.all([
        admin.from('students').select('id,name,status').order('id').limit(2000),
        admin.from('student_subjects').select('*').eq('status', 'ACTIVE'),
        admin.from('fee_structure').select('*').eq('item_type', 'SUBJECT').eq('status', 'Active'),
        admin.from('student_fees').select('*').eq('status', 'Active').is('effective_to', null),
        admin.from('settings').select('setting_key,value').in('setting_key', ['ACADEMIC_YEAR','INVOICE_DUE_DAY']),
      ])
      if (studentError || assignmentError || feeError || studentFeeError) throw studentError || assignmentError || feeError || studentFeeError
      const settings = Object.fromEntries((settingRows || []).map((r) => [r.setting_key, r.value]))
      const academicYear = settings.ACADEMIC_YEAR || '2026-27'
      const dueDay = Math.min(28, Math.max(1, Number.parseInt(settings.INVOICE_DUE_DAY || '10', 10) || 10))
      const dueDate = `${month}-${String(dueDay).padStart(2, '0')}`
      const eligible = (students || []).filter((s) => (!studentFilter || s.id === studentFilter) && String(s.status).toUpperCase() === 'ACTIVE')
      if (!eligible.length) throw new ApiFault('BAD_REQUEST', 'No eligible students found.')
      const { data: existingRows, error: existingError } = await admin.from('invoices').select('student_id,status').eq('month', month).eq('academic_year', academicYear)
      if (existingError) throw existingError
      const already = new Set((existingRows || []).filter((r) => String(r.status).toUpperCase() !== 'CANCELLED').map((r) => r.student_id))
      const subjectNames = new Map<string, string>()
      const assignedSubjectIds = [...new Set((assignments || []).map((a) => a.subject_id))]
      const { data: subjects } = await admin.from('subjects').select('id,name').in('id', assignedSubjectIds.length ? assignedSubjectIds : ['__none__'])
      for (const s of subjects || []) subjectNames.set(s.id, s.name)
      const standardByKey = new Map((feeRows || []).filter((f) => f.academic_year === academicYear).map((f) => [f.subject_id, Number(f.amount)]))
      const overrideByKey = new Map((studentFeeRows || []).filter((r) => r.effective_from <= todayDate())
        .map((r) => [`${r.student_id}|${r.subject_id}`, r]))
      const assignmentByStudent = new Map<string, any[]>()
      for (const a of assignments || []) assignmentByStudent.set(a.student_id, [...(assignmentByStudent.get(a.student_id) || []), a])
      const result = { generated: 0, skippedExisting: 0, skippedEmpty: 0, total: 0, details: [] as Array<Record<string, unknown>> }
      for (const student of eligible) {
        if (already.has(student.id)) { result.skippedExisting++; continue }
        const active = assignmentByStudent.get(student.id) || []
        const lines = active.map((a) => {
          const feeOverride = overrideByKey.get(`${student.id}|${a.subject_id}`)
          const standard = feeOverride ? Number(feeOverride.standard_amount) : a.fee_override !== null ? Number(a.fee_override) : standardByKey.get(a.subject_id) || 0
          const discount = feeOverride ? Number(feeOverride.discount_amount) : 0
          return { subjectId: a.subject_id, subjectName: subjectNames.get(a.subject_id) || a.subject_id,
            standardAmount: standard, discountAmount: discount, finalAmount: Math.max(0, standard - discount), paidAmount: 0 }
        }).filter((line) => line.finalAmount > 0)
        if (!lines.length) { result.skippedEmpty++; continue }
        const total = Math.round(lines.reduce((sum, line) => sum + line.finalAmount, 0) * 100) / 100
        const id = await newId(admin, 'invoices', `INV-${month.replace('-', '')}-`, 4)
        const { error } = await admin.from('invoices').insert({ id, student_id: student.id, month, academic_year: academicYear,
          line_items: lines, total_amount: total, paid_amount: 0, balance_amount: total, status: 'UNPAID', due_date: dueDate })
        if (error?.code === '23505') { result.skippedExisting++; continue }
        if (error) throw error
        already.add(student.id)
        result.generated++; result.total = Math.round((result.total + total) * 100) / 100
        result.details.push({ studentId: student.id, name: student.name, invoiceId: id, amount: total })
      }
      await logAction(admin, user, 'GENERATE_INVOICES', 'INVOICES', month,
        { generated: result.generated, skipped: result.skippedExisting + result.skippedEmpty })
      return response({ ok: true, data: result })
    }

    if (action === 'invoices.list') {
      const month = requireText(payload.month, 'Month', 7)
      const statusFilter = String(payload.status || '').toUpperCase()
      const search = String(payload.search || '').trim().toLowerCase().slice(0, 100)
      const limit = Math.min(Math.max(Number.parseInt(payload.limit, 10) || 500, 1), 2000)
      let query = admin.from('invoices').select('*').order('month', { ascending: false }).order('id', { ascending: false }).limit(5000)
      if (month) query = query.eq('month', month)
      const { data, error } = await query
      if (error) throw error
      const studentIds = [...new Set((data || []).map((r) => r.student_id))]
      const { data: students, error: studentsError } = await admin.from('students').select('id,name,current_class').in('id', studentIds.length ? studentIds : ['__none__'])
      if (studentsError) throw studentsError
      const studentMap = new Map((students || []).map((s) => [s.id, s]))
      let rows = (data || []).map((r) => {
        const student = studentMap.get(r.student_id)
        return { InvoiceID: r.id, StudentID: r.student_id, StudentName: student?.name || r.student_id,
          CurrentClass: student?.current_class || '', Month: r.month, MonthLabel: monthLabel(r.month),
          TotalAmount: Number(r.total_amount) || 0, PaidAmount: Number(r.paid_amount) || 0,
          BalanceAmount: Math.max(0, Number(r.total_amount) - Number(r.paid_amount)), DueDate: r.due_date,
          Status: invoiceStatus(r.total_amount, r.paid_amount, r.due_date, r.status), StoredStatus: r.status }
      })
      if (statusFilter) rows = rows.filter((r) => r.Status === statusFilter)
      if (search) rows = rows.filter((r) => r.StudentName.toLowerCase().includes(search) || r.StudentID.toLowerCase().includes(search) || r.InvoiceID.toLowerCase().includes(search))
      const totals = { count: 0, billed: 0, paid: 0, balance: 0, overdue: 0 }
      for (const row of rows) if (row.Status !== 'CANCELLED') {
        totals.count++; totals.billed += row.TotalAmount; totals.paid += row.PaidAmount; totals.balance += row.BalanceAmount
        if (row.Status === 'OVERDUE') totals.overdue += row.BalanceAmount
      }
      return response({ ok: true, data: { rows: rows.slice(0, limit), totals } })
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
        admin.from('students').select('name,current_class').eq('id', invoice.student_id).maybeSingle(),
        admin.from('subjects').select('id,name'),
      ])
      const subjectNames = new Map((subjects || []).map((s) => [s.id, s.name]))
      const lines = normalizedInvoiceLines(invoice).map((line) => ({ ...line,
        subjectName: line.subjectName || subjectNames.get(String(line.subjectId)) || String(line.subjectId || '') }))
      const total = Number(invoice.total_amount) || 0, paid = Number(invoice.paid_amount) || 0
      return response({ ok: true, data: { invoice: { InvoiceID: invoice.id, StudentID: invoice.student_id,
        StudentName: student?.name || invoice.student_id, CurrentClass: student?.current_class || '', Month: invoice.month,
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
      await logAction(admin, user, 'ADD_PAYMENT', 'PAYMENT', paymentId, { invoiceId, amount, mode, receiptId, allocations })
      await logAction(admin, user, 'CREATE_RECEIPT', 'RECEIPT', receiptId, { paymentId, amount })
      return response({ ok: true, data })
    }

    if (action === 'receipts.list') {
      const search = String(payload.search || '').trim().toLowerCase().slice(0, 100)
      const from = requireText(payload.from, 'From date', 10), to = requireText(payload.to, 'To date', 10)
      const limit = Math.min(Math.max(Number.parseInt(payload.limit, 10) || 200, 1), 1000)
      let query = admin.from('receipts').select('id,student_id,receipt_date,amount,status,created_by')
        .order('receipt_date', { ascending: false }).order('id', { ascending: false }).limit(5000)
      if (from) query = query.gte('receipt_date', from)
      if (to) query = query.lte('receipt_date', to)
      const { data, error } = await query
      if (error) throw error
      const ids = [...new Set((data || []).map((r) => r.student_id))]
      const { data: students, error: studentsError } = await admin.from('students').select('id,name').in('id', ids.length ? ids : ['__none__'])
      if (studentsError) throw studentsError
      const names = new Map((students || []).map((s) => [s.id, s.name]))
      const rows = (data || []).filter((r) => !search || r.id.toLowerCase().includes(search) || r.student_id.toLowerCase().includes(search) ||
        String(names.get(r.student_id) || '').toLowerCase().includes(search)).slice(0, limit)
      return response({ ok: true, data: rows.map((r) => ({ ReceiptID: r.id, StudentID: r.student_id,
        StudentName: names.get(r.student_id) || r.student_id, ReceiptDate: r.receipt_date, Amount: Number(r.amount),
        Status: r.status, CreatedBy: r.created_by || '' })) })
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
      const settingMap = Object.fromEntries((settings || []).map((r) => [r.setting_key, r.value]))
      let invoiceData = null
      if (payment?.invoice_id) {
        const { data: inv } = await admin.from('invoices').select('*').eq('id', payment.invoice_id).maybeSingle()
        if (inv) invoiceData = { InvoiceID: inv.id, Month: inv.month, MonthLabel: monthLabel(inv.month),
          LineItems: normalizedInvoiceLines(inv), TotalAmount: Number(inv.total_amount), PaidAmount: Number(inv.paid_amount), BalanceAmount: Number(inv.balance_amount) }
      }
      return response({ ok: true, data: { receipt: { ReceiptID: receipt.id, ReceiptDate: receipt.receipt_date,
        Amount: Number(receipt.amount), Status: receipt.status, Format: receipt.format, CreatedBy: receipt.created_by,
        CreatedAt: receipt.created_at, VoidedBy: receipt.voided_by, VoidDate: receipt.void_date, VoidReason: receipt.void_reason },
        payment: payment ? { PaymentID: payment.id, Mode: payment.payment_mode, Reference: payment.transaction_reference,
          Notes: payment.notes, PaymentDate: payment.payment_date, Allocations: allocationsFromPayment(payment.allocations) } : null,
        invoice: invoiceData, student: student ? { StudentID: student.id, Name: student.name, CurrentClass: student.current_class,
          CurrentBatch: student.current_batch_id, ParentName: student.parent_name, Mobile: student.mobile || student.parent_mobile } : null,
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
          Mode: payment.payment_mode, Reference: payment.transaction_reference, Notes: payment.notes,
          PaymentDate: payment.payment_date, Allocations: allocationsFromPayment(payment.allocations) } : null,
        invoice, student: student ? { StudentID: student.id, Name: student.name, CurrentClass: student.current_class,
          CurrentBatch: student.current_batch_id, ParentName: student.parent_name, Mobile: student.mobile || student.parent_mobile } : null,
        centre: { name: values.CENTRE_NAME || 'Creative Math Zone', tagline: values.TAGLINE || '', address: values.ADDRESS || '',
          mobile: values.MOBILE || '', email: values.EMAIL || '', website: values.WEBSITE || '', academicYear: values.ACADEMIC_YEAR || '2026-27' } } })
    }

    if (action === 'student.invoiceDoc') {
      if (user.user_type !== 'STUDENT' || !user.linked_id) throw new ApiFault('FORBIDDEN', 'This action is only available in the student portal.')
      const id = requireText(payload.invoiceId, 'Invoice ID', 60, true)
      const [{ data: invoice, error }, { data: payments, error: paymentsError }, { data: student }, { data: settings }] = await Promise.all([
        admin.from('invoices').select('*').eq('id', id).eq('student_id', user.linked_id).maybeSingle(),
        admin.from('payments').select('*').eq('invoice_id', id).eq('student_id', user.linked_id).neq('status', 'VOID').order('payment_date'),
        admin.from('students').select('id,name,current_class,parent_name').eq('id', user.linked_id).maybeSingle(),
        admin.from('settings').select('setting_key,value').in('setting_key', ['CENTRE_NAME','TAGLINE','ADDRESS','MOBILE','EMAIL','WEBSITE','ACADEMIC_YEAR']),
      ])
      if (error || paymentsError) throw error || paymentsError
      if (!invoice || String(invoice.status).toUpperCase() === 'CANCELLED') throw new ApiFault('NOT_FOUND', 'Invoice not found.')
      const total = Number(invoice.total_amount) || 0, paid = Number(invoice.paid_amount) || 0
      const values = Object.fromEntries((settings || []).map((r) => [r.setting_key, r.value]))
      return response({ ok: true, data: { invoice: { InvoiceID: invoice.id, Month: invoice.month, MonthLabel: monthLabel(invoice.month),
        DueDate: invoice.due_date, Status: invoiceStatus(total, paid, invoice.due_date, invoice.status), TotalAmount: total,
        PaidAmount: paid, BalanceAmount: Math.max(0, total - paid) }, lines: normalizedInvoiceLines(invoice),
        payments: (payments || []).map((p) => ({ PaymentDate: p.payment_date, Amount: Number(p.amount) || 0,
          PaymentMode: p.payment_mode, ReceiptID: p.receipt_id, Allocations: allocationsFromPayment(p.allocations) })),
        student: student ? { StudentID: student.id, Name: student.name, CurrentClass: student.current_class, ParentName: student.parent_name } : null,
        centre: { name: values.CENTRE_NAME || 'Creative Math Zone', tagline: values.TAGLINE || '', address: values.ADDRESS || '',
          mobile: values.MOBILE || '', email: values.EMAIL || '', website: values.WEBSITE || '', academicYear: values.ACADEMIC_YEAR || '2026-27' } } })
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
      const studentRow = { ...row, id, registration_year: String(year), registration_date: now.slice(0, 10),
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
      const tempPassword = payload.password ? String(payload.password) : passwordTemp()
      if (tempPassword.length < 8 || tempPassword.length > 200) throw new ApiFault('BAD_PASSWORD', 'Password must be at least 8 characters.')
      const { error } = await admin.auth.admin.updateUserById(linkedUser.auth_user_id, { password: tempPassword })
      if (error) throw new ApiFault('PASSWORD_UPDATE_FAILED', 'Could not reset this password.')
      await admin.from('app_users').update({ must_change_password: true, password_changed_at: new Date().toISOString() }).eq('id', linkedUser.id)
      await logAction(admin, user, 'RESET_PASSWORD', isStudent ? 'STUDENT' : 'TEACHER', linkedId, { username: linkedUser.username })
      return response({ ok: true, data: { username: linkedUser.username, tempPassword } })
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
      const { data: current, error: currentError } = await admin.from('student_subjects').select('subject_id').eq('student_id', studentId).eq('status', 'ACTIVE')
      if (currentError) throw currentError
      if ((current || []).some((r) => r.subject_id === subjectId)) throw new ApiFault('DUPLICATE', 'Student already takes this subject.')
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
      if (error?.code === '23505') throw new ApiFault('DUPLICATE', 'This subject is already assigned for the academic year.')
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
      if (row.status !== 'ACTIVE') throw new ApiFault('BAD_REQUEST', 'This subject is already ended.')
      if (row.start_date && endDate < row.start_date) throw new ApiFault('BAD_REQUEST', 'End date cannot be before the start date.')
      const { error } = await admin.from('student_subjects').update({ end_date: endDate, status: 'ENDED' }).eq('id', id)
      if (error) throw error
      await admin.from('change_history').insert({ id: `CHG-${crypto.randomUUID()}`, student_id: row.student_id, field: 'Subject',
        old_value: `${row.subject_id} / ${row.teacher_id || ''} / ${row.batch_id || ''}`, new_value: 'ENDED', changed_by: user.id,
        reason: requireText(payload.reason, 'Reason', 200), academic_year: row.academic_year || '' })
      await logAction(admin, user, 'END_STUDENT_SUBJECT', 'STUDENT_SUBJECT', id, { endDate })
      return response({ ok: true, data: { ended: true } })
    }

    if (action === 'student.subjects' || action === 'student.timetable' || action === 'student.attendance' || action === 'student.dashboard') {
      if (!user.linked_id) throw new ApiFault('NOT_FOUND', 'Student account is not linked to a student record.')
      const { data: student, error: studentError } = await admin.from('students').select('*').eq('id', user.linked_id).maybeSingle()
      if (studentError) throw studentError
      if (!student) throw new ApiFault('NOT_FOUND', 'Student record not found.')
      const { data: subjects, error: subjectsError } = await admin.from('student_subjects').select('*').eq('student_id', student.id).order('start_date', { ascending: false })
      if (subjectsError) throw subjectsError
      const subjectRows = subjects || []
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
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()).toUpperCase()
      const dayName = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long' }).format(new Date()).toUpperCase()
      const [{ data: sub }, { data: teachers }, { data: rooms }, { data: sessions }, { data: notices }] = await Promise.all([
        admin.from('subjects').select('id,name').in('id', [...new Set((timetable || []).flatMap((r) => [r.subject_id, r.co_subject_id].filter(Boolean)))]),
        admin.from('teachers').select('id,name').in('id', (timetable || []).map((r) => r.teacher_id)),
        admin.from('rooms').select('id,name').in('id', (timetable || []).map((r) => r.room_id).filter(Boolean)),
        admin.from('class_sessions').select('id,timetable_id,status').eq('session_date', today),
        admin.from('notices').select('*').ilike('status', 'active').order('posted_at', { ascending: false }).limit(100),
      ])
      const sm = new Map((sub || []).map((x) => [x.id, x.name])), tm = new Map((teachers || []).map((x) => [x.id, x.name])), rm = new Map((rooms || []).map((x) => [x.id, x.name]))
      const activeSubjects = subjectRows.filter((r) => r.status.toUpperCase() === 'ACTIVE').length
      const todayClasses = (timetable || []).filter((r) => r.day.toUpperCase() === dayName).map((r) => {
        const ses = (sessions || []).find((s) => s.timetable_id === r.id && s.status === 'OPEN')
        return { TimetableID: r.id, StartTime: r.start_time, EndTime: r.end_time,
          SubjectName: [sm.get(r.subject_id) || r.subject_id, r.co_subject_id ? sm.get(r.co_subject_id) || r.co_subject_id : ''].filter(Boolean).join(' + '),
          TeacherName: tm.get(r.teacher_id) || r.teacher_id, RoomName: rm.get(r.room_id) || r.room_id, ActiveSessionID: ses?.id || null }
      })
      const recentNotices = (notices || []).filter((n) => !n.expires_at || n.expires_at >= today).filter((n) =>
        ['ALL', 'STUDENTS'].includes(String(n.audience).toUpperCase()) || (String(n.audience).toUpperCase() === 'BATCH' && n.batch_id === student.current_batch_id))
        .slice(0, 3).map((n) => ({ NoticeID: n.id, Title: n.title, Body: n.body, Audience: n.audience, PostedAt: n.posted_at, ExpiresAt: n.expires_at }))
      return response({ ok: true, data: { student: legacyStudent(student), stats: { activeSubjects, attendancePct: rows.length ? Math.round((present + late * 0.5) / rows.length * 100) : 0,
        present, late, absent, totalSessions: rows.length }, todayClasses, recentNotices } })
    }

    if (action === 'teacher.dashboard' || action === 'teacher.timetable' || action === 'teacher.students' || action === 'teacher.sessions') {
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
      const [{ data: assignments }, { data: subjects }, { data: batches }, { data: rooms }, { data: sessions }] = await Promise.all([
        admin.from('student_subjects').select('student_id,subject_id,batch_id,status').eq('teacher_id', teacher.id).ilike('status', 'active'),
        admin.from('subjects').select('id,name'), admin.from('batches').select('id,name'), admin.from('rooms').select('id,name'),
        admin.from('class_sessions').select('id,timetable_id,status').eq('session_date', new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())),
      ])
      const activeAssignments = assignments || []
      const sm = new Map((subjects || []).map((x) => [x.id, x.name]))
      const bm = new Map((batches || []).map((x) => [x.id, x.name]))
      const rm = new Map((rooms || []).map((x) => [x.id, x.name]))
      const dayName = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long' }).format(new Date()).toUpperCase()
      const todays = tt.filter((r) => r.day.toUpperCase() === dayName)
      const sessionRows = (sessions || [])
      return response({ ok: true, data: { teacher: { TeacherID: teacher.id, Name: teacher.name, Mobile: teacher.mobile, Email: teacher.email },
        stats: { students: new Set(activeAssignments.map((r) => r.student_id)).size, subjects: new Set(activeAssignments.map((r) => r.subject_id)).size, todayClasses: todays.length },
        todayClasses: todays.map((r) => { const ses = sessionRows.find((x) => x.timetable_id === r.id && x.status === 'OPEN'); return { TimetableID: r.id,
          StartTime: r.start_time, EndTime: r.end_time, BatchID: r.batch_id, BatchName: bm.get(r.batch_id) || r.batch_id,
          SubjectID: r.subject_id, CoSubjectID: r.co_subject_id || '',
          SubjectName: [sm.get(r.subject_id) || r.subject_id, r.co_subject_id ? sm.get(r.co_subject_id) || r.co_subject_id : ''].filter(Boolean).join(' + '),
          RoomID: r.room_id, RoomName: rm.get(r.room_id) || r.room_id, ActiveSessionID: ses?.id || null } }) } })
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
          start_time: slot.start_time, end_time: slot.end_time, teacher_id: slot.teacher_id, batch_id: slot.batch_id, subject_id: slot.subject_id,
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
        let query = admin.from('payments').select('payment_date,amount,payment_mode,status').neq('status', 'VOID').order('payment_date')
        if (from) query = query.gte('payment_date', from)
        if (to) query = query.lte('payment_date', to)
        const { data, error } = await query.limit(10000)
        if (error) throw error
        const byMonth = new Map<string, number>(), byMode = new Map<string, number>()
        let total = 0
        for (const p of data || []) { const amount = Number(p.amount) || 0, month = p.payment_date.slice(0, 7), mode = p.payment_mode || 'Other'
          byMonth.set(month, (byMonth.get(month) || 0) + amount); byMode.set(mode, (byMode.get(mode) || 0) + amount); total += amount }
        return response({ ok: true, data: { total, count: (data || []).length, months: [...byMonth].sort(([a], [b]) => a.localeCompare(b)).map(([Month, Amount]) => ({ Month, MonthLabel: monthLabel(Month), Amount })),
          modes: [...byMode].sort(([a], [b]) => a.localeCompare(b)).map(([Mode, Amount]) => ({ Mode, Amount })) } })
      }
      if (action === 'reports.dues') {
        if (!permissionsFor(user).includes('*') && !permissionsFor(user).includes('FINANCE_VIEW')) throw new ApiFault('FORBIDDEN', 'Finance view permission is required.')
        let query = admin.from('invoices').select('*').neq('status', 'CANCELLED').order('due_date')
        const month = requireText(payload.month, 'Month', 7); if (month) query = query.eq('month', month)
        const { data: invoices, error } = await query.limit(10000); if (error) throw error
        const eligible = (invoices || []).map((i) => ({ invoice: i, status: invoiceStatus(i.total_amount, i.paid_amount, i.due_date, i.status), balance: Math.max(0, Number(i.total_amount) - Number(i.paid_amount)) }))
          .filter((x) => x.status !== 'CANCELLED' && x.balance > 0)
        const ids = [...new Set(eligible.map((x) => x.invoice.student_id))]
        const { data: students, error: stError } = ids.length ? await admin.from('students').select('id,name,current_class,mobile,parent_mobile').in('id', ids) : { data: [], error: null }
        if (stError) throw stError
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
        const [{ data: teachers, error: tError }, { data: assignments, error: aError }, { data: students, error: sError }, { data: settings }] = await Promise.all([
          admin.from('teachers').select('id,default_rate_per_student,status').eq('status', 'Active'),
          admin.from('student_subjects').select('*').eq('status', 'ACTIVE'), admin.from('students').select('id,status'),
          admin.from('settings').select('setting_key,value').eq('setting_key', 'ACADEMIC_YEAR').maybeSingle(),
        ])
        if (tError) throw tError; if (aError) throw aError; if (sError) throw sError
        const activeStudentIds = new Set((students || []).filter((s) => s.status.toUpperCase() === 'ACTIVE').map((s) => s.id))
        const teacherById = new Map((teachers || []).map((t) => [t.id, t]))
        const counts = new Map<string, { teacherId: string; subjectId: string; students: Set<string>; rate: number }>()
        for (const a of assignments || []) {
          if (!a.teacher_id || !a.subject_id || !activeStudentIds.has(a.student_id) || !teacherById.has(a.teacher_id)) continue
          if (a.start_date && a.start_date > monthEnd) continue
          if (a.end_date && a.end_date < monthStart) continue
          const key = `${a.teacher_id}|${a.subject_id}`, t = teacherById.get(a.teacher_id)!
          const g = counts.get(key) || { teacherId: a.teacher_id, subjectId: a.subject_id, students: new Set<string>(), rate: Number(a.teacher_rate_override ?? t.default_rate_per_student) || 0 }
          g.students.add(a.student_id); counts.set(key, g)
        }
        const academicYear = String(settings?.value || `${month.slice(0, 4)}-${Number(month.slice(0, 4)) + 1}`)
        const [{ data: existing, error: eError }, { data: subjects, error: subError }] = await Promise.all([
          admin.from('teacher_income').select('*').eq('month', month).eq('academic_year', academicYear), admin.from('subjects').select('id,name'),
        ])
        if (eError) throw eError; if (subError) throw subError
        const oldRows = existing || [], oldByKey = new Map(oldRows.map((r) => [`${r.teacher_id}|${r.subject_id}`, r]))
        const payments = await paidMap(oldRows.map((r) => r.id)), subjectNames = new Map((subjects || []).map((s) => [s.id, s.name]))
        let created = 0, refreshed = 0, skippedLocked = 0, skippedNoRate = 0
        const rows: Record<string, unknown>[] = []
        for (const [key, g] of counts) {
          if (g.rate <= 0) { skippedNoRate++; continue }
          const studentCount = g.students.size, gross = Math.round(studentCount * g.rate * 100) / 100, old = oldByKey.get(key)
          if (old && (payments.get(old.id) || 0) > 0) { skippedLocked++; continue }
          rows.push({ id: old?.id || await newId(admin, 'teacher_income', 'TI-', 5), teacher_id: g.teacherId, subject_id: g.subjectId,
            month, student_count: studentCount, rate_per_student: g.rate, gross_income: gross,
            adjustment: old?.adjustment || 0, adjustment_reason: old?.adjustment_reason || '', final_payable: Math.max(0, gross + (Number(old?.adjustment) || 0)),
            status: 'Pending', academic_year: academicYear })
          if (old) refreshed++; else created++
        }
        for (let i = 0; i < rows.length; i += 200) { const { error } = await admin.from('teacher_income').upsert(rows.slice(i, i + 200), { onConflict: 'teacher_id,subject_id,month,academic_year' }); if (error) throw error }
        await logAction(admin, user, 'GENERATE_TEACHER_INCOME', 'TEACHER_INCOME', month, { created, refreshed, skippedLocked, skippedNoRate })
        return response({ ok: true, data: { created, refreshed, skippedLocked, skippedNoRate } })
      }
      if (action === 'teacherIncome.list') {
        const month = requireText(payload.month, 'Month', 7), teacherId = requireText(payload.teacherId, 'Teacher ID', 60)
        let query = admin.from('teacher_income').select('*').order('month', { ascending: false }).order('teacher_id')
        if (month) query = query.eq('month', month); if (teacherId) query = query.eq('teacher_id', teacherId)
        const { data: rows, error } = await query.limit(5000); if (error) throw error
        const incomeRows = rows || [], ids = incomeRows.map((r) => r.id), paid = await paidMap(ids)
        const [{ data: teachers }, { data: subjects }] = await Promise.all([admin.from('teachers').select('id,name'), admin.from('subjects').select('id,name')])
        const tm = new Map((teachers || []).map((x) => [x.id, x.name])), sm = new Map((subjects || []).map((x) => [x.id, x.name]))
        let payable = 0, paidTotal = 0
        const result = incomeRows.map((r) => { const p = paid.get(r.id) || 0, f = Number(r.final_payable) || 0, balance = Math.max(0, f - p); payable += f; paidTotal += p
          return { IncomeID: r.id, TeacherID: r.teacher_id, TeacherName: tm.get(r.teacher_id) || r.teacher_id, SubjectID: r.subject_id, SubjectName: sm.get(r.subject_id) || r.subject_id,
            Month: r.month, MonthLabel: monthLabel(r.month), StudentCount: r.student_count, RatePerStudent: r.rate_per_student, GrossIncome: r.gross_income,
            Adjustment: r.adjustment, AdjustmentReason: r.adjustment_reason, FinalPayable: f, PaidAmount: p, BalanceAmount: balance, Status: balance <= 0 ? 'PAID' : p > 0 ? 'PARTIAL' : 'PENDING' } })
        return response({ ok: true, data: { rows: result, totals: { count: result.length, payable, paid: paidTotal, balance: Math.max(0, payable - paidTotal) } } })
      }
      const incomeId = requireText(payload.incomeId, 'Income ID', 60, true)
      const { data: income, error: incomeError } = await admin.from('teacher_income').select('*').eq('id', incomeId).maybeSingle()
      if (incomeError) throw incomeError
      if (!income) throw new ApiFault('NOT_FOUND', 'Teacher income record not found.')
      const { data: payRows, error: payError } = await admin.from('teacher_payments').select('*').eq('income_id', incomeId).order('payment_date', { ascending: false })
      if (payError) throw payError
      const paid = (payRows || []).reduce((sum, p) => sum + Number(p.amount), 0), balance = Math.max(0, Number(income.final_payable) - paid)
      if (action === 'teacherIncome.get') {
        const userIds = [...new Set((payRows || []).map((p) => p.paid_by).filter(Boolean))]
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
      return response({ ok: true, data: { teacher: { Name: teacher.name, Rate: teacher.default_rate_per_student, Method: teacher.income_method },
        income: (income || []).map((r) => ({ IncomeID: r.id, Month: r.month, SubjectName: names.get(r.subject_id) || r.subject_id,
          StudentCount: r.student_count, Rate: r.rate_per_student, Gross: r.gross_income, Adjustment: r.adjustment, FinalPayable: r.final_payable, Status: r.status })),
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
        if (!existing.has(key)) throw new ApiFault('BAD_REQUEST', `Unknown setting: ${key}`)
        const value = requireText(raw, key, 300, key !== 'SUBJECT_BLOCKED_PAIRS')
        if (key === 'REGISTRATION_ENABLED' && !['TRUE', 'FALSE'].includes(value.toUpperCase())) throw new ApiFault('BAD_REQUEST', 'REGISTRATION_ENABLED must be TRUE or FALSE.')
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
