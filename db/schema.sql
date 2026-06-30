-- ============================================================================
--  ORBIT — Supabase schema + Row-Level Security
--  Paste this whole file into  Supabase → SQL Editor → New query → Run.
--  Safe to re-run (everything is "if not exists" / "or replace").
-- ============================================================================

-- ---- PROFILES: one row per user --------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text,
  color       text default '#D8B06A',
  home_lat    double precision,
  home_lng    double precision,
  invite_code text unique default substr(md5(random()::text), 1, 6),
  created_at  timestamptz default now()
);

-- ---- FRIENDSHIPS: one row per pair, always stored with user_a < user_b ------
create table if not exists public.friendships (
  id         uuid primary key default gen_random_uuid(),
  user_a     uuid references public.profiles(id) on delete cascade,
  user_b     uuid references public.profiles(id) on delete cascade,
  since      date default current_date,
  created_at timestamptz default now(),
  unique (user_a, user_b),
  check (user_a < user_b)
);

-- ---- LOCATIONS: raw GPS fixes. PRIVATE to the owner (never shared raw) ------
create table if not exists public.locations (
  id          bigint generated always as identity primary key,
  user_id     uuid references public.profiles(id) on delete cascade,
  recorded_at timestamptz not null,
  lat         double precision not null,
  lng         double precision not null,
  accuracy    double precision,
  created_at  timestamptz default now()
);
create index if not exists locations_user_time on public.locations (user_id, recorded_at);

-- ---- DAILY_RECORDS: the computed "closest moment" per pair per local day ----
--  Written ONLY by the compute job (service role). Shared between the 2 friends.
--  replay = [{ t, a:{lat,lng}, b:{lat,lng} }]  where a = user_a's positions.
create table if not exists public.daily_records (
  id           uuid primary key default gen_random_uuid(),
  user_a       uuid references public.profiles(id) on delete cascade,
  user_b       uuid references public.profiles(id) on delete cascade,
  day          date not null,                  -- local (Australia/Brisbane) day
  closest_m    double precision not null,
  closest_t    timestamptz,
  closest_min  int,                            -- minutes past local midnight
  replay       jsonb,
  closest_index int,
  a_start_idx  int,
  b_start_idx  int,
  computed_at  timestamptz default now(),
  unique (user_a, user_b, day),
  check (user_a < user_b)
);
create index if not exists daily_records_pair on public.daily_records (user_a, user_b, day);

-- ============================================================================
--  ROW-LEVEL SECURITY
-- ============================================================================
alter table public.profiles      enable row level security;
alter table public.friendships   enable row level security;
alter table public.locations     enable row level security;
alter table public.daily_records enable row level security;

-- profiles: any signed-in user can read basic profiles (to show a friend's name);
--           you can only write your own row.
drop policy if exists "profiles_read"   on public.profiles;
drop policy if exists "profiles_insert" on public.profiles;
drop policy if exists "profiles_update" on public.profiles;
create policy "profiles_read"   on public.profiles for select to authenticated using (true);
create policy "profiles_insert" on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "profiles_update" on public.profiles for update to authenticated using (id = auth.uid());

-- friendships: you can see pairs you're in. (Creating one goes through redeem_invite.)
drop policy if exists "friendships_read" on public.friendships;
create policy "friendships_read" on public.friendships for select to authenticated
  using (user_a = auth.uid() or user_b = auth.uid());

-- locations: fully private — you can only ever read/insert your OWN fixes.
drop policy if exists "locations_read"   on public.locations;
drop policy if exists "locations_insert" on public.locations;
create policy "locations_read"   on public.locations for select to authenticated using (user_id = auth.uid());
create policy "locations_insert" on public.locations for insert to authenticated with check (user_id = auth.uid());

-- daily_records: readable by either friend in the pair. No client writes
--                (only the service-role compute job inserts these).
drop policy if exists "daily_read" on public.daily_records;
create policy "daily_read" on public.daily_records for select to authenticated
  using (user_a = auth.uid() or user_b = auth.uid());

-- ============================================================================
--  Auto-create a profile row whenever a new auth user signs up
-- ============================================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

-- ============================================================================
--  Redeem an invite code  ->  creates a friendship (mutual by shared code)
--  Call from the app:  supabase.rpc('redeem_invite', { code: 'abc123' })
-- ============================================================================
create or replace function public.redeem_invite(code text)
returns json language plpgsql security definer set search_path = public as $$
declare other uuid; me uuid := auth.uid(); a uuid; b uuid;
begin
  if me is null then return json_build_object('ok', false, 'error', 'Not signed in'); end if;
  select id into other from public.profiles where invite_code = lower(trim(code));
  if other is null then return json_build_object('ok', false, 'error', 'Code not found'); end if;
  if other = me  then return json_build_object('ok', false, 'error', 'That is your own code'); end if;
  a := least(me, other); b := greatest(me, other);
  insert into public.friendships (user_a, user_b) values (a, b) on conflict do nothing;
  return json_build_object('ok', true);
end; $$;
grant execute on function public.redeem_invite(text) to authenticated;
