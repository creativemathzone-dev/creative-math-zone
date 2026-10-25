-- Automatically close live classes once their scheduled end time passes.
-- Class dates and times are stored as local Asia/Kolkata wall-clock values.

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create or replace function public.close_expired_class_sessions()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_marked_absent integer := 0;
begin
  with due_sessions as (
    update public.class_sessions as s
       set status = 'CLOSED',
           closed_at = coalesce(s.closed_at, now()),
           code_expires_at = least(coalesce(s.code_expires_at, now()), now())
     where upper(s.status) = 'OPEN'
       and (s.session_date + s.end_time) <= (now() at time zone 'Asia/Kolkata')
    returning s.id, s.teacher_id, s.batch_id, s.subject_id, s.co_subject_id,
              s.session_date, s.academic_year
  ), roster as (
    select d.id as session_id,
           d.batch_id,
           d.session_date,
           d.academic_year,
           ss.student_id,
           (array_agg(ss.subject_id order by case when ss.subject_id = d.subject_id then 0 else 1 end))[1] as subject_id
      from due_sessions as d
      join public.student_subjects as ss
        on ss.teacher_id = d.teacher_id
       and ss.batch_id = d.batch_id
       and ss.subject_id in (d.subject_id, d.co_subject_id)
       and upper(ss.status) = 'ACTIVE'
     group by d.id, d.batch_id, d.session_date, d.academic_year, d.subject_id, ss.student_id
  ), absent_marks as (
    insert into public.attendance (
      id, session_id, student_id, subject_id, batch_id, session_date,
      status, marked_by, method, academic_year
    )
    select 'ATT-' || gen_random_uuid()::text,
           r.session_id, r.student_id, r.subject_id, r.batch_id, r.session_date,
           'ABSENT', null, 'AUTO_CLOSE', r.academic_year
      from roster as r
      join public.students as st on st.id = r.student_id and upper(st.status) = 'ACTIVE'
    on conflict (session_id, student_id) do nothing
    returning id
  )
  select count(*)::integer into v_marked_absent from absent_marks;

  return v_marked_absent;
end;
$function$;

revoke all on function public.close_expired_class_sessions() from public, anon, authenticated;

do $block$
declare
  v_job_id bigint;
begin
  for v_job_id in
    select jobid from cron.job where jobname = 'cmz-auto-close-expired-classes'
  loop
    perform cron.unschedule(v_job_id);
  end loop;

  perform cron.schedule(
    'cmz-auto-close-expired-classes',
    '* * * * *',
    'select public.close_expired_class_sessions();'
  );
end;
$block$;
