-- =====================================================================
-- msfm_mappings_setup.sql — shared priority league mappings for the
-- Multi-Sport Fixtures Manager (multi-sport-fixtures-manager.html)
-- =====================================================================
-- REVIEW BEFORE RUNNING. Nothing in this file has been executed.
-- Run order (Supabase SQL Editor, as the project owner):
--   1. This file                      -> creates the table and its security.
--   2. msfm_priority_mappings_seed.sql -> loads the agreed mapping list (292 rows).
--   3. Choose ONE read-access option in section 3 (owner decision).
--
-- SECURITY POSTURE (consistent with RLS_REMEDIATION_PLAN.md / rls_hardening.sql)
--   * RLS enabled from creation. No `using (true)` policy for anon.
--   * The browser NEVER writes: no INSERT/UPDATE/DELETE grant or policy for
--     anon or authenticated. Changes are made only in the Supabase dashboard /
--     SQL Editor (project owner) or by a future trusted backend (service_role).
--   * Contents: competition names and Flashscore league labels only — no
--     personal data, no credentials.
-- =====================================================================

create table if not exists public.msfm_priority_mappings (
  id                 bigint generated always as identity primary key,
  sport              text        not null
                     check (sport in ('Basketball','Ice hockey','Floorball','Waterpolo','Bandy','Field hockey')),
  country            text        not null check (btrim(country) <> ''),
  priority_league    text        not null check (btrim(priority_league) <> ''),
  flashscore_league  text        not null default '',   -- '' = no Flashscore name: never auto-matches
  active             boolean     not null default true,
  sort_order         integer     not null default 0,     -- keeps the agreed list order per sport
  updated_at         timestamptz not null default now(),
  constraint msfm_priority_mappings_unique unique (sport, country, priority_league)
);

create index if not exists msfm_priority_mappings_sport_idx
  on public.msfm_priority_mappings (sport, sort_order);

-- Keep updated_at honest when an administrator edits a row.
create or replace function public.msfm_priority_mappings_touch()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists msfm_priority_mappings_touch on public.msfm_priority_mappings;
create trigger msfm_priority_mappings_touch before update on public.msfm_priority_mappings
  for each row execute function public.msfm_priority_mappings_touch();
revoke execute on function public.msfm_priority_mappings_touch() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Row Level Security: least privilege, read-only at most.
-- ---------------------------------------------------------------------
alter table public.msfm_priority_mappings enable row level security;

revoke all on public.msfm_priority_mappings from anon, authenticated;
revoke all on sequence public.msfm_priority_mappings_id_seq from anon, authenticated;

drop policy if exists msfm_priority_mappings_read_authenticated on public.msfm_priority_mappings;
create policy msfm_priority_mappings_read_authenticated
  on public.msfm_priority_mappings for select to authenticated using (true);
grant select on public.msfm_priority_mappings to authenticated;
-- (Intentionally NO insert/update/delete policy or grant for anon/authenticated.)

-- ---------------------------------------------------------------------
-- 3. READ ACCESS FOR THE BROWSER — OWNER DECISION (plan item UA5). Pick ONE.
--
--   The Fixtures Manager runs in the browser with the suite's PUBLISHABLE
--   (anon) key and has no sign-in yet. With section 2 only, it CANNOT read the
--   table: it will show "Supabase refused read access" and keep using the
--   mappings saved in each browser.
--
--   Option A — wait for sign-in (Stage 2 of the remediation plan).
--     Run nothing here. The shared list works once users have authenticated
--     sessions.
--
--   Option B — allow anonymous READ of this table only.
--     The table holds league names only. Anyone holding the publishable key
--     (it is embedded in the suite's pages) could read the list; nobody can
--     change it. Uncomment to apply:
--
-- drop policy if exists msfm_priority_mappings_read_anon on public.msfm_priority_mappings;
-- create policy msfm_priority_mappings_read_anon
--   on public.msfm_priority_mappings for select to anon using (true);
-- grant select on public.msfm_priority_mappings to anon;
--
-- ---------------------------------------------------------------------
-- 4. Verification (read-only) — expected after section 2 (+ optional 3B):
--   select policyname, roles, cmd from pg_policies where tablename = 'msfm_priority_mappings';
--     -> only SELECT policies (authenticated, and anon if 3B was applied)
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_name = 'msfm_priority_mappings' and grantee in ('anon','authenticated');
--     -> SELECT only
--   select sport, count(*), count(*) filter (where flashscore_league = '') as blank
--     from public.msfm_priority_mappings group by sport order by sport;
--     -> after the seed: Bandy 6/1, Basketball 173/17, Field hockey 7/1,
--        Floorball 9/3, Ice hockey 80/42, Waterpolo 17/8
-- =====================================================================
