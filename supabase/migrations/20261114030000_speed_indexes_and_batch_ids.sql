-- Speed: indexes for the lookups the portal does most, and batch ID reservation
-- so invoice generation needs one database call instead of one per student.
-- Safe to run more than once. Nothing here changes or deletes data.

-- 1) IDs never get cut short. Before, lpad() truncated numbers longer than the
--    width (invoice 10000 would have become "1000" and clashed). Now the number
--    is only padded, never cut.
create or replace function public.next_id(p_counter_name text, p_prefix text, p_width integer)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  next_value bigint;
begin
  if p_counter_name !~ '^[a-z_]{1,40}$' or p_width < 1 or p_width > 12 or length(p_prefix) > 80 then
    raise exception 'Invalid ID counter parameters';
  end if;
  insert into public.id_counters(counter_name, last_value)
  values (p_counter_name, 1)
  on conflict (counter_name) do update set last_value = id_counters.last_value + 1
  returning last_value into next_value;
  return p_prefix || lpad(next_value::text, greatest(p_width, length(next_value::text)), '0');
end;
$$;
revoke all on function public.next_id(text, text, integer) from public, anon, authenticated;
grant execute on function public.next_id(text, text, integer) to service_role;

-- 2) Reserve p_count IDs at once (same format and counter as next_id).
create or replace function public.next_ids(p_counter_name text, p_prefix text, p_width integer, p_count integer)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_last bigint;
begin
  if p_counter_name !~ '^[a-z_]{1,40}$' or p_width < 1 or p_width > 12 or length(p_prefix) > 80
     or p_count < 1 or p_count > 5000 then
    raise exception 'Invalid ID counter parameters';
  end if;
  insert into public.id_counters(counter_name, last_value)
  values (p_counter_name, p_count)
  on conflict (counter_name) do update set last_value = id_counters.last_value + p_count
  returning id_counters.last_value into v_last;
  return array(
    select p_prefix || lpad(n::text, greatest(p_width, length(n::text)), '0')
    from generate_series(v_last - p_count + 1, v_last) as n
    order by n
  );
end;
$$;
revoke all on function public.next_ids(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.next_ids(text, text, integer, integer) to service_role;

-- 3) Indexes for frequent lookups.
create index if not exists invoices_month_idx on public.invoices(month, id desc);
create index if not exists invoices_due_date_idx on public.invoices(due_date) where status <> 'CANCELLED';
create index if not exists receipts_date_idx on public.receipts(receipt_date desc, id desc);
create index if not exists receipts_student_idx on public.receipts(student_id);
create index if not exists receipts_payment_idx on public.receipts(payment_id);
create index if not exists payments_invoice_idx on public.payments(invoice_id);
create index if not exists payments_date_idx on public.payments(payment_date, id);
create index if not exists student_subjects_student_idx on public.student_subjects(student_id, status);
create index if not exists student_subjects_subject_idx on public.student_subjects(subject_id, status);
create index if not exists student_fees_student_idx on public.student_fees(student_id, subject_id) where status = 'Active';
create index if not exists change_history_student_idx on public.change_history(student_id, changed_at desc);
create index if not exists admin_logs_logged_at_idx on public.admin_logs(logged_at desc);
create index if not exists class_sessions_closed_idx on public.class_sessions(closed_at) where closed_at is not null;
create index if not exists teacher_income_month_idx on public.teacher_income(month, teacher_id);
create index if not exists teacher_payments_income_idx on public.teacher_payments(income_id);

analyze public.invoices, public.receipts, public.payments, public.student_subjects, public.admin_logs;
