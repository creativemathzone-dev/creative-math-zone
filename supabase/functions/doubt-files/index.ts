import { createClient } from 'npm:@supabase/supabase-js@2'

// Doubt portal photos.
//  POST {action:'upload'}  – a student/teacher adds a photo to their own doubt or answer.
//                            The photo goes straight to the connected Google Drive; only
//                            if Drive is unavailable is it kept in the private
//                            'doubt-files' bucket for the worker to move later.
//  GET  ?file=ID           – view a photo (same visibility rules as the doubt).
//  POST {action:'worker'}  – hourly: move fallback photos to Drive, and remove anything
//                            still in Supabase after 7 days.

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-archive-secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }
const enc = new TextEncoder()
const MAX_BYTES = 3 * 1024 * 1024
const MAX_PER_OWNER = 3
const KEEP_DAYS = 7
const fromB64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

function clients() {
  const url = Deno.env.get('SUPABASE_URL') || ''
  const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}')
  const pub = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}')
  if (!url || !keys.default || !pub.default) throw new Error('Supabase keys are not configured.')
  return { admin: createClient(url, keys.default, { auth: { persistSession: false, autoRefreshToken: false } }),
    auth: createClient(url, pub.default, { auth: { persistSession: false, autoRefreshToken: false } }) }
}
async function cryptoKey(usages: KeyUsage[]) {
  const raw = fromB64(Deno.env.get('GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY') || '')
  if (raw.length !== 32) throw new Error('Google Drive token encryption key is not configured.')
  return await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, usages)
}
async function accessToken(connection: any) {
  const [iv, cipher] = String(connection.refresh_token_ciphertext || '').split('.')
  const refresh = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, await cryptoKey(['decrypt']), fromB64(cipher)))
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: Deno.env.get('GOOGLE_DRIVE_CLIENT_ID') || '', client_secret: Deno.env.get('GOOGLE_DRIVE_CLIENT_SECRET') || '',
      refresh_token: refresh, grant_type: 'refresh_token' }) })
  const body = await res.json()
  if (!res.ok || !body.access_token) throw new Error(body.error_description || 'Could not refresh the Google Drive connection.')
  return body.access_token as string
}
async function doubtFolder(admin: any, connection: any, access: string) {
  if (connection.doubt_folder_id) return connection.doubt_folder_id as string
  const res = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Creative Math Zone Doubts', mimeType: 'application/vnd.google-apps.folder' }) })
  const made = await res.json()
  if (!res.ok || !made.id) throw new Error(made.error?.message || 'Could not create the doubts folder in Google Drive.')
  await admin.from('google_drive_connections').update({ doubt_folder_id: made.id }).eq('id', connection.id)
  connection.doubt_folder_id = made.id
  return made.id as string
}
async function uploadDrive(access: string, name: string, mime: string, bytes: Uint8Array, folderId: string) {
  const boundary = `cmz_${crypto.randomUUID().replaceAll('-', '')}`
  const prefix = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, mimeType: mime, parents: [folderId] })}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`
  const body = new Blob([enc.encode(prefix), bytes as Uint8Array<ArrayBuffer>, enc.encode(`\r\n--${boundary}--`)])
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': `multipart/related; boundary=${boundary}` }, body })
  const result = await res.json()
  if (!res.ok || !result.id) throw new Error(result.error?.message || 'Google Drive upload failed.')
  return result.id as string
}
async function primaryDrive(admin: any) {
  const { data } = await admin.from('google_drive_connections').select('*').eq('is_primary', true).is('disconnected_at', null).maybeSingle()
  return data
}
async function signedInUser(req: Request, admin: any, auth: any) {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  if (!token) throw json({ error: 'Sign-in required.' }, 401)
  const { data: { user: authUser } } = await auth.auth.getUser(token)
  if (!authUser) throw json({ error: 'Sign-in expired. Sign in again.' }, 401)
  const { data: user } = await admin.from('app_users').select('id,user_type,role,linked_id,status').eq('auth_user_id', authUser.id).maybeSingle()
  if (!user || String(user.status).toUpperCase() !== 'ACTIVE') throw json({ error: 'Account is not active.' }, 403)
  return user
}
// Same visibility as the API: teachers/admins see all; students see their own doubts and
// non-hidden doubts for their class and subjects. Unapproved answers are only for their author.
async function canView(admin: any, user: any, doubt: any, answer: any) {
  if (user.user_type === 'ADMIN' || user.user_type === 'TEACHER') return true
  if (user.user_type !== 'STUDENT') return false
  const me = user.linked_id
  if (answer && answer.status !== 'APPROVED' && !(answer.author_type === 'STUDENT' && answer.author_id === me)) return false
  if (doubt.student_id === me) return true
  if (doubt.hidden) return false
  const [{ data: st }, { data: subs }] = await Promise.all([
    admin.from('students').select('current_class').eq('id', me).maybeSingle(),
    admin.from('student_subjects').select('subject_id').eq('student_id', me).eq('subject_id', doubt.subject_id).ilike('status', 'active').limit(1),
  ])
  return !!st && st.current_class === doubt.class_name && (subs || []).length > 0
}

// Load a stored photo from Google Drive (or the temporary Supabase copy).
// Throws a ready-made error Response when it cannot be loaded.
async function photoBlob(admin: any, file: any): Promise<Blob> {
  if (file.drive_file_id && file.drive_connection_id) {
    const { data: connection } = await admin.from('google_drive_connections').select('*').eq('id', file.drive_connection_id).maybeSingle()
    if (!connection) throw json({ error: 'The Google Drive account for this photo is no longer connected.' }, 410)
    let access = ''
    try { if (connection.refresh_token_ciphertext && !connection.disconnected_at) access = await accessToken(connection) } catch { access = '' }
    if (!access) {
      // Old login expired: use the current login of the same Google account and re-point the photo.
      const current = await primaryDrive(admin)
      if (!current || String(current.account_email).toLowerCase() !== String(connection.account_email).toLowerCase())
        throw json({ error: 'The Google Drive login for this photo has expired. Reconnect Google Drive in Settings.' }, 410)
      access = await accessToken(current)
      await admin.from('doubt_files').update({ drive_connection_id: current.id }).eq('id', file.id)
    }
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.drive_file_id)}?alt=media`,
      { headers: { Authorization: `Bearer ${access}` } })
    if (!res.ok) throw json({ error: 'Could not load this photo from Google Drive.' }, 502)
    return await res.blob()
  }
  const { data, error } = await admin.storage.from('doubt-files').download(file.storage_path)
  if (error || !data) throw json({ error: 'Photo not found.' }, 404)
  return data
}

/* ---------------- Free AI draft (Google Gemini, no billing) ---------------- */
const AI_SYSTEM = [
  'You are an experienced, patient mathematics/science tutor at an Indian coaching centre (CBSE, ICSE, ISC, WBBSE, WBCHSE, WBJEE/JEE).',
  'Write a model solution that a teacher will check before a student sees it.',
  'Rules:',
  '- Solve step by step with short numbered steps a school student can follow; show the key formula used.',
  '- Plain text only: no Markdown headings, no LaTeX. Use Unicode maths symbols (√ ² ³ π θ ≤ ≥ ≠ ± × ÷ ∫ Σ →) and fractions like (a+b)/2.',
  '- End with a line starting "Answer:".',
  '- If the question or photo is unclear, incomplete or has several possible readings, say exactly what is unclear and solve the most likely reading.',
  '- If you are not confident, start with "Teacher please check:" and explain why.',
  '- Reply in the language of the question (English by default; Bengali or Hindi if the student wrote in it).',
  '- Keep it under 350 words. Do not mention that you are an AI.',
].join('\n')

async function settingValue(admin: any, key: string, fallback: string) {
  const { data } = await admin.from('settings').select('value').eq('setting_key', key).maybeSingle()
  return data?.value != null && String(data.value).trim() !== '' ? String(data.value).trim() : fallback
}
async function geminiKey(admin: any) {
  const env = Deno.env.get('GEMINI_API_KEY')
  if (env) return env
  const { data } = await admin.from('app_secrets').select('value').eq('key', 'GEMINI_API_KEY').maybeSingle()
  return data?.value ? String(data.value) : ''
}
const toB64 = (bytes: Uint8Array) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s) }

// Free Gemini models are sometimes overloaded (503) or rate limited per model (429).
// Retry once after a short wait, then fall back to other free models, within a time budget.
const MODEL_FALLBACKS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite']
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function callGemini(key: string, model: string, text: string, images: Array<{ mime: string, data: string }>) {
  const started = Date.now(), budgetMs = 110000
  let lastError = 'AI did not answer.', busy = false
  for (const m of [...new Set([model, ...MODEL_FALLBACKS])].filter(Boolean)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (Date.now() - started > budgetMs) break
      let res: Response, out: any
      try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: AI_SYSTEM }] },
            contents: [{ role: 'user', parts: [{ text }, ...images.map((i) => ({ inline_data: { mime_type: i.mime, data: i.data } }))] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
          }),
        })
        out = await res.json().catch(() => ({}))
      } catch { lastError = 'Could not reach Google AI.'; await pause(1500); continue }
      if (res.ok) {
        const answer = (out.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || '').join('').trim()
        if (answer) return { text: answer.slice(0, 6000), model: m }
        lastError = out.candidates?.[0]?.finishReason === 'SAFETY' ? 'The AI declined this question.' : 'The AI returned an empty answer.'
        break
      }
      const msg = String(out.error?.message || '')
      if (res.status === 401 || res.status === 403 || /api key/i.test(msg)) throw new Error('The AI key was rejected. Check the key in Admin → Settings → AI assistant.')
      if (res.status === 404) { lastError = `Model ${m} is not available.`; break }   // try the next model name
      if (res.status === 503 || res.status === 500 || res.status === 504 || res.status === 429) {
        busy = true; lastError = msg || `Google AI is busy (${res.status}).`
        if (attempt === 0) { await pause(res.status === 429 ? 2000 : 3000); continue }
        break // try the next (lighter) model
      }
      if (res.status === 400) throw new Error('The AI could not read this question' + (msg ? ': ' + msg.slice(0, 200) : '.'))
      throw new Error(msg || `AI request failed (${res.status}).`)
    }
  }
  if (busy) throw new Error('Google’s free AI is very busy right now. Please try again in a few minutes.')
  throw new Error(lastError)
}

async function aiDraft(admin: any, user: any, doubtId: string) {
  if (!['TEACHER', 'ADMIN'].includes(user.user_type)) return json({ error: 'Only teachers can use AI drafts.' }, 403)
  if ((await settingValue(admin, 'AI_DOUBT_DRAFTS_ENABLED', 'TRUE')).toUpperCase() !== 'TRUE') return json({ error: 'AI drafts are switched off in Settings.' }, 403)
  const { data: doubt } = await admin.from('doubts').select('*').eq('id', doubtId).maybeSingle()
  if (!doubt) return json({ error: 'Doubt not found.' }, 404)
  if (user.user_type === 'TEACHER') {
    const [{ data: slots }, { data: assigned }] = await Promise.all([
      admin.from('timetable').select('subject_id,co_subject_id').eq('teacher_id', user.linked_id).ilike('status', 'active'),
      admin.from('student_subjects').select('subject_id').eq('teacher_id', user.linked_id).ilike('status', 'active'),
    ])
    const mine = new Set([...(slots || []).flatMap((s: any) => [s.subject_id, s.co_subject_id]), ...(assigned || []).map((s: any) => s.subject_id)].filter(Boolean))
    if (!mine.has(doubt.subject_id)) return json({ error: 'Only teachers of this subject can use AI drafts here.' }, 403)
  } else if (user.role !== 'SUPER_ADMIN') return json({ error: 'Only teachers or the Super Admin can use AI drafts.' }, 403)
  const key = await geminiKey(admin)
  if (!key) return json({ error: 'The AI assistant is not set up yet. Super Admin: add the free Gemini key in Settings → AI assistant.' }, 400)
  const limit = Number.parseInt(await settingValue(admin, 'AI_DAILY_LIMIT', '40'), 10) || 0
  const { data: allowed, error: capError } = await admin.rpc('ai_take', { p_limit: limit })
  if (capError) throw capError
  if (!allowed) return json({ error: `Today's AI limit (${limit} drafts) is reached. It resets at midnight.` }, 429)
  // Only the question goes to the AI: no student name, ID, phone or class roster.
  const { data: subject } = await admin.from('subjects').select('name').eq('id', doubt.subject_id).maybeSingle()
  const text = [`Subject: ${subject?.name || doubt.subject_id}`, `Class: ${doubt.class_name}`, doubt.chapter ? `Chapter/topic: ${doubt.chapter}` : '',
    `Question: ${doubt.title}`, doubt.body ? `Details from the student: ${doubt.body}` : '', 'Photos of the question are attached if any.'].filter(Boolean).join('\n')
  const { data: files } = await admin.from('doubt_files').select('*').eq('doubt_id', doubt.id).is('answer_id', null).is('expired_at', null).order('created_at').limit(3)
  const images: Array<{ mime: string, data: string }> = []
  for (const f of files || []) {
    try { const blob = await photoBlob(admin, f); images.push({ mime: f.mime_type, data: toB64(new Uint8Array(await blob.arrayBuffer())) }) } catch { /* skip unreadable photo */ }
  }
  const model = await settingValue(admin, 'AI_MODEL', 'gemini-flash-latest')
  try {
    const out = await callGemini(key, model, text, images)
    const row = { doubt_id: doubt.id, status: 'OK', body: out.text, model: out.model, error: '', requested_by: String(user.linked_id || user.id), created_at: new Date().toISOString() }
    await admin.from('doubt_ai_drafts').upsert(row, { onConflict: 'doubt_id' })
    return json({ draft: { Body: out.text, Model: out.model, CreatedAt: row.created_at, Photos: images.length } })
  } catch (e) {
    // A failed AI call should not use up one of today's allowed drafts.
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
    const { data: used } = await admin.from('ai_usage').select('calls').eq('day', day).maybeSingle()
    if (used && used.calls > 0) await admin.from('ai_usage').update({ calls: used.calls - 1 }).eq('day', day).eq('calls', used.calls)
    const message = e instanceof Error ? e.message : 'AI draft failed.'
    return json({ error: message }, 502)
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const { admin, auth } = clients()
    if (req.method === 'GET') {
      const user = await signedInUser(req, admin, auth)
      const fileId = new URL(req.url).searchParams.get('file') || ''
      const { data: file } = await admin.from('doubt_files').select('*').eq('id', fileId).maybeSingle()
      if (!file) return json({ error: 'Photo not found.' }, 404)
      const { data: doubt } = await admin.from('doubts').select('*').eq('id', file.doubt_id).maybeSingle()
      const { data: answer } = file.answer_id ? await admin.from('doubt_answers').select('*').eq('id', file.answer_id).maybeSingle() : { data: null }
      if (!doubt || !(await canView(admin, user, doubt, answer))) return json({ error: 'You cannot open this photo.' }, 403)
      if (file.expired_at) return json({ error: 'This photo was removed after 7 days because it could not be saved to Google Drive.' }, 410)
      const blob = await photoBlob(admin, file)
      return new Response(blob, { headers: { ...cors, 'Content-Type': file.mime_type, 'Cache-Control': 'private, max-age=86400' } })
    }

    if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)
    const body = await req.json().catch(() => ({}))

    if (body.action === 'worker') {
      if (req.headers.get('x-archive-secret') !== Deno.env.get('HOMEWORK_ARCHIVE_CRON_SECRET')) return json({ error: 'Unauthorized worker request.' }, 401)
      const { data: files, error } = await admin.from('doubt_files').select('*').not('storage_path', 'is', null).order('created_at').limit(100)
      if (error) throw error
      const primary = await primaryDrive(admin)
      let access = '', folder = '', moved = 0, expired = 0, retained = 0
      if (primary) { try { access = await accessToken(primary); folder = await doubtFolder(admin, primary, access) } catch { access = '' } }
      const cutoff = Date.now() - KEEP_DAYS * 86400000
      for (const file of files || []) {
        try {
          if (!access) throw new Error('No working Google Drive connection.')
          const { data: blob, error: dlError } = await admin.storage.from('doubt-files').download(file.storage_path)
          if (dlError || !blob) throw dlError || new Error('Stored photo missing.')
          const driveId = await uploadDrive(access, `${file.doubt_id}-${file.id}.jpg`, file.mime_type, new Uint8Array(await blob.arrayBuffer()), folder)
          const { error: upError } = await admin.from('doubt_files').update({ drive_file_id: driveId, drive_connection_id: primary.id, storage_path: null, archive_error: null }).eq('id', file.id)
          if (upError) throw upError
          await admin.storage.from('doubt-files').remove([file.storage_path])
          moved++
        } catch (e) {
          if (new Date(file.created_at).getTime() < cutoff) {
            // Free Supabase storage: drop the copy after 7 days even if Drive never accepted it.
            await admin.storage.from('doubt-files').remove([file.storage_path])
            await admin.from('doubt_files').update({ storage_path: null, expired_at: new Date().toISOString(),
              archive_error: String(e instanceof Error ? e.message : e).slice(0, 500) }).eq('id', file.id)
            expired++
          } else {
            await admin.from('doubt_files').update({ archive_error: String(e instanceof Error ? e.message : e).slice(0, 500) }).eq('id', file.id)
            retained++
          }
        }
      }
      return json({ moved, expired, retained })
    }

    if (body.action === 'aiDraft') {
      const user = await signedInUser(req, admin, auth)
      return await aiDraft(admin, user, String(body.doubtId || ''))
    }

    if (body.action === 'upload') {
      const user = await signedInUser(req, admin, auth)
      if (!['STUDENT', 'TEACHER'].includes(user.user_type) || !user.linked_id) return json({ error: 'Only students and teachers can add photos.' }, 403)
      const doubtId = String(body.doubtId || ''), answerId = String(body.answerId || '')
      const mime = String(body.mimeType || '').toLowerCase()
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) return json({ error: 'Photos must be JPG, PNG or WebP.' }, 400)
      let bytes: Uint8Array
      try { bytes = fromB64(String(body.data || '')) } catch { return json({ error: 'The photo could not be read.' }, 400) }
      if (!bytes.length || bytes.length > MAX_BYTES) return json({ error: 'Each photo must be under 3 MB.' }, 400)
      const { data: doubt } = await admin.from('doubts').select('*').eq('id', doubtId).maybeSingle()
      if (!doubt) return json({ error: 'Doubt not found.' }, 404)
      const ownerType = user.user_type as 'STUDENT' | 'TEACHER'
      const freshFor = 60 * 60 * 1000
      if (answerId) {
        const { data: answer } = await admin.from('doubt_answers').select('*').eq('id', answerId).eq('doubt_id', doubtId).maybeSingle()
        if (!answer || answer.author_type !== ownerType || answer.author_id !== user.linked_id) return json({ error: 'You can add photos only to your own answer.' }, 403)
        if (Date.now() - new Date(answer.created_at).getTime() > freshFor) return json({ error: 'Photos can be added only right after posting.' }, 400)
      } else {
        if (ownerType !== 'STUDENT' || doubt.student_id !== user.linked_id) return json({ error: 'You can add photos only to your own doubt.' }, 403)
        if (Date.now() - new Date(doubt.created_at).getTime() > freshFor) return json({ error: 'Photos can be added only right after posting.' }, 400)
      }
      let countQuery = admin.from('doubt_files').select('id', { count: 'exact', head: true }).eq('doubt_id', doubtId)
      countQuery = answerId ? countQuery.eq('answer_id', answerId) : countQuery.is('answer_id', null)
      const { count } = await countQuery
      if ((count || 0) >= MAX_PER_OWNER) return json({ error: `Up to ${MAX_PER_OWNER} photos are allowed.` }, 400)
      const id = `DF-${crypto.randomUUID()}`
      const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg'
      const fileName = `${doubtId}${answerId ? '-' + answerId : ''}-${id.slice(3, 11)}.${ext}`
      const row: Record<string, unknown> = { id, doubt_id: doubtId, answer_id: answerId || null, uploaded_by_type: ownerType,
        uploaded_by_id: user.linked_id, file_name: fileName, mime_type: mime, file_size: bytes.length }
      // Preferred path: straight to Google Drive, no Supabase storage used.
      const primary = await primaryDrive(admin)
      let savedTo = 'drive'
      try {
        if (!primary) throw new Error('No Google Drive account is connected.')
        const access = await accessToken(primary)
        row.drive_file_id = await uploadDrive(access, fileName, mime, bytes, await doubtFolder(admin, primary, access))
        row.drive_connection_id = primary.id
      } catch (e) {
        // Fallback: keep it in Supabase; the hourly worker moves it to Drive (or removes it after 7 days).
        const path = `${doubtId}/${id}.${ext}`
        const { error: upError } = await admin.storage.from('doubt-files').upload(path, bytes, { contentType: mime, upsert: false })
        if (upError) throw upError
        row.storage_path = path
        row.archive_error = String(e instanceof Error ? e.message : e).slice(0, 500)
        savedTo = 'temporary'
      }
      const { error: insertError } = await admin.from('doubt_files').insert(row)
      if (insertError) {
        if (row.storage_path) await admin.storage.from('doubt-files').remove([row.storage_path as string])
        throw insertError
      }
      return json({ FileID: id, savedTo })
    }
    return json({ error: 'Unknown action.' }, 400)
  } catch (error) {
    if (error instanceof Response) return error
    console.error('Doubt photo operation failed:', error)
    return json({ error: error instanceof Error ? error.message : 'Doubt photo operation failed.' }, 500)
  }
})
