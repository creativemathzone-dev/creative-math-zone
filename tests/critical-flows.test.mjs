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
  const block = actionBlock("if (action === 'invoices.generate')", "if (action === 'invoices.list')");
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

test('teacher monthly income generation uses student fees, collections, contribution, and preserves prior payouts', () => {
  assert.match(api, /'teacherIncome\.generate':\s*'TEACHER_INCOME_MANAGE'/);
  const block = actionBlock("if (action === 'teacherIncome.generate')", "if (action === 'teacherIncome.list')");
  assert.match(block, /expected_amount: expected, collected_amount: collected, outstanding_amount: Math\.max\(0, expected - collected\)/);
  assert.match(block, /final_payable: Math\.max\(0, collected - contribution\)/);
  assert.match(block, /const net = Math\.max\(alreadyPaid, Math\.max\(0, collected - contribution\)\)/);
  assert.match(block, /status: teacherIncomeStatus\(expected, collected, contribution, net, alreadyPaid\)/);
  assert.match(block, /student_details: g\.details/);
});
