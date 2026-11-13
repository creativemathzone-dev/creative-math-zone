import { createClient } from 'npm:@supabase/supabase-js@2'

// AI worksheet maker: board-style test papers with answer keys (Gemini free tier).
// No Supabase Storage: worksheets are text rows; after 7 days their text moves to
// Google Drive and is cleared from the database (a small index row stays).
//
// POST actions (signed-in): context, generate, list, get, save, delete, assign,
//   studentView, studentKeys.   POST {action:'worker'} with the cron secret.

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-archive-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS' }
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
const fail = (error: string, status = 400) => json({ error }, status)
const enc = new TextEncoder()
const fromB64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
const KEEP_DAYS = 7
const BOARDS = ['CBSE', 'ICSE', 'ISC', 'WBBSE', 'WBCHSE', 'WBJEE', 'JEE Main']

function clients() {
  const url = Deno.env.get('SUPABASE_URL') || ''
  const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}')
  const pub = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}')
  if (!url || !keys.default || !pub.default) throw new Error('Supabase keys are not configured.')
  return { admin: createClient(url, keys.default, { auth: { persistSession: false, autoRefreshToken: false } }),
    auth: createClient(url, pub.default, { auth: { persistSession: false, autoRefreshToken: false } }) }
}
async function signedInUser(req: Request, admin: any, auth: any) {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  if (!token) throw fail('Sign-in required.', 401)
  const { data: { user: authUser } } = await auth.auth.getUser(token)
  if (!authUser) throw fail('Sign-in expired. Sign in again.', 401)
  const { data: user } = await admin.from('app_users').select('id,user_type,role,linked_id,status').eq('auth_user_id', authUser.id).maybeSingle()
  if (!user || String(user.status).toUpperCase() !== 'ACTIVE') throw fail('Account is not active.', 403)
  return user
}
function istToday() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()) }
async function setting(admin: any, key: string, fallback: string) {
  const { data } = await admin.from('settings').select('value').eq('setting_key', key).maybeSingle()
  return data?.value != null && String(data.value).trim() !== '' ? String(data.value).trim() : fallback
}

/* ---------- Google Drive (same account fallback, like the other functions) ---------- */
async function accessToken(connection: any) {
  const raw = fromB64(Deno.env.get('GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY') || '')
  if (raw.length !== 32) throw new Error('Google Drive token encryption key is not configured.')
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt'])
  const [iv, cipher] = String(connection.refresh_token_ciphertext || '').split('.')
  const refresh = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, key, fromB64(cipher)))
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: Deno.env.get('GOOGLE_DRIVE_CLIENT_ID') || '', client_secret: Deno.env.get('GOOGLE_DRIVE_CLIENT_SECRET') || '',
      refresh_token: refresh, grant_type: 'refresh_token' }) })
  const body = await res.json()
  if (!res.ok || !body.access_token) throw new Error(body.error_description || 'Could not refresh the Google Drive connection.')
  return body.access_token as string
}
async function primaryDrive(admin: any) {
  const { data } = await admin.from('google_drive_connections').select('*').eq('is_primary', true).is('disconnected_at', null).maybeSingle()
  return data
}
async function accessFor(admin: any, connectionId: string) {
  const { data: c } = await admin.from('google_drive_connections').select('*').eq('id', connectionId).maybeSingle()
  if (c && c.refresh_token_ciphertext && !c.disconnected_at) { try { return { access: await accessToken(c), id: c.id } } catch { /* expired */ } }
  const p = await primaryDrive(admin)
  if (!c || !p || String(p.account_email).toLowerCase() !== String(c.account_email).toLowerCase()) throw new Error('The Google Drive login for this worksheet has expired. Reconnect Google Drive in Settings.')
  return { access: await accessToken(p), id: p.id }
}
async function worksheetFolder(admin: any, connection: any, access: string) {
  if (connection.worksheet_folder_id) return connection.worksheet_folder_id as string
  const res = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST', headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Creative Math Zone Worksheets', mimeType: 'application/vnd.google-apps.folder' }) })
  const made = await res.json()
  if (!res.ok || !made.id) throw new Error(made.error?.message || 'Could not create the worksheets folder in Google Drive.')
  await admin.from('google_drive_connections').update({ worksheet_folder_id: made.id }).eq('id', connection.id)
  return made.id as string
}
async function readContent(admin: any, w: any) {
  if (!w.archived_at) return { questions: w.questions, answerKey: w.answer_key }
  if (!w.drive_file_id || !w.drive_connection_id) throw new Error('This worksheet’s text is no longer available.')
  const { access, id } = await accessFor(admin, w.drive_connection_id)
  if (id !== w.drive_connection_id) await admin.from('worksheets').update({ drive_connection_id: id }).eq('id', w.id)
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(w.drive_file_id)}?alt=media`, { headers: { Authorization: `Bearer ${access}` } })
  if (!res.ok) throw new Error('Could not load this worksheet from Google Drive.')
  const data = await res.json()
  return { questions: String(data.questions || ''), answerKey: String(data.answerKey || '') }
}

/* ---------- who teaches what ---------- */
async function teacherScope(admin: any, teacherId: string) {
  const [{ data: slots }, { data: assigned }] = await Promise.all([
    admin.from('timetable').select('batch_id,subject_id,co_subject_id').eq('teacher_id', teacherId).ilike('status', 'active'),
    admin.from('student_subjects').select('batch_id,subject_id').eq('teacher_id', teacherId).ilike('status', 'active'),
  ])
  const pairs: Array<[string, string]> = []
  for (const s of slots || []) { if (s.subject_id) pairs.push([s.batch_id, s.subject_id]); if (s.co_subject_id) pairs.push([s.batch_id, s.co_subject_id]) }
  for (const s of assigned || []) if (s.batch_id && s.subject_id) pairs.push([s.batch_id, s.subject_id])
  return { pairs, subjects: new Set(pairs.map((p) => p[1])), batches: new Set(pairs.map((p) => p[0])) }
}
function normBoard(b: string) {
  const k = String(b || '').toUpperCase()
  if (k.startsWith('CBSE')) return 'CBSE'
  return BOARDS.find((x) => x.toUpperCase() === k) || ''
}

/* ---------- board patterns given to the AI (guidance; scaled to the chosen marks) ---------- */
function patternFor(board: string, classLevel: number, subjectName: string) {
  const competitive = /WBJEE|JEE/i.test(board) || /WBJEE|JEE/i.test(subjectName)
  if (competitive && /WBJEE/i.test(board + subjectName)) return 'WBJEE pattern: Category I — single-correct MCQs (+1, −¼); Category II — single-correct MCQs (+2, −½); Category III — one or more correct options (+2, no negative marking). Four options (A)–(D) each.'
  if (competitive) return 'JEE Main pattern: Section A — single-correct MCQs (+4, −1) with four options; Section B — numerical-value answer questions (+4).'
  if (classLevel && classLevel <= 8) return 'Junior school practice-test pattern: Section A objective (MCQ, fill in the blanks, true/false — 1 mark each); Section B short answers (2 marks); Section C word problems / long answers (3–4 marks).'
  switch (board) {
    case 'CBSE': return 'CBSE pattern: Section A — MCQs including 2 Assertion–Reason questions (1 mark each); Section B — very short answers (2 marks); Section C — short answers (3 marks); Section D — long answers (5 marks); Section E — case-study / source-based questions with sub-parts (4 marks). Give internal choice ("OR") in a few questions of B, C and D.'
    case 'ICSE': return 'ICSE pattern: Section A (compulsory) — Question 1 has MCQs (1 mark each), then structured questions with sub-parts (i), (ii), (iii) showing marks for each part; Section B — longer structured questions with sub-parts; tell students how many Section B questions to attempt (e.g. "Attempt any four").'
    case 'ISC': return 'ISC pattern: Section A (compulsory) — short questions and MCQs, then longer questions with internal choice; Section B and Section C — choice-based longer questions with sub-parts; show marks for every part.'
    case 'WBBSE': return 'WBBSE (Madhyamik) pattern: Group A — MCQs (1 mark); Group B — very short answers: fill in the blanks / true or false / one-word (1 mark); Group C — short answers (2 marks); Group D/E — long answers (3–5 marks) with "OR" alternatives.'
    case 'WBCHSE': return 'WBCHSE (Higher Secondary) pattern: Part A — MCQs and very short answers (1 mark); Part B — short and long descriptive questions (2–5 marks) with "OR" alternatives.'
    default: return 'Board-style pattern: objective section (1 mark each), short answers (2–3 marks) and long answers (4–5 marks) with a few "OR" choices.'
  }
}
function defaultDuration(marks: number) { return marks <= 10 ? 20 : marks <= 20 ? 45 : marks <= 30 ? 60 : marks <= 40 ? 90 : marks <= 50 ? 120 : marks <= 70 ? 150 : 180 }
function classLevelOf(c: string) {
  const roman: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10, XI: 11, XII: 12 }
  const k = String(c || '').toUpperCase().replace(/^CLASS\s*/, '').trim()
  return roman[k] || Number.parseInt(k, 10) || 0
}

/* ---------- Gemini (free tier, daily cap shared with doubt drafts) ---------- */
async function geminiKey(admin: any) {
  const env = Deno.env.get('GEMINI_API_KEY'); if (env) return env
  const { data } = await admin.from('app_secrets').select('value').eq('key', 'GEMINI_API_KEY').maybeSingle()
  return data?.value ? String(data.value) : ''
}
// Free Gemini models are sometimes overloaded (503) or rate limited per model (429).
// Retry once after a short wait, then fall back to other free models, within a time budget.
const MODEL_FALLBACKS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite']
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function callGemini(key: string, model: string, system: string, text: string) {
  const started = Date.now(), budgetMs = 110000
  let last = 'AI did not answer.', busy = false
  for (const m of [...new Set([model, ...MODEL_FALLBACKS])].filter(Boolean)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (Date.now() - started > budgetMs) break
      let res: Response, out: any
      try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text }] }],
            generationConfig: { temperature: 0.5, maxOutputTokens: 16384 } }) })
        out = await res.json().catch(() => ({}))
      } catch { last = 'Could not reach Google AI.'; await pause(1500); continue }
      if (res.ok) {
        const t = (out.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || '').join('').trim()
        if (t) return { text: t, model: m }
        last = 'The AI returned an empty answer.'; break
      }
      const msg = String(out.error?.message || '')
      if (res.status === 401 || res.status === 403 || /api key/i.test(msg)) throw new Error('The AI key was rejected. Check it in Admin → Settings → AI assistant.')
      if (res.status === 404) { last = `Model ${m} is not available.`; break }
      if (res.status === 503 || res.status === 500 || res.status === 504 || res.status === 429) {
        busy = true; last = msg || `Google AI is busy (${res.status}).`
        if (attempt === 0) { await pause(res.status === 429 ? 2000 : 3000); continue }
        break // try the next (lighter) model
      }
      throw new Error('AI request failed' + (msg ? ': ' + msg.slice(0, 200) : ` (${res.status}).`))
    }
  }
  if (busy) throw new Error('Google’s free AI is very busy right now. Please try again in a few minutes.')
  throw new Error(last)
}
// A failed AI call should not use up one of today's allowed drafts.
async function refundAi(admin: any) {
  const day = istToday()
  const { data } = await admin.from('ai_usage').select('calls').eq('day', day).maybeSingle()
  if (data && data.calls > 0) await admin.from('ai_usage').update({ calls: data.calls - 1 }).eq('day', day).eq('calls', data.calls)
}
const SYSTEM = [
  'You are an experienced Indian school teacher and paper setter. You write accurate, syllabus-appropriate question papers and answer keys.',
  'Output format, exactly:',
  '=== TITLE ===', '<one line title>', '=== QUESTIONS ===', '<the question paper>', '=== ANSWER KEY ===', '<answer key>',
  'Rules for the question paper:',
  '- Start with a line "Full Marks: N    Time: T minutes" and short general instructions.',
  '- Use the requested board pattern: sections/groups with headings, marks shown in square brackets after every question or sub-part, e.g. [2].',
  '- The marks of all questions a student must attempt must add up EXACTLY to the requested full marks (count only one side of each OR choice).',
  '- Number questions continuously. MCQ options as (a) (b) (c) (d) on separate lines.',
  '- Plain text only: no Markdown, no LaTeX. Use Unicode maths symbols (√ ² ³ π θ ≤ ≥ ≠ ± × ÷ ∫ Σ →) and fractions like (a+b)/2.',
  '- Questions must be correct, solvable, at the requested difficulty, and only from the given chapter/topic and class level.',
  'Rules for the answer key: same numbering; MCQ answers with the correct option; short worked solutions for other questions; final answers clearly marked.',
].join('\n')
function parse(out: string) {
  const grab = (a: string, b?: string) => {
    const i = out.indexOf(a); if (i < 0) return ''
    const j = b ? out.indexOf(b, i + a.length) : -1
    return out.slice(i + a.length, j < 0 ? undefined : j).trim()
  }
  const title = grab('=== TITLE ===', '=== QUESTIONS ===').split('\n')[0]?.trim() || ''
  const questions = grab('=== QUESTIONS ===', '=== ANSWER KEY ===')
  const answerKey = grab('=== ANSWER KEY ===')
  return { title, questions, answerKey }
}

function row(w: any, names: { subjects: Map<string, string>, batches: Map<string, string>, teachers: Map<string, string> }, extra: Record<string, unknown> = {}) {
  return { WorksheetID: w.id, Title: w.title, SubjectID: w.subject_id, SubjectName: names.subjects.get(w.subject_id) || '', ClassName: w.class_name,
    Board: w.board, BatchID: w.batch_id, BatchName: names.batches.get(w.batch_id) || '', Chapter: w.chapter, Difficulty: w.difficulty,
    TotalMarks: w.total_marks, DurationMin: w.duration_min, Set: w.set_label, ParentID: w.parent_id, TeacherName: names.teachers.get(w.teacher_id) || '',
    Archived: !!w.archived_at, CreatedAt: w.created_at, UpdatedAt: w.updated_at, ...extra }
}
async function names(admin: any, rows: any[]) {
  const ids = (k: string) => [...new Set(rows.map((r) => r[k]).filter(Boolean))]
  const none = ['__none__']
  const [{ data: s }, { data: b }, { data: t }] = await Promise.all([
    admin.from('subjects').select('id,name').in('id', ids('subject_id').length ? ids('subject_id') : none),
    admin.from('batches').select('id,name').in('id', ids('batch_id').length ? ids('batch_id') : none),
    admin.from('teachers').select('id,name').in('id', ids('teacher_id').length ? ids('teacher_id') : none),
  ])
  const m = (rows: any[] | null) => new Map<string, string>((rows || []).map((x: any) => [String(x.id), String(x.name)]))
  return { subjects: m(s), batches: m(b), teachers: m(t) }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    if (req.method !== 'POST') return fail('Method not allowed.', 405)
    const { admin, auth } = clients()
    const body = await req.json().catch(() => ({}))
    const action = String(body.action || '')

    /* ----- hourly: move worksheets older than 7 days to Google Drive ----- */
    if (action === 'worker') {
      const secret = Deno.env.get('HOMEWORK_ARCHIVE_CRON_SECRET')
      if (!secret || req.headers.get('x-archive-secret') !== secret) return fail('Unauthorized scheduled job.', 401)
      const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString()
      const { data: due, error } = await admin.from('worksheets').select('*').is('archived_at', null).lt('updated_at', cutoff).order('updated_at').limit(50)
      if (error) throw error
      if (!due?.length) return json({ archived: 0 })
      const primary = await primaryDrive(admin)
      if (!primary) return json({ archived: 0, kept: due.length, reason: 'No Google Drive account is connected; text stays until it is.' })
      const access = await accessToken(primary), folder = await worksheetFolder(admin, primary, access)
      let archived = 0, kept = 0
      for (const w of due) {
        try {
          const payload = JSON.stringify({ format: 'cmz-worksheet-v1', id: w.id, title: w.title, classAndBoard: `${w.class_name} ${w.board}`, chapter: w.chapter,
            totalMarks: w.total_marks, questions: w.questions, answerKey: w.answer_key, savedAt: new Date().toISOString() })
          const boundary = `cmz_${crypto.randomUUID().replaceAll('-', '')}`
          const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: `${w.id} ${w.title}`.slice(0, 120) + '.json', mimeType: 'application/json', parents: [folder] })}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`
          const up = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST',
            headers: { Authorization: `Bearer ${access}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
            body: new Blob([enc.encode(head), enc.encode(payload), enc.encode(`\r\n--${boundary}--`)]) })
          const made = await up.json()
          if (!up.ok || !made.id) throw new Error(made.error?.message || 'Drive upload failed.')
          // Only clear the text after Drive has confirmed the copy; skip if it was edited meanwhile.
          const { data: done } = await admin.from('worksheets').update({ questions: '', answer_key: '', archived_at: new Date().toISOString(),
            drive_file_id: made.id, drive_connection_id: primary.id, archive_error: '' }).eq('id', w.id).eq('updated_at', w.updated_at).is('archived_at', null).select('id')
          if (done?.length) archived++
          else { await fetch(`https://www.googleapis.com/drive/v3/files/${made.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${access}` } }); kept++ }
        } catch (e) {
          await admin.from('worksheets').update({ archive_error: String(e instanceof Error ? e.message : e).slice(0, 300) }).eq('id', w.id)
          kept++
        }
      }
      return json({ archived, kept })
    }

    const user = await signedInUser(req, admin, auth)
    const isTeacher = user.user_type === 'TEACHER' && !!user.linked_id
    const isSuper = user.user_type === 'ADMIN' && user.role === 'SUPER_ADMIN'
    const isStudent = user.user_type === 'STUDENT' && !!user.linked_id

    /* ----- students: open a worksheet homework; answer keys after the deadline ----- */
    if (action === 'studentView' || action === 'studentKeys') {
      if (!isStudent) return fail('Only students can use this.', 403)
      const { data: st } = await admin.from('students').select('id,current_batch_id').eq('id', user.linked_id).maybeSingle()
      const { data: assigned } = await admin.from('student_subjects').select('batch_id').eq('student_id', user.linked_id).ilike('status', 'active')
      const batchIds = [...new Set([st?.current_batch_id, ...(assigned || []).map((x: any) => x.batch_id)].filter(Boolean))]
      if (action === 'studentKeys') {
        if (!batchIds.length) return json({ rows: [] })
        const since = new Date(Date.now() - 60 * 86400000).toISOString(), now = new Date().toISOString()
        const { data: hw } = await admin.from('homework').select('id,title,subject_id,due_at,worksheet_id').in('batch_id', batchIds)
          .not('worksheet_id', 'is', null).eq('status', 'Active').lt('due_at', now).gte('due_at', since).order('due_at', { ascending: false }).limit(50)
        const { data: subs } = await admin.from('subjects').select('id,name')
        const sm = new Map((subs || []).map((x: any) => [x.id, x.name]))
        return json({ rows: (hw || []).map((h: any) => ({ HomeworkID: h.id, Title: h.title, SubjectName: sm.get(h.subject_id) || '', DueAt: h.due_at })) })
      }
      const { data: hw } = await admin.from('homework').select('id,batch_id,due_at,worksheet_id,status,title').eq('id', String(body.homeworkId || '')).maybeSingle()
      if (!hw || !hw.worksheet_id || hw.status !== 'Active' || !batchIds.includes(hw.batch_id)) return fail('Worksheet not found for your class.', 404)
      const { data: w } = await admin.from('worksheets').select('*').eq('id', hw.worksheet_id).maybeSingle()
      if (!w) return fail('This worksheet was deleted by the teacher.', 404)
      const c = await readContent(admin, w)
      const keyOpen = !!hw.due_at && new Date(hw.due_at).getTime() <= Date.now()
      return json({ Title: w.title, TotalMarks: w.total_marks, DurationMin: w.duration_min, Questions: c.questions,
        AnswerKey: keyOpen ? c.answerKey : '', AnswerKeyOpensAt: keyOpen ? null : hw.due_at })
    }

    if (!isTeacher && !isSuper) return fail('Only teachers and the Super Admin can use worksheets.', 403)
    const scope = isTeacher ? await teacherScope(admin, user.linked_id) : null
    const canSeeSubject = (subjectId: string) => isSuper || (!!scope && scope.subjects.has(subjectId))
    const ownerOf = (w: any) => isSuper || (isTeacher && w.teacher_id === user.linked_id)
    const load = async (id: unknown) => {
      const { data: w } = await admin.from('worksheets').select('*').eq('id', String(id || '')).maybeSingle()
      if (!w || !canSeeSubject(w.subject_id)) throw fail('Worksheet not found.', 404)
      return w
    }

    if (action === 'context') {
      // Batches with class and the board mix of their students (for auto-detect).
      let batchIds: string[]
      if (isSuper) { const { data } = await admin.from('batches').select('id').eq('status', 'Active'); batchIds = (data || []).map((b: any) => b.id) }
      else batchIds = [...scope!.batches]
      const none = ['__none__']
      const [{ data: batches }, { data: subjects }, { data: inBatch }, { data: viaSubjects }] = await Promise.all([
        admin.from('batches').select('id,name,class').in('id', batchIds.length ? batchIds : none),
        admin.from('subjects').select('id,name,status').eq('status', 'Active').order('name'),
        admin.from('students').select('id,board,current_batch_id').in('current_batch_id', batchIds.length ? batchIds : none).ilike('status', 'active'),
        admin.from('student_subjects').select('student_id,batch_id').in('batch_id', batchIds.length ? batchIds : none).ilike('status', 'active'),
      ])
      const extraIds = [...new Set((viaSubjects || []).map((r: any) => r.student_id))].filter((id) => !(inBatch || []).some((s: any) => s.id === id))
      const { data: extra } = extraIds.length ? await admin.from('students').select('id,board').in('id', extraIds).ilike('status', 'active') : { data: [] }
      const boardOf = new Map([...(inBatch || []), ...(extra || [])].map((s: any) => [s.id, normBoard(s.board)]))
      const members = new Map<string, Set<string>>()
      for (const s of inBatch || []) members.set(s.current_batch_id, (members.get(s.current_batch_id) || new Set()).add(s.id))
      for (const r of viaSubjects || []) if (boardOf.has(r.student_id)) members.set(r.batch_id, (members.get(r.batch_id) || new Set()).add(r.student_id))
      const subjectName = new Map((subjects || []).map((s: any) => [s.id, s.name]))
      return json({
        boards: BOARDS,
        subjects: (subjects || []).filter((s: any) => canSeeSubject(s.id)).map((s: any) => ({ id: s.id, name: s.name })),
        batches: (batches || []).map((b: any) => {
          const counts: Record<string, number> = {}
          for (const id of members.get(b.id) || []) { const k = boardOf.get(id) || 'Not set'; counts[k] = (counts[k] || 0) + 1 }
          const top = Object.entries(counts).filter(([k]) => k !== 'Not set').sort((a, c) => c[1] - a[1])[0]
          const subs = isSuper ? [] : scope!.pairs.filter((p) => p[0] === b.id).map((p) => p[1])
          return { BatchID: b.id, BatchName: b.name, ClassName: b.class, BoardCounts: counts, SuggestedBoard: top ? top[0] : '',
            Subjects: [...new Set(subs)].map((id) => ({ id, name: subjectName.get(id) || id })) }
        }).sort((a: any, c: any) => String(a.BatchName).localeCompare(String(c.BatchName))),
      })
    }

    if (action === 'generate') {
      if ((await setting(admin, 'AI_DOUBT_DRAFTS_ENABLED', 'TRUE')).toUpperCase() !== 'TRUE') return fail('The AI assistant is switched off in Settings (AI_DOUBT_DRAFTS_ENABLED).', 403)
      const subjectId = String(body.subjectId || ''), board = BOARDS.includes(String(body.board)) ? String(body.board) : ''
      const className = String(body.className || '').trim().slice(0, 20), chapter = String(body.chapter || '').trim().slice(0, 150)
      const difficulty = ['EASY', 'MEDIUM', 'HARD', 'MIXED'].includes(String(body.difficulty)) ? String(body.difficulty) : 'MIXED'
      const totalMarks = Math.min(100, Math.max(5, Number.parseInt(body.totalMarks, 10) || 20))
      const batchId = String(body.batchId || '') || null
      let parent: any = null
      if (body.setOf) parent = await load(body.setOf)
      if (!subjectId || !canSeeSubject(subjectId)) return fail('Choose one of your subjects.')
      if (!board) return fail('Choose a board.')
      if (!className) return fail('Choose a class.')
      if (!chapter) return fail('Write the chapter or topic.')
      if (batchId && isTeacher && !scope!.batches.has(batchId)) return fail('Choose one of your batches.')
      const key = await geminiKey(admin)
      if (!key) return fail('The AI assistant is not set up yet. Super Admin: add the free Gemini key in Settings → AI assistant.')
      const limit = Number.parseInt(await setting(admin, 'AI_DAILY_LIMIT', '40'), 10) || 0
      const { data: allowed, error: capError } = await admin.rpc('ai_take', { p_limit: limit })
      if (capError) throw capError
      if (!allowed) return fail(`Today's AI limit (${limit}) is reached. It resets at midnight.`, 429)
      const { data: subject } = await admin.from('subjects').select('name').eq('id', subjectId).maybeSingle()
      const duration = defaultDuration(totalMarks)
      // Only class, board, subject and topic are sent — no student data.
      let prompt = [`Make a ${board} board-style question paper with answer key.`, `Class: ${className}`, `Subject: ${subject?.name || subjectId}`,
        `Chapter / topic: ${chapter}`, `Difficulty: ${difficulty.toLowerCase()}${difficulty === 'MIXED' ? ' (about 30% easy, 50% medium, 20% hard)' : ''}`,
        `Full marks: ${totalMarks}`, `Time: ${duration} minutes`, `Pattern to follow (scale the number of questions to the full marks): ${patternFor(board, classLevelOf(className), String(subject?.name || ''))}`].join('\n')
      if (parent) {
        const pc = await readContent(admin, parent)
        prompt += `\n\nThis is SET B of the paper below. Keep exactly the same pattern, sections, marks and difficulty, but change every question (different numbers, values and situations) so students cannot copy answers between sets.\n--- SET A QUESTIONS ---\n${pc.questions.slice(0, 12000)}`
      }
      let out: { text: string, model: string }
      try { out = await callGemini(key, await setting(admin, 'AI_MODEL', 'gemini-flash-latest'), SYSTEM, prompt) }
      catch (e) { await refundAi(admin); return fail(e instanceof Error ? e.message : 'AI failed.', 502) }
      const p = parse(out.text)
      if (!p.questions || !p.answerKey) { await refundAi(admin); return fail('The AI reply was incomplete. Please try again.', 502) }
      const { data: idData, error: idError } = await admin.rpc('next_id', { p_counter_name: 'worksheets', p_prefix: 'WS-', p_width: 5 })
      if (idError) throw idError
      const title = (p.title || `${subject?.name || 'Worksheet'} — ${chapter}`).slice(0, 140) + (parent ? ' (Set B)' : '')
      const rec = { id: String(idData), created_by: user.id, teacher_id: isTeacher ? user.linked_id : null, subject_id: subjectId, batch_id: batchId,
        class_name: className, board, chapter, difficulty, total_marks: totalMarks, duration_min: duration, title: title.slice(0, 150),
        set_label: parent ? 'B' : 'A', parent_id: parent ? parent.id : null, questions: p.questions.slice(0, 60000), answer_key: p.answerKey.slice(0, 60000), model: out.model }
      const { error } = await admin.from('worksheets').insert(rec)
      if (error) throw error
      const n = await names(admin, [rec])
      return json({ worksheet: row({ ...rec, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), archived_at: null }, n, { Questions: rec.questions, AnswerKey: rec.answer_key, CanEdit: true }) })
    }

    if (action === 'list') {
      let q = admin.from('worksheets').select('id,title,subject_id,batch_id,teacher_id,class_name,board,chapter,difficulty,total_marks,duration_min,set_label,parent_id,archived_at,created_at,updated_at')
        .order('created_at', { ascending: false }).limit(200)
      if (isTeacher) { const subs = [...scope!.subjects]; q = q.in('subject_id', subs.length ? subs : ['__none__']) }
      if (body.subjectId) q = q.eq('subject_id', String(body.subjectId))
      if (body.board) q = q.eq('board', String(body.board))
      if (body.className) q = q.eq('class_name', String(body.className))
      if (body.mine && isTeacher) q = q.eq('teacher_id', user.linked_id)
      const term = String(body.search || '').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().slice(0, 60)
      if (term) q = q.or(`title.ilike."%${term}%",chapter.ilike."%${term}%"`)
      const { data, error } = await q
      if (error) throw error
      const n = await names(admin, data || [])
      return json({ rows: (data || []).map((w: any) => row(w, n, { CanEdit: ownerOf(w) })) })
    }

    if (action === 'get') {
      const w = await load(body.id)
      let content: { questions: string, answerKey: string }
      try { content = await readContent(admin, w) } catch (e) { return fail(e instanceof Error ? e.message : 'Could not load worksheet.', 502) }
      const { data: hw } = await admin.from('homework').select('id,batch_id,due_at').eq('worksheet_id', w.id).order('created_at', { ascending: false }).limit(20)
      const n = await names(admin, [w, ...(hw || []).map((h: any) => ({ batch_id: h.batch_id }))])
      return json({ worksheet: row(w, n, { Questions: content.questions, AnswerKey: content.answerKey, CanEdit: ownerOf(w),
        Homework: (hw || []).map((h: any) => ({ HomeworkID: h.id, BatchName: n.batches.get(h.batch_id) || h.batch_id, DueAt: h.due_at })) }) })
    }

    if (action === 'save') {
      const w = await load(body.id)
      if (!ownerOf(w)) return fail('Only the teacher who made this worksheet can edit it.', 403)
      const title = String(body.title || '').trim().slice(0, 150), questions = String(body.questions || '').slice(0, 60000), answerKey = String(body.answerKey || '').slice(0, 60000)
      if (!title || !questions.trim()) return fail('Title and questions cannot be empty.')
      // Editing brings the text back for another 7 days.
      const { error } = await admin.from('worksheets').update({ title, questions, answer_key: answerKey, archived_at: null, updated_at: new Date().toISOString() }).eq('id', w.id)
      if (error) throw error
      return json({ saved: true })
    }

    if (action === 'delete') {
      const w = await load(body.id)
      if (!ownerOf(w)) return fail('Only the teacher who made this worksheet (or the Super Admin) can delete it.', 403)
      if (w.drive_file_id && w.drive_connection_id) {
        try { const { access } = await accessFor(admin, w.drive_connection_id); await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(w.drive_file_id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${access}` } }) } catch { /* keep going */ }
      }
      const { error } = await admin.from('worksheets').delete().eq('id', w.id)
      if (error) throw error
      return json({ deleted: true })
    }

    if (action === 'assign') {
      if (!isTeacher) return fail('Only teachers can send homework.', 403)
      const w = await load(body.id)
      const batchId = String(body.batchId || '')
      if (!scope!.pairs.some((p) => p[0] === batchId && p[1] === w.subject_id)) return fail('You do not teach this subject in that batch.', 403)
      const dueAt = new Date(String(body.dueAt || ''))
      if (!Number.isFinite(dueAt.getTime()) || dueAt.getTime() <= Date.now()) return fail('Choose a due date and time in the future.')
      const { data: idData, error: idError } = await admin.rpc('next_id', { p_counter_name: 'homework', p_prefix: 'HW-', p_width: 5 })
      if (idError) throw idError
      const instructions = `Worksheet: ${w.title}\nFull Marks: ${w.total_marks} · Time: ${w.duration_min} minutes\nTap “Open worksheet” to see the questions. Write your answers on paper and upload photos, or type them below. The answer key opens after the due time.`
      const { error } = await admin.from('homework').insert({ id: String(idData), teacher_id: user.linked_id, batch_id: batchId, subject_id: w.subject_id,
        title: w.title.slice(0, 150), instructions, materials: [], due_at: dueAt.toISOString(), worksheet_id: w.id })
      if (error) throw error
      return json({ homeworkId: String(idData) })
    }

    return fail('Unknown action.')
  } catch (error) {
    if (error instanceof Response) return error
    console.error('Worksheets failed:', error)
    return fail(error instanceof Error ? error.message : 'Worksheet operation failed.', 500)
  }
})
