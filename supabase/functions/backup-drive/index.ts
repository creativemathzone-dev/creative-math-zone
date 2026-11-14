import { createClient } from 'npm:@supabase/supabase-js@2'

// Free weekly database backup to the centre's connected Google Drive.
//  POST {action:'scheduled'} – from pg_cron (private secret), every Sunday 2 AM.
//  POST {action:'run'}       – Super Admin "Back up now".
//  POST {action:'list'}      – Super Admin: recent backups.
//  GET  ?run=ID              – Super Admin: download a backup (.json.gz).
// Each backup is one gzip-compressed JSON file containing every table's rows.
// The newest KEEP backups are kept in Drive; older ones are deleted.

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-archive-secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Expose-Headers': 'Content-Disposition' }
const KEEP = 8
const enc = new TextEncoder()
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
async function backupFolder(admin: any, connection: any, access: string) {
  if (connection.backup_folder_id) return connection.backup_folder_id as string
  const res = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Creative Math Zone Backups', mimeType: 'application/vnd.google-apps.folder' }) })
  const made = await res.json()
  if (!res.ok || !made.id) throw new Error(made.error?.message || 'Could not create the backup folder in Google Drive.')
  await admin.from('google_drive_connections').update({ backup_folder_id: made.id }).eq('id', connection.id)
  return made.id as string
}
async function gzip(text: string) {
  const stream = new Blob([enc.encode(text)]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
async function superAdmin(req: Request, admin: any, auth: any) {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  if (!token) throw json({ error: 'Sign-in required.' }, 401)
  const { data: { user: authUser } } = await auth.auth.getUser(token)
  if (!authUser) throw json({ error: 'Sign-in expired. Sign in again.' }, 401)
  const { data: user } = await admin.from('app_users').select('id,user_type,role,status').eq('auth_user_id', authUser.id).maybeSingle()
  if (!user || String(user.status).toUpperCase() !== 'ACTIVE' || user.user_type !== 'ADMIN' || user.role !== 'SUPER_ADMIN') throw json({ error: 'Only the Super Admin can manage backups.' }, 403)
  if (!await adminUnlocked(admin, authUser.id, token)) throw json({ error: 'Enter your admin PIN first (sign in again).' }, 401)
  return user
}

async function runBackup(admin: any, trigger: 'SCHEDULED' | 'MANUAL') {
  const { data: run, error: runError } = await admin.from('backup_runs').insert({ trigger }).select('id').single()
  if (runError) throw runError
  try {
    const { data: primary } = await admin.from('google_drive_connections').select('*').eq('is_primary', true).is('disconnected_at', null).maybeSingle()
    if (!primary) throw new Error('No Google Drive account is connected. Connect one in Settings → Homework file archive.')
    const { data: names, error: namesError } = await admin.rpc('backup_table_names')
    if (namesError) throw namesError
    const tables: Record<string, unknown[]> = {}
    let rows = 0
    for (const raw of names || []) {
      const name = typeof raw === 'string' ? raw : Object.values(raw as Record<string, string>)[0]
      const { data, error } = await admin.rpc('backup_export_table', { p_table: name })
      if (error) throw new Error(`Could not export ${name}: ${error.message}`)
      tables[name] = Array.isArray(data) ? data : []
      rows += tables[name].length
    }
    const stamp = new Date().toISOString()
    const istDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
    const bytes = await gzip(JSON.stringify({ format: 'cmz-backup-v1', createdAt: stamp, project: 'krjkkkwxqvvxeifxmgjx',
      note: 'Rows of every app table. Login passwords are not included (they live in Supabase Auth); users can reset them after a restore.',
      tables }))
    const fileName = `cmz-backup-${istDate}-${run.id.slice(0, 8)}.json.gz`
    const access = await accessToken(primary)
    const folder = await backupFolder(admin, primary, access)
    const boundary = `cmz_${crypto.randomUUID().replaceAll('-', '')}`
    const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: fileName, mimeType: 'application/gzip', parents: [folder] })}\r\n--${boundary}\r\nContent-Type: application/gzip\r\n\r\n`
    const up = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: new Blob([enc.encode(head), bytes as Uint8Array<ArrayBuffer>, enc.encode(`\r\n--${boundary}--`)]) })
    const made = await up.json()
    if (!up.ok || !made.id) throw new Error(made.error?.message || 'Google Drive upload failed.')
    await admin.from('backup_runs').update({ status: 'OK', finished_at: new Date().toISOString(), file_name: fileName, drive_file_id: made.id,
      drive_connection_id: primary.id, size_bytes: bytes.length, table_count: Object.keys(tables).length, row_count: rows }).eq('id', run.id)
    // Keep only the newest KEEP successful backups in Drive.
    const { data: old } = await admin.from('backup_runs').select('id,drive_file_id').eq('status', 'OK').not('drive_file_id', 'is', null)
      .eq('drive_connection_id', primary.id).order('started_at', { ascending: false }).range(KEEP, KEEP + 50)
    for (const o of old || []) {
      const del = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(o.drive_file_id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${access}` } })
      if (del.ok || del.status === 404) await admin.from('backup_runs').update({ drive_file_id: null }).eq('id', o.id)
    }
    return { ok: true, fileName, sizeBytes: bytes.length, tables: Object.keys(tables).length, rows }
  } catch (e) {
    const message = String(e instanceof Error ? e.message : e).slice(0, 500)
    await admin.from('backup_runs').update({ status: 'FAILED', finished_at: new Date().toISOString(), error: message }).eq('id', run.id)
    return { ok: false, error: message }
  }
}

// Admin PIN lock (same rule as the main API): an admin who set a PIN must have entered it
// for this sign-in session. If the SQL is not installed yet, no PINs exist, so allow.
async function adminUnlocked(admin: any, authUserId: string, token: string) {
  let sid = ''
  try { const b = token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'); sid = String(JSON.parse(atob(b.padEnd(Math.ceil(b.length / 4) * 4, '='))).session_id || '') } catch { /* no session id */ }
  const { data, error } = await admin.rpc('admin_session_ok', { p_auth_user: authUserId, p_session: sid })
  if (error) return /admin_session_ok|does not exist|schema cache/i.test(String(error.message || ''))
  return data !== false
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const { admin, auth } = clients()
    if (req.method === 'GET') {
      await superAdmin(req, admin, auth)
      const id = new URL(req.url).searchParams.get('run') || ''
      const { data: run } = await admin.from('backup_runs').select('*').eq('id', id).maybeSingle()
      if (!run || !run.drive_file_id || !run.drive_connection_id) return json({ error: 'This backup is no longer in Google Drive.' }, 404)
      const { data: connection } = await admin.from('google_drive_connections').select('*').eq('id', run.drive_connection_id).maybeSingle()
      if (!connection) return json({ error: 'That Google Drive account is no longer connected.' }, 410)
      let access = ''
      try { if (connection.refresh_token_ciphertext && !connection.disconnected_at) access = await accessToken(connection) } catch { access = '' }
      if (!access) {
        // Old login expired: use the current login of the same Google account.
        const { data: current } = await admin.from('google_drive_connections').select('*').eq('is_primary', true).is('disconnected_at', null).maybeSingle()
        if (!current || String(current.account_email).toLowerCase() !== String(connection.account_email).toLowerCase())
          return json({ error: 'The Google Drive login for this backup has expired. Reconnect Google Drive in Settings.' }, 410)
        access = await accessToken(current)
        await admin.from('backup_runs').update({ drive_connection_id: current.id }).eq('id', run.id)
      }
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(run.drive_file_id)}?alt=media`, { headers: { Authorization: `Bearer ${access}` } })
      if (!res.ok) return json({ error: 'Could not download the backup from Google Drive.' }, 502)
      return new Response(await res.blob(), { headers: { ...cors, 'Content-Type': 'application/gzip', 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${String(run.file_name).replace(/["\r\n]/g, '_')}"` } })
    }
    if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)
    const body = await req.json().catch(() => ({}))
    if (body.action === 'scheduled') {
      const secret = Deno.env.get('HOMEWORK_ARCHIVE_CRON_SECRET')
      if (!secret || req.headers.get('x-archive-secret') !== secret) return json({ error: 'Unauthorized scheduled job.' }, 401)
      const { data: flag } = await admin.from('settings').select('value').eq('setting_key', 'AUTO_BACKUP_ENABLED').maybeSingle()
      if (String(flag?.value || 'TRUE').toUpperCase() !== 'TRUE') return json({ skipped: 'AUTO_BACKUP_ENABLED is FALSE' })
      return json(await runBackup(admin, 'SCHEDULED'))
    }
    if (body.action === 'run') {
      await superAdmin(req, admin, auth)
      const result = await runBackup(admin, 'MANUAL')
      return json(result, result.ok ? 200 : 500)
    }
    if (body.action === 'list') {
      await superAdmin(req, admin, auth)
      const { data, error } = await admin.from('backup_runs').select('id,started_at,finished_at,status,trigger,file_name,drive_file_id,size_bytes,table_count,row_count,error')
        .order('started_at', { ascending: false }).limit(12)
      if (error) throw error
      return json({ runs: (data || []).map((r: any) => ({ ...r, in_drive: !!r.drive_file_id, drive_file_id: undefined })) })
    }
    return json({ error: 'Unknown action.' }, 400)
  } catch (error) {
    if (error instanceof Response) return error
    console.error('Backup operation failed:', error)
    return json({ error: error instanceof Error ? error.message : 'Backup operation failed.' }, 500)
  }
})
