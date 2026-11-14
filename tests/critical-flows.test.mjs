import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const api = await readFile(new URL('../supabase/functions/api/index.ts', import.meta.url), 'utf8');
const financeMigration = await readFile(new URL('../supabase/migrations/20261013040000_finance_transactions.sql', import.meta.url), 'utf8');
const rescheduleMigration = await readFile(new URL('../supabase/migrations/20261105010000_one_day_class_reschedules.sql', import.meta.url), 'utf8');

function actionBlock(start, end) {
  const startAt = api.indexOf(start);
  assert.notEqual(startAt, -1, `Missing API handler: ${start}`);
  const endAt = api.indexOf(end, startAt + start.length);
  assert.notEqual(endAt, -1, `Missing end marker for handler: ${start}`);
  return api.slice(startAt, endAt);
}

test('notice posting validates input, defaults new notices to Active, and persists them', () => {
  assert.match(api, /'notices\.add':\s*'NOTICE_EDIT'/);
  const block = actionBlock("if (action === 'notices.add' || action === 'notices.update')", "if (action === 'notices.setStatus')");
  assert.match(block, /if \(!\['STUDENTS','TEACHERS','BATCH','ALL'\]\.includes\(audience\)\)/);
  assert.match(block, /if \(!\['Active','Inactive'\]\.includes\(status\)\)/);
  assert.match(block, /row\.status = row\.status \|\| 'Active'/);
  assert.match(block, /admin\.from\('notices'\)\.insert\(row\)\.select\('\*'\)\.single\(\)/);
  assert.match(block, /return response\(\{ ok: true, data: \{ NoticeID: saved\.id/);
});

test('payment recording rejects invalid or excessive allocations and uses an atomic transaction', () => {
  assert.match(api, /'payments\.record':\s*'FINANCE_EDIT'/);
  const block = actionBlock("if (action === 'payments.record')", "if (action === 'receipts.list')");
  assert.match(block, /if \(balance <= 0\) throw new ApiFault\('BAD_REQUEST', 'This invoice is already fully paid\.'/);
  assert.match(block, /if \(amount < 1 \|\| amount > balance \+ 0\.005\)/);
  assert.match(block, /admin\.rpc\('record_payment_transaction'/);
  assert.match(financeMigration, /from public\.invoices where id = p_invoice_id for update/i);
  assert.match(financeMigration, /insert into public\.payments/i);
  assert.match(financeMigration, /insert into public\.receipts/i);
  assert.match(financeMigration, /update public\.invoices set line_items = next_lines, paid_amount = new_paid/i);
});

test('one-day class rescheduling is teacher-owned, date-scoped, and leaves the weekly timetable intact', () => {
  assert.match(api, /'teacher\.rescheduleClass':\s*'CLASS_RUN'/);
  const block = actionBlock("if (action === 'teacher.rescheduleClass')", "if (action === 'student.classChanges')");
  assert.match(block, /slot\.teacher_id !== user\.linked_id/);
  assert.match(block, /original_date: originalDate, rescheduled_date: rescheduledDate/);
  assert.match(block, /admin\.from\('class_reschedules'\)\.upsert\(row, \{ onConflict: 'timetable_id,original_date' \}\)/);
  assert.match(rescheduleMigration, /create table if not exists public\.class_reschedules/i);
  assert.match(rescheduleMigration, /unique \(timetable_id, original_date\)/i);
  assert.doesNotMatch(block, /admin\.from\('timetable'\)\.update\(/);
});

test('invoice generation bills each subject once and skips same-day mistakes', () => {
  const block = actionBlock('async function generateInvoices(', 'Deno.serve(');
  assert.match(block, /assignmentEnd <= assignmentStart\) continue/);
  assert.match(block, /const bySubject = new Map/);
  assert.match(block, /assignmentByStudent\.set\(studentId, \[\.\.\.bySubject\.values\(\)\]\)/);
  assert.match(block, /\.in\('status', \['ACTIVE', 'ENDED'\]\)/);
});

test('subjects given by mistake can be removed and start dates corrected', () => {
  assert.match(api, /'studentSubjects\.updateStart':\s*'STUDENT_EDIT'/);
  const end = actionBlock("if (action === 'studentSubjects.end')", "if (action === 'studentSubjects.updateStart')");
  assert.match(end, /update\(\{ status: 'REMOVED'/);
  const start = actionBlock("if (action === 'studentSubjects.updateStart')", "if (action === 'students.finance')");
  assert.match(start, /if \(overlap\) throw new ApiFault/);
});

test('permanent student delete needs Super Admin, the switch, the typed ID and the password', () => {
  const block = actionBlock("if (action === 'settings.studentDelete.get'", "if (action === 'studentSubjects.updateFee')");
  assert.match(block, /user\.role !== 'SUPER_ADMIN'/);
  assert.match(block, /if \(!enabled\) throw new ApiFault\('FORBIDDEN'/);
  assert.match(block, /confirmStudentId/);
  assert.match(block, /await verifyPassword\(payload\.password\)\s*\n\s*const \{ data: student/);
  assert.match(block, /admin\.rpc\('delete_student_permanently'/);
  assert.match(api, /key === 'STUDENT_DELETE_ENABLED'\) throw new ApiFault/);
});

test('doubt portal: visibility, teacher-only answering, approval before points', async () => {
  const block = actionBlock("if (action.startsWith('doubts.'))", "if (action === 'settings.studentDelete.get'");
  // Students only see their own doubts or non-hidden ones of their class and subjects.
  assert.match(block, /d\.class_name === sCtx\.cls && sCtx\.subjects\.has\(String\(d\.subject_id\)\)/);
  assert.match(block, /if \(!teachesIt\(d\)\) throw new ApiFault\('FORBIDDEN', 'Only teachers of this subject can answer it\.'\)/);
  // Classmate answers start PENDING; only an approval awards points.
  assert.match(block, /author_type: 'STUDENT', author_id: me, body, status: 'PENDING'/);
  assert.match(block, /const points = approve \? await settingNumber\('DOUBT_APPROVAL_POINTS', 10\) : 0/);
  assert.match(block, /DOUBT_DAILY_LIMIT/);
  const files = await readFile(new URL('../supabase/functions/doubt-files/index.ts', import.meta.url), 'utf8');
  assert.match(files, /const KEEP_DAYS = 7/);
  assert.match(files, /uploadDrive\(access, fileName, mime, bytes/);
  assert.match(files, /if \(answer && answer\.status !== 'APPROVED'/);
  const workflow = await readFile(new URL('../.github/workflows/deploy-supabase-api.yml', import.meta.url), 'utf8');
  assert.match(workflow, /supabase functions deploy doubt-files/);
});

test('subject assignment blocks periods overlapping an earlier ended period', () => {
  const block = actionBlock("if (action === 'studentSubjects.assign')", "if (action === 'studentSubjects.end')");
  assert.match(block, /r\.end_date > r\.start_date && String\(r\.end_date\) > startDate/);
  assert.match(block, /throw new ApiFault\('OVERLAP'/);
});

test('monthly auto-invoices reuse the button logic and need the private secret', () => {
  const block = actionBlock("if (action === 'cron.autoInvoices')", 'const token = String(');
  assert.match(block, /request\.headers\.get\('x-archive-secret'\) !== secret/);
  assert.match(block, /AUTO_INVOICE_ENABLED/);
  assert.match(block, /await generateInvoices\(admin, \{ month \}\)/);
  assert.match(api, /if \(action === 'invoices\.generate'\) \{\s*\n\s*const \{ month, result \} = await generateInvoices\(admin, payload\)/);
});

test('weekly backup goes to Google Drive (never GitHub), Super Admin only, keeps 8', async () => {
  const fn = await readFile(new URL('../supabase/functions/backup-drive/index.ts', import.meta.url), 'utf8');
  assert.match(fn, /const KEEP = 8/);
  assert.match(fn, /user\.role !== 'SUPER_ADMIN'/);
  assert.match(fn, /googleapis\.com\/upload\/drive/);
  const sql = await readFile(new URL('../supabase/migrations/20261114010000_auto_invoices_and_backups.sql', import.meta.url), 'utf8');
  assert.match(sql, /not in \('google_drive_connections'/);
  for (const wf of ['deploy-supabase-api.yml', 'publish-pages.yml']) {
    const text = await readFile(new URL(`../.github/workflows/${wf}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /backup/i.test(wf) ? /x^/ : /upload-artifact@/);
  }
});

test('free reminders: correct fee schedule, cron secret, no duplicates, no paid services', async () => {
  const fn = await readFile(new URL('../supabase/functions/notify/index.ts', import.meta.url), 'utf8');
  assert.match(fn, /days === -3 \? 'BEFORE_3' : days === 0 \? 'DUE' : days > 0 && days % 7 === 0 \? `OVERDUE_W\$\{days \/ 7\}`/);
  assert.match(fn, /req\.headers\.get\('x-archive-secret'\) !== secret/);
  assert.match(fn, /onConflict: 'kind,ref_id,student_id,stage', ignoreDuplicates: true/);
  assert.match(fn, /FEE_REMINDERS_ENABLED/);
  assert.match(fn, /ABSENT_ALERTS_ENABLED/);
  // Only closed classes from the last few hours, so the first run cannot flood old absences.
  assert.match(fn, /Date\.now\(\) - 6 \* 3600000/);
  assert.doesNotMatch(fn, /twilio|graph\.facebook\.com|msg91|interakt|wati/i);
  const sql = await readFile(new URL('../supabase/migrations/20261114020000_reminders_and_push.sql', import.meta.url), 'utf8');
  assert.match(sql, /'backup_runs','app_secrets','push_subscriptions'/);
  const sw = await readFile(new URL('../web/service-worker.js', import.meta.url), 'utf8');
  assert.match(sw, /addEventListener\('push'/);
});

test('large tables are read page by page (no silent 1,000-row cut-off) and invoices save in batches', () => {
  assert.match(api, /async function fetchAll<T = any>\(build: \(\) => any, pageSize = 1000/);
  const gen = actionBlock('async function generateInvoices(', 'Deno.serve(');
  assert.match(gen, /fetchAll\(\(\) => \{\s*\n\s*let q = admin\.from\('student_subjects'\)/);
  assert.match(gen, /await newIds\(admin, 'invoices'/);
  assert.match(gen, /if \(error\.code !== '23505'\) throw error/); // duplicate batch falls back to one-by-one
  assert.doesNotMatch(gen, /\.limit\(2000\)/);
  // next_ids missing -> falls back to next_id one at a time
  assert.match(api, /if \(!error && Array\.isArray\(data\) && data\.length === count\) return data\.map\(String\)/);
  const income = actionBlock("if (action === 'teacherIncome.generate')", "if (action === 'teacherIncome.list')");
  assert.match(income, /fetchAll\(\(\) => admin\.from\('student_subjects'\)/);
  assert.doesNotMatch(api, /\.limit\(10000\)/);
});

test('AI drafts: teachers only, no student personal data sent, daily cap, key never returned', async () => {
  const fn = await readFile(new URL('../supabase/functions/doubt-files/index.ts', import.meta.url), 'utf8');
  const draft = fn.slice(fn.indexOf('async function aiDraft('), fn.indexOf('Deno.serve('));
  assert.match(draft, /if \(!\['TEACHER', 'ADMIN'\]\.includes\(user\.user_type\)\)/);
  assert.match(draft, /admin\.rpc\('ai_take'/);
  // The prompt is built only from subject, class, chapter, title, body - not the student record.
  const prompt = draft.slice(draft.indexOf('const text = ['), draft.indexOf("].filter(Boolean).join('\\n')"));
  assert.doesNotMatch(prompt, /student_id|students|\.name\b(?!\s*\|\|\s*doubt\.subject_id)|mobile|phone|parent/);
  const get = actionBlock("if (action === 'doubts.get')", "if (action === 'doubts.create')");
  assert.match(get, /const aiAllowed = teachesIt\(d\) \|\| \(isAdmin && user\.role === 'SUPER_ADMIN'\)/);
  const status = actionBlock("if (action === 'ai.status' || action === 'ai.setKey')", '/* ---------------- Push notifications');
  assert.doesNotMatch(status.slice(status.indexOf("admin.from('app_secrets').select('key,created_at')")), /value:\s*stored|stored\.value|key:\s*key\b.*response/);
  assert.match(status, /user\.role !== 'SUPER_ADMIN'/);
  const sql = await readFile(new URL('../supabase/migrations/20261114040000_ai_doubt_drafts.sql', import.meta.url), 'utf8');
  assert.match(sql, /calls < greatest\(p_limit, 0\)/);
});

test('worksheets: no Supabase Storage, text moves to Drive after 7 days, keys hidden until deadline, no student data to AI', async () => {
  const fn = await readFile(new URL('../supabase/functions/worksheets/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(fn, /\.storage\./); // never uses Supabase Storage
  assert.match(fn, /const KEEP_DAYS = 7/);
  // text is cleared only after Drive confirmed the copy, and not if edited meanwhile
  assert.match(fn, /update\(\{ questions: '', answer_key: '', archived_at: new Date\(\)\.toISOString\(\),\s*\n\s*drive_file_id: made\.id/);
  assert.match(fn, /\.eq\('updated_at', w\.updated_at\)\.is\('archived_at', null\)/);
  // students get the answer key only after the due time
  assert.match(fn, /const keyOpen = !!hw\.due_at && new Date\(hw\.due_at\)\.getTime\(\) <= Date\.now\(\)/);
  assert.match(fn, /AnswerKey: keyOpen \? c\.answerKey : ''/);
  // prompt built from class/board/subject/topic only
  const prompt = fn.slice(fn.indexOf('let prompt = ['), fn.indexOf("if (parent) {"));
  assert.doesNotMatch(prompt, /student|mobile|phone|parent_/i);
  assert.match(fn, /admin\.rpc\('ai_take'/);
  const sql = await readFile(new URL('../supabase/migrations/20261114050000_worksheets.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(sql, /storage\.buckets/);
  const wf = await readFile(new URL('../.github/workflows/deploy-supabase-api.yml', import.meta.url), 'utf8');
  assert.match(wf, /supabase functions deploy worksheets/);
});

test('AI search: names hidden before the AI, read-only, own permissions, own daily limit', async () => {
  const fn = await readFile(new URL('../supabase/functions/ai-search/index.ts', import.meta.url), 'utf8');
  // read-only: no writes to records (only the AI cache table is written)
  for (const m of fn.matchAll(/\.from\('(\w+)'\)\.(insert|update|upsert|delete)\(/g)) assert.equal(m[1], 'ai_search_cache');
  assert.doesNotMatch(fn, /\.storage\./);
  // the AI gets only the masked question text
  assert.match(fn, /plan = cleanPlan\(await askGemini\(key, systemPrompt\(c\), m\.text\)\)/);
  assert.match(fn, /const m = maskQuestion\(q, dict\)/);
  const prompt = fn.slice(fn.indexOf('function systemPrompt('), fn.indexOf('function cleanPlan('));
  assert.doesNotMatch(prompt, /dict\.|studentRows|info\.get|parent_mobile/);
  // permissions: teachers limited to their own students/classes; finance needs FINANCE_VIEW
  assert.match(fn, /dues: \{\s*\n\s*label: 'Fee dues', who: \(c\) => has\(c, 'FINANCE_VIEW'\)/);
  assert.match(fn, /if \(!spec\.who\(c\)\) return json/);
  assert.match(fn, /if \(c\.isTeacher\) marks = await onlyMySessions\(c, marks\)/);
  // separate daily limit, refunded on failure
  assert.match(fn, /ai_take_feature', \{ p_feature: 'SEARCH'/);
  assert.match(fn, /catch \(e\) \{ await admin\.rpc\('ai_refund_feature', \{ p_feature: 'SEARCH' \}\); throw e \}/);
  const sql = await readFile(new URL('../supabase/migrations/20261114060000_ai_search_and_feature_limits.sql', import.meta.url), 'utf8');
  assert.match(sql, /v_total >= greatest\(p_total_limit, 0\) or v_feature >= greatest\(p_feature_limit, 0\)/);
  const wf = await readFile(new URL('../.github/workflows/deploy-supabase-api.yml', import.meta.url), 'utf8');
  assert.match(wf, /supabase functions deploy ai-search/);
  const cfg = await readFile(new URL('../supabase/config.toml', import.meta.url), 'utf8');
  assert.match(cfg, /\[functions\.ai-search\]\s*\n#[^\n]*\nverify_jwt = false/);
});

test('AI copy checking stores no photos; quiz and notice writer use their own limits; notice hides names', async () => {
  const fn = await readFile(new URL('../supabase/functions/worksheets/index.ts', import.meta.url), 'utf8');
  const block = fn.slice(fn.indexOf("if (action === 'checkCopy')"), fn.indexOf("if (action === 'quiz')"));
  assert.ok(block.length > 100);
  assert.doesNotMatch(block, /\.insert\(|\.upsert\(|\.update\(|drive|upload/i); // photos are never saved
  assert.match(block, /takeAi\(admin, 'COPYCHECK'\)/);
  assert.match(block, /refundAi\(admin, 'COPYCHECK'\)/);
  assert.match(fn, /Never write or repeat the student\\'s name/);
  const quiz = fn.slice(fn.indexOf("if (action === 'quiz')"), fn.indexOf("if (action === 'list')"));
  assert.match(quiz, /const w = await load\(body\.id\)/); // same subject permission as other worksheet actions
  assert.match(quiz, /set_label: 'Q'/);
  const js = await readFile(new URL('../web/worksheets.js', import.meta.url), 'utf8');
  assert.match(js, /if \(coverTop\) \{ g\.fillStyle = '#fff'; g\.fillRect\(0, 0, cv\.width, Math\.round\(cv\.height \* 0\.12\)\); \}/);
  const search = await readFile(new URL('../supabase/functions/ai-search/index.ts', import.meta.url), 'utf8');
  const notice = search.slice(search.indexOf("if (action === 'notice')"), search.indexOf("if (action === 'run')"));
  assert.match(notice, /if \(!has\(c, 'NOTICE_EDIT'\)\)/);
  assert.match(notice, /const m = maskQuestion\(points, dict\)/);
  assert.match(notice, /What the notice must say:\\n\$\{m\.text\}/);
  assert.match(notice, /p_feature: 'NOTICES'/);
  const sql = await readFile(new URL('../supabase/migrations/20261114070000_ai_copycheck_and_notice_limits.sql', import.meta.url), 'utf8');
  assert.match(sql, /'AI_LIMIT_NOTICES', '3'/);
});

test('one login: account decides the portal; admin PIN enforced on every server function; forgot password reveals nothing', async () => {
  // single login screen asks for any portal and routes by account type
  const student = await readFile(new URL('../web/student.html', import.meta.url), 'utf8');
  assert.match(student, /api\('auth\.login', \{ username:u, password:p, portal:'ANY' \}\)/);
  assert.match(student, /const PORTALS = \{ TEACHER: \['teacher\.html', 'cmz_tt', 'cmz_trt'\], ADMIN: \['admin\.html', 'cmz_t', 'cmz_tr'\] \}/);
  // never remember admin accounts on a device (checked in the page and in accounts.js)
  assert.match(student, /if \(ACC && refresh && user\.userType !== 'ADMIN'\) ACC\.save\(/);
  const accounts = await readFile(new URL('../web/accounts.js', import.meta.url), 'utf8');
  assert.match(accounts, /if \(!acc \|\| !acc\.authId \|\| !acc\.refresh \|\| acc\.type === 'ADMIN'\) return;/);
  assert.match(student, /if \(me\.mustChangePassword \|\| me\.pinRequired \|\| me\.userType === 'ADMIN'\) throw/);
  // QR login cards carry only the login link with the ID
  const admin = await readFile(new URL('../web/admin.html', import.meta.url), 'utf8');
  assert.match(admin, /qr\.addData\(base \+ '\?id=' \+ encodeURIComponent\(s\.StudentID\)\)/);
  for (const page of ['teacher', 'admin']) {
    const html = await readFile(new URL(`../web/${page}.html`, import.meta.url), 'utf8');
    assert.match(html, /function toLogin\(msg, out\)/);
    assert.match(html, /toLogin\('', false\);\r?\n\}\)\(\);/);
  }
  const login = await readFile(new URL('../web/login.html', import.meta.url), 'utf8');
  assert.match(login, /location\.replace\('\.\/student\.html'/);
  // API: PIN lock checked before any action except the few needed to unlock
  assert.match(api, /if \(!pinOk && !\['auth\.me', 'auth\.logout', 'auth\.pinVerify', 'auth\.ping'\]\.includes\(action\)\)/);
  assert.match(api, /if \(portal !== 'ANY' && portal !== user\.user_type\)/);
  const pin = actionBlock("if (action === 'auth.pinVerify')", "if (action === 'auth.pinSet')");
  assert.match(pin, /consumeLoginLimit\(admin, rateKey, 15 \* 60, 5\)/); // 5 tries per 15 minutes
  // every other function that admins can use checks the same lock
  for (const fn of ['worksheets', 'doubt-files', 'backup-drive', 'homework-drive', 'google-drive-oauth', 'ai-search']) {
    const code = await readFile(new URL(`../supabase/functions/${fn}/index.ts`, import.meta.url), 'utf8');
    assert.match(code, /admin\.rpc\('admin_session_ok'/, fn);
    assert.match(code, /adminUnlocked\(admin, ?authUser\.id, ?token\)/, fn);
  }
  // forgot password: same answer whether or not the account exists; students/teachers need their mobile
  const forgot = actionBlock("if (action === 'public.forgotPassword')", "if (action === 'auth.login')");
  assert.ok(forgot.length > 200);
  assert.doesNotMatch(forgot, /fail\('NOT_FOUND'|No account/);
  assert.match(forgot, /if \(!known\.includes\(mobile\)\) return done/);
  const sql = await readFile(new URL('../supabase/migrations/20261114080000_one_login_admin_pin_password_help.sql', import.meta.url), 'utf8');
  assert.match(sql, /crypt\(p_pin, gen_salt\('bf', 8\)\)/); // PIN stored only as a hash
});

test('offline mode: only read-only pages are saved, sign out wipes them, saved accounts survive no internet', async () => {
  const student = await readFile(new URL('../web/student.html', import.meta.url), 'utf8');
  const reads = student.match(/const OFFLINE_READS = new Set\(\[([\s\S]*?)\]\)/)[1];
  for (const write of ['submit', 'paymentSubmit', 'enterCode', 'updateProfile', 'changePassword', 'login', 'create', 'answer', 'upload']) {
    assert.doesNotMatch(reads, new RegExp(write), `${write} must never be served from the phone`);
  }
  assert.match(student, /if \(S\.offlineOnly\) return fromPhone\(/); // opened offline: nothing is sent
  assert.match(student, /if \(owner\) CMZOffline\.clearOwner\(owner\)/); // sign out deletes the phone copy
  assert.match(student, /if \(window\.CMZOffline && CMZOffline\.isNetworkError\(e\)\) return openSavedOffline\(acc\); \/\/ keep the account/);
  assert.match(student, /if \(!acc \|\| acc\.type !== 'STUDENT'/); // only student accounts open offline for now
  // sign-in library is served from our own site so the app can start without internet
  for (const page of ['student', 'teacher', 'admin']) {
    const html = await readFile(new URL(`../web/${page}.html`, import.meta.url), 'utf8');
    assert.match(html, /<script src="vendor\/supabase-js-2\.105\.0\.js"><\/script>/, page);
  }
  const sw = await readFile(new URL('../web/service-worker.js', import.meta.url), 'utf8');
  assert.match(sw, /'\.\/vendor\/supabase-js-2\.105\.0\.js'/);
  assert.match(sw, /'\.\/offline-store\.js'/);
  // every folder the pages load from must be published (web/vendor once went missing)
  const publish = await readFile(new URL('../.github/workflows/publish-pages.yml', import.meta.url), 'utf8');
  assert.match(publish, /cp -R web\/vendor _site\/web\/vendor/);
});

test('portals: list helpers are never called on a single-element selector ($ vs $$)', async () => {
  // $() returns one element; calling .forEach/.map on it breaks the whole page.
  for (const page of ['admin', 'teacher', 'student']) {
    const html = await readFile(new URL(`../web/${page}.html`, import.meta.url), 'utf8');
    const bad = html.match(/(^|[^$])\$\('[^']*'(, *[a-zA-Z]+)?\)\.(forEach|map|filter|find|some|every)\(/gm);
    assert.equal(bad, null, `${page}.html: ${bad}`);
  }
});

test('teacher monthly income generation uses student fees, collections, contribution, and preserves prior payouts', () => {
  assert.match(api, /'teacherIncome\.generate':\s*'TEACHER_INCOME_MANAGE'/);
  const block = actionBlock("if (action === 'teacherIncome.generate')", "if (action === 'teacherIncome.list')");
  assert.match(block, /expected_amount: expected, collected_amount: collected, outstanding_amount: Math\.max\(0, expected - collected\)/);
  assert.match(block, /final_payable: Math\.max\(0, collected - contribution\)/);
  assert.match(block, /const net = Math\.max\(alreadyPaid, Math\.max\(0, collected - contribution\)\)/);
  assert.match(block, /status: teacherIncomeStatus\(expected, collected, contribution, net, alreadyPaid\)/);
  assert.match(block, /student_details: g\.details/);
});
