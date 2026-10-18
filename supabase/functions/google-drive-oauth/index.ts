import { createClient } from 'npm:@supabase/supabase-js@2'

const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'}
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{...cors,'Content-Type':'application/json'}})
const b64=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes))
function fromB64(text:string){return Uint8Array.from(atob(text),c=>c.charCodeAt(0))}
async function encryptToken(token:string){
  const raw=fromB64(Deno.env.get('GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY')||'')
  if(raw.length!==32)throw new Error('GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.')
  const key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt'])
  const iv=crypto.getRandomValues(new Uint8Array(12))
  const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(token))
  return `${b64(iv)}.${b64(new Uint8Array(cipher))}`
}

Deno.serve(async req=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors})
  const url=Deno.env.get('SUPABASE_URL')||''
  const secret=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}').default
  const publishable=JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS')||'{}').default
  const clientId=Deno.env.get('GOOGLE_DRIVE_CLIENT_ID')||''
  const clientSecret=Deno.env.get('GOOGLE_DRIVE_CLIENT_SECRET')||''
  const redirect=Deno.env.get('GOOGLE_DRIVE_REDIRECT_URI')||''
  try{
    if(req.method==='POST'){
      const token=(req.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'')
      if(!token||!secret||!publishable)return json({error:'Sign in as the Super Admin first.'},401)
      const authClient=createClient(url,publishable,{auth:{persistSession:false,autoRefreshToken:false}})
      const {data:{user:authUser}}=await authClient.auth.getUser(token)
      if(!authUser)return json({error:'Sign in again and retry.'},401)
      const admin=createClient(url,secret,{auth:{persistSession:false,autoRefreshToken:false}})
      const {data:appUser}=await admin.from('app_users').select('id,user_type,role,status').eq('auth_user_id',authUser.id).maybeSingle()
      if(!appUser||appUser.user_type!=='ADMIN'||appUser.role!=='SUPER_ADMIN'||String(appUser.status).toUpperCase()!=='ACTIVE')return json({error:'Only the active Super Admin can connect Google Drive.'},403)
      const body=await req.json().catch(()=>({}))
      const {data:state,error}=await admin.from('google_drive_oauth_states').select('state').eq('state',String(body.state||'')).eq('app_user_id',appUser.id).gt('created_at',new Date(Date.now()-10*60*1000).toISOString()).maybeSingle()
      if(error||!state)return json({error:'The Google connection request expired. Start again from Settings.'},400)
      const exchange=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code:String(body.code||''),client_id:clientId,client_secret:clientSecret,redirect_uri:redirect,grant_type:'authorization_code'})})
      const tokens=await exchange.json()
      if(!exchange.ok||!tokens.refresh_token)throw new Error(tokens.error_description||'Google did not return a refresh token. Please retry and approve access.')
      const profileResponse=await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:`Bearer ${tokens.access_token}`}})
      const profile=await profileResponse.json()
      if(!profile.email)throw new Error('Google did not return an account email.')
      const encrypted=await encryptToken(tokens.refresh_token)
      await admin.from('google_drive_oauth_states').delete().eq('state',String(body.state))
      const {data:oldPrimary}=await admin.from('google_drive_connections').select('id').eq('is_primary',true).is('disconnected_at',null).maybeSingle()
      const {data:newConnection,error:insertError}=await admin.from('google_drive_connections').insert({account_email:profile.email,refresh_token_ciphertext:encrypted,connected_by:appUser.id,is_primary:false}).select('id').single()
      if(insertError)throw insertError
      if(oldPrimary){const {error:oldError}=await admin.from('google_drive_connections').update({is_primary:false}).eq('id',oldPrimary.id);if(oldError){await admin.from('google_drive_connections').delete().eq('id',newConnection.id);throw oldError}}
      const {error:promoteError}=await admin.from('google_drive_connections').update({is_primary:true}).eq('id',newConnection.id)
      if(promoteError){if(oldPrimary)await admin.from('google_drive_connections').update({is_primary:true}).eq('id',oldPrimary.id);await admin.from('google_drive_connections').delete().eq('id',newConnection.id);throw promoteError}
      return json({connected:true,email:profile.email})
    }
    if(req.method==='GET'){
      const params=new URL(req.url).searchParams
      const state=params.get('state')||'', code=params.get('code')||''
      const admin=createClient(url,secret,{auth:{persistSession:false,autoRefreshToken:false}})
      const {data:pending}=await admin.from('google_drive_oauth_states').select('state').eq('state',state).gt('created_at',new Date(Date.now()-10*60*1000).toISOString()).maybeSingle()
      if(!pending||!code)throw new Error('Google authorization expired or was cancelled. Start again from Admin Settings.')
      const redirectTo=Deno.env.get('GOOGLE_DRIVE_CONNECT_RETURN_URL')||'https://creativemathzone.in/web/admin.html'
      return Response.redirect(`${redirectTo}?drive_code=${encodeURIComponent(code)}&drive_state=${encodeURIComponent(state)}`,303)
    }
    return json({error:'Use GET for the OAuth callback or POST to complete it.'},405)
  }catch(error){
    console.error('Google Drive OAuth error:',error)
    return json({error:error instanceof Error?error.message:'Google Drive connection failed.'},500)
  }
})
