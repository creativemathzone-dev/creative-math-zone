-- Permanently remove one student and every record that belongs to them.
-- Runs as one transaction: either everything is removed or nothing is.
-- Called only by the API after the Super Admin re-enters their password
-- and the STUDENT_DELETE_ENABLED setting has been switched on.
create or replace function public.delete_student_permanently(p_student_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_counts jsonb := '{}'::jsonb;
  v_n integer;
begin
  if not exists (select 1 from public.students where id = p_student_id for update) then
    raise exception 'student not found';
  end if;

  -- Homework submissions (their files rows cascade).
  delete from public.homework_submissions where student_id = p_student_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('homework_submissions', v_n);

  -- Money: online payment claims, receipts, payments, invoices.
  delete from public.payment_submissions
   where student_id = p_student_id
      or invoice_id in (select id from public.invoices where student_id = p_student_id);
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('payment_submissions', v_n);

  update public.payments set receipt_id = null where student_id = p_student_id;
  update public.receipts set reissue_of = null
   where reissue_of in (select id from public.receipts where student_id = p_student_id);
  update public.receipts set reissued_by = null
   where reissued_by in (select id from public.receipts where student_id = p_student_id);
  delete from public.receipts
   where student_id = p_student_id
      or payment_id in (select id from public.payments where student_id = p_student_id);
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('receipts', v_n);

  delete from public.payments where student_id = p_student_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('payments', v_n);

  delete from public.invoices where student_id = p_student_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('invoices', v_n);

  delete from public.student_fees where student_id = p_student_id;
  delete from public.discounts where student_id = p_student_id;

  -- Attendance and history.
  delete from public.attendance_logs where student_id = p_student_id;
  delete from public.attendance where student_id = p_student_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('attendance', v_n);
  delete from public.change_history where student_id = p_student_id;

  -- Subjects, registration form, login link, and finally the student.
  delete from public.student_subjects where student_id = p_student_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('subjects', v_n);
  delete from public.registrations where student_id = p_student_id;
  delete from public.app_users where user_type = 'STUDENT' and linked_id = p_student_id;
  delete from public.students where id = p_student_id;

  return v_counts;
end;
$$;

revoke all on function public.delete_student_permanently(text) from public, anon, authenticated;
grant execute on function public.delete_student_permanently(text) to service_role;
