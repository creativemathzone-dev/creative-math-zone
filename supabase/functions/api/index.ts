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
      'students.list': 'STUDENT_VIEW', 'students.get': 'STUDENT_VIEW',
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
      return response({ ok: true, data: (data || []).map((r) => ({ TeacherID: r.id, Name: r.name,
        Photo: r.photo_url, Mobile: r.mobile, Email: r.email, Address: r.address, Qualification: r.qualification,
        JoiningDate: r.joining_date, Status: r.status, Username: r.username, IncomeMethod: r.income_method,
        DefaultRatePerStudent: r.default_rate_per_student, IncomeVisibleToTeacher: r.income_visible_to_teacher,
        CreatedAt: r.created_at, UpdatedAt: r.updated_at })) })
    }

    if (action === 'users.list') {
      const { data, error } = await admin.from('app_users').select('id,username,user_type,role,linked_id,status,must_change_password,extra_permissions,last_login,last_logout,created_at').order('username')
      if (error) throw error
      return response({ ok: true, data: (data || []).map((r) => ({ UserID: r.id, Username: r.username,
        UserType: r.user_type, Role: r.role, LinkedID: r.linked_id, Status: r.status,
        MustChangePassword: r.must_change_password, ExtraPermissions: r.extra_permissions,
        LastLogin: r.last_login, LastLogout: r.last_logout, CreatedDate: r.created_at })) })
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

    return response(fail('UNKNOWN_ACTION', 'This action has not been migrated yet.'))
  } catch (error) {
    console.error('API action failed:', action, error)
    return response(fail('SERVER_ERROR', 'Something went wrong. Please try again.'))
  }
})
