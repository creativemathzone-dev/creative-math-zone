-- Board/class based fee suggestions and atomic, history-preserving promotions.
create table if not exists public.promotion_fee_rates (
  id text primary key,
  board text not null,
  target_class text not null,
  subject_id text not null references public.subjects(id),
  academic_year text not null,
  amount numeric(12,2) not null check (amount >= 0 and amount <= 100000),
  updated_at timestamptz not null default now(),
  unique (board, target_class, subject_id, academic_year)
);
alter table public.promotion_fee_rates enable row level security;
revoke all on public.promotion_fee_rates from anon, authenticated;
grant all on public.promotion_fee_rates to service_role;

create or replace function public.apply_student_promotions(
  p_board text,
  p_source_class text,
  p_target_class text,
  p_target_batch_id text,
  p_academic_year text,
  p_start_date date,
  p_promotions jsonb,
  p_changed_by uuid
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_assignment record;
  v_student public.students%rowtype;
  v_batch public.batches%rowtype;
  v_fees jsonb;
  v_fee numeric(12,2);
  v_discount numeric(12,2);
  v_count integer := 0;
  v_new_id text;
begin
  if jsonb_typeof(p_promotions) <> 'array' or jsonb_array_length(p_promotions) = 0 then
    raise exception 'Select at least one student to promote.';
  end if;
  if p_board is null or p_source_class is null or p_target_class is null or p_academic_year is null or p_start_date is null then
    raise exception 'Board, classes, academic year, and effective date are required.';
  end if;
  select * into v_batch from public.batches where id = p_target_batch_id and status = 'Active';
  if not found or upper(trim(v_batch.class)) <> upper(trim(p_target_class)) or v_batch.academic_year <> p_academic_year then
    raise exception 'Choose an active target batch for the selected class and academic year.';
  end if;

  for v_item in select value from jsonb_array_elements(p_promotions)
  loop
    select * into v_student from public.students
      where id = v_item->>'studentId'
        and upper(trim(status)) = 'ACTIVE'
        and upper(trim(board)) = upper(trim(p_board))
        and upper(trim(current_class)) = upper(trim(p_source_class))
      for update;
    if not found then raise exception 'A selected student no longer matches this promotion group.'; end if;

    v_fees := coalesce(v_item->'fees', '[]'::jsonb);
    if jsonb_typeof(v_fees) <> 'array' then raise exception 'Promotion fee details are invalid.'; end if;
    if not exists (select 1 from public.student_subjects where student_id = v_student.id and upper(status) = 'ACTIVE') then
      raise exception 'Student % has no active subject assignments.', v_student.name;
    end if;
    for v_assignment in
      select * from public.student_subjects where student_id = v_student.id and upper(status) = 'ACTIVE' for update
    loop
      if v_assignment.start_date is not null and p_start_date < v_assignment.start_date then
        raise exception 'Promotion date cannot be before an active subject start date for %.', v_student.name;
      end if;
      select (fee_row.value->>'amount')::numeric into v_fee
        from jsonb_array_elements(v_fees) as fee_row(value)
        where fee_row.value->>'studentSubjectId' = v_assignment.id;
      if v_fee is null or v_fee < 0 or v_fee > 100000 then
        raise exception 'A valid fee from 0 to 100000 is required for every subject of %.', v_student.name;
      end if;
      select coalesce(max(discount_amount), 0) into v_discount
        from public.student_fees
        where student_id = v_student.id and subject_id = v_assignment.subject_id
          and status = 'Active' and effective_to is null;
      if v_fee < v_discount then
        raise exception 'The new fee for % cannot be lower than the active discount for student %.',
          coalesce((select name from public.subjects where id = v_assignment.subject_id), v_assignment.subject_id), v_student.name;
      end if;
      update public.student_subjects set status = 'ENDED', end_date = p_start_date
        where id = v_assignment.id;
      v_new_id := 'SS-' || replace(gen_random_uuid()::text, '-', '');
      insert into public.student_subjects (id, student_id, subject_id, teacher_id, batch_id, start_date,
        status, fee_override, teacher_rate_override, academic_year)
      values (v_new_id, v_student.id, v_assignment.subject_id, v_assignment.teacher_id, p_target_batch_id,
        p_start_date, 'ACTIVE', v_fee, v_assignment.teacher_rate_override, p_academic_year);
      insert into public.change_history (id, student_id, field, old_value, new_value, changed_by, reason, academic_year)
      values ('CHG-' || gen_random_uuid()::text, v_student.id, 'Subject',
        v_assignment.subject_id || ' / ' || coalesce(v_assignment.teacher_id, '') || ' / ' || coalesce(v_assignment.batch_id, ''),
        v_assignment.subject_id || ' / ' || coalesce(v_assignment.teacher_id, '') || ' / ' || p_target_batch_id,
        p_changed_by, 'Academic promotion ' || p_source_class || ' to ' || p_target_class, p_academic_year);
    end loop;

    update public.students set current_class = p_target_class, current_batch_id = p_target_batch_id,
      academic_year = p_academic_year, updated_at = now() where id = v_student.id;
    insert into public.change_history (id, student_id, field, old_value, new_value, changed_by, reason, academic_year)
    values ('CHG-' || gen_random_uuid()::text, v_student.id, 'current_class', v_student.current_class,
      p_target_class, p_changed_by, 'Academic promotion ' || p_source_class || ' to ' || p_target_class, p_academic_year);
    if coalesce(v_student.current_batch_id, '') <> coalesce(p_target_batch_id, '') then
      insert into public.change_history (id, student_id, field, old_value, new_value, changed_by, reason, academic_year)
      values ('CHG-' || gen_random_uuid()::text, v_student.id, 'current_batch_id', coalesce(v_student.current_batch_id, ''),
        p_target_batch_id, p_changed_by, 'Academic promotion ' || p_source_class || ' to ' || p_target_class, p_academic_year);
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.apply_student_promotions(text,text,text,text,text,date,jsonb,uuid) from public, anon, authenticated;
grant execute on function public.apply_student_promotions(text,text,text,text,text,date,jsonb,uuid) to service_role;
