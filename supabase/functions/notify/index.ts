import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

// Free reminders: Web Push to the student app + a WhatsApp list for the office.
//  GET  ?vapid=1            – public key the browser needs to subscribe (no login).
//  POST {action:'fees'}     – pg_cron daily 9 AM: fee reminders (3 days before, due day, weekly overdue).
//  POST {action:'absent'}   – pg_cron every 10 min: absent alerts for recently closed classes.
//  POST {action:'test'}     – signed-in user: send a test notification to their own devices.

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-archive-secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
const STUDENT_URL = 'https://creativemathzone.in/web/student.html'

function clients() {
  const url = Deno.env.get('SUPABASE_URL') || ''
  const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}')
  const pub = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}')
  if (!url || !keys.default || !pub.default) throw new Error('Supabase keys are not configured.')
  return { admin: createClient(url, keys.default, { auth: { persistSession: false, autoRefreshToken: false } }),
    auth: createClient(url, pub.default, { auth: { persistSession: false, autoRefreshToken: false } }) }
}
function istDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d)
}
const shown = (v: string) => /^\d{4}-\d{2}-\d{2}/.test(v) ? `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}` : v
const money = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN')
const monthName = (m: string) => /^\d{4}-\d{2}$/.test(m)
  ? new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric' }).format(new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1)) : m
const hm = (t: string) => { const h = Number(String(t).slice(0, 2)), m = String(t).slice(3, 5); return Number.isFinite(h) ? `${(h % 12) || 12}:${m} ${h < 12 ? 'AM' : 'PM'}` : '' }
const phoneOf = (s: any) => String(s.parent_whatsapp || s.parent_mobile || s.mobile || '').replace(/\D/g, '').slice(-10)

async function vapidKeys(admin: any) {
  const read = async () => {
    const { data } = await admin.from('app_secrets').select('key,value').in('key', ['VAPID_PUBLIC', 'VAPID_PRIVATE'])
    const m = Object.fromEntries((data || []).map((r: any) => [r.key, r.value]))
    return m.VAPID_PUBLIC && m.VAPID_PRIVATE ? { publicKey: m.VAPID_PUBLIC as string, privateKey: m.VAPID_PRIVATE as string } : null
  }
  const have = await read()
  if (have) return have
  const made = webpush.generateVAPIDKeys()
  await admin.from('app_secrets').upsert([{ key: 'VAPID_PUBLIC', value: made.publicKey }, { key: 'VAPID_PRIVATE', value: made.privateKey }],
    { onConflict: 'key', ignoreDuplicates: true })
  return (await read())!
}

async function pushTo(admin: any, subs: any[], payload: Record<string, unknown>) {
  if (!subs.length) return { devices: 0, delivered: 0 }
  const keys = await vapidKeys(admin)
  let delivered = 0
  for (const s of subs) {
    try {
      const d = webpush.generateRequestDetails({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload),
        { vapidDetails: { subject: 'https://creativemathzone.in', publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 2 * 86400, urgency: 'normal' })
      const res = await fetch(d.endpoint, { method: d.method, headers: d.headers as Record<string, string>, body: d.body as unknown as BodyInit })
      if (res.ok) { delivered++; await admin.from('push_subscriptions').update({ last_success_at: new Date().toISOString(), fail_count: 0 }).eq('id', s.id) }
      else if (res.status === 404 || res.status === 410) await admin.from('push_subscriptions').delete().eq('id', s.id) // phone unsubscribed
      else await admin.from('push_subscriptions').update({ fail_count: (s.fail_count || 0) + 1 }).eq('id', s.id)
    } catch {
      await admin.from('push_subscriptions').update({ fail_count: (s.fail_count || 0) + 1 }).eq('id', s.id)
    }
  }
  return { devices: subs.length, delivered }
}

async function enabled(admin: any, key: string) {
  const { data } = await admin.from('settings').select('value').eq('setting_key', key).maybeSingle()
  return String(data?.value || 'TRUE').toUpperCase() === 'TRUE'
}
async function centreName(admin: any) {
  const { data } = await admin.from('settings').select('value').eq('setting_key', 'CENTRE_NAME').maybeSingle()
  return String(data?.value || 'Creative Math Zone')
}

// Insert new reminders (duplicates are ignored), then push each new one to the student's phones.
async function deliver(admin: any, rows: any[]) {
  if (!rows.length) return { created: 0, pushed: 0 }
  const { data: created, error } = await admin.from('reminder_log').upsert(rows, { onConflict: 'kind,ref_id,student_id,stage', ignoreDuplicates: true }).select('*')
  if (error) throw error
  const studentIds = [...new Set((created || []).map((r: any) => r.student_id))]
  const { data: subs } = studentIds.length
    ? await admin.from('push_subscriptions').select('*').in('student_id', studentIds).lt('fail_count', 10) : { data: [] }
  let pushed = 0
  for (const r of created || []) {
    const mine = (subs || []).filter((s: any) => s.student_id === r.student_id)
    const out = await pushTo(admin, mine, { title: r.title, body: r.message, url: STUDENT_URL, tag: `${r.kind}-${r.ref_id}` })
    if (out.devices) await admin.from('reminder_log').update({ push_devices: out.devices, push_delivered: out.delivered }).eq('id', r.id)
    pushed += out.delivered
  }
  return { created: (created || []).length, pushed }
}

async function feeReminders(admin: any) {
  if (!(await enabled(admin, 'FEE_REMINDERS_ENABLED'))) return { skipped: 'FEE_REMINDERS_ENABLED is FALSE' }
  const today = istDate(), centre = await centreName(admin)
  const { data: invoices, error } = await admin.from('invoices').select('id,student_id,month,total_amount,paid_amount,due_date,status')
    .not('due_date', 'is', null).neq('status', 'CANCELLED').gte('due_date', istDate(-400)).lte('due_date', istDate(3))
  if (error) throw error
  const due: any[] = []
  for (const inv of invoices || []) {
    const balance = Math.max(0, Number(inv.total_amount) - Number(inv.paid_amount))
    if (balance < 1) continue
    const days = Math.round((Date.parse(today) - Date.parse(String(inv.due_date))) / 86400000)
    const stage = days === -3 ? 'BEFORE_3' : days === 0 ? 'DUE' : days > 0 && days % 7 === 0 ? `OVERDUE_W${days / 7}` : ''
    if (stage) due.push({ inv, balance, stage })
  }
  if (!due.length) return { created: 0, pushed: 0 }
  const { data: students } = await admin.from('students').select('id,name,status,mobile,parent_mobile,parent_whatsapp')
    .in('id', [...new Set(due.map((x) => x.inv.student_id))])
  const byId = new Map((students || []).map((s: any) => [s.id, s]))
  const rows = due.flatMap(({ inv, balance, stage }) => {
    const st: any = byId.get(inv.student_id)
    if (!st || String(st.status).toUpperCase() !== 'ACTIVE') return []
    const what = `the ${monthName(inv.month)} fee of ${money(balance)} for ${st.name}`
    const message = stage === 'BEFORE_3' ? `Dear Parent, ${what} is due on ${shown(inv.due_date)}. You can pay by UPI from the student app or at the centre. – ${centre}`
      : stage === 'DUE' ? `Dear Parent, ${what} is due today (${shown(inv.due_date)}). Please pay by UPI from the student app or at the centre. – ${centre}`
      : `Dear Parent, ${what} was due on ${shown(inv.due_date)} and is still pending. Kindly pay at the earliest. Ignore if already paid. – ${centre}`
    const phone = phoneOf(st)
    return [{ kind: 'FEE', student_id: st.id, ref_id: inv.id, stage, title: stage.startsWith('OVERDUE') ? 'Fee overdue' : 'Fee reminder',
      message, phone, whatsapp_status: phone.length === 10 ? 'PENDING' : 'NO_PHONE' }]
  })
  return await deliver(admin, rows)
}

async function absentAlerts(admin: any) {
  if (!(await enabled(admin, 'ABSENT_ALERTS_ENABLED'))) return { skipped: 'ABSENT_ALERTS_ENABLED is FALSE' }
  const since = new Date(Date.now() - 6 * 3600000).toISOString()
  const { data: sessions, error } = await admin.from('class_sessions').select('id,session_date,start_time,end_time,subject_id,co_subject_id,status,closed_at')
    .ilike('status', 'closed').gte('closed_at', since).gte('session_date', istDate(-1))
  if (error) throw error
  if (!sessions?.length) return { created: 0, pushed: 0 }
  const { data: absences, error: aError } = await admin.from('attendance').select('session_id,student_id,subject_id,status')
    .in('session_id', sessions.map((s: any) => s.id)).eq('status', 'ABSENT')
  if (aError) throw aError
  if (!absences?.length) return { created: 0, pushed: 0 }
  const centre = await centreName(admin)
  const [{ data: students }, { data: subjects }] = await Promise.all([
    admin.from('students').select('id,name,status,mobile,parent_mobile,parent_whatsapp').in('id', [...new Set(absences.map((a: any) => a.student_id))]),
    admin.from('subjects').select('id,name'),
  ])
  const st = new Map((students || []).map((s: any) => [s.id, s])), su = new Map((subjects || []).map((s: any) => [s.id, s.name]))
  const se = new Map(sessions.map((s: any) => [s.id, s]))
  const rows = absences.flatMap((a: any) => {
    const s: any = st.get(a.student_id), c: any = se.get(a.session_id)
    if (!s || !c || String(s.status).toUpperCase() !== 'ACTIVE') return []
    const subject = su.get(a.subject_id) || su.get(c.subject_id) || 'class'
    const message = `Dear Parent, ${s.name} was absent from the ${subject} class on ${shown(c.session_date)} (${hm(c.start_time)}–${hm(c.end_time)}). Please contact the centre if this is not correct. – ${centre}`
    const phone = phoneOf(s)
    return [{ kind: 'ABSENT', student_id: s.id, ref_id: c.id, stage: 'ABSENT', title: 'Absent today', message, phone,
      whatsapp_status: phone.length === 10 ? 'PENDING' : 'NO_PHONE' }]
  })
  return await deliver(admin, rows)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const { admin, auth } = clients()
    if (req.method === 'GET') {
      if (new URL(req.url).searchParams.get('vapid')) return json({ publicKey: (await vapidKeys(admin)).publicKey })
      return json({ error: 'Not found.' }, 404)
    }
    if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)
    const body = await req.json().catch(() => ({}))
    if (body.action === 'fees' || body.action === 'absent') {
      const secret = Deno.env.get('HOMEWORK_ARCHIVE_CRON_SECRET')
      if (!secret || req.headers.get('x-archive-secret') !== secret) return json({ error: 'Unauthorized scheduled job.' }, 401)
      return json(body.action === 'fees' ? await feeReminders(admin) : await absentAlerts(admin))
    }
    if (body.action === 'test') {
      const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
      const { data: { user: authUser } } = token ? await auth.auth.getUser(token) : { data: { user: null } }
      if (!authUser) return json({ error: 'Sign in again.' }, 401)
      const { data: user } = await admin.from('app_users').select('id').eq('auth_user_id', authUser.id).maybeSingle()
      if (!user) return json({ error: 'Account not found.' }, 403)
      const { data: subs } = await admin.from('push_subscriptions').select('*').eq('app_user_id', user.id)
      const out = await pushTo(admin, subs || [], { title: 'Notifications are on ✓', body: 'You will get fee reminders and absent alerts from Creative Math Zone here.', url: STUDENT_URL, tag: 'test' })
      return json(out)
    }
    return json({ error: 'Unknown action.' }, 400)
  } catch (error) {
    console.error('Notify failed:', error)
    return json({ error: error instanceof Error ? error.message : 'Notify failed.' }, 500)
  }
})
