-- =====================================================================
-- msfm_team_mappings_setup.sql - shared TEAM mappings for the
-- Multi-Sport Fixtures Manager (multi-sport-fixtures-manager.html)
-- =====================================================================
-- REVIEW BEFORE RUNNING. Nothing in this file has been executed.
-- This is a NEW, separate table. It does NOT touch the existing
-- msfm_priority_mappings table (priority LEAGUE mappings) in any way.
--
-- Purpose: map a Flashscore team name (scoped by sport + country +
-- Flashscore league) to the corresponding BCM team name, so the New
-- Matches table can display BCM Home / BCM Away / Mapping Status.
--
-- Run order (Supabase SQL Editor, as the project owner):
--   1. This file                        -> creates the table and its security.
--   2. (optional) a seed file exported from the app
--                 "Export Team Mappings as Supabase SQL" -> loads your rows.
--   3. Choose ONE read-access option in section 3 (owner decision).
--
-- SECURITY POSTURE (identical to msfm_mappings_setup.sql / RLS_REMEDIATION_PLAN.md)
--   * RLS enabled from creation. No `using (true)` policy for anon by default.
--   * The browser NEVER writes: no INSERT/UPDATE/DELETE grant or policy for
--     anon or authenticated. Changes are made only in the Supabase dashboard /
--     SQL Editor (project owner) or by a future trusted backend (service_role).
--   * Contents: sport, country, competition and team labels only - no personal
--     data, no credentials.
-- =====================================================================

create table if not exists public.msfm_team_mappings (
  id                 bigint generated always as identity primary key,
  sport              text        not null
                     check (sport in ('Basketball','Ice hockey','Floorball','Waterpolo','Bandy','Field hockey')),
  country            text        not null check (btrim(country) <> ''),
  flashscore_league  text        not null check (btrim(flashscore_league) <> ''),
  flashscore_team    text        not null check (btrim(flashscore_team) <> ''),
  bcm_team           text        not null check (btrim(bcm_team) <> ''),
  active             boolean     not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- A Flashscore team is unique within one sport + country + Flashscore league.
  -- This scopes teams so identical/similar names in different sports, countries
  -- or leagues stay distinct, and the SAME team may legitimately appear in more
  -- than one league without creating a duplicate canonical identity.
  constraint msfm_team_mappings_unique unique (sport, country, flashscore_league, flashscore_team)
);

create index if not exists msfm_team_mappings_lookup_idx
  on public.msfm_team_mappings (sport, country, flashscore_league);

-- Keep updated_at honest when an administrator edits a row.
create or replace function public.msfm_team_mappings_touch()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists msfm_team_mappings_touch on public.msfm_team_mappings;
create trigger msfm_team_mappings_touch before update on public.msfm_team_mappings
  for each row execute function public.msfm_team_mappings_touch();
revoke execute on function public.msfm_team_mappings_touch() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Row Level Security: least privilege, read-only at most.
-- ---------------------------------------------------------------------
alter table public.msfm_team_mappings enable row level security;

revoke all on public.msfm_team_mappings from anon, authenticated;
revoke all on sequence public.msfm_team_mappings_id_seq from anon, authenticated;

drop policy if exists msfm_team_mappings_read_authenticated on public.msfm_team_mappings;
create policy msfm_team_mappings_read_authenticated
  on public.msfm_team_mappings for select to authenticated using (true);
grant select on public.msfm_team_mappings to authenticated;
-- (Intentionally NO insert/update/delete policy or grant for anon/authenticated.)

-- ---------------------------------------------------------------------
-- 3. READ ACCESS FOR THE BROWSER - OWNER DECISION (plan item UA5). Pick ONE.
--
--   The Fixtures Manager runs in the browser with the suite's PUBLISHABLE
--   (anon) key and has no sign-in yet. With section 2 only, it CANNOT read the
--   table: it will keep using the team mappings saved in each browser.
--
--   Option A - wait for sign-in (Stage 2 of the remediation plan).
--     Run nothing here. The shared team list works once users have
--     authenticated sessions.
--
--   Option B - allow anonymous READ of this table only.
--     The table holds sport/country/competition/team labels only. Anyone
--     holding the publishable key (it is embedded in the suite's pages) could
--     read the list; nobody can change it. Uncomment to apply:
--
-- drop policy if exists msfm_team_mappings_read_anon on public.msfm_team_mappings;
-- create policy msfm_team_mappings_read_anon
--   on public.msfm_team_mappings for select to anon using (true);
-- grant select on public.msfm_team_mappings to anon;
--
-- ---------------------------------------------------------------------
-- 4. Verification (read-only) - expected after section 2 (+ optional 3B):
--   select policyname, roles, cmd from pg_policies where tablename = 'msfm_team_mappings';
--     -> only SELECT policies (authenticated, and anon if 3B was applied)
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_name = 'msfm_team_mappings' and grantee in ('anon','authenticated');
--     -> SELECT only
--   select sport, count(*) from public.msfm_team_mappings group by sport order by sport;
-- =====================================================================
