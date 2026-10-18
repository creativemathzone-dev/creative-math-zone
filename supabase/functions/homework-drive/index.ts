import { createClient } from 'npm:@supabase/supabase-js@2'

const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, apikey, content-type, x-archive-secret','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Expose-Headers':'Content-Disposition'}
const enc=new TextEncoder()
const b64=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes))
const fromB64=(text:string)=>Uint8Array.from(atob(text),c=>c.charCodeAt(0))
function clients(){
  const url=Deno.env.get('SUPABASE_URL')||''
  const keys=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}')
  const pub=JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS')||'{}')
  if(!url||!keys.default||!pub.default)throw new Error('Supabase keys are not configured.')
  return {url,admin:createClient(url,keys.default,{auth:{persistSession:false,autoRefreshToken:false}}),auth:createClient(url,pub.default,{auth:{persistSession:false,autoRefreshToken:false}})}
}
async function cryptoKey(usages:KeyUsage[]){
  const raw=fromB64(Deno.env.get('GOOGLE_DRIVE_TOKEN_ENCRYPTION_KEY')||'')
  if(raw.length!==32)throw new Error('Google Drive token encryption key is not configured.')
  return await crypto.subtle.importKey('raw',raw,'AES-GCM',false,usages)
}
async function decryptToken(value:string){
  const [iv,cipher]=value.split('.')
  return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:fromB64(iv)},await cryptoKey(['decrypt']),fromB64(cipher)))
}
async function accessToken(connection:any){
  const refresh=await decryptToken(connection.refresh_token_ciphertext)
  const res=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:Deno.env.get('GOOGLE_DRIVE_CLIENT_ID')||'',client_secret:Deno.env.get('GOOGLE_DRIVE_CLIENT_SECRET')||'',refresh_token:refresh,grant_type:'refresh_token'})})
  const body=await res.json()
  if(!res.ok||!body.access_token)throw new Error(body.error_description||'Could not refresh the Google Drive connection.')
  return body.access_token as string
}
async function uploadDrive(access:string,fileName:string,mime:string,bytes:Uint8Array,folderId?:string|null){
  const metadata:any={name:fileName,mimeType:mime}
  if(folderId)metadata.parents=[folderId]
  const boundary=`cmz_${crypto.randomUUID().replaceAll('-','')}`
  const prefix=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`
  const suffix=`\r\n--${boundary}--`
  const body=new Blob([enc.encode(prefix),bytes,enc.encode(suffix)])
  const res=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink',{method:'POST',headers:{Authorization:`Bearer ${access}`,'Content-Type':`multipart/related; boundary=${boundary}`},body})
  const result=await res.json()
  if(!res.ok||!result.id)throw new Error(result.error?.message||'Google Drive upload failed.')
  return result
}
async function ensureFolder(admin:any,connection:any,access:string){
  if(connection.drive_folder_id)return connection.drive_folder_id
  const response=await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name',{method:'POST',headers:{Authorization:`Bearer ${access}`,'Content-Type':'application/json'},body:JSON.stringify({name:'Creative Math Zone Homework Archive',mimeType:'application/vnd.google-apps.folder'})})
  const made=await response.json()
  if(!response.ok||!made.id)throw new Error(made.error?.message||'Could not create the homework archive folder in Google Drive.')
  const {error}=await admin.from('google_drive_connections').update({drive_folder_id:made.id}).eq('id',connection.id)
  if(error)throw error
  return made.id
}
async function authorizedUser(req:Request,admin:any,auth:any){
  const token=(req.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'')
  if(!token)throw new Response(JSON.stringify({error:'Sign-in required.'}),{status:401})
  const {data:{user:authUser}}=await auth.auth.getUser(token)
  if(!authUser)throw new Response(JSON.stringify({error:'Sign-in expired.'}),{status:401})
  const {data:user}=await admin.from('app_users').select('id,user_type,role,linked_id,status').eq('auth_user_id',authUser.id).maybeSingle()
  if(!user||String(user.status).toUpperCase()!=='ACTIVE')throw new Response(JSON.stringify({error:'Account is not active.'}),{status:403})
  return user
}
function json(data:unknown,status=200){return new Response(JSON.stringify(data),{status,headers:{...cors,'Content-Type':'application/json'}})}

Deno.serve(async req=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors})
  try{
    const {admin,auth}=clients()
    if(req.method==='POST'){
      const body=await req.json().catch(()=>({}))
      if(body.action==='delete'){
        const user=await authorizedUser(req,admin,auth),fileId=String(body.fileId||'')
        const {data:file}=await admin.from('homework_files').select('*').eq('id',fileId).maybeSingle()
        if(!file)return json({error:'File not found.'},404)
        const {data:hw}=await admin.from('homework').select('id,teacher_id').eq('id',file.homework_id).maybeSingle()
        if(!hw)return json({error:'Homework not found.'},404)
        const allowed=(user.user_type==='ADMIN'&&user.role==='SUPER_ADMIN')||
          (user.user_type==='TEACHER'&&hw.teacher_id===user.linked_id)||
          (user.user_type==='STUDENT'&&file.uploaded_by_type==='STUDENT'&&file.uploaded_by_id===user.linked_id)
        if(!allowed)return json({error:'You cannot delete this homework file.'},403)
        if(file.drive_file_id&&file.drive_connection_id){
          const {data:connection}=await admin.from('google_drive_connections').select('*').eq('id',file.drive_connection_id).maybeSingle()
          if(!connection)return json({error:'The archive Drive account is unavailable; file record was kept.'},410)
          const access=await accessToken(connection),removed=await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.drive_file_id)}`,{method:'DELETE',headers:{Authorization:`Bearer ${access}`}})
          if(!removed.ok&&removed.status!==404)throw new Error('Google Drive could not delete this archive; the app copy was retained.')
        }
        if(file.file_path){const {error}=await admin.storage.from('homework-files').remove([file.file_path]);if(error)throw error}
        const {error}=await admin.from('homework_files').delete().eq('id',fileId)
        if(error)throw error
        return json({deleted:true})
      }
      if(body.action==='transfer'){
        const user=await authorizedUser(req,admin,auth)
        if(user.user_type!=='ADMIN'||user.role!=='SUPER_ADMIN')return json({error:'Only the Super Admin can transfer archived files.'},403)
        const targetId=String(body.targetConnectionId||'')
        const {data:target}=await admin.from('google_drive_connections').select('*').eq('id',targetId).eq('is_primary',true).is('disconnected_at',null).maybeSingle()
        if(!target)return json({error:'The selected Drive account is not the active destination.'},400)
        const sourceId=String(body.sourceConnectionId||'')
        const {data:files,error}=await admin.from('homework_files').select('id,file_name,mime_type,drive_file_id,drive_connection_id').eq('drive_connection_id',sourceId).not('drive_file_id','is',null).limit(50)
        if(error)throw error
        const {data:source}=await admin.from('google_drive_connections').select('*').eq('id',sourceId).maybeSingle()
        if(!source)return json({error:'The old Drive connection was not found.'},404)
        const oldAccess=await accessToken(source),newAccess=await accessToken(target),folder=await ensureFolder(admin,target,newAccess)
        let moved=0
        for(const f of files||[]){
          const get=await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(f.drive_file_id)}?alt=media`,{headers:{Authorization:`Bearer ${oldAccess}`}})
          if(!get.ok)throw new Error(`Could not read archived file ${f.file_name} from the previous Drive account.`)
          const data=new Uint8Array(await get.arrayBuffer()),copy=await uploadDrive(newAccess,f.file_name,f.mime_type,data,folder)
          const {error:updateError}=await admin.from('homework_files').update({drive_file_id:copy.id,drive_connection_id:target.id,archive_error:null}).eq('id',f.id)
          if(updateError){await fetch(`https://www.googleapis.com/drive/v3/files/${copy.id}`,{method:'DELETE',headers:{Authorization:`Bearer ${newAccess}`}});throw updateError}
          await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(f.drive_file_id)}`,{method:'DELETE',headers:{Authorization:`Bearer ${oldAccess}`}})
          moved++
        }
        const {count:remaining,error:countError}=await admin.from('homework_files').select('id',{count:'exact',head:true}).eq('drive_connection_id',sourceId).not('drive_file_id','is',null)
        if(countError)throw countError
        if(!remaining)await admin.from('google_drive_connections').update({is_primary:false,disconnected_at:new Date().toISOString(),refresh_token_ciphertext:''}).eq('id',sourceId)
        return json({transferred:moved,remaining:remaining||0,disconnected:!remaining})
      }
      if(req.headers.get('x-archive-secret')!==Deno.env.get('HOMEWORK_ARCHIVE_CRON_SECRET'))return json({error:'Unauthorized worker request.'},401)
      const {data:primary,error:primaryError}=await admin.from('google_drive_connections').select('*').eq('is_primary',true).is('disconnected_at',null).maybeSingle()
      if(primaryError)throw primaryError
      if(!primary)return json({archived:0,retained:0,reason:'No Google Drive account is connected.'})
      const {data:homework,error:hwError}=await admin.from('homework').select('id,due_at').not('due_at','is',null).lte('due_at',new Date().toISOString()).limit(200)
      if(hwError)throw hwError
      const ids=(homework||[]).map((x)=>x.id)
      if(!ids.length)return json({archived:0,retained:0})
      const {data:files,error:fileError}=await admin.from('homework_files').select('*').in('homework_id',ids).is('archived_at',null).limit(100)
      if(fileError)throw fileError
      if(!files?.length)return json({archived:0,retained:0})
      const access=await accessToken(primary),folder=await ensureFolder(admin,primary,access)
      let archived=0,retained=0
      for(const file of files){
        try{
          let driveId=file.drive_file_id
          if(!driveId){
            const {data:blob,error:downloadError}=await admin.storage.from('homework-files').download(file.file_path)
            if(downloadError||!blob)throw downloadError||new Error('Supabase file was not found.')
            const created=await uploadDrive(access,file.file_name,file.mime_type,new Uint8Array(await blob.arrayBuffer()),folder)
            driveId=created.id
            const {error:recordError}=await admin.from('homework_files').update({drive_file_id:driveId,drive_connection_id:primary.id,archive_error:null}).eq('id',file.id)
            if(recordError)throw recordError
          }
          const {error:removeError}=await admin.storage.from('homework-files').remove([file.file_path])
          if(removeError)throw removeError
          const {error:finishError}=await admin.from('homework_files').update({archived_at:new Date().toISOString(),drive_connection_id:primary.id,archive_error:null}).eq('id',file.id)
          if(finishError)throw finishError
          archived++
        }catch(error){
          retained++
          await admin.from('homework_files').update({archive_error:String(error instanceof Error?error.message:'Archive failed.').slice(0,500)}).eq('id',file.id)
        }
      }
      return json({archived,retained})
    }
    if(req.method==='GET'){
      const user=await authorizedUser(req,admin,auth),fileId=new URL(req.url).searchParams.get('file')||''
      const {data:file}=await admin.from('homework_files').select('*').eq('id',fileId).maybeSingle()
      if(!file)return json({error:'File not found.'},404)
      const {data:hw}=await admin.from('homework').select('id,teacher_id,batch_id').eq('id',file.homework_id).maybeSingle()
      if(!hw)return json({error:'Homework not found.'},404)
      let allowed=user.user_type==='ADMIN'&&user.role==='SUPER_ADMIN'
      if(user.user_type==='TEACHER'&&hw.teacher_id===user.linked_id)allowed=true
      if(user.user_type==='STUDENT'){
        if(file.uploaded_by_type==='STUDENT'&&file.uploaded_by_id===user.linked_id)allowed=true
        if(file.uploaded_by_type==='TEACHER'){
          const {data:student}=await admin.from('students').select('current_batch_id').eq('id',user.linked_id).maybeSingle()
          const {data:assignments}=await admin.from('student_subjects').select('batch_id').eq('student_id',user.linked_id).ilike('status','active')
          if([student?.current_batch_id,...(assignments||[]).map((x)=>x.batch_id)].includes(hw.batch_id))allowed=true
        }
      }
      if(!allowed)return json({error:'You cannot access this homework file.'},403)
      let blob:Blob
      if(file.drive_file_id&&file.drive_connection_id){
        const {data:connection}=await admin.from('google_drive_connections').select('*').eq('id',file.drive_connection_id).maybeSingle()
        if(!connection)return json({error:'The archive Drive account is unavailable.'},410)
        const access=await accessToken(connection)
        const result=await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.drive_file_id)}?alt=media`,{headers:{Authorization:`Bearer ${access}`}})
        if(!result.ok)throw new Error('Could not retrieve the archived file from Google Drive.')
        blob=await result.blob()
      }else{
        const {data,error}=await admin.storage.from('homework-files').download(file.file_path)
        if(error||!data)throw error||new Error('Stored file not found.')
        blob=data
      }
      const safeName=String(file.file_name).replace(/["\r\n]/g,'_')
      return new Response(blob,{headers:{...cors,'Content-Type':file.mime_type,'Content-Length':String(blob.size),'Content-Disposition':`attachment; filename="${safeName}"`,'Cache-Control':'private, no-store'}})
    }
    return json({error:'Use GET for file downloads or POST for archive jobs.'},405)
  }catch(error){
    if(error instanceof Response)return error
    console.error('Homework Drive operation failed:',error)
    return json({error:error instanceof Error?error.message:'Homework Drive operation failed.'},500)
  }
})
