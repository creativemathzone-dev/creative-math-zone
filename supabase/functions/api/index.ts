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

    if (action === 'auth.login') {
      const username = String(payload.username || '').trim()
      const password = String(payload.password || '')
      const portal = String(payload.portal || '').toUpperCase()
      if (!username || !password || username.length > 60 || password.length > 200) return response(fail('BAD_LOGIN', 'Username or password is incorrect.'))
      const { data: user } = await admin.from('app_users').select('*').ilike('username', username).maybeSingle()
      if (!user || !user.auth_user_id) return response(fail('BAD_LOGIN', 'Username or password is incorrect.'))
      const { data: authUser } = await admin.auth.admin.getUserById(user.auth_user_id)
      const email = authUser.user?.email
      if (!email) return response(fail('BAD_LOGIN', 'Username or password is incorrect.'))
      const { data: session, error } = await auth.auth.signInWithPassword({ email, password })
      if (error || !session.session) return response(fail('BAD_LOGIN', 'Username or password is incorrect.'))
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
    }
    const permission = needed[action]
    const granted = permissionsFor(user)
    if (!permission) return response(fail('UNKNOWN_ACTION', 'This action has not been migrated yet.'))
    if (!granted.includes('*') && !granted.includes(permission)) return response(fail('FORBIDDEN', 'You do not have permission to perform this action.'))

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
      const startDate = requireText(payload.startDate || new Date().toISOString().slice(0, 10), 'Start date', 10, true)
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
      const endDate = requireText(payload.endDate || new Date().toISOString().slice(0, 10), 'End date', 10, true)
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
