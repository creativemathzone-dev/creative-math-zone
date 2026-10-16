import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Use POST.' }), { status: 405, headers: { ...cors, 'Content-Type': 'application/json' } })
  try {
    const url = Deno.env.get('SUPABASE_URL')!
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}')
    if (!url || !keys.default) throw new Error('Supabase secret key is not configured.')
    const admin = createClient(url, keys.default, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: expired, error } = await admin.from('class_materials').select('id,file_path').lte('expires_at', new Date().toISOString()).limit(500)
    if (error) throw error
    if (!expired?.length) return new Response(JSON.stringify({ deleted: 0 }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    const { error: removeError } = await admin.storage.from('class-materials').remove(expired.map((row) => row.file_path))
    if (removeError) throw removeError
    const { error: rowError } = await admin.from('class_materials').delete().in('id', expired.map((row) => row.id))
    if (rowError) throw rowError
    return new Response(JSON.stringify({ deleted: expired.length }), { headers: { ...cors, 'Content-Type': 'application/json' } })
  } catch (error) {
    console.error('Expired class material cleanup failed:', error)
    return new Response(JSON.stringify({ error: 'Cleanup failed.' }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
