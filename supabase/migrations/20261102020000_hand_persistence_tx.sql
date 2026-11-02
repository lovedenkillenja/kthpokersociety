-- M3c: Atomic hand persistence transactions (`start_hand_tx` and `apply_hand_tx`)
-- and host open-table limit (max 3 open/playing tables per host).
-- Additive migration; callable ONLY by `service_role`.

-- 1. Enforce at most 3 open/playing tables per host at the database level
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

drop trigger if exists poker_tables_max_open_per_host_trg on public.poker_tables;
create trigger poker_tables_max_open_per_host_trg
  before insert on public.poker_tables
  for each row
  execute function public.enforce_max_open_tables_per_host();


-- 2. Atomic hand start transaction (`start_hand_tx`) – callable ONLY by `service_role`
-- In ONE transaction:
--   * locks `poker_tables` and the latest `hands` row for the table with `FOR UPDATE`
--   * verifies no hand is currently open and checks initial `actionSeq = 0`
--   * inserts the new `hands` row
--   * updates `table_seats.stack` (and optional seat `status`)
--   * inserts `hole_cards`
--   * inserts initial `hand_actions` (blinds)
--   * updates `poker_tables.status`
--   * verifies table chip conservation before vs after
create or replace function public.start_hand_tx(
  p_table_id uuid,
  p_hand_no integer,
  p_dealer_seat integer,
  p_board text[],
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
  v_table public.poker_tables%rowtype;
  v_prev_hand public.hands%rowtype;
  v_hand public.hands%rowtype;
  v_initial_seq integer;
  v_seats_before bigint;
  v_pots_before bigint;
  v_chips_before bigint;
  v_seats_after bigint;
  v_pots_after bigint;
  v_elem jsonb;
  v_seat_no integer;
  v_stack integer;
  v_seat_status text;
  v_next_table_status text;
begin
  if session_user in ('anon', 'authenticated')
     or coalesce(current_setting('request.jwt.claim.role', true), 'service_role') not in ('service_role', '') then
    raise exception 'ERR_FORBIDDEN: start_hand_tx requires service_role' using errcode = '42501';
  end if;

  if p_table_id is null or p_hand_no is null or p_dealer_seat is null or p_pot is null or p_state is null then
    raise exception 'ERR_INVALID_ARGS: table_id, hand_no, dealer_seat, pot, and state are required'
      using errcode = '22023';
  end if;

  if p_pot < 0 then
    raise exception 'ERR_INVALID_ARGS: pot cannot be negative' using errcode = '22023';
  end if;

  -- Lock the table row first to serialize all table/hand/seat transitions on this table.
  select *
  into v_table
  from public.poker_tables
  where id = p_table_id
  for update;

  if not found then
    raise exception 'ERR_TABLE_NOT_FOUND: table % does not exist', p_table_id using errcode = 'P0002';
  end if;

  if v_table.status = 'closed' then
    raise exception 'ERR_TABLE_CLOSED: table % is closed', v_table.code using errcode = '55000';
  end if;

  -- Lock the most recent hand row for this table with FOR UPDATE (if one exists).
  select *
  into v_prev_hand
  from public.hands
  where table_id = p_table_id
  order by hand_no desc
  limit 1
  for update;

  if found and v_prev_hand.ended_at is null then
    raise exception 'ERR_HAND_IN_PROGRESS: a hand is already in progress at this table'
      using errcode = '23505';
  end if;

  if p_hand_no <> coalesce(v_prev_hand.hand_no, 0) + 1 then
    raise exception 'ERR_STALE_HAND: expected hand_no %, got %', coalesce(v_prev_hand.hand_no, 0) + 1, p_hand_no
      using errcode = '40001';
  end if;

  v_initial_seq := coalesce((p_state->>'actionSeq')::integer, 0);
  if v_initial_seq <> 0 then
    raise exception 'ERR_STALE_ACTION_SEQ: expected initial actionSeq 0, got %', v_initial_seq
      using errcode = '40001';
  end if;

  -- Measure table chips before mutation.
  select coalesce(sum(stack), 0)::bigint
  into v_seats_before
  from public.table_seats
  where table_id = p_table_id
    and status in ('active', 'sitout');

  select coalesce(sum(pot), 0)::bigint
  into v_pots_before
  from public.hands
  where table_id = p_table_id
    and ended_at is null;

  v_chips_before := v_seats_before + v_pots_before;

  -- 1. Insert the new hand row.
  insert into public.hands (
    table_id,
    hand_no,
    dealer_seat,
    board,
    pot,
    state,
    showdown,
    ended_at
  )
  values (
    p_table_id,
    p_hand_no,
    p_dealer_seat,
    coalesce(p_board, '{}'::text[]),
    p_pot,
    p_state,
    p_showdown,
    p_ended_at
  )
  returning * into v_hand;

  -- 2. Update `table_seats.stack` (and optional seat status).
  for v_elem in select * from jsonb_array_elements(coalesce(p_seat_stacks, '[]'::jsonb))
  loop
    v_seat_no := coalesce((v_elem->>'seatNo')::integer, (v_elem->>'seat_no')::integer);
    v_stack := (v_elem->>'stack')::integer;
    v_seat_status := v_elem->>'status';

    if v_seat_no is null or v_stack is null or v_stack < 0 then
      raise exception 'ERR_INVALID_ARGS: invalid seat stack entry %', v_elem using errcode = '22023';
    end if;

    update public.table_seats
    set stack = v_stack,
        status = coalesce(v_seat_status, status)
    where table_id = p_table_id
      and seat_no = v_seat_no
      and status in ('active', 'sitout');

    if not found then
      raise exception 'ERR_NOT_SEATED: active seat % not found at table %', v_seat_no, v_table.code
        using errcode = 'P0002';
    end if;
  end loop;

  -- 3. Insert private hole cards for each dealt seat.
  for v_elem in select * from jsonb_array_elements(coalesce(p_hole_cards, '[]'::jsonb))
  loop
    insert into public.hole_cards (hand_id, member_id, cards)
    values (
      v_hand.id,
      coalesce((v_elem->>'member_id')::uuid, (v_elem->>'memberId')::uuid),
      array(select jsonb_array_elements_text(v_elem->'cards'))
    );
  end loop;

  -- 4. Insert initial hand actions (e.g., `post-sb`, `post-bb`).
  for v_elem in select * from jsonb_array_elements(coalesce(p_actions, '[]'::jsonb))
  loop
    insert into public.hand_actions (hand_id, seat_no, action, amount)
    values (
      v_hand.id,
      coalesce((v_elem->>'seat_no')::integer, (v_elem->>'seatNo')::integer),
      v_elem->>'action',
      coalesce((v_elem->>'amount')::integer, 0)
    );
  end loop;

  -- 5. Update `poker_tables.status`.
  v_next_table_status := coalesce(
    p_table_status,
    case when p_ended_at is null then 'playing' else 'open' end
  );

  update public.poker_tables
  set status = v_next_table_status
  where id = p_table_id;

  -- Verify chip conservation across table seats + open hand pot.
  select coalesce(sum(stack), 0)::bigint
  into v_seats_after
  from public.table_seats
  where table_id = p_table_id
    and status in ('active', 'sitout');

  select coalesce(sum(pot), 0)::bigint
  into v_pots_after
  from public.hands
  where table_id = p_table_id
    and ended_at is null;

  if (v_seats_after + v_pots_after) <> v_chips_before then
    raise exception 'ERR_CHIP_CONSERVATION: table chip total changed from % to %',
      v_chips_before, (v_seats_after + v_pots_after)
      using errcode = '55000';
  end if;

  return v_hand;
end;
$$;

revoke all on function public.start_hand_tx(
  uuid, integer, integer, text[], integer, jsonb, jsonb, timestamptz, jsonb, jsonb, jsonb, text
) from public, anon, authenticated;

grant execute on function public.start_hand_tx(
  uuid, integer, integer, text[], integer, jsonb, jsonb, timestamptz, jsonb, jsonb, jsonb, text
) to service_role;


-- 3. Atomic hand action/settlement transaction (`apply_hand_tx`) – callable ONLY by `service_role`
-- In ONE transaction:
--   * locks `poker_tables` and the `hands` row with `FOR UPDATE`
--   * verifies the hand is still open and `state->>'actionSeq'` matches `p_expected_action_seq`
--   * updates `hands` (`board`, `pot`, `state`, `showdown`, `ended_at`)
--   * updates `table_seats.stack` (and optional seat `status`)
--   * upserts any `hole_cards` rows (if provided)
--   * inserts new `hand_actions` rows
--   * updates `poker_tables.status`
--   * verifies table chip conservation before vs after
create or replace function public.apply_hand_tx(
  p_hand_id uuid,
  p_expected_action_seq integer,
  p_board text[],
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
  v_table_id uuid;
  v_table public.poker_tables%rowtype;
  v_hand public.hands%rowtype;
  v_current_seq integer;
  v_seats_before bigint;
  v_pots_before bigint;
  v_chips_before bigint;
  v_seats_after bigint;
  v_pots_after bigint;
  v_elem jsonb;
  v_seat_no integer;
  v_stack integer;
  v_seat_status text;
  v_next_table_status text;
begin
  if session_user in ('anon', 'authenticated')
     or coalesce(current_setting('request.jwt.claim.role', true), 'service_role') not in ('service_role', '') then
    raise exception 'ERR_FORBIDDEN: apply_hand_tx requires service_role' using errcode = '42501';
  end if;

  if p_hand_id is null or p_expected_action_seq is null or p_pot is null or p_state is null then
    raise exception 'ERR_INVALID_ARGS: hand_id, expected_action_seq, pot, and state are required'
      using errcode = '22023';
  end if;

  if p_pot < 0 then
    raise exception 'ERR_INVALID_ARGS: pot cannot be negative' using errcode = '22023';
  end if;

  select table_id
  into v_table_id
  from public.hands
  where id = p_hand_id;

  if not found then
    raise exception 'ERR_HAND_NOT_FOUND: hand % does not exist', p_hand_id using errcode = 'P0002';
  end if;

  -- Lock table row first (consistent lock order with sit_down, leave_seat, and start_hand_tx).
  select *
  into v_table
  from public.poker_tables
  where id = v_table_id
  for update;

  -- Lock the hands row with FOR UPDATE.
  select *
  into v_hand
  from public.hands
  where id = p_hand_id
  for update;

  if v_hand.ended_at is not null then
    raise exception 'ERR_NO_ACTIVE_HAND: hand % has already ended', p_hand_id using errcode = '55000';
  end if;

  v_current_seq := coalesce((v_hand.state->>'actionSeq')::integer, 0);
  if v_current_seq <> p_expected_action_seq then
    raise exception 'ERR_STALE_ACTION_SEQ: expected actionSeq %, got %', p_expected_action_seq, v_current_seq
      using errcode = '40001';
  end if;

  -- Measure table chips before mutation.
  select coalesce(sum(stack), 0)::bigint
  into v_seats_before
  from public.table_seats
  where table_id = v_table_id
    and status in ('active', 'sitout');

  select coalesce(sum(pot), 0)::bigint
  into v_pots_before
  from public.hands
  where table_id = v_table_id
    and ended_at is null;

  v_chips_before := v_seats_before + v_pots_before;

  -- 1. Update the locked `hands` row.
  update public.hands
  set board = coalesce(p_board, board),
      pot = p_pot,
      state = p_state,
      showdown = p_showdown,
      ended_at = p_ended_at
  where id = p_hand_id
  returning * into v_hand;

  -- 2. Update `table_seats.stack` (and optional seat status).
  for v_elem in select * from jsonb_array_elements(coalesce(p_seat_stacks, '[]'::jsonb))
  loop
    v_seat_no := coalesce((v_elem->>'seatNo')::integer, (v_elem->>'seat_no')::integer);
    v_stack := (v_elem->>'stack')::integer;
    v_seat_status := v_elem->>'status';

    if v_seat_no is null or v_stack is null or v_stack < 0 then
      raise exception 'ERR_INVALID_ARGS: invalid seat stack entry %', v_elem using errcode = '22023';
    end if;

    update public.table_seats
    set stack = v_stack,
        status = coalesce(v_seat_status, status)
    where table_id = v_table_id
      and seat_no = v_seat_no
      and status in ('active', 'sitout');

    if not found then
      raise exception 'ERR_NOT_SEATED: active seat % not found at table %', v_seat_no, v_table.code
        using errcode = 'P0002';
    end if;
  end loop;

  -- 3. Upsert `hole_cards` if provided.
  for v_elem in select * from jsonb_array_elements(coalesce(p_hole_cards, '[]'::jsonb))
  loop
    insert into public.hole_cards (hand_id, member_id, cards)
    values (
      v_hand.id,
      coalesce((v_elem->>'member_id')::uuid, (v_elem->>'memberId')::uuid),
      array(select jsonb_array_elements_text(v_elem->'cards'))
    )
    on conflict (hand_id, member_id) do update
      set cards = excluded.cards;
  end loop;

  -- 4. Insert new `hand_actions` rows.
  for v_elem in select * from jsonb_array_elements(coalesce(p_actions, '[]'::jsonb))
  loop
    insert into public.hand_actions (hand_id, seat_no, action, amount)
    values (
      v_hand.id,
      coalesce((v_elem->>'seat_no')::integer, (v_elem->>'seatNo')::integer),
      v_elem->>'action',
      coalesce((v_elem->>'amount')::integer, 0)
    );
  end loop;

  -- 5. Update `poker_tables.status`.
  v_next_table_status := coalesce(
    p_table_status,
    case when p_ended_at is null then 'playing' else 'open' end
  );

  update public.poker_tables
  set status = v_next_table_status
  where id = v_table_id;

  -- Verify chip conservation across table seats + open hand pot.
  select coalesce(sum(stack), 0)::bigint
  into v_seats_after
  from public.table_seats
  where table_id = v_table_id
    and status in ('active', 'sitout');

  select coalesce(sum(pot), 0)::bigint
  into v_pots_after
  from public.hands
  where table_id = v_table_id
    and ended_at is null;

  if (v_seats_after + v_pots_after) <> v_chips_before then
    raise exception 'ERR_CHIP_CONSERVATION: table chip total changed from % to %',
      v_chips_before, (v_seats_after + v_pots_after)
      using errcode = '55000';
  end if;

  return v_hand;
end;
$$;

revoke all on function public.apply_hand_tx(
  uuid, integer, text[], integer, jsonb, jsonb, timestamptz, jsonb, jsonb, jsonb, text
) from public, anon, authenticated;

grant execute on function public.apply_hand_tx(
  uuid, integer, text[], integer, jsonb, jsonb, timestamptz, jsonb, jsonb, jsonb, text
) to service_role;
