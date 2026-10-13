-- Lock a teacher-income row while checking its remaining balance so parallel
-- payment requests cannot overpay it.
create or replace function public.record_teacher_payment(
  p_income_id text,
  p_payment_date date,
  p_amount numeric,
  p_payment_mode text,
  p_reference text,
  p_paid_by uuid,
  p_notes text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_teacher_id text;
  v_payable numeric(12,2);
  v_paid numeric(12,2);
  v_payment_id text;
begin
  if p_amount <= 0 or p_amount > 10000000 then raise exception 'Invalid payment amount'; end if;
  if p_payment_mode not in ('CASH','UPI','BANK_TRANSFER','CHEQUE') then raise exception 'Invalid payment mode'; end if;

  select teacher_id, final_payable into v_teacher_id, v_payable
  from public.teacher_income where id = p_income_id for update;
  if not found then raise exception 'Teacher income record not found'; end if;

  select coalesce(sum(amount), 0) into v_paid from public.teacher_payments where income_id = p_income_id;
  if p_amount > v_payable - v_paid then raise exception 'Payment exceeds remaining balance'; end if;

  v_payment_id := public.next_id('teacher_payments', 'TIP-', 5);
  insert into public.teacher_payments(id, teacher_id, income_id, payment_date, amount, payment_mode, upi_reference, paid_by, notes)
  values (v_payment_id, v_teacher_id, p_income_id, p_payment_date, p_amount, p_payment_mode, coalesce(p_reference,''), p_paid_by, coalesce(p_notes,''));
  update public.teacher_income
  set status = case when v_paid + p_amount >= v_payable then 'Paid' when v_paid + p_amount > 0 then 'Partial' else 'Pending' end
  where id = p_income_id;
  return v_payment_id;
end;
$$;

revoke all on function public.record_teacher_payment(text,date,numeric,text,text,uuid,text) from public, anon, authenticated;
grant execute on function public.record_teacher_payment(text,date,numeric,text,text,uuid,text) to service_role;
