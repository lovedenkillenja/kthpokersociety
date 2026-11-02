-- M3a: Poker tables, seats, hands, hole cards, hand actions, RLS policies,
-- and transactional service_role-only buy-in / cash-out functions.
-- Additive migration; does not alter existing tables (`members`, `chip_profiles`, `chip_ledger`).

-- 1. Poker tables
create table public.poker_tables (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (char_length(code) = 5 and code ~ '^[A-Z0-9]{5}$'),
  host_id uuid not null references public.members(id) on delete restrict,
  sb integer not null default 10 check (sb > 0 and sb <= 10000),
  bb integer not null default 20 check (bb >= sb and bb <= 20000),
  min_buyin integer not null default 400 check (min_buyin > 0 and min_buyin <= 100000),
  max_buyin integer not null default 2000 check (max_buyin >= min_buyin and max_buyin <= 100000),
  max_seats integer not null default 6 check (max_seats between 2 and 6),
  status text not null default 'open' check (status in ('open', 'playing', 'closed')),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  check (status <> 'closed' or closed_at is not null)
);

create index poker_tables_status_idx on public.poker_tables (status, created_at desc);

alter table public.poker_tables enable row level security;

-- Clients can only read tables when authenticated; all writes happen via Edge Function (service_role).
revoke insert, update, delete on public.poker_tables from anon, authenticated;

create policy "Authenticated members read poker tables"
  on public.poker_tables
  for select
  to authenticated
  using ((select auth.uid()) is not null);


-- 2. Table seats
create table public.table_seats (
  table_id uuid not null references public.poker_tables(id) on delete cascade,
  seat_no integer not null check (seat_no between 0 and 5),
  member_id uuid not null references public.members(id) on delete restrict,
  stack integer not null check (stack >= 0 and stack <= 1000000),
  status text not null default 'active' check (status in ('active', 'sitout', 'left')),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  primary key (table_id, seat_no),
  -- A seat that has left the table may never retain chips.
  check (status <> 'left' or stack = 0)
);

-- Enforce at most one active/sitout seat per member per table.
create unique index table_seats_one_active_seat_per_member_uniq
  on public.table_seats (table_id, member_id)
  where status in ('active', 'sitout');

create index table_seats_member_idx on public.table_seats (member_id)
  where status in ('active', 'sitout');

alter table public.table_seats enable row level security;

revoke insert, update, delete on public.table_seats from anon, authenticated;

create policy "Authenticated members read table seats"
  on public.table_seats
  for select
  to authenticated
  using ((select auth.uid()) is not null);


-- 3. Hands (`state` is server-only and contains the deck; clients never select from `hands` directly)
create table public.hands (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.poker_tables(id) on delete cascade,
  hand_no integer not null check (hand_no >= 1),
  dealer_seat integer not null check (dealer_seat between 0 and 5),
  board text[] not null default '{}'::text[] check (cardinality(board) <= 5),
  pot integer not null default 0 check (pot >= 0 and pot <= 10000000),
  state jsonb not null,
  showdown jsonb,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (table_id, hand_no)
);

-- At most one active (unended) hand per table at a time.
create unique index hands_one_active_per_table_uniq
  on public.hands (table_id)
  where ended_at is null;

create index hands_table_started_idx on public.hands (table_id, hand_no desc);

alter table public.hands enable row level security;

-- Revoke all table-level privileges from clients so `hands.state` (which holds the deck
-- and full server state) is unreadable even if queried directly.
revoke all on public.hands from public, anon, authenticated;

-- Grant column-level SELECT only on non-secret columns so the `security_invoker` view works
-- while any SELECT referencing `hands.state` (or `SELECT * FROM hands`) is denied by Postgres.
grant select (
  id,
  table_id,
  hand_no,
  dealer_seat,
  board,
  pot,
  showdown,
  started_at,
  ended_at
) on public.hands to authenticated;

create policy "Authenticated members read public hand columns"
  on public.hands
  for select
  to authenticated
  using ((select auth.uid()) is not null);

-- Safe public view exposing only board, pot, dealer_seat, and status (never `state`).
create view public.public_hands with (security_invoker = true) as
  select
    id,
    table_id,
    hand_no,
    dealer_seat,
    board,
    pot,
    showdown,
    case when ended_at is null then 'playing' else 'complete' end as status,
    started_at,
    ended_at
  from public.hands;

revoke all on public.public_hands from public, anon;
grant select on public.public_hands to authenticated, service_role;


-- 4. Hole cards (private per member; RLS permits selecting only own rows)
create table public.hole_cards (
  hand_id uuid not null references public.hands(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  cards text[] not null check (cardinality(cards) = 2),
  created_at timestamptz not null default now(),
  primary key (hand_id, member_id)
);

create index hole_cards_member_idx on public.hole_cards (member_id, hand_id);

alter table public.hole_cards enable row level security;

revoke insert, update, delete on public.hole_cards from anon, authenticated;

create policy "Members read own hole cards"
  on public.hole_cards
  for select
  to authenticated
  using ((select auth.uid()) = member_id);


-- 5. Hand actions (public, append-only audit log of actions)
create table public.hand_actions (
  id bigint generated always as identity primary key,
  hand_id uuid not null references public.hands(id) on delete cascade,
  seat_no integer not null check (seat_no between 0 and 5),
  action text not null check (
    action in (
      'post-sb',
      'post-bb',
      'fold',
      'check',
      'call',
      'bet',
      'raise',
      'all-in',
      'timeout-fold',
      'showdown',
      'win'
    )
  ),
  amount integer not null default 0 check (amount >= 0 and amount <= 1000000),
  created_at timestamptz not null default now()
);

create index hand_actions_hand_idx on public.hand_actions (hand_id, id asc);

alter table public.hand_actions enable row level security;

revoke insert, update, delete on public.hand_actions from anon, authenticated;

create policy "Authenticated members read hand actions"
  on public.hand_actions
  for select
  to authenticated
  using ((select auth.uid()) is not null);


-- 6. Transactional Buy-In Function (`sit_down`) – callable ONLY by `service_role`
create or replace function public.sit_down(
  p_table_id uuid,
  p_member_id uuid,
  p_seat_no integer,
  p_buyin integer
)
returns public.table_seats
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table public.poker_tables%rowtype;
  v_balance integer;
  v_active_count integer;
  v_ref text;
  v_seat public.table_seats%rowtype;
begin
  -- Defense-in-depth: reject any non-service-role caller even if grants are misconfigured.
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
     and current_user not in ('postgres', 'supabase_admin', 'service_role') then
    raise exception 'ERR_FORBIDDEN: sit_down requires service_role' using errcode = '42501';
  end if;

  if p_table_id is null or p_member_id is null or p_seat_no is null or p_buyin is null then
    raise exception 'ERR_INVALID_ARGS: table, member, seat, and buyin are required' using errcode = '22023';
  end if;

  -- Serialize all chip operations for this member across all tables (prevents double-buy-in race).
  perform pg_advisory_xact_lock(hashtextextended(p_member_id::text, 0));

  perform 1
  from public.members
  where id = p_member_id
  for update;

  if not found then
    raise exception 'ERR_NOT_A_MEMBER: member % does not exist', p_member_id using errcode = '23503';
  end if;

  -- Lock table row to serialize seat changes on this table.
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

  if p_seat_no < 0 or p_seat_no >= v_table.max_seats then
    raise exception 'ERR_INVALID_SEAT: seat_no % out of range (0..%)', p_seat_no, v_table.max_seats - 1 using errcode = '22023';
  end if;

  if p_buyin < v_table.min_buyin or p_buyin > v_table.max_buyin then
    raise exception 'ERR_INVALID_BUYIN: buy-in % must be between % and %', p_buyin, v_table.min_buyin, v_table.max_buyin using errcode = '22023';
  end if;

  -- Ensure member is not already seated at this table.
  if exists (
    select 1
    from public.table_seats
    where table_id = p_table_id
      and member_id = p_member_id
      and status in ('active', 'sitout')
  ) then
    raise exception 'ERR_ALREADY_SEATED: member is already seated at this table' using errcode = '23505';
  end if;

  -- Ensure target seat is not currently occupied.
  if exists (
    select 1
    from public.table_seats
    where table_id = p_table_id
      and seat_no = p_seat_no
      and status in ('active', 'sitout')
  ) then
    raise exception 'ERR_SEAT_TAKEN: seat % is already occupied', p_seat_no using errcode = '23505';
  end if;

  select count(*)::integer
  into v_active_count
  from public.table_seats
  where table_id = p_table_id
    and status in ('active', 'sitout');

  if v_active_count >= v_table.max_seats then
    raise exception 'ERR_TABLE_FULL: table % is full', v_table.code using errcode = '55000';
  end if;

  -- Check member ledger balance while holding the member advisory lock.
  select coalesce(sum(delta), 0)::integer
  into v_balance
  from public.chip_ledger
  where member_id = p_member_id;

  if v_balance < p_buyin then
    raise exception 'ERR_INSUFFICIENT_CHIPS: balance % is less than buy-in %', v_balance, p_buyin using errcode = '55000';
  end if;

  -- Unique buy-in reference per SPEC.md (`buyin:<table>:<seat>:<ts>`).
  v_ref := format(
    'buyin:%s:%s:%s:%s',
    p_table_id,
    p_seat_no,
    floor(extract(epoch from clock_timestamp()) * 1000)::bigint,
    substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)
  );

  insert into public.chip_ledger (member_id, delta, reason, source, ref)
  values (
    p_member_id,
    -p_buyin,
    format('Buy-in at table %s (seat %s)', v_table.code, p_seat_no),
    'game',
    v_ref
  );

  insert into public.table_seats as ts (table_id, seat_no, member_id, stack, status, joined_at, left_at)
  values (p_table_id, p_seat_no, p_member_id, p_buyin, 'active', now(), null)
  on conflict (table_id, seat_no) do update
    set member_id = excluded.member_id,
        stack = excluded.stack,
        status = 'active',
        joined_at = now(),
        left_at = null
    where ts.status = 'left'
  returning * into v_seat;

  if not found then
    raise exception 'ERR_SEAT_TAKEN: seat % is already occupied', p_seat_no using errcode = '23505';
  end if;

  return v_seat;
end;
$$;

revoke all on function public.sit_down(uuid, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.sit_down(uuid, uuid, integer, integer) to service_role;


-- 7. Transactional Cash-Out Function (`leave_seat`) – callable ONLY by `service_role`
create or replace function public.leave_seat(
  p_table_id uuid,
  p_member_id uuid
)
returns public.table_seats
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table public.poker_tables%rowtype;
  v_seat public.table_seats%rowtype;
  v_cashout integer;
  v_ref text;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
     and current_user not in ('postgres', 'supabase_admin', 'service_role') then
    raise exception 'ERR_FORBIDDEN: leave_seat requires service_role' using errcode = '42501';
  end if;

  if p_table_id is null or p_member_id is null then
    raise exception 'ERR_INVALID_ARGS: table and member are required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_member_id::text, 0));

  select *
  into v_table
  from public.poker_tables
  where id = p_table_id
  for update;

  if not found then
    raise exception 'ERR_TABLE_NOT_FOUND: table % does not exist', p_table_id using errcode = 'P0002';
  end if;

  if exists (
    select 1
    from public.hands
    where table_id = p_table_id
      and ended_at is null
  ) then
    raise exception 'ERR_HAND_IN_PROGRESS: active hand must be settled before cashing out seat' using errcode = '55000';
  end if;

  select *
  into v_seat
  from public.table_seats
  where table_id = p_table_id
    and member_id = p_member_id
    and status in ('active', 'sitout')
  for update;

  if not found then
    raise exception 'ERR_NOT_SEATED: member is not actively seated at table %', v_table.code using errcode = 'P0002';
  end if;

  v_cashout := v_seat.stack;

  -- Return positive stack to `chip_ledger` (`chip_ledger` requires `delta <> 0`).
  if v_cashout > 0 then
    v_ref := format(
      'cashout:%s:%s:%s:%s',
      p_table_id,
      v_seat.seat_no,
      floor(extract(epoch from clock_timestamp()) * 1000)::bigint,
      substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)
    );

    insert into public.chip_ledger (member_id, delta, reason, source, ref)
    values (
      p_member_id,
      v_cashout,
      format('Cash-out from table %s (seat %s)', v_table.code, v_seat.seat_no),
      'game',
      v_ref
    );
  end if;

  update public.table_seats
  set stack = 0,
      status = 'left',
      left_at = now()
  where table_id = p_table_id
    and seat_no = v_seat.seat_no
  returning * into v_seat;

  return v_seat;
end;
$$;

revoke all on function public.leave_seat(uuid, uuid) from public, anon, authenticated;
grant execute on function public.leave_seat(uuid, uuid) to service_role;
