-- Keep payment, receipt, and invoice totals atomic under concurrent requests.
alter table public.invoices drop constraint if exists invoices_student_id_month_academic_year_key;
create unique index if not exists invoices_one_live_month_per_student_uidx
  on public.invoices(student_id, month, academic_year) where upper(status) <> 'CANCELLED';

create or replace function public.record_payment_transaction(
  p_payment_id text,
  p_receipt_id text,
  p_invoice_id text,
  p_payment_date date,
  p_payment_mode text,
  p_transaction_reference text,
  p_notes text,
  p_academic_year text,
  p_received_by uuid,
  p_allocations jsonb,
  p_receipt_format text default 'A5'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  inv public.invoices%rowtype;
  line jsonb;
  allocation jsonb;
  next_line jsonb;
  next_lines jsonb := '[]'::jsonb;
  line_paid numeric;
  line_final numeric;
  line_alloc numeric;
  alloc_total numeric := 0;
  new_paid numeric := 0;
  new_balance numeric;
  payment_status text;
  remaining_old_paid numeric;
  alloc_found boolean;
begin
  if jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 then
    raise exception 'At least one payment allocation is required';
  end if;
  if p_payment_mode not in ('CASH','UPI','BANK_TRANSFER','CHEQUE') then
    raise exception 'Invalid payment mode';
  end if;

  select * into inv from public.invoices where id = p_invoice_id for update;
  if not found then raise exception 'Invoice not found'; end if;
  if upper(inv.status) = 'CANCELLED' then raise exception 'Invoice is cancelled'; end if;
  if inv.total_amount - inv.paid_amount <= 0 then raise exception 'Invoice is already fully paid'; end if;

  for allocation in select value from jsonb_array_elements(p_allocations)
  loop
    if coalesce(allocation->>'subjectId','') = '' or coalesce((allocation->>'amount')::numeric,0) <= 0 then
      raise exception 'Invalid payment allocation';
    end if;
    alloc_total := alloc_total + (allocation->>'amount')::numeric;
    if (select count(*) from jsonb_array_elements(p_allocations) a where a.value->>'subjectId' = allocation->>'subjectId') > 1 then
      raise exception 'A subject appears more than once';
    end if;
    if not exists (select 1 from jsonb_array_elements(inv.line_items) l where l.value->>'subjectId' = allocation->>'subjectId') then
      raise exception 'Subject is not on this invoice';
    end if;
  end loop;
  if abs(alloc_total - (select coalesce(sum((value->>'amount')::numeric),0) from jsonb_array_elements(p_allocations))) > 0.005 then
    raise exception 'Payment allocation total is invalid';
  end if;
  if alloc_total < 1 or alloc_total > inv.total_amount - inv.paid_amount + 0.005 then
    raise exception 'Payment exceeds the invoice balance';
  end if;

  remaining_old_paid := inv.paid_amount;
  for line in select value from jsonb_array_elements(inv.line_items)
  loop
    line_final := coalesce((line->>'finalAmount')::numeric, 0);
    if line ? 'paidAmount' then
      line_paid := coalesce((line->>'paidAmount')::numeric, 0);
    else
      line_paid := least(line_final, remaining_old_paid);
      remaining_old_paid := greatest(0, remaining_old_paid - line_paid);
    end if;
    line_alloc := 0;
    alloc_found := false;
    for allocation in select value from jsonb_array_elements(p_allocations)
    loop
      if allocation->>'subjectId' = line->>'subjectId' then
        line_alloc := (allocation->>'amount')::numeric;
        alloc_found := true;
      end if;
    end loop;
    if alloc_found and line_alloc > line_final - line_paid + 0.005 then
      raise exception 'Payment exceeds a subject balance';
    end if;
    next_line := jsonb_set(jsonb_set(line, '{paidAmount}', to_jsonb(line_paid + line_alloc), true),
      '{balanceAmount}', to_jsonb(greatest(0, line_final - line_paid - line_alloc)), true);
    next_lines := next_lines || jsonb_build_array(next_line);
    new_paid := new_paid + line_paid + line_alloc;
  end loop;

  if abs(new_paid - (inv.paid_amount + alloc_total)) > 0.02 then raise exception 'Invoice line totals do not match'; end if;
  new_balance := greatest(0, inv.total_amount - new_paid);
  if new_balance = 0 then payment_status := 'PAID';
  elsif inv.due_date is not null and inv.due_date < (now() at time zone 'Asia/Kolkata')::date then payment_status := 'OVERDUE';
  elsif new_paid > 0 then payment_status := 'PARTIAL';
  else payment_status := 'UNPAID'; end if;

  insert into public.payments (id, student_id, invoice_id, payment_date, amount, payment_mode, transaction_reference,
    received_by, status, notes, receipt_id, academic_year, allocations)
  values (p_payment_id, inv.student_id, inv.id, p_payment_date, alloc_total, p_payment_mode,
    coalesce(p_transaction_reference,''), p_received_by, 'PAID', coalesce(p_notes,''), null, p_academic_year, p_allocations);

  insert into public.receipts (id, payment_id, student_id, receipt_date, amount, format, status,
    academic_year, created_by)
  values (p_receipt_id, p_payment_id, inv.student_id, p_payment_date, alloc_total, coalesce(p_receipt_format,'A5'),
    'PAID', p_academic_year, p_received_by);

  update public.payments set receipt_id = p_receipt_id where id = p_payment_id;
  update public.invoices set line_items = next_lines, paid_amount = new_paid, balance_amount = new_balance,
    status = payment_status, updated_at = now() where id = inv.id;

  return jsonb_build_object('paymentId',p_payment_id,'receiptId',p_receipt_id,'amount',alloc_total,
    'invoiceStatus',payment_status,'balance',new_balance,'allocations',p_allocations);
end;
$$;

create or replace function public.void_receipt_transaction(p_receipt_id text, p_voided_by uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  rec public.receipts%rowtype;
  pay public.payments%rowtype;
  inv public.invoices%rowtype;
  line jsonb;
  allocation jsonb;
  next_line jsonb;
  next_lines jsonb := '[]'::jsonb;
  line_final numeric;
  line_paid numeric;
  line_reversal numeric;
  remaining_reversal numeric;
  new_paid numeric := 0;
  new_balance numeric;
  new_status text;
  has_allocations boolean;
begin
  if coalesce(trim(p_reason),'') = '' then raise exception 'A reason is required'; end if;
  select * into rec from public.receipts where id = p_receipt_id for update;
  if not found then raise exception 'Receipt not found'; end if;
  if upper(rec.status) = 'VOID' then return jsonb_build_object('ok',true,'unchanged',true); end if;
  select * into pay from public.payments where id = rec.payment_id for update;
  if not found then raise exception 'Linked payment not found'; end if;
  if upper(pay.status) = 'VOID' then return jsonb_build_object('ok',true,'unchanged',true); end if;

  if pay.invoice_id is not null then
    select * into inv from public.invoices where id = pay.invoice_id for update;
    if found and upper(inv.status) <> 'CANCELLED' then
      has_allocations := jsonb_typeof(pay.allocations) = 'array' and jsonb_array_length(pay.allocations) > 0;
      remaining_reversal := pay.amount;
      for line in select value from jsonb_array_elements(inv.line_items)
      loop
        line_final := coalesce((line->>'finalAmount')::numeric,0);
        line_paid := coalesce((line->>'paidAmount')::numeric,0);
        line_reversal := 0;
        if has_allocations then
          for allocation in select value from jsonb_array_elements(pay.allocations)
          loop
            if allocation->>'subjectId' = line->>'subjectId' then
              line_reversal := (allocation->>'amount')::numeric;
            end if;
          end loop;
        else
          line_reversal := least(line_paid, remaining_reversal);
          remaining_reversal := greatest(0, remaining_reversal - line_reversal);
        end if;
        line_paid := greatest(0, line_paid - line_reversal);
        next_line := jsonb_set(jsonb_set(line, '{paidAmount}', to_jsonb(line_paid), true),
          '{balanceAmount}', to_jsonb(greatest(0,line_final-line_paid)), true);
        next_lines := next_lines || jsonb_build_array(next_line);
        new_paid := new_paid + line_paid;
      end loop;
      new_balance := greatest(0, inv.total_amount - new_paid);
      if new_balance = 0 then new_status := 'PAID';
      elsif inv.due_date is not null and inv.due_date < (now() at time zone 'Asia/Kolkata')::date then new_status := 'OVERDUE';
      elsif new_paid > 0 then new_status := 'PARTIAL';
      else new_status := 'UNPAID'; end if;
      update public.invoices set line_items = next_lines, paid_amount = new_paid, balance_amount = new_balance,
        status = new_status, updated_at = now() where id = inv.id;
    end if;
  end if;

  update public.receipts set status = 'VOID', voided_by = p_voided_by, void_date = now(), void_reason = p_reason where id = rec.id;
  update public.payments set status = 'VOID', voided_by = p_voided_by, void_date = now(), void_reason = p_reason where id = pay.id;
  return jsonb_build_object('ok',true,'unchanged',false,'paymentId',pay.id);
end;
$$;

create or replace function public.cancel_invoice_transaction(p_invoice_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  inv public.invoices%rowtype;
begin
  select * into inv from public.invoices where id = p_invoice_id for update;
  if not found then raise exception 'Invoice not found'; end if;
  if upper(inv.status) = 'CANCELLED' then return jsonb_build_object('ok',true,'unchanged',true); end if;
  if inv.paid_amount > 0 then raise exception 'Cannot cancel an invoice that already has payments'; end if;
  update public.invoices set status = 'CANCELLED', updated_at = now() where id = inv.id;
  return jsonb_build_object('ok',true,'unchanged',false);
end;
$$;

revoke all on function public.record_payment_transaction(text,text,text,date,text,text,text,text,uuid,jsonb,text) from public, anon, authenticated;
grant execute on function public.record_payment_transaction(text,text,text,date,text,text,text,text,uuid,jsonb,text) to service_role;
revoke all on function public.void_receipt_transaction(text,uuid,text) from public, anon, authenticated;
grant execute on function public.void_receipt_transaction(text,uuid,text) to service_role;
revoke all on function public.cancel_invoice_transaction(text) from public, anon, authenticated;
grant execute on function public.cancel_invoice_transaction(text) to service_role;
