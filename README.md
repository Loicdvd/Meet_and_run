# Run Planner (React Native)

Mobile app to plan running routes on a map, calculate distance, schedule a run, and share with other users.

## Features
- Tap to set start and finish points
- Auto-generate a walking route using Google Directions API
- Auto loop generation from start point + target distance (returns to start)
- Route preferences: avoid major car roads, prefer higher elevation
- Preference-aware routing engine: evaluates multiple route candidates and picks the best match
- Live run execution mode with off-route detection and post-run stats
- In-map place search with address suggestions and pin auto-assignment (start then finish)
- Search suggestions include quick actions (`Start` / `Finish`) plus recent and nearby place shortcuts
- Pre-run preview stats: elevation gain, estimated completion time (based on your history), personalized difficulty
- Post-run feedback: rate enjoyment and perceived difficulty after completion
- Tap an upcoming run card to open detailed stats, trajectory preview, and participant list
- Distance calculation (km) from the generated route
- Schedule date and time for the run
- Authentication (sign up / sign in)
- Save planned runs in Supabase
- Share a run invitation via the native share sheet
- Join/leave runs across devices
- Follow/unfollow runners and view them in account settings
- Sort runs by nearest start point from your current location
- First-login tutorial shown once per account on this device

## Run it
1. Install dependencies
   - `npm install`
2. Configure environment
   - `cp .env.example .env`
   - set values in `.env`:
   - `EXPO_PUBLIC_GOOGLE_DIRECTIONS_API_KEY`
   - `EXPO_PUBLIC_SUPABASE_URL`
   - `EXPO_PUBLIC_SUPABASE_ANON_KEY`
3. Start Expo
   - `npm run start`

## Supabase Setup
1. Create a new Supabase project.
2. In SQL editor, run this full script once.
   - It uses consistent names: `profiles`, `run_plans`, `run_participants`, `user_follows`.
   - For dev, it drops old tables first to prevent foreign-key drift.
```sql
create extension if not exists pgcrypto;

drop table if exists public.user_follows cascade;
drop table if exists public.run_participants cascade;
drop table if exists public.run_plans cascade;
drop table if exists public.profiles cascade;

drop function if exists public.handle_new_user_profile() cascade;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique,
  full_name text,
  city text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.run_plans (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  date_time timestamptz not null,
  distance_km numeric not null default 0,
  points jsonb not null default '[]'::jsonb,
  start_point jsonb,
  end_point jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.run_participants (
  run_id uuid not null references public.run_plans(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (run_id, user_id)
);

create table if not exists public.user_follows (
  user_id uuid not null references auth.users(id) on delete cascade,
  follows_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, follows_user_id)
);

alter table public.run_plans enable row level security;
alter table public.run_participants enable row level security;
alter table public.user_follows enable row level security;
alter table public.profiles enable row level security;

create policy "read runs" on public.run_plans
for select to authenticated using (true);

create policy "insert own runs" on public.run_plans
for insert to authenticated with check (auth.uid() = owner_id);

create policy "delete own runs" on public.run_plans
for delete to authenticated using (auth.uid() = owner_id);

create policy "read participants" on public.run_participants
for select to authenticated using (true);

create policy "join as self" on public.run_participants
for insert to authenticated with check (auth.uid() = user_id);

create policy "leave as self" on public.run_participants
for delete to authenticated using (auth.uid() = user_id);

create policy "read follows" on public.user_follows
for select to authenticated using (auth.uid() = user_id);

create policy "insert follows as self" on public.user_follows
for insert to authenticated with check (auth.uid() = user_id);

create policy "delete follows as self" on public.user_follows
for delete to authenticated using (auth.uid() = user_id);

create policy "read profiles" on public.profiles
for select to authenticated using (true);

create policy "insert own profile" on public.profiles
for insert to authenticated with check (auth.uid() = id);

create policy "update own profile" on public.profiles
for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id)
  values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;

create trigger on_auth_user_created_profile
after insert on auth.users
for each row execute function public.handle_new_user_profile();
```
3. In Supabase `Project Settings -> API`, copy:
   - Project URL -> `EXPO_PUBLIC_SUPABASE_URL`
   - Anon public key -> `EXPO_PUBLIC_SUPABASE_ANON_KEY`

## Docker (reproducible dev)
1. Build and run
   - `docker compose up --build`
2. Open Expo DevTools
   - `http://localhost:19000`

Notes:
- The container runs `npm run start -- --lan` so devices on the same network can connect.
- If LAN discovery doesn’t work in your environment, change the command in `Dockerfile` to `--tunnel`.

## Google Maps setup (Android)
1. Create a Google Cloud project and enable:
   - Directions API
   - Elevation API (required for "High Elevation" option)
   - Geocoding API (required for in-app place search)
   - Places API (required for nearby category suggestions)
2. Create an API key.
   - Restrict by API to `Directions API`, `Elevation API`, `Geocoding API`, and `Places API`.
3. Put your key in `.env` as `EXPO_PUBLIC_GOOGLE_DIRECTIONS_API_KEY`.

## Branding setup
- Brand kit is defined in `brand/BRAND.md`.
- App name/slug/package are set to `StrideLoop` in `app.json`.
- Brand icon source is in `assets/brand/strideloop-icon.svg`.
- App-ready PNG assets are in `assets/brand/`:
- `icon.png`, `adaptive-icon.png`, `splash.png`, `favicon.png`
- In-app icon/wordmark component is `components/BrandMark.js`.

## Notes
- Uses Expo + `react-native-maps`, `expo-location`, and Supabase Auth/DB.
- Live run tracking uses foreground location updates and stores run session history locally per user/device.
