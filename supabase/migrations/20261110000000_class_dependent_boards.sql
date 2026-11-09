-- Normalize known CBSE aliases in existing records so board-specific
-- promotions continue to find students after the class-dependent options ship.
with normalized as (
  select id,
    regexp_replace(upper(trim(board)), '[^A-Z0-9]', '', 'g') as board_key,
    regexp_replace(upper(trim(current_class)), '^CLASS\s*', '') as class_key
  from public.students
  where board is not null and trim(board) <> ''
), mapped as (
  select id,
    case
      when class_key in ('XI', 'XII', '11', '12') then 'CBSE (Higher)'
      when class_key in ('I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10') then 'CBSE (Lower)'
      else null
    end as board_value
  from normalized
  where board_key in ('CBSE', 'CBSEHIGHER', 'CBSESR', 'CBSECLASS11', 'CBSELOWER', 'CBSEJR', 'CBSECLASS10')
)
update public.students as s
set board = mapped.board_value
from mapped
where s.id = mapped.id and mapped.board_value is not null and s.board is distinct from mapped.board_value;

with normalized as (
  select id,
    regexp_replace(upper(trim(board)), '[^A-Z0-9]', '', 'g') as board_key,
    regexp_replace(upper(trim(current_class)), '^CLASS\s*', '') as class_key
  from public.registrations
  where board is not null and trim(board) <> ''
), mapped as (
  select id,
    case
      when class_key in ('XI', 'XII', '11', '12') then 'CBSE (Higher)'
      when class_key in ('I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10') then 'CBSE (Lower)'
      else null
    end as board_value
  from normalized
  where board_key in ('CBSE', 'CBSEHIGHER', 'CBSESR', 'CBSECLASS11', 'CBSELOWER', 'CBSEJR', 'CBSECLASS10')
)
update public.registrations as r
set board = mapped.board_value
from mapped
where r.id = mapped.id and mapped.board_value is not null and r.board is distinct from mapped.board_value;
