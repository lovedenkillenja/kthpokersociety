-- M5: 3-6 players, 30-second action timers & consecutive-timeout sit-out tracking,
-- automatic 30-minute idle empty table cleanup, and host `close_table` / `set_seat_status` RPCs.
-- Additive migration; all functions are SECURITY DEFINER and callable ONLY by `service_role`.

-- 1. Columns for idle table cleanup and consecutive timeout tracking
alter table public.poker_tables
  add column if not exists last_activity_at timestamptz not null default now();

alter table public.table_seats
  add column if not exists consecutive_timeouts integer not null default 0
  check (consecutive_timeouts >= 0 and consecutive_timeouts <= 100);

create index if not exists poker_tables_idle_cleanup_idx
  on public.poker_tables (status, last_activity_at);


-- 2. Trigger to keep `poker_tables.last_activity_at` fresh on any seat or hand change
create or replace function public.touch_poker_table_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_table_name = 'table_seats' then
    if tg_op = 'INSERT' or new.status = 'left' or (old.status = 'left' and new.status = 'active') then
      new.consecutive_timeouts := 0;
    end if;
  end if;
  update public.poker_tables
  set last_activity_at = now()
  where id = new.table_id;
  return new;
end;
$$;

revoke all on function public.touch_poker_table_activity() from public, anon, authenticated;
grant execute on function public.touch_poker_table_activity() to service_role;

drop trigger if exists table_seats_touch_activity_trg on public.table_seats;
create trigger table_seats_touch_activity_trg
  before insert or update on public.table_seats
  for each row
  execute function public.touch_poker_table_activity();

drop trigger if exists hands_touch_activity_trg on public.hands;
create trigger hands_touch_activity_trg
  after insert or update on public.hands
  for each row
  execute function public.touch_poker_table_activity();


-- 3. Automatically close empty tables with no activity for 30 minutes (`service_role` only)
create or replace function public.close_idle_tables(
  p_now timestamptz default now()
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_closed_count integer := 0;
begin
  if session_user in ('anon', 'authenticated')
     or coalesce(current_setting('request.jwt.claim.role', true), 'service_role') not in ('service_role', '') then
    raise exception 'ERR_FORBIDDEN: close_idle_tables requires service_role' using errcode = '42501';
  end if;

  with closed as (
    update public.poker_tables t
    set status = 'closed',
        closed_at = coalesce(p_now, now())
    where t.status in ('open', 'playing')
      and coalesce(t.last_activity_at, t.created_at) <= coalesce(p_now, now()) - interval '30 minutes'
      and not exists (
        select 1
        from public.table_seats ts
        where ts.table_id = t.id
          and (ts.status in ('active', 'sitout') or ts.stack > 0)
      )
      and not exists (
        select 1
        from public.hands h
        where h.table_id = t.id
          and h.ended_at is null
      )
    returning t.id
  )
  select count(*)::integer into v_closed_count from closed;

  return v_closed_count;
end;
$$;

revoke all on function public.close_idle_tables(timestamptz) from public, anon, authenticated;
grant execute on function public.close_idle_tables(timestamptz) to service_role;


-- 4. Update host cap trigger so 30-minute idle empty tables are closed before counting open tables
create or replace function public.enforce_max_open_tables_per_host()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_open_count integer;
begin
  if new.status in ('open', 'playing') then
    perform pg_advisory_xact_lock(hashtextextended(new.host_id::text, 1));

    -- Opportunistically close any empty tables idle for >= 30 minutes so hosts are never locked out.
    perform public.close_idle_tables(now());

    select count(*)::integer
    into v_open_count
    from public.poker_tables
    where host_id = new.host_id
      and status in ('open', 'playing')
      and id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid);

    if v_open_count >= 3 then
      raise exception 'ERR_TOO_MANY_OPEN_TABLES: host already has % open tables (max 3)', v_open_count
        using errcode = '55000';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_max_open_tables_per_host() from public, anon, authenticated;
grant execute on function public.enforce_max_open_tables_per_host() to service_role;


-- 5. Host `close_table` RPC when table is empty (`service_role` only)
create or replace function public.close_table(
  p_table_id uuid,
  p_host_id uuid
)
returns public.poker_tables
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table public.poker_tables%rowtype;
begin
  if session_user in ('anon', 'authenticated')
     or coalesce(current_setting('request.jwt.claim.role', true), 'service_role') not in ('service_role', '') then
    raise exception 'ERR_FORBIDDEN: close_table requires service_role' using errcode = '42501';
  end if;

  if p_table_id is null or p_host_id is null then
    raise exception 'ERR_INVALID_ARGS: table_id and host_id are required' using errcode = '22023';
  end if;

  select *
  into v_table
  from public.poker_tables
  where id = p_table_id
  for update;

  if not found then
    raise exception 'ERR_TABLE_NOT_FOUND: table % does not exist', p_table_id using errcode = 'P0002';
  end if;

  if v_table.host_id <> p_host_id then
    raise exception 'ERR_NOT_HOST: only the table host can close this table' using errcode = '42501';
  end if;

  if v_table.status = 'closed' then
    return v_table;
  end if;

  if exists (
    select 1
    from public.hands
    where table_id = p_table_id
      and ended_at is null
  ) then
    raise exception 'ERR_HAND_IN_PROGRESS: cannot close table while a hand is active' using errcode = '55000';
  end if;

  if exists (
    select 1
    from public.table_seats
    where table_id = p_table_id
      and (status in ('active', 'sitout') or stack > 0)
  ) then
    raise exception 'ERR_TABLE_NOT_EMPTY: table cannot be closed while players are seated' using errcode = '55000';
  end if;

  update public.poker_tables
  set status = 'closed',
      closed_at = now(),
      last_activity_at = now()
  where id = p_table_id
  returning * into v_table;

  return v_table;
end;
$$;

revoke all on function public.close_table(uuid, uuid) from public, anon, authenticated;
grant execute on function public.close_table(uuid, uuid) to service_role;


-- 6. Toggle seat status (`active` <-> `sitout`) and reset consecutive timeouts (`service_role` only)
create or replace function public.set_seat_status(
  p_table_id uuid,
  p_member_id uuid,
  p_status text
)
returns public.table_seats
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seat public.table_seats%rowtype;
begin
  if session_user in ('anon', 'authenticated')
     or coalesce(current_setting('request.jwt.claim.role', true), 'service_role') not in ('service_role', '') then
    raise exception 'ERR_FORBIDDEN: set_seat_status requires service_role' using errcode = '42501';
  end if;

  if p_table_id is null or p_member_id is null or p_status not in ('active', 'sitout') then
    raise exception 'ERR_INVALID_ARGS: valid table_id, member_id, and status (active|sitout) are required'
      using errcode = '22023';
  end if;

  perform 1
  from public.poker_tables
  where id = p_table_id
  for update;

  update public.table_seats
  set status = p_status,
      consecutive_timeouts = case when p_status = 'active' then 0 else consecutive_timeouts end
  where table_id = p_table_id
    and member_id = p_member_id
    and status in ('active', 'sitout')
  returning * into v_seat;

  if not found then
    raise exception 'ERR_NOT_SEATED: member is not seated at this table' using errcode = 'P0002';
  end if;

  return v_seat;
end;
$$;

revoke all on function public.set_seat_status(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.set_seat_status(uuid, uuid, text) to service_role;


-- 7. Update `apply_hand_tx` so `p_seat_stacks` atomically updates `consecutive_timeouts` and `status`
create or replace function public.apply_hand_tx(
  p_hand_id uuid,
  p_expected_action_seq integer,
  p_board jsonb,
  p_pot integer,
  p_state jsonb,
  p_showdown jsonb default null,
  p_ended_at timestamptz default null,
  p_seat_stacks jsonb default '[]'::jsonb,
  p_hole_cards jsonb default '[]'::jsonb,
  p_actions jsonb default '[]'::jsonb,
  p_table_status text default null
)
returns public.hands
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hand public.hands%rowtype;
  v_table public.poker_tables%rowtype;
  v_current_seq integer;
  v_next_seq integer;
  v_chips_before integer;
  v_seats_after integer;
  v_pot_after integer;
  v_seat_item jsonb;
  v_seat_no integer;
  v_new_stack integer;
  v_new_status text;
  v_new_timeouts integer;
  v_card_item jsonb;
  v_action_item jsonb;
  v_resolved_table_status text;
begin
  if session_user in ('anon', 'authenticated')
     or coalesce(current_setting('request.jwt.claim.role', true), 'service_role') not in ('service_role', '') then
    raise exception 'ERR_FORBIDDEN: apply_hand_tx requires service_role' using errcode = '42501';
  end if;

  if p_hand_id is null or p_expected_action_seq is null or p_pot is null or p_pot < 0 or p_state is null then
    raise exception 'ERR_INVALID_ARGS: invalid hand transition arguments' using errcode = '22023';
  end if;

  select *
  into v_hand
  from public.hands
  where id = p_hand_id
  for update;

  if not found then
    raise exception 'ERR_HAND_NOT_FOUND: hand % does not exist', p_hand_id using errcode = 'P0002';
  end if;

  if v_hand.ended_at is not null then
    raise exception 'ERR_NO_ACTIVE_HAND: hand % has already ended', p_hand_id using errcode = '55000';
  end if;

  select *
  into v_table
  from public.poker_tables
  where id = v_hand.table_id
  for update;

  if not found then
    raise exception 'ERR_TABLE_NOT_FOUND: table % does not exist', v_hand.table_id using errcode = 'P0002';
  end if;

  v_current_seq := coalesce((v_hand.state->>'actionSeq')::integer, 0);
  if v_current_seq <> p_expected_action_seq then
    raise exception 'ERR_STALE_ACTION_SEQ: expected actionSeq %, got %', p_expected_action_seq, v_current_seq
      using errcode = '40001';
  end if;

  v_next_seq := coalesce((p_state->>'actionSeq')::integer, -1);
  if v_next_seq <> p_expected_action_seq + 1 then
    raise exception 'ERR_STALE_ACTION_SEQ: next state actionSeq must be %, got %', p_expected_action_seq + 1, v_next_seq
      using errcode = '40001';
  end if;

  perform 1
  from public.table_seats
  where table_id = v_hand.table_id
    and status in ('active', 'sitout')
  for update;

  select coalesce(sum(stack), 0)::integer + v_hand.pot
  into v_chips_before
  from public.table_seats
  where table_id = v_hand.table_id
    and status in ('active', 'sitout');

  for v_seat_item in select * from jsonb_array_elements(coalesce(p_seat_stacks, '[]'::jsonb))
  loop
    v_seat_no := coalesce((v_seat_item->>'seatNo')::integer, (v_seat_item->>'seat_no')::integer);
    v_new_stack := (v_seat_item->>'stack')::integer;
    v_new_status := nullif(v_seat_item->>'status', '');
    v_new_timeouts := coalesce(
      (v_seat_item->>'consecutiveTimeouts')::integer,
      (v_seat_item->>'consecutive_timeouts')::integer
    );

    if v_seat_no is null or v_new_stack is null or v_new_stack < 0 then
      raise exception 'ERR_INVALID_ARGS: invalid seat stack update %', v_seat_item using errcode = '22023';
    end if;

    update public.table_seats
    set stack = v_new_stack,
        status = coalesce(v_new_status, status),
        consecutive_timeouts = coalesce(v_new_timeouts, consecutive_timeouts)
    where table_id = v_hand.table_id
      and seat_no = v_seat_no
      and status in ('active', 'sitout');

    if not found then
      raise exception 'ERR_NOT_SEATED: active seat % not found at table %', v_seat_no, v_hand.table_id
        using errcode = 'P0002';
    end if;
  end loop;

  select coalesce(sum(stack), 0)::integer
  into v_seats_after
  from public.table_seats
  where table_id = v_hand.table_id
    and status in ('active', 'sitout');

  v_pot_after := case when p_ended_at is null then p_pot else 0 end;

  if v_seats_after + v_pot_after <> v_chips_before then
    raise exception 'ERR_CHIP_CONSERVATION: table chip total changed during apply_hand_tx (before=%, after=%)',
      v_chips_before, v_seats_after + v_pot_after
      using errcode = '55000';
  end if;

  update public.hands
  set board = coalesce(p_board, '[]'::jsonb),
      pot = p_pot,
      state = p_state,
      showdown = p_showdown,
      ended_at = p_ended_at
  where id = p_hand_id
  returning * into v_hand;

  for v_card_item in select * from jsonb_array_elements(coalesce(p_hole_cards, '[]'::jsonb))
  loop
    insert into public.hole_cards (hand_id, member_id, cards)
    values (
      p_hand_id,
      coalesce((v_card_item->>'member_id')::uuid, (v_card_item->>'memberId')::uuid),
      v_card_item->'cards'
    )
    on conflict (hand_id, member_id) do update
      set cards = excluded.cards;
  end loop;

  for v_action_item in select * from jsonb_array_elements(coalesce(p_actions, '[]'::jsonb))
  loop
    insert into public.hand_actions (hand_id, seat_no, action, amount)
    values (
      p_hand_id,
      coalesce((v_action_item->>'seat_no')::integer, (v_action_item->>'seatNo')::integer),
      v_action_item->>'action',
      coalesce((v_action_item->>'amount')::integer, 0)
    );
  end loop;

  v_resolved_table_status := coalesce(
    nullif(p_table_status, ''),
    case when p_ended_at is not null then 'open' else 'playing' end
  );

  update public.poker_tables
  set status = v_resolved_table_status,
      last_activity_at = now()
  where id = v_hand.table_id;

  return v_hand;
end;
$$;

revoke all on function public.apply_hand_tx(uuid, integer, jsonb, integer, jsonb, jsonb, timestamptz, jsonb, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.apply_hand_tx(uuid, integer, jsonb, integer, jsonb, jsonb, timestamptz, jsonb, jsonb, jsonb, text) to service_role;


-- 8. Schedule background idle table cleanup via `pg_cron` if the extension is available
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.unschedule('kth-poker-close-idle-tables');
    exception when others then
      null;
    end;
    perform cron.schedule(
      'kth-poker-close-idle-tables',
      '*/5 * * * *',
      $cron$select public.close_idle_tables(now());$cron$
    );
  end if;
exception when others then
  null;
end;
$$;
