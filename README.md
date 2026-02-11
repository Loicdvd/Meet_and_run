# Run Planner (React Native)

Mobile app to plan running routes on a map, calculate distance, schedule a run, and share with other users.

## Features
- Tap to set start and finish points
- Auto-generate a walking route using Google Directions API
- Distance calculation (km) from the generated route
- Schedule date and time for the run
- Authentication (sign up / sign in)
- Save planned runs in Supabase
- Share a run invitation via the native share sheet
- Join/leave runs across devices

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
2. In SQL editor, run:
```sql
create extension if not exists pgcrypto;

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

alter table public.run_plans enable row level security;
alter table public.run_participants enable row level security;

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
2. Create an API key.
   - Restrict by API to `Directions API`.
3. Put your key in `.env` as `EXPO_PUBLIC_GOOGLE_DIRECTIONS_API_KEY`.

## Branding setup
- App name and slug are in `app.json`.
- Custom logos/splash are currently removed to avoid placeholder assets.
- Add your own branding assets later in `app.json` when ready.

## Notes
- Uses Expo + `react-native-maps`, `expo-location`, and Supabase Auth/DB.
