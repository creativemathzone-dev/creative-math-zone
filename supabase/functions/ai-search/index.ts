import { createClient } from 'npm:@supabase/supabase-js@2'

// AI search bar for admin and teachers (Google Gemini free tier).
//
// Safety design:
//  * The AI never sees records. It only turns the question into ONE of a fixed list of
//    read-only searches ("plans") below; this function then runs that search itself.
//  * Before the question is sent, every student/teacher name, phone number, e-mail and ID
//    in it is replaced with a placeholder (PERSON_1, NUMBER_1 ...). Names are matched here.
//  * Every search applies the signed-in user's own permissions (teachers: only their
//    students, classes and subjects; admins: their role permissions).
//  * Nothing here writes to the records. Plain name/ID searches and the quick buttons
//    use no AI at all. The same question on the same day is answered from a cache.
//
// POST {action:'suggest'} | {action:'search', q} | {action:'run', plan:{intent, params}}
//      {action:'notice', points, langs, tone, audience}  (AI notice writer, admins with NOTICE_EDIT)

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
const fail = (error: string, status = 400) => json({ error }, status)
class Fault extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status } }

const ROLE_PERMISSIONS: Record<string, string[]> = {
  SUPER_ADMIN: ['*'],
  ACCOUNTS_ADMIN: ['STUDENT_VIEW', 'TEACHER_VIEW', 'MASTER_VIEW', 'SETTINGS_VIEW', 'FINANCE_VIEW', 'FINANCE_EDIT', 'TEACHER_INCOME_MANAGE', 'REPORT_VIEW', 'NOTICE_VIEW', 'SELF_VIEW'],
}
const MAX_ROWS = 500

function clients() {
  const url = Deno.env.get('SUPABASE_URL') || ''
  const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}')
  const pub = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}')
  if (!url || !keys.default || !pub.default) throw new Error('Supabase keys are not configured.')
  return { admin: createClient(url, keys.default, { auth: { persistSession: false, autoRefreshToken: false } }),
    auth: createClient(url, pub.default, { auth: { persistSession: false, autoRefreshToken: false } }) }
}
function tokenIssuedAt(token: string) {
  try {
    const b = token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/')
    const n = Number(JSON.parse(atob(b.padEnd(Math.ceil(b.length / 4) * 4, '='))).iat)
    return Number.isFinite(n) ? n : null
  } catch { return null }
}
async function signedInUser(req: Request, admin: any, auth: any) {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  if (!token) throw new Fault('Sign-in required.', 401)
  const { data: { user: authUser } } = await auth.auth.getUser(token)
  if (!authUser) throw new Fault('Sign-in expired. Sign in again.', 401)
  const { data: user } = await admin.from('app_users').select('id,user_type,role,linked_id,status,extra_permissions,password_changed_at,must_change_password').eq('auth_user_id', authUser.id).maybeSingle()
  if (!user || String(user.status).toUpperCase() !== 'ACTIVE') throw new Fault('Account is not active.', 403)
  if (user.password_changed_at) {
    const cutoff = Math.floor(new Date(user.password_changed_at).getTime() / 1000), iat = tokenIssuedAt(token)
    if (iat === null || iat < cutoff) throw new Fault('Your password changed. Sign in again.', 401)
  }
  if (user.must_change_password) throw new Fault('Please change your temporary password first.', 403)
  return user
}
async function setting(admin: any, key: string, fallback: string) {
  const { data } = await admin.from('settings').select('value').eq('setting_key', key).maybeSingle()
  return data?.value != null && String(data.value).trim() !== '' ? String(data.value).trim() : fallback
}

/* ---------------- dates (India time) ---------------- */
function today() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()) }
function addDays(d: string, n: number) { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10) }
function weekday(d: string) { return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(new Date(`${d}T12:00:00Z`)).toUpperCase() }
function validDate(v: unknown) { const s = String(v || ''); return /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s ? s : '' }
function validMonth(v: unknown) { const s = String(v || ''); return /^\d{4}-(0[1-9]|1[0-2])$/.test(s) ? s : '' }
function monthStart(d: string) { return d.slice(0, 8) + '01' }
function weekStart(d: string) { const w = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'].indexOf(weekday(d)); return addDays(d, -w) }
function daysBetween(a: string, b: string) { return Math.round((new Date(`${b}T12:00:00Z`).getTime() - new Date(`${a}T12:00:00Z`).getTime()) / 86400000) }
const fmtDate = (d: string) => d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : ''
const monthName = (m: string) => { const h = /^(\d{4})-(\d{2})$/.exec(m); return h ? new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(+h[1], +h[2] - 1, 1))) : m }
const rupees = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN')

/* ---------------- small helpers ---------------- */
const str = (v: unknown, max = 60) => String(v ?? '').replace(/[^\p{L}\p{N} @._\-()+]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const num = (v: unknown, min: number, max: number, dflt: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt }
const lc = (s: unknown) => String(s || '').toLowerCase()
async function fetchAll(build: () => any, maxRows = 50000) {
  const rows: any[] = []
  for (let from = 0; from < maxRows; from += 1000) {
    const { data, error } = await build().range(from, from + 999)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < 1000) break
  }
  return rows
}
async function selectIn(ids: string[], build: (chunk: string[]) => any) {
  const unique = [...new Set(ids.filter(Boolean))], out: any[] = []
  for (let i = 0; i < unique.length; i += 150) { const { data, error } = await build(unique.slice(i, i + 150)); if (error) throw error; out.push(...(data || [])) }
  return out
}
export function classKey(c: unknown) {
  const roman: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10, XI: 11, XII: 12 }
  const k = String(c || '').toUpperCase().replace(/^CLASS\s*/, '').replace(/\s+/g, '').trim()
  const lead = /^([IVX]+|\d{1,2})/.exec(k)?.[1] || ''
  return String(roman[lead] || Number.parseInt(lead, 10) || k)
}

/* ---------------- who is asking ---------------- */
type Ctx = { admin: any, user: any, perms: string[], isTeacher: boolean, isAdmin: boolean, teacherId: string,
  lookups: Lookups, mine?: { students: Set<string>, subjects: Set<string>, batches: Set<string> } }
type Lookups = { subjects: any[], batches: any[], teachers: any[], rooms: any[] }
const has = (c: Ctx, p: string) => c.isAdmin && (c.perms.includes('*') || c.perms.includes(p))
async function lookups(admin: any): Promise<Lookups> {
  const [s, b, t, r] = await Promise.all([admin.from('subjects').select('id,name,status'), admin.from('batches').select('id,name,class,status'),
    admin.from('teachers').select('id,name,status,mobile'), admin.from('rooms').select('id,name')])
  return { subjects: s.data || [], batches: b.data || [], teachers: t.data || [], rooms: r.data || [] }
}
async function teacherMine(admin: any, teacherId: string) {
  const [{ data: slots }, assigned] = await Promise.all([
    admin.from('timetable').select('batch_id,subject_id,co_subject_id').eq('teacher_id', teacherId).ilike('status', 'active'),
    fetchAll(() => admin.from('student_subjects').select('id,student_id,batch_id,subject_id').eq('teacher_id', teacherId).ilike('status', 'active').order('id')),
  ])
  const subjects = new Set<string>(), batches = new Set<string>(), students = new Set<string>()
  for (const s of slots || []) { batches.add(s.batch_id); if (s.subject_id) subjects.add(s.subject_id); if (s.co_subject_id) subjects.add(s.co_subject_id) }
  for (const a of assigned) { students.add(a.student_id); if (a.batch_id) batches.add(a.batch_id); if (a.subject_id) subjects.add(a.subject_id) }
  return { students, subjects, batches }
}
const nameMap = (rows: any[]) => new Map<string, string>(rows.map((r) => [String(r.id), String(r.name)]))
function findIds(rows: any[], wanted: unknown) {
  const w = lc(str(wanted)).replace(/^class\s+/, '')
  if (!w) return null
  const exact = rows.filter((r) => lc(r.name) === w)
  return (exact.length ? exact : rows.filter((r) => lc(r.name).includes(w))).map((r) => String(r.id))
}

/* ---------------- hiding names before anything is sent to the AI ---------------- */
export const STOP = new Set(('the and for who whom what which when where why how show list find give get tell all any much many has have had not did didnt does doesnt with without from this that these those ' +
  'last next today tomorrow yesterday week weeks month months year years class classes batch batches board boards student students teacher teachers fee fees due dues paid pay unpaid payment payments ' +
  'absent absentees present late attendance homework doubt doubts worksheet worksheets subject subjects invoice invoices receipt receipts collection collections collected total pending ' +
  'registration registrations birthday birthdays joined join new old more less than times time day days morning evening between after before since until only also are was were been ' +
  'his her their them they she him its our your you open profile details number phone mobile name names count above below over under percent per most least top highest lowest ' +
  'submit submitted submission not done answered unanswered open closed active inactive left school gender boy boys girl girls male female who\'s whos me my mine i we us can could ' +
  'please search check see view status report summary compare versus vs and or of in on at to by is be it as an a ka ki ke kya hai nahi kaun kitna kitne aaj kal mere ' +
  'january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec ' +
  'monday tuesday wednesday thursday friday saturday sunday mon tue wed thu fri sat sun ' +
  'cbse icse isc wbbse wbchse wbjee jee main neet maths math mathematics physics chemistry biology science english computer history geography economics accountancy commerce ' +
  'room rooms schedule timetable routine taking takes teaches teach taught load busiest free hours hour cash upi bank online mode modes amount money rupees rs').split(/\s+/))

type Dict = { at: number, tokens: Set<string>, students: Array<{ id: string, name: string, words: string[] }>, teachers: Array<{ id: string, name: string, words: string[] }> }
let dictCache: Dict | null = null
async function nameDict(admin: any, lk: Lookups): Promise<Dict> {
  if (dictCache && Date.now() - dictCache.at < 5 * 60000) return dictCache
  const studentRows = await fetchAll(() => admin.from('students').select('id,name').order('id'))
  const words = (n: string) => lc(n).split(/[^\p{L}]+/u).filter((w) => w.length >= 3)
  const extraStop = new Set([...lk.subjects, ...lk.batches, ...lk.rooms].flatMap((r) => words(String(r.name))))
  const students = studentRows.map((s: any) => ({ id: String(s.id), name: String(s.name), words: words(s.name) }))
  const teachers = lk.teachers.map((t: any) => ({ id: String(t.id), name: String(t.name), words: words(t.name) }))
  const tokens = new Set<string>()
  for (const p of [...students, ...teachers]) for (const w of p.words) if (!STOP.has(w) && !extraStop.has(w)) tokens.add(w)
  dictCache = { at: Date.now(), tokens, students, teachers }
  return dictCache
}
type Masked = { text: string, people: Record<string, string[]>, refs: Record<string, string>, numbers: Record<string, string> }
export function maskQuestion(q: string, dict: Dict): Masked {
  const people: Record<string, string[]> = {}, refs: Record<string, string> = {}, numbers: Record<string, string> = {}
  let text = q.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, () => 'EMAIL')
  text = text.replace(/\b[A-Z]{2,5}-\d{2,6}\b/gi, (m) => { const k = `REF_${Object.keys(refs).length + 1}`; refs[k] = m.toUpperCase(); return k })
  text = text.replace(/(\+?\d[\d\s-]{6,}\d)/g, (m) => { const d = m.replace(/\D/g, ''); if (d.length < 7) return m; const k = `NUMBER_${Object.keys(numbers).length + 1}`; numbers[k] = d; return k })
  // Even parts are words, odd parts are the separators between them. Consecutive name
  // words ("Diptanshu Maji") become one placeholder.
  const parts = text.split(/([^\p{L}'’]+)/u), out: string[] = []
  let run: string[] = [], gap = ''
  const flush = () => { if (!run.length) return; const k = `PERSON_${Object.keys(people).length + 1}`; people[k] = run; out.push(k); run = [] }
  const sep = () => { if (gap) { out.push(gap); gap = '' } }
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (i % 2 === 1) { if (run.length && /^\s+$/.test(p)) { gap = p; continue } flush(); sep(); out.push(p); continue }
    const base = lc(p).replace(/['’]s$/, '').replace(/['’]/g, '')
    if (base.length >= 3 && dict.tokens.has(base)) { run.push(base); gap = ''; if (/['’]s$/i.test(p)) { flush(); out.push("'s") } continue }
    flush(); sep(); out.push(p)
  }
  flush(); sep()
  return { text: out.join('').replace(/\s+/g, ' ').trim(), people, refs, numbers }
}
function matchPeople(list: Array<{ id: string, name: string, words: string[] }>, words: string[]) {
  return list.filter((p) => words.every((w) => p.words.includes(w)))
}

/* ---------------- the fixed list of searches the AI may choose from ---------------- */
type Spec = { label: string, who: (c: Ctx) => boolean, params: string, run: (c: Ctx, p: any, m: Masked) => Promise<Result> }
type Col = { key: string, label: string, type?: 'student' | 'money' | 'date' | 'pct' | 'num' | 'text' }
type Result = { title: string, summary?: string, columns: Col[], rows: any[], open?: { view: string, label: string }, note?: string }

function studentsFromPeople(c: Ctx, m: Masked, dict: Dict, key: unknown) {
  const k = String(key || '')
  if (m.refs[k]) return dict.students.filter((s) => s.id === m.refs[k])
  if (m.people[k]) return matchPeople(dict.students, m.people[k])
  return null
}
function teachersFromPeople(c: Ctx, m: Masked, dict: Dict, key: unknown) {
  const k = String(key || '')
  if (m.refs[k]) return c.lookups.teachers.filter((t) => t.id === m.refs[k]).map((t) => String(t.id))
  if (m.people[k]) return matchPeople(dict.teachers, m.people[k]).map((t) => t.id)
  const byName = findIds(c.lookups.teachers, key)
  return byName && byName.length ? byName : null
}
async function studentMembers(c: Ctx, batchIds: string[] | null, subjectIds: string[] | null) {
  // Students linked to batches/subjects through their subject assignments (and current batch).
  if (!batchIds && !subjectIds) return null
  const ids = new Set<string>()
  const rows = await fetchAll(() => { let q = c.admin.from('student_subjects').select('id,student_id,batch_id,subject_id').ilike('status', 'active').order('id')
    if (batchIds) q = q.in('batch_id', batchIds.length ? batchIds : ['__none__'])
    if (subjectIds) q = q.in('subject_id', subjectIds.length ? subjectIds : ['__none__'])
    return q })
  for (const r of rows) ids.add(r.student_id)
  if (batchIds && !subjectIds && batchIds.length) {
    const cur = await fetchAll(() => c.admin.from('students').select('id').in('current_batch_id', batchIds).order('id'))
    for (const r of cur) ids.add(r.id)
  }
  return ids
}
function scopeStudents(c: Ctx, ids: Set<string> | null) {
  if (!c.isTeacher) return ids
  const mine = c.mine!.students
  return ids ? new Set([...ids].filter((id) => mine.has(id))) : new Set(mine)
}
async function studentRows(c: Ctx, ids: string[]) {
  const rows = await selectIn(ids, (chunk) => c.admin.from('students').select('id,name,current_class,current_batch_id,board,status,parent_mobile,mobile,dob,registration_date,school,gender').in('id', chunk))
  return new Map<string, any>(rows.map((r) => [r.id, r]))
}
function dateRange(p: any, dfltFrom: string, dfltTo: string, maxDays = 366) {
  let from = validDate(p.from) || dfltFrom, to = validDate(p.to) || dfltTo
  if (from > to) [from, to] = [to, from]
  if (daysBetween(from, to) > maxDays) from = addDays(to, -maxDays)
  return { from, to }
}
function filterIds(c: Ctx, p: any) {
  const batchIds = p.batch ? findIds(c.lookups.batches, p.batch) : null
  const subjectIds = p.subject ? findIds(c.lookups.subjects, p.subject) : null
  return { batchIds, subjectIds, className: p.className ? classKey(p.className) : '' }
}
const describe = (bits: Array<string | false | undefined | null>) => bits.filter(Boolean).join(' · ')

/* Timetable for one date, with one-day reschedules applied. */
async function classesOn(c: Ctx, date: string) {
  const [{ data: slots }, { data: moved }] = await Promise.all([
    c.admin.from('timetable').select('*').eq('day', weekday(date)).ilike('status', 'active'),
    c.admin.from('class_reschedules').select('*').eq('status', 'ACTIVE').or(`original_date.eq.${date},rescheduled_date.eq.${date}`),
  ])
  const away = new Set((moved || []).filter((r: any) => r.original_date === date).map((r: any) => r.timetable_id))
  const list = (slots || []).filter((s: any) => !away.has(s.id)).map((s: any) => ({ ...s, date, note: '' }))
  for (const r of moved || []) if (r.rescheduled_date === date) list.push({ ...r, id: r.timetable_id, date, note: `Moved from ${fmtDate(r.original_date)}` })
  return list
}

const SPECS: Record<string, Spec> = {
  students: {
    label: 'Students', who: (c) => c.isTeacher || has(c, 'STUDENT_VIEW'),
    params: 'className, batch, subject, board, school, gender (Male/Female), status (Active/Inactive/Left; default Active), joinedFrom, joinedTo (YYYY-MM-DD)',
    run: async (c, p) => {
      const f = filterIds(c, p)
      let ids = await studentMembers(c, f.batchIds, f.subjectIds)
      ids = scopeStudents(c, ids)
      const status = str(p.status || 'Active', 20)
      const rows = (ids && ids.size === 0) ? [] : await fetchAll(() => {
        let q = c.admin.from('students').select('id,name,current_class,current_batch_id,board,status,parent_mobile,mobile,school,gender,registration_date').order('name').order('id')
        if (status && status.toUpperCase() !== 'ALL') q = q.ilike('status', status)
        if (p.board) q = q.ilike('board', `${str(p.board, 20)}%`)
        if (p.school) q = q.ilike('school', `%${str(p.school, 40)}%`)
        if (p.gender) q = q.ilike('gender', str(p.gender, 10))
        if (validDate(p.joinedFrom)) q = q.gte('registration_date', validDate(p.joinedFrom))
        if (validDate(p.joinedTo)) q = q.lte('registration_date', validDate(p.joinedTo))
        return q
      })
      const bn = nameMap(c.lookups.batches)
      const list = rows.filter((s) => (!ids || ids.has(s.id)) && (!f.className || classKey(s.current_class) === f.className))
      const showPhone = has(c, 'STUDENT_VIEW')
      return { title: describe(['Students', p.className && `Class ${str(p.className, 10)}`, p.batch && str(p.batch), p.subject && str(p.subject), p.board && str(p.board, 20), p.school && str(p.school), status !== 'Active' && status]),
        summary: `${list.length} student${list.length === 1 ? '' : 's'}`,
        columns: [{ key: 'student', label: 'Student', type: 'student' }, { key: 'id', label: 'ID' }, { key: 'cls', label: 'Class' }, { key: 'batch', label: 'Batch' }, { key: 'board', label: 'Board' },
          ...(showPhone ? [{ key: 'phone', label: 'Phone' } as Col] : []), { key: 'joined', label: 'Joined', type: 'date' as const }, { key: 'status', label: 'Status' }],
        rows: list.slice(0, MAX_ROWS).map((s) => ({ student: { id: s.id, name: s.name }, id: s.id, cls: s.current_class, batch: bn.get(s.current_batch_id) || '', board: s.board,
          phone: showPhone ? (s.parent_mobile || s.mobile || '') : '', joined: s.registration_date || '', status: s.status })) }
    },
  },
  student: {
    label: 'One student', who: (c) => c.isTeacher || has(c, 'STUDENT_VIEW'),
    params: 'person (the PERSON_n / REF_n placeholder), show (profile | fees | attendance | subjects), from, to',
    run: async (c, p, m) => {
      const dict = await nameDict(c.admin, c.lookups)
      let found = studentsFromPeople(c, m, dict, p.person)
      if (!found) throw new Fault('Write the student’s name or ID in the question.')
      if (c.isTeacher) found = found.filter((s) => c.mine!.students.has(s.id))
      const ids = found.map((s) => s.id).slice(0, 20)
      if (!ids.length) return { title: 'Student', summary: c.isTeacher ? 'No student with that name in your classes.' : 'No student with that name.', columns: [], rows: [] }
      const info = await studentRows(c, ids), bn = nameMap(c.lookups.batches), sn = nameMap(c.lookups.subjects)
      const show = ['profile', 'fees', 'attendance', 'subjects'].includes(String(p.show)) ? String(p.show) : 'profile'
      const who = (id: string) => ({ id, name: info.get(id)?.name || id })
      if (show === 'fees') {
        if (!has(c, 'FINANCE_VIEW')) throw new Fault('You do not have permission to see fees.', 403)
        const inv = await selectIn(ids, (chunk) => c.admin.from('invoices').select('id,student_id,month,total_amount,paid_amount,due_date,status').in('student_id', chunk).neq('status', 'CANCELLED').order('month', { ascending: false }))
        const t = today(), bal = inv.reduce((v, i) => v + Math.max(0, Number(i.total_amount) - Number(i.paid_amount)), 0)
        return { title: 'Fees', summary: `${rupees(bal)} due in total`, columns: [{ key: 'student', label: 'Student', type: 'student' }, { key: 'month', label: 'Month' }, { key: 'total', label: 'Total', type: 'money' },
            { key: 'paid', label: 'Paid', type: 'money' }, { key: 'balance', label: 'Balance', type: 'money' }, { key: 'state', label: 'Status' }],
          rows: inv.slice(0, MAX_ROWS).map((i) => { const b = Math.max(0, Number(i.total_amount) - Number(i.paid_amount))
            return { student: who(i.student_id), month: monthName(i.month), total: Number(i.total_amount), paid: Number(i.paid_amount), balance: b,
              state: b <= 0 ? 'Paid' : i.due_date && i.due_date < t ? 'Overdue' : Number(i.paid_amount) > 0 ? 'Part paid' : 'Unpaid' } }) }
      }
      if (show === 'attendance') {
        const { from, to } = dateRange(p, addDays(today(), -30), today())
        let marks = await selectIn(ids, (chunk) => c.admin.from('attendance').select('student_id,session_id,status,session_date').in('student_id', chunk).gte('session_date', from).lte('session_date', to).limit(5000))
        if (c.isTeacher) marks = await onlyMySessions(c, marks)
        const g = new Map<string, { p: number, l: number, a: number }>()
        for (const r of marks) { const x = g.get(r.student_id) || { p: 0, l: 0, a: 0 }; if (r.status === 'PRESENT') x.p++; else if (r.status === 'LATE') x.l++; else if (r.status === 'ABSENT') x.a++; g.set(r.student_id, x) }
        return { title: `Attendance ${fmtDate(from)} – ${fmtDate(to)}`, columns: [{ key: 'student', label: 'Student', type: 'student' }, { key: 'p', label: 'Present', type: 'num' }, { key: 'l', label: 'Late', type: 'num' },
            { key: 'a', label: 'Absent', type: 'num' }, { key: 'pct', label: 'Attendance', type: 'pct' }],
          rows: ids.map((id) => { const x = g.get(id) || { p: 0, l: 0, a: 0 }, t = x.p + x.l + x.a; return { student: who(id), p: x.p, l: x.l, a: x.a, pct: t ? Math.round((x.p + x.l) * 100 / t) : null } }) }
      }
      if (show === 'subjects') {
        let subs = await selectIn(ids, (chunk) => c.admin.from('student_subjects').select('student_id,subject_id,batch_id,teacher_id,status,start_date').in('student_id', chunk).ilike('status', 'active'))
        if (c.isTeacher) subs = subs.filter((s) => s.teacher_id === c.teacherId)
        const tn = nameMap(c.lookups.teachers)
        return { title: 'Subjects', columns: [{ key: 'student', label: 'Student', type: 'student' }, { key: 'subject', label: 'Subject' }, { key: 'batch', label: 'Batch' }, { key: 'teacher', label: 'Teacher' }, { key: 'since', label: 'Since', type: 'date' }],
          rows: subs.map((s) => ({ student: who(s.student_id), subject: sn.get(s.subject_id) || s.subject_id, batch: bn.get(s.batch_id) || '', teacher: tn.get(s.teacher_id) || '', since: s.start_date || '' })) }
      }
      const showPhone = has(c, 'STUDENT_VIEW')
      return { title: 'Student', summary: ids.length > 1 ? `${ids.length} students match — tap a name to open the profile` : 'Tap the name to open the profile',
        columns: [{ key: 'student', label: 'Student', type: 'student' }, { key: 'id', label: 'ID' }, { key: 'cls', label: 'Class' }, { key: 'batch', label: 'Batch' }, ...(showPhone ? [{ key: 'phone', label: 'Phone' } as Col] : []), { key: 'status', label: 'Status' }],
        rows: ids.map((id) => { const s = info.get(id) || {}; return { student: who(id), id, cls: s.current_class || '', batch: bn.get(s.current_batch_id) || '', phone: showPhone ? (s.parent_mobile || s.mobile || '') : '', status: s.status || '' } }) }
    },
  },
  dues: {
    label: 'Fee dues', who: (c) => has(c, 'FINANCE_VIEW'),
    params: 'month (YYYY-MM, optional; omit for all months), className, batch, overdueOnly (true/false), minBalance (number)',
    run: async (c, p) => {
      const month = validMonth(p.month), f = filterIds(c, p), t = today()
      const inv = await fetchAll(() => { const q = c.admin.from('invoices').select('id,student_id,month,total_amount,paid_amount,due_date,status').neq('status', 'CANCELLED').order('id'); return month ? q.eq('month', month) : q })
      const members = await studentMembers(c, f.batchIds, null)
      const g = new Map<string, { bal: number, over: number, n: number, oldest: string }>()
      for (const i of inv) {
        const b = Math.max(0, Number(i.total_amount) - Number(i.paid_amount)); if (b <= 0.005) continue
        if (members && !members.has(i.student_id)) continue
        const x = g.get(i.student_id) || { bal: 0, over: 0, n: 0, oldest: '' }
        x.bal += b; x.n++; if (i.due_date && i.due_date < t) x.over += b; if (i.due_date && (!x.oldest || i.due_date < x.oldest)) x.oldest = i.due_date
        g.set(i.student_id, x)
      }
      const info = await studentRows(c, [...g.keys()])
      const minBal = num(p.minBalance, 0, 10000000, 0)
      const list = [...g].filter(([id, x]) => (!f.className || classKey(info.get(id)?.current_class) === f.className) && (!p.overdueOnly || String(p.overdueOnly) === 'false' || x.over > 0) && x.bal >= minBal)
        .sort((a, b) => b[1].over - a[1].over || b[1].bal - a[1].bal)
      const total = list.reduce((v, [, x]) => v + x.bal, 0), overdue = list.reduce((v, [, x]) => v + x.over, 0)
      return { title: describe(['Fee dues', month ? monthName(month) : 'all months', p.className && `Class ${str(p.className, 10)}`, p.batch && str(p.batch), p.overdueOnly && String(p.overdueOnly) !== 'false' && 'overdue only']),
        summary: `${list.length} students · ${rupees(total)} due · ${rupees(overdue)} overdue`,
        columns: [{ key: 'student', label: 'Student', type: 'student' }, { key: 'cls', label: 'Class' }, { key: 'bal', label: 'Balance', type: 'money' }, { key: 'over', label: 'Overdue', type: 'money' },
          { key: 'n', label: 'Invoices', type: 'num' }, { key: 'oldest', label: 'Oldest due', type: 'date' }, { key: 'phone', label: 'Phone' }],
        rows: list.slice(0, MAX_ROWS).map(([id, x]) => { const s = info.get(id) || {}; return { student: { id, name: s.name || id }, cls: s.current_class || '', bal: x.bal, over: x.over, n: x.n, oldest: x.oldest, phone: s.parent_mobile || s.mobile || '' } }),
        open: { view: 'invoices', label: 'Open Invoices' } }
    },
  },
  collections: {
    label: 'Fees collected', who: (c) => has(c, 'FINANCE_VIEW'),
    params: 'from, to (YYYY-MM-DD; default this month), groupBy (month | day | mode)',
    run: async (c, p) => {
      const t = today(), { from, to } = dateRange(p, monthStart(t), t, 800)
      const pays = await fetchAll(() => c.admin.from('payments').select('id,payment_date,amount,payment_mode,status').neq('status', 'VOID').gte('payment_date', from).lte('payment_date', to).order('payment_date').order('id'))
      const by = ['month', 'day', 'mode'].includes(String(p.groupBy)) ? String(p.groupBy) : daysBetween(from, to) > 45 ? 'month' : 'mode'
      const g = new Map<string, { amt: number, n: number }>()
      for (const x of pays) { const k = by === 'month' ? x.payment_date.slice(0, 7) : by === 'day' ? x.payment_date : (x.payment_mode || 'Other'); const v = g.get(k) || { amt: 0, n: 0 }; v.amt += Number(x.amount) || 0; v.n++; g.set(k, v) }
      const total = pays.reduce((v, x) => v + (Number(x.amount) || 0), 0)
      return { title: `Fees collected ${fmtDate(from)} – ${fmtDate(to)}`, summary: `${rupees(total)} from ${pays.length} payment${pays.length === 1 ? '' : 's'}`,
        columns: [{ key: 'k', label: by === 'month' ? 'Month' : by === 'day' ? 'Date' : 'Mode' }, { key: 'amt', label: 'Amount', type: 'money' }, { key: 'n', label: 'Payments', type: 'num' }],
        rows: [...g].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => ({ k: by === 'month' ? monthName(k) : by === 'day' ? fmtDate(k) : k, amt: v.amt, n: v.n })), open: { view: 'reports', label: 'Open Reports' } }
    },
  },
  payments: {
    label: 'Payments list', who: (c) => has(c, 'FINANCE_VIEW'),
    params: 'from, to (YYYY-MM-DD; default last 7 days), mode (Cash/UPI/Bank...), minAmount',
    run: async (c, p) => {
      const t = today(), { from, to } = dateRange(p, addDays(t, -6), t, 400)
      const pays = await fetchAll(() => { let q = c.admin.from('payments').select('id,student_id,payment_date,amount,payment_mode,receipt_id,status').neq('status', 'VOID').gte('payment_date', from).lte('payment_date', to).order('payment_date', { ascending: false }).order('id')
        if (p.mode) q = q.ilike('payment_mode', `%${str(p.mode, 20)}%`); return q })
      const list = pays.filter((x) => Number(x.amount) >= num(p.minAmount, 0, 10000000, 0))
      const info = await studentRows(c, list.slice(0, MAX_ROWS).map((x) => x.student_id))
      return { title: `Payments ${fmtDate(from)} – ${fmtDate(to)}`, summary: `${list.length} payments · ${rupees(list.reduce((v, x) => v + Number(x.amount), 0))}`,
        columns: [{ key: 'date', label: 'Date', type: 'date' }, { key: 'student', label: 'Student', type: 'student' }, { key: 'amt', label: 'Amount', type: 'money' }, { key: 'mode', label: 'Mode' }, { key: 'receipt', label: 'Receipt' }],
        rows: list.slice(0, MAX_ROWS).map((x) => ({ date: x.payment_date, student: { id: x.student_id, name: info.get(x.student_id)?.name || x.student_id }, amt: Number(x.amount), mode: x.payment_mode, receipt: x.receipt_id || '' })) }
    },
  },
  absentees: {
    label: 'Absent students', who: (c) => c.isTeacher || has(c, 'STUDENT_VIEW'),
    params: 'from, to (YYYY-MM-DD; default today), minAbsent (default 1), className, batch, subject',
    run: async (c, p) => attendanceSearch(c, p, 'absent'),
  },
  low_attendance: {
    label: 'Low attendance', who: (c) => c.isTeacher || has(c, 'STUDENT_VIEW'),
    params: 'from, to (YYYY-MM-DD; default last 30 days), belowPercent (default 75), className, batch, subject',
    run: async (c, p) => attendanceSearch(c, p, 'low'),
  },
  classes: {
    label: 'Classes (timetable)', who: (c) => c.isTeacher || has(c, 'MASTER_VIEW'),
    params: 'from, to (YYYY-MM-DD; default today; at most 7 days), teacher (name or PERSON_n), batch, subject',
    run: async (c, p, m) => {
      const t = today(), { from, to } = dateRange(p, t, validDate(p.from) && !validDate(p.to) ? validDate(p.from) : t, 6)
      const f = filterIds(c, p), dict = await nameDict(c.admin, c.lookups)
      const teacherIds = c.isTeacher ? [c.teacherId] : (p.teacher ? teachersFromPeople(c, m, dict, p.teacher) : null)
      const bn = nameMap(c.lookups.batches), sn = nameMap(c.lookups.subjects), tn = nameMap(c.lookups.teachers), rn = nameMap(c.lookups.rooms)
      const rows: any[] = []
      for (let d = from; d <= to; d = addDays(d, 1)) {
        for (const s of await classesOn(c, d)) {
          if (teacherIds && !teacherIds.includes(s.teacher_id)) continue
          if (f.batchIds && !f.batchIds.includes(s.batch_id)) continue
          if (f.subjectIds && !f.subjectIds.includes(s.subject_id) && !f.subjectIds.includes(s.co_subject_id)) continue
          rows.push({ date: d, day: weekday(d).slice(0, 3), time: `${String(s.start_time).slice(0, 5)}–${String(s.end_time).slice(0, 5)}`, batch: bn.get(s.batch_id) || s.batch_id,
            subject: [sn.get(s.subject_id), s.co_subject_id ? sn.get(s.co_subject_id) : ''].filter(Boolean).join(' + '), teacher: tn.get(s.teacher_id) || '', room: rn.get(s.room_id) || '', note: s.note, sort: d + s.start_time })
        }
      }
      rows.sort((a, b) => a.sort.localeCompare(b.sort))
      return { title: `Classes ${from === to ? fmtDate(from) + ' (' + weekday(from).slice(0, 3) + ')' : fmtDate(from) + ' – ' + fmtDate(to)}`, summary: `${rows.length} class${rows.length === 1 ? '' : 'es'}`,
        columns: [...(from === to ? [] : [{ key: 'date', label: 'Date', type: 'date' } as Col, { key: 'day', label: 'Day' } as Col]), { key: 'time', label: 'Time' }, { key: 'batch', label: 'Batch' }, { key: 'subject', label: 'Subject' },
          ...(c.isTeacher ? [] : [{ key: 'teacher', label: 'Teacher' } as Col]), { key: 'room', label: 'Room' }, { key: 'note', label: 'Note' }], rows, open: { view: 'timetable', label: 'Open Timetable' } }
    },
  },
  teacher_load: {
    label: 'Classes per teacher', who: (c) => has(c, 'MASTER_VIEW'),
    params: 'from, to (YYYY-MM-DD; default this week Monday–Sunday; at most 31 days)',
    run: async (c, p) => {
      const t = today(), { from, to } = dateRange(p, weekStart(t), addDays(weekStart(t), 6), 30)
      const g = new Map<string, { n: number, min: number }>()
      for (let d = from; d <= to; d = addDays(d, 1)) for (const s of await classesOn(c, d)) {
        const mins = (h: string) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5))
        const x = g.get(s.teacher_id) || { n: 0, min: 0 }; x.n++; x.min += Math.max(0, mins(String(s.end_time)) - mins(String(s.start_time))); g.set(s.teacher_id, x)
      }
      const tn = nameMap(c.lookups.teachers)
      return { title: `Classes per teacher ${fmtDate(from)} – ${fmtDate(to)}`, columns: [{ key: 'teacher', label: 'Teacher' }, { key: 'n', label: 'Classes', type: 'num' }, { key: 'h', label: 'Hours', type: 'num' }],
        rows: [...g].sort((a, b) => b[1].n - a[1].n).map(([id, x]) => ({ teacher: tn.get(id) || id, n: x.n, h: Math.round(x.min / 6) / 10 })) }
    },
  },
  homework_missing: {
    label: 'Homework not submitted', who: (c) => c.isTeacher || has(c, 'STUDENT_VIEW'),
    params: 'keyword (words from the homework title), subject, batch',
    run: async (c, p) => {
      const f = filterIds(c, p)
      let q = c.admin.from('homework').select('id,title,batch_id,subject_id,due_at,teacher_id').eq('status', 'Active').order('created_at', { ascending: false }).limit(3)
      if (c.isTeacher) q = q.eq('teacher_id', c.teacherId)
      if (p.keyword) q = q.ilike('title', `%${str(p.keyword, 60)}%`)
      if (f.batchIds) q = q.in('batch_id', f.batchIds.length ? f.batchIds : ['__none__'])
      if (f.subjectIds) q = q.in('subject_id', f.subjectIds.length ? f.subjectIds : ['__none__'])
      const { data: hws, error } = await q
      if (error) throw error
      const rows: any[] = [], bn = nameMap(c.lookups.batches)
      for (const h of hws || []) {
        let members = await studentMembers(c, [h.batch_id], h.subject_id ? [h.subject_id] : null) || new Set<string>()
        if (c.isTeacher) members = new Set([...members].filter((id) => c.mine!.students.has(id)))
        const { data: subs } = await c.admin.from('homework_submissions').select('student_id').eq('homework_id', h.id)
        const done = new Set((subs || []).map((s: any) => s.student_id))
        const info = await studentRows(c, [...members])
        for (const id of members) { const s = info.get(id); if (!s || done.has(id) || String(s.status).toUpperCase() !== 'ACTIVE') continue
          rows.push({ hw: h.title, batch: bn.get(h.batch_id) || '', due: String(h.due_at || '').slice(0, 10), student: { id, name: s.name } }) }
      }
      return { title: describe(['Homework not submitted', p.keyword && `“${str(p.keyword)}”`]), summary: (hws || []).length ? `${rows.length} student${rows.length === 1 ? '' : 's'} not submitted (latest ${(hws || []).length} matching homework)` : 'No matching homework found.',
        columns: [{ key: 'hw', label: 'Homework' }, { key: 'batch', label: 'Batch' }, { key: 'due', label: 'Due', type: 'date' }, { key: 'student', label: 'Student', type: 'student' }], rows, open: { view: 'homework', label: 'Open Homework' } }
    },
  },
  homework_summary: {
    label: 'Homework submissions', who: (c) => c.isTeacher || has(c, 'STUDENT_VIEW'),
    params: 'from, to (YYYY-MM-DD; homework due dates; default last 14 days), subject, batch',
    run: async (c, p) => {
      const t = today(), { from, to } = dateRange(p, addDays(t, -14), addDays(t, 7), 120), f = filterIds(c, p)
      let q = c.admin.from('homework').select('id,title,batch_id,subject_id,due_at,teacher_id').eq('status', 'Active').gte('due_at', `${from}T00:00:00+05:30`).lte('due_at', `${to}T23:59:59+05:30`).order('due_at', { ascending: false }).limit(40)
      if (c.isTeacher) q = q.eq('teacher_id', c.teacherId)
      if (f.batchIds) q = q.in('batch_id', f.batchIds.length ? f.batchIds : ['__none__'])
      if (f.subjectIds) q = q.in('subject_id', f.subjectIds.length ? f.subjectIds : ['__none__'])
      const { data: hws, error } = await q
      if (error) throw error
      const bn = nameMap(c.lookups.batches), sn = nameMap(c.lookups.subjects), rows: any[] = []
      for (const h of hws || []) {
        const members = await studentMembers(c, [h.batch_id], h.subject_id ? [h.subject_id] : null) || new Set<string>()
        const { count } = await c.admin.from('homework_submissions').select('id', { count: 'exact', head: true }).eq('homework_id', h.id)
        rows.push({ hw: h.title, subject: sn.get(h.subject_id) || '', batch: bn.get(h.batch_id) || '', due: String(h.due_at || '').slice(0, 10), done: count || 0, of: members.size,
          pct: members.size ? Math.round((count || 0) * 100 / members.size) : null })
      }
      return { title: `Homework due ${fmtDate(from)} – ${fmtDate(to)}`, summary: `${rows.length} homework`, columns: [{ key: 'hw', label: 'Homework' }, { key: 'subject', label: 'Subject' }, { key: 'batch', label: 'Batch' },
        { key: 'due', label: 'Due', type: 'date' }, { key: 'done', label: 'Submitted', type: 'num' }, { key: 'of', label: 'Students', type: 'num' }, { key: 'pct', label: 'Done', type: 'pct' }], rows, open: { view: 'homework', label: 'Open Homework' } }
    },
  },
  doubts_open: {
    label: 'Unanswered doubts', who: (c) => c.isTeacher || c.isAdmin,
    params: 'subject, className, olderThanDays (number)',
    run: async (c, p) => {
      const f = filterIds(c, p)
      let q = c.admin.from('doubts').select('id,title,subject_id,class_name,status,created_at,me_too_count').in('status', ['OPEN', 'CLAIMED']).eq('hidden', false).order('created_at').limit(MAX_ROWS)
      if (c.isTeacher) q = q.in('subject_id', c.mine!.subjects.size ? [...c.mine!.subjects] : ['__none__'])
      if (f.subjectIds) q = q.in('subject_id', f.subjectIds.length ? f.subjectIds : ['__none__'])
      if (p.olderThanDays) q = q.lt('created_at', new Date(Date.now() - num(p.olderThanDays, 0, 365, 0) * 86400000).toISOString())
      const { data, error } = await q
      if (error) throw error
      const list = (data || []).filter((d: any) => !f.className || classKey(d.class_name) === f.className), sn = nameMap(c.lookups.subjects)
      return { title: describe(['Unanswered doubts', p.subject && str(p.subject), p.className && `Class ${str(p.className, 10)}`]), summary: `${list.length} waiting for an answer`,
        columns: [{ key: 'q', label: 'Question' }, { key: 'subject', label: 'Subject' }, { key: 'cls', label: 'Class' }, { key: 'state', label: 'Status' }, { key: 'asked', label: 'Asked', type: 'date' }, { key: 'me', label: 'Me too', type: 'num' }],
        rows: list.map((d: any) => ({ q: d.title, subject: sn.get(d.subject_id) || '', cls: d.class_name, state: d.status === 'CLAIMED' ? 'Being answered' : 'Open', asked: String(d.created_at).slice(0, 10), me: d.me_too_count })),
        open: { view: 'doubts', label: 'Open Doubts' } }
    },
  },
  registrations: {
    label: 'Registrations', who: (c) => has(c, 'STUDENT_VIEW'),
    params: 'status (Pending/Approved/Rejected; default Pending), from, to (submitted dates)',
    run: async (c, p) => {
      const status = str(p.status || 'Pending', 20)
      let q = c.admin.from('registrations').select('id,name,current_class,board,submitted_at,status').order('submitted_at', { ascending: false }).limit(MAX_ROWS)
      if (status.toUpperCase() !== 'ALL') q = q.ilike('status', status)
      if (validDate(p.from)) q = q.gte('submitted_at', `${validDate(p.from)}T00:00:00+05:30`)
      if (validDate(p.to)) q = q.lte('submitted_at', `${validDate(p.to)}T23:59:59+05:30`)
      const { data, error } = await q
      if (error) throw error
      return { title: `Registrations · ${status}`, summary: `${(data || []).length} registration${(data || []).length === 1 ? '' : 's'}`,
        columns: [{ key: 'name', label: 'Name' }, { key: 'cls', label: 'Class' }, { key: 'board', label: 'Board' }, { key: 'at', label: 'Submitted', type: 'date' }, { key: 'state', label: 'Status' }],
        rows: (data || []).map((r: any) => ({ name: r.name, cls: r.current_class, board: r.board, at: String(r.submitted_at).slice(0, 10), state: r.status })), open: { view: 'registrations', label: 'Open Registrations' } }
    },
  },
  worksheets: {
    label: 'Worksheets', who: (c) => c.isTeacher || (c.isAdmin && c.user.role === 'SUPER_ADMIN'),
    params: 'keyword (topic words), subject, board, className, mine (true = only mine)',
    run: async (c, p) => {
      const f = filterIds(c, p)
      let q = c.admin.from('worksheets').select('id,title,subject_id,class_name,board,chapter,total_marks,set_label,teacher_id,created_at').order('created_at', { ascending: false }).limit(200)
      if (c.isTeacher) q = q.in('subject_id', c.mine!.subjects.size ? [...c.mine!.subjects] : ['__none__'])
      if (c.isTeacher && String(p.mine) === 'true') q = q.eq('teacher_id', c.teacherId)
      if (f.subjectIds) q = q.in('subject_id', f.subjectIds.length ? f.subjectIds : ['__none__'])
      if (p.board) q = q.ilike('board', str(p.board, 20))
      const kw = String(p.keyword || '').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60); if (kw) q = q.or(`title.ilike."%${kw}%",chapter.ilike."%${kw}%"`)
      const { data, error } = await q
      if (error) throw error
      const list = (data || []).filter((w: any) => !f.className || classKey(w.class_name) === f.className), sn = nameMap(c.lookups.subjects), tn = nameMap(c.lookups.teachers)
      return { title: describe(['Worksheets', kw && `“${kw}”`]), summary: `${list.length} worksheet${list.length === 1 ? '' : 's'}`,
        columns: [{ key: 'title', label: 'Title' }, { key: 'subject', label: 'Subject' }, { key: 'cls', label: 'Class' }, { key: 'board', label: 'Board' }, { key: 'marks', label: 'Marks', type: 'num' }, { key: 'by', label: 'By' }, { key: 'at', label: 'Made', type: 'date' }],
        rows: list.map((w: any) => ({ title: w.title, subject: sn.get(w.subject_id) || '', cls: w.class_name, board: w.board, marks: w.total_marks, by: tn.get(w.teacher_id) || '', at: String(w.created_at).slice(0, 10) })),
        open: { view: 'worksheets', label: 'Open Worksheets' } }
    },
  },
  birthdays: {
    label: 'Birthdays', who: (c) => c.isTeacher || has(c, 'STUDENT_VIEW'),
    params: 'from, to (YYYY-MM-DD; default today; at most 31 days)',
    run: async (c, p) => {
      const t = today(), { from, to } = dateRange(p, t, validDate(p.from) && !validDate(p.to) ? validDate(p.from) : t, 30)
      const want = new Map<string, string>()
      for (let d = from; d <= to; d = addDays(d, 1)) want.set(d.slice(5), d)
      const mine = c.isTeacher ? c.mine!.students : null
      const rows = (await fetchAll(() => c.admin.from('students').select('id,name,dob,current_class,status').ilike('status', 'active').not('dob', 'is', null).order('id')))
        .filter((s) => want.has(String(s.dob).slice(5, 10)) && (!mine || mine.has(s.id)))
        .map((s) => ({ date: want.get(String(s.dob).slice(5, 10)), student: { id: s.id, name: s.name }, cls: s.current_class, age: Number(String(want.get(String(s.dob).slice(5, 10))).slice(0, 4)) - Number(String(s.dob).slice(0, 4)) }))
        .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      return { title: `Birthdays ${from === to ? fmtDate(from) : fmtDate(from) + ' – ' + fmtDate(to)}`, summary: `${rows.length} birthday${rows.length === 1 ? '' : 's'} 🎂`,
        columns: [{ key: 'date', label: 'Date', type: 'date' }, { key: 'student', label: 'Student', type: 'student' }, { key: 'cls', label: 'Class' }, { key: 'age', label: 'Turns', type: 'num' }], rows }
    },
  },
  teachers: {
    label: 'Teachers', who: (c) => has(c, 'TEACHER_VIEW'),
    params: 'teacher (name or PERSON_n), subject, batch',
    run: async (c, p, m) => {
      const dict = await nameDict(c.admin, c.lookups), f = filterIds(c, p)
      const only = p.teacher ? teachersFromPeople(c, m, dict, p.teacher) : null
      const { data: slots } = await c.admin.from('timetable').select('teacher_id,batch_id,subject_id,co_subject_id').ilike('status', 'active')
      const sn = nameMap(c.lookups.subjects), bn = nameMap(c.lookups.batches), g = new Map<string, { s: Set<string>, b: Set<string> }>()
      for (const s of slots || []) { const x = g.get(s.teacher_id) || { s: new Set(), b: new Set() }; [s.subject_id, s.co_subject_id].filter(Boolean).forEach((id: string) => x.s.add(id)); x.b.add(s.batch_id); g.set(s.teacher_id, x) }
      const list = c.lookups.teachers.filter((t) => String(t.status).toUpperCase() === 'ACTIVE' && (!only || only.includes(t.id)) &&
        (!f.subjectIds || [...(g.get(t.id)?.s || [])].some((id) => f.subjectIds!.includes(id))) && (!f.batchIds || [...(g.get(t.id)?.b || [])].some((id) => f.batchIds!.includes(id))))
      return { title: describe(['Teachers', p.subject && str(p.subject), p.batch && str(p.batch)]), summary: `${list.length} teacher${list.length === 1 ? '' : 's'}`,
        columns: [{ key: 'name', label: 'Teacher' }, { key: 'subjects', label: 'Subjects' }, { key: 'batches', label: 'Batches' }, { key: 'phone', label: 'Phone' }],
        rows: list.map((t) => ({ name: t.name, subjects: [...(g.get(t.id)?.s || [])].map((id) => sn.get(id) || id).join(', '), batches: [...(g.get(t.id)?.b || [])].map((id) => bn.get(id) || id).join(', '), phone: t.mobile || '' })),
        open: { view: 'teachers', label: 'Open Teachers' } }
    },
  },
}

async function onlyMySessions(c: Ctx, marks: any[]) {
  const sessions = await selectIn(marks.map((m) => m.session_id), (chunk) => c.admin.from('class_sessions').select('id,teacher_id').in('id', chunk))
  const mineIds = new Set(sessions.filter((s) => s.teacher_id === c.teacherId).map((s) => s.id))
  return marks.filter((m) => mineIds.has(m.session_id))
}
async function attendanceSearch(c: Ctx, p: any, mode: 'absent' | 'low'): Promise<Result> {
  const t = today(), { from, to } = mode === 'absent' ? dateRange(p, t, validDate(p.from) && !validDate(p.to) ? validDate(p.from) : t, 120) : dateRange(p, addDays(t, -30), t, 180)
  const f = filterIds(c, p)
  let marks = await fetchAll(() => { let q = c.admin.from('attendance').select('id,student_id,session_id,batch_id,subject_id,status,session_date').gte('session_date', from).lte('session_date', to).order('id')
    if (f.batchIds) q = q.in('batch_id', f.batchIds.length ? f.batchIds : ['__none__'])
    if (f.subjectIds) q = q.in('subject_id', f.subjectIds.length ? f.subjectIds : ['__none__'])
    return q }, 60000)
  if (c.isTeacher) marks = await onlyMySessions(c, marks)
  const g = new Map<string, { a: number, t: number, ok: number, last: string }>()
  for (const r of marks) { const x = g.get(r.student_id) || { a: 0, t: 0, ok: 0, last: '' }; x.t++; if (r.status === 'ABSENT') { x.a++; if (r.session_date > x.last) x.last = r.session_date } else x.ok++; g.set(r.student_id, x) }
  const info = await studentRows(c, [...g.keys()])
  const keep = ([id]: [string, any]) => !f.className || classKey(info.get(id)?.current_class) === f.className
  const range = from === to ? fmtDate(from) : `${fmtDate(from)} – ${fmtDate(to)}`
  if (mode === 'absent') {
    const min = num(p.minAbsent, 1, 100, 1)
    const list = [...g].filter(([, x]) => x.a >= min).filter(keep).sort((a, b) => b[1].a - a[1].a)
    return { title: describe([`Absent ${range}`, min > 1 && `${min}+ times`, p.batch && str(p.batch), p.subject && str(p.subject), p.className && `Class ${str(p.className, 10)}`]),
      summary: `${list.length} student${list.length === 1 ? '' : 's'}`, columns: [{ key: 'student', label: 'Student', type: 'student' }, { key: 'cls', label: 'Class' }, { key: 'a', label: 'Absent', type: 'num' },
        { key: 't', label: 'Classes', type: 'num' }, { key: 'last', label: 'Last absent', type: 'date' }, ...(has(c, 'STUDENT_VIEW') ? [{ key: 'phone', label: 'Phone' } as Col] : [])],
      rows: list.slice(0, MAX_ROWS).map(([id, x]) => { const s = info.get(id) || {}; return { student: { id, name: s.name || id }, cls: s.current_class || '', a: x.a, t: x.t, last: x.last, phone: has(c, 'STUDENT_VIEW') ? (s.parent_mobile || s.mobile || '') : '' } }) }
  }
  const below = num(p.belowPercent, 1, 100, 75)
  const list = [...g].map(([id, x]) => [id, { ...x, pct: Math.round(x.ok * 100 / x.t) }] as [string, any]).filter(([, x]) => x.pct < below).filter(keep).sort((a, b) => a[1].pct - b[1].pct)
  return { title: describe([`Attendance below ${below}%`, range, p.batch && str(p.batch), p.subject && str(p.subject)]), summary: `${list.length} student${list.length === 1 ? '' : 's'}`,
    columns: [{ key: 'student', label: 'Student', type: 'student' }, { key: 'cls', label: 'Class' }, { key: 'pct', label: 'Attendance', type: 'pct' }, { key: 'a', label: 'Absent', type: 'num' }, { key: 't', label: 'Classes', type: 'num' }],
    rows: list.slice(0, MAX_ROWS).map(([id, x]) => ({ student: { id, name: info.get(id)?.name || id }, cls: info.get(id)?.current_class || '', pct: x.pct, a: x.a, t: x.t })) }
}

/* ---------------- quick buttons (no AI) ---------------- */
function suggestions(c: Ctx) {
  const t = today(), list: Array<{ label: string, plan: { intent: string, params: Record<string, unknown> } }> = []
  const add = (label: string, intent: string, params: Record<string, unknown> = {}) => { if (SPECS[intent].who(c)) list.push({ label, plan: { intent, params } }) }
  add(c.isTeacher ? 'My classes today' : 'Classes today', 'classes', {})
  if (c.isTeacher) add('My classes tomorrow', 'classes', { from: addDays(t, 1), to: addDays(t, 1) })
  add('Absent today', 'absentees', {})
  add('This month’s dues', 'dues', { month: t.slice(0, 7) })
  add('Overdue fees', 'dues', { overdueOnly: true })
  add('Collected this month', 'collections', { groupBy: 'mode' })
  add('Attendance below 75% (30 days)', 'low_attendance', {})
  add('Homework submissions', 'homework_summary', {})
  add('Unanswered doubts', 'doubts_open', {})
  add('Pending registrations', 'registrations', {})
  add('Birthdays this week', 'birthdays', { from: t, to: addDays(t, 6) })
  add('Classes per teacher this week', 'teacher_load', {})
  return list
}

/* ---------------- Gemini: question -> plan ---------------- */
async function geminiKey(admin: any) {
  const env = Deno.env.get('GEMINI_API_KEY'); if (env) return env
  const { data } = await admin.from('app_secrets').select('value').eq('key', 'GEMINI_API_KEY').maybeSingle()
  return data?.value ? String(data.value) : ''
}
const SEARCH_MODELS = ['gemini-flash-lite-latest', 'gemini-2.5-flash-lite', 'gemini-flash-latest', 'gemini-2.5-flash']
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
function thinkingVariants(m: string): Array<Record<string, unknown> | null> {
  return /2\.5/.test(m) ? [{ thinkingBudget: 0 }, null] : [{ thinkingLevel: 'low' }, { thinkingBudget: 0 }, null]
}
async function askGemini(key: string, system: string, text: string, maxOutputTokens = 600) {
  // Short search plans: fast "lite" model first. Longer writing (notices): the better model first.
  const long = maxOutputTokens > 600, perCall = long ? 30000 : 15000
  const started = Date.now(), left = () => (long ? 70000 : 35000) - (Date.now() - started)
  let busy = false, last = 'The AI did not answer.'
  for (const m of long ? [SEARCH_MODELS[2], SEARCH_MODELS[3], SEARCH_MODELS[0], SEARCH_MODELS[1]] : SEARCH_MODELS) {
    const variants = thinkingVariants(m); let v = 0
    for (let attempt = 0; attempt < 2; attempt++) {
      if (left() < 4000) break
      let res: Response, out: any
      try {
        const generationConfig: Record<string, unknown> = { temperature: maxOutputTokens > 600 ? 0.4 : 0, maxOutputTokens, responseMimeType: 'application/json' }
        if (variants[v]) generationConfig.thinkingConfig = variants[v]
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, signal: AbortSignal.timeout(Math.min(perCall, left() - 2000)),
          body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text }] }], generationConfig }) })
        out = await res.json().catch(() => ({}))
      } catch (e) {
        if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) { busy = true; break }
        last = 'Could not reach Google AI.'; await pause(800); continue
      }
      if (res.ok) {
        const t = (out.candidates?.[0]?.content?.parts || []).filter((p: any) => !p.thought).map((p: any) => p.text || '').join('').trim()
        try { const j = JSON.parse(t.replace(/^```(?:json)?|```$/g, '').trim()); if (j && typeof j === 'object') return j } catch { /* bad JSON */ }
        last = 'The AI gave an unclear answer.'; break
      }
      const msg = String(out.error?.message || '')
      if (res.status === 401 || res.status === 403 || /api key/i.test(msg)) throw new Fault('The AI key was rejected. Super Admin: check it in Settings → AI assistant.', 502)
      if (res.status === 404) break
      if (res.status === 400 && /thinking/i.test(msg) && v < variants.length - 1) { v++; attempt--; continue }
      if ([429, 500, 503, 504].includes(res.status)) { busy = true; if (attempt === 0) { await pause(1200); continue } break }
      last = 'AI request failed' + (msg ? ': ' + msg.slice(0, 160) : '.'); break
    }
  }
  throw new Fault(busy ? 'Google’s free AI is busy right now. Try again in a minute, or use the quick buttons (they need no AI).' : last, 502)
}
function systemPrompt(c: Ctx) {
  const t = today()
  const allowed = Object.entries(SPECS).filter(([, s]) => s.who(c))
  return [
    'You convert a question from a coaching-centre admin or teacher into ONE search plan. You never answer the question yourself.',
    'Reply with JSON only: {"intent": "<one of the intents>", "params": {...}}. Use {"intent":"unknown"} if no intent fits.',
    `Today is ${t} (${weekday(t)}), India. Convert relative dates ("today", "this week" = Monday–Sunday, "last month", "next Saturday") to YYYY-MM-DD; months to YYYY-MM.`,
    'Placeholders like PERSON_1, REF_1, NUMBER_1 stand for hidden names, IDs and phone numbers: copy them exactly into "person" or "teacher" params.',
    'If the question is about one named student, use intent "student" with person and show. Leave out params that are not mentioned.',
    c.isTeacher ? 'The user is a TEACHER: "my" means their own classes and students; results are limited to them automatically.' : 'The user is an ADMIN.',
    `Known subjects: ${c.lookups.subjects.filter((s) => s.status !== 'Inactive').map((s) => s.name).join(', ')}.`,
    `Known batches: ${c.lookups.batches.filter((b) => b.status !== 'Inactive').map((b) => `${b.name} (class ${b.class})`).join(', ')}.`,
    'Classes are written as Roman numerals I–XII. Boards: CBSE, ICSE, ISC, WBBSE, WBCHSE.',
    'Intents and their params:',
    ...allowed.map(([k, s]) => `- ${k}: ${s.label}. Params: ${s.params}`),
  ].join('\n')
}
export function cleanPlan(raw: any) {
  const intent = String(raw?.intent || 'unknown')
  const params: Record<string, unknown> = {}
  if (raw?.params && typeof raw.params === 'object') for (const [k, v] of Object.entries(raw.params).slice(0, 12)) {
    if (/^[a-zA-Z]{1,20}$/.test(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) params[k] = typeof v === 'string' ? v.slice(0, 80) : v
  }
  return { intent, params }
}
async function sha(text: string) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/* ---------------- request handling ---------------- */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    if (req.method !== 'POST') return fail('Method not allowed.', 405)
    const { admin, auth } = clients()
    const body = await req.json().catch(() => ({}))
    const action = String(body.action || '')
    const user = await signedInUser(req, admin, auth)
    const isTeacher = user.user_type === 'TEACHER' && !!user.linked_id, isAdmin = user.user_type === 'ADMIN'
    if (!isTeacher && !isAdmin) return fail('The search bar is for admin and teachers.', 403)
    const lk = await lookups(admin)
    const c: Ctx = { admin, user, isTeacher, isAdmin, teacherId: isTeacher ? String(user.linked_id) : '', lookups: lk,
      perms: [...new Set([...(ROLE_PERMISSIONS[user.role] || []), ...((user.extra_permissions || []) as string[])])] }
    if (isTeacher) c.mine = await teacherMine(admin, c.teacherId)
    const aiOn = (await setting(admin, 'AI_SEARCH_ENABLED', 'TRUE')).toUpperCase() === 'TRUE'

    if (action === 'suggest') return json({ suggestions: suggestions(c), aiEnabled: aiOn && !!(await geminiKey(admin)) })

    const finish = async (plan: { intent: string, params: any }, m: Masked, via: string) => {
      const spec = SPECS[plan.intent]
      if (!spec) return json({ understood: null, via, result: null, message: 'I could not match that to a search I know. Try different words, or tap a quick button.' })
      if (!spec.who(c)) return json({ understood: spec.label, via, result: null, message: 'You do not have permission for this search.' })
      const result = await spec.run(c, plan.params || {}, m)
      return json({ understood: spec.label, via, result })
    }

    /* ----- A1: notice writer (admin with NOTICE_EDIT). Names/phones are hidden from the AI and put back after. ----- */
    if (action === 'notice') {
      if (!has(c, 'NOTICE_EDIT')) return fail('You do not have permission to post notices.', 403)
      if (!aiOn) return fail('AI is switched off in Settings (AI_SEARCH_ENABLED).', 403)
      const points = String(body.points || '').replace(/\s+\n/g, '\n').trim().slice(0, 800)
      if (points.length < 5) return fail('Write a few words about what the notice should say.')
      const langs = (Array.isArray(body.langs) ? body.langs : ['en']).filter((l: unknown) => ['en', 'bn', 'hi'].includes(String(l))).slice(0, 3)
      if (!langs.length) langs.push('en')
      const tone = body.tone === 'friendly' ? 'warm and friendly' : 'polite and formal'
      const audience = ({ STUDENTS: 'students and parents', TEACHERS: 'teachers', BATCH: 'students of one batch and their parents', ALL: 'everyone (students, parents and teachers)' } as Record<string, string>)[String(body.audience)] || 'students and parents'
      const key = await geminiKey(admin)
      if (!key) return fail('The AI assistant is not set up yet. Super Admin: add the free Gemini key in Settings → AI assistant.')
      const dict = await nameDict(admin, lk)
      const m = maskQuestion(points, dict)
      const total = Number.parseInt(await setting(admin, 'AI_DAILY_LIMIT', '40'), 10) || 0
      const own = Number.parseInt(await setting(admin, 'AI_LIMIT_NOTICES', '3'), 10) || 0
      const took = await admin.rpc('ai_take_feature', { p_feature: 'NOTICES', p_feature_limit: own, p_total_limit: total })
      if (took.error) return fail('Run the latest SQL update in Supabase first.', 500)
      if (!took.data) return fail(`Today's notice-writer limit (${own}) is used up. It resets at midnight.`, 429)
      const centre = await setting(admin, 'CENTRE_NAME', 'Creative Math Zone')
      const names: Record<string, string> = { en: 'English', bn: 'Bengali (বাংলা script)', hi: 'Hindi (देवनागरी script)' }
      const system = [`You write short, clear notices for "${centre}", a coaching centre in West Bengal, India.`,
        'Reply with JSON only: {"versions":[{"lang":"en","title":"...","body":"..."}]} with one version per requested language, same meaning in each.',
        'Title: at most 10 words. Body: 40–120 words, plain text, short paragraphs or simple lines; include every date, time, fee amount and instruction given; do not invent facts, dates or amounts.',
        'Placeholders like PERSON_1, NUMBER_1, REF_1 stand for hidden names, phone numbers and IDs: copy them exactly where they belong.',
        `Tone: ${tone}. Readers: ${audience}. End the body with "— ${centre}".`].join('\n')
      const text = `Languages: ${langs.map((l: string) => `${l} = ${names[l]}`).join(', ')}\nWhat the notice must say:\n${m.text}`
      let j: any
      try { j = await askGemini(key, system, text, 1500) }
      catch (e) { await admin.rpc('ai_refund_feature', { p_feature: 'NOTICES' }); throw e }
      const restore = (s: string) => s.replace(/\b(PERSON|NUMBER|REF)_(\d+)\b/g, (all, kind, n) => {
        const k = `${kind}_${n}`
        if (kind === 'PERSON' && m.people[k]) return m.people[k].map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
        if (kind === 'NUMBER' && m.numbers[k]) return m.numbers[k]
        if (kind === 'REF' && m.refs[k]) return m.refs[k]
        return all
      })
      const versions = (Array.isArray(j?.versions) ? j.versions : []).filter((v: any) => v && langs.includes(String(v.lang)))
        .map((v: any) => ({ lang: String(v.lang), title: restore(String(v.title || '')).slice(0, 150), body: restore(String(v.body || '')).slice(0, 3000) }))
        .filter((v: any) => v.title && v.body)
      if (!versions.length) { await admin.rpc('ai_refund_feature', { p_feature: 'NOTICES' }); return fail('The AI reply was unclear. Please try again.', 502) }
      return json({ versions })
    }

    if (action === 'run') {
      const plan = cleanPlan(body.plan)
      return await finish(plan, { text: '', people: {}, refs: {}, numbers: {} }, 'button')
    }

    if (action === 'search') {
      const q = String(body.q || '').replace(/\s+/g, ' ').trim().slice(0, 200)
      if (q.length < 2) return fail('Type a question or a name.')
      const dict = await nameDict(admin, lk)
      const m = maskQuestion(q, dict)
      const leftover = m.text.replace(/\b(PERSON|REF|NUMBER)_\d+\b/g, ' ').replace(/'s\b/gi, ' ')
        .replace(/\b(show|find|open|search|student|students|profile|details|of|the|for|me|please|teacher|id|phone|mobile|number)\b/gi, ' ').replace(/[^\p{L}\p{N}]+/gu, '').trim()

      // 1) Plain name / ID / phone: no AI needed.
      if (!leftover) {
        const keys = [...Object.keys(m.people), ...Object.keys(m.refs)]
        if (keys.length === 1 && (isTeacher || has(c, 'STUDENT_VIEW'))) {
          const studentMatch = studentsFromPeople(c, m, dict, keys[0]) || []
          if (studentMatch.length || !has(c, 'TEACHER_VIEW')) return await finish({ intent: 'student', params: { person: keys[0], show: 'profile' } }, m, 'direct')
          return await finish({ intent: 'teachers', params: { teacher: keys[0] } }, m, 'direct')
        }
        const phones = Object.values(m.numbers)
        if (phones.length === 1 && has(c, 'STUDENT_VIEW')) {
          const d = phones[0].slice(-10)
          const { data } = await admin.from('students').select('id,name').or(`mobile.ilike."%${d}%",parent_mobile.ilike."%${d}%",parent_whatsapp.ilike."%${d}%"`).limit(20)
          const ids = (data || []).map((s: any) => String(s.id))
          const fake: Masked = { text: '', people: {}, refs: Object.fromEntries(ids.map((id: string, i: number) => [`REF_${i + 1}`, id])), numbers: {} }
          if (!ids.length) return json({ understood: 'Phone number', via: 'direct', result: { title: 'Phone number', summary: 'No student with that number.', columns: [], rows: [] } })
          const all = await Promise.all(ids.map((_: string, i: number) => SPECS.student.run(c, { person: `REF_${i + 1}`, show: 'profile' }, fake)))
          return json({ understood: 'Phone number', via: 'direct', result: { ...all[0], summary: `${ids.length} student${ids.length === 1 ? '' : 's'} with this number`, rows: all.flatMap((r) => r.rows) } })
        }
      }

      // 2) A sentence: ask the AI which search it means (names already hidden).
      if (!aiOn) return fail('The AI search is switched off in Settings (AI_SEARCH_ENABLED). Use the quick buttons or type just a name.', 403)
      const key = await geminiKey(admin)
      if (!key) return fail('The AI assistant is not set up yet. Super Admin: add the free Gemini key in Settings → AI assistant.')
      const day = today(), role = isTeacher ? 'T' : 'A'
      const cacheKey = await sha(`${role}|${lc(m.text)}`)
      const { data: hit } = await admin.from('ai_search_cache').select('plan').eq('day', day).eq('question_key', cacheKey).maybeSingle()
      if (hit?.plan) return await finish(cleanPlan(hit.plan), m, 'cache')

      const total = Number.parseInt(await setting(admin, 'AI_DAILY_LIMIT', '40'), 10) || 0
      const own = Number.parseInt(await setting(admin, 'AI_LIMIT_SEARCH', '50'), 10) || 0
      const took = await admin.rpc('ai_take_feature', { p_feature: 'SEARCH', p_feature_limit: own, p_total_limit: total })
      if (took.error) return fail('Run the latest SQL update (ai_search_and_feature_limits) in Supabase first.', 500)
      if (!took.data) return fail(`Today's AI search limit (${own}) or overall AI limit (${total}) is reached. The quick buttons and name search still work.`, 429)
      let plan
      try { plan = cleanPlan(await askGemini(key, systemPrompt(c), m.text)) }
      catch (e) { await admin.rpc('ai_refund_feature', { p_feature: 'SEARCH' }); throw e }
      await admin.from('ai_search_cache').upsert({ day, question_key: cacheKey, plan }, { onConflict: 'day,question_key' })
      if (Math.random() < 0.05) await admin.from('ai_search_cache').delete().lt('day', addDays(day, -2))
      return await finish(plan, m, 'ai')
    }
    return fail('Unknown action.')
  } catch (e) {
    if (e instanceof Fault) return fail(e.message, e.status)
    console.error(e)
    return fail(e instanceof Error ? e.message : 'Search failed.', 500)
  }
})
