/* =====================================================================
   plfm-shared.js  (window.PLFM_SHARED)  -- READ-ONLY shared-mapping loader.

   Loads the team's shared mapping lists from the EXISTING Supabase tables
   (msfm_priority_mappings, msfm_team_mappings) and MERGES them into the local
   PLFM stores. It mirrors the MSFM integration (same REST query shape, same
   public/publishable key, same test-fetch hook convention) and is deliberately
   NON-DESTRUCTIVE.

   SECURITY (hard rules)
     - The browser only ever issues HTTP GET. There is no INSERT/UPDATE/DELETE,
       no RPC, no service-role key, no auth flow. The only credential is the
       suite's public (publishable) key that MSFM already embeds.
     - Row Level Security is untouched; if the project owner has not granted the
       public key SELECT, the load fails with a readable message and nothing
       changes locally.

   MERGE RULES (never blindly overwrite)
     - A shared row is matched to local records by the same identity the database
       enforces:   league = sport + country + priority_league
                   team   = sport + country + flashscore_league + flashscore_team
       (folded through FXE so case / accents / spacing never create false misses).
     - Not present locally            -> ADDED.
     - Present and identical          -> counted as "already present" (no write).
     - Present but values differ      -> CONFLICT: the LOCAL record is kept as-is
                                         and the difference is reported.
     - Duplicate keys inside the load -> identical copies are counted as
                                         duplicates; differing copies are a conflict
                                         and that key is not loaded.
     - Invalid rows (unknown sport, blank required field) -> skipped and counted.
     - Local records are NEVER edited or deleted, so confirmed Betradar links,
       review states, notes and any other additive fields are preserved.
     - Reloading is idempotent: a second reload with unchanged data adds nothing.

   STORAGE: new rows go through the existing reactive funnel
   (reactive.datasets.commit) to the existing localStorage keys, in ONE commit per
   reload, so PLFM <-> MSFM integration is unchanged.
   ===================================================================== */
(function(){
  "use strict";
  if (typeof window === "undefined") { return; }
  if (!window.FXE) {
    throw new Error("plfm-shared.js requires engine.js (window.FXE) to be loaded first.");
  }
  var FXE = window.FXE;

  // Same project / publishable key / tables MSFM uses. READ ONLY.
  var CONFIG = {
    url: "https://ywfvifcityihcfvyeisd.supabase.co",
    key: "sb_publishable_Oym01Q8PYn7Xp8kuWLmRNQ_H3RI4B5l",
    pageSize: 1000,
    maxPages: 100,                                   // hard stop against a runaway loop
    league: { table: "msfm_priority_mappings",
              select: "sport,country,priority_league,flashscore_league,active,sort_order",
              order: "sport.asc,sort_order.asc,id.asc" },
    team:   { table: "msfm_team_mappings",
              select: "sport,country,flashscore_league,flashscore_team,bcm_team,active",
              order: "sport.asc,country.asc,id.asc" }
  };

  /* ---------------------------------------------------------------
     Small pure helpers
     --------------------------------------------------------------- */
  function trim(v){ return String(v == null ? "" : v).trim(); }

  // Fold with an FXE function, falling back to a lowercase raw string so two
  // different names that fold to "" (all punctuation) can never collapse into
  // one identity.
  function fold(fn, raw){
    var s = trim(raw);
    var k = "";
    try { k = fn(s); } catch (e) { k = ""; }
    return k || s.toLowerCase();
  }

  function leagueIdentity(rec){
    return (FXE.canonSport(rec.sport) || trim(rec.sport).toLowerCase()) + "|" +
           fold(FXE.countryKey, rec.country) + "|" +
           fold(FXE.leagueKey, rec.priorityLeague);
  }
  function teamIdentity(rec){
    return (FXE.canonSport(rec.sport) || trim(rec.sport).toLowerCase()) + "|" +
           fold(FXE.countryKey, rec.country) + "|" +
           fold(FXE.leagueKey, rec.flashscoreLeague) + "|" +
           fold(FXE.teamKey, rec.flashscoreTeam);
  }

  function leagueLabel(rec){ return rec.sport + " / " + rec.country + " / " + rec.priorityLeague; }
  function teamLabel(rec){ return rec.sport + " / " + rec.country + " / " + rec.flashscoreLeague + " / " + rec.flashscoreTeam; }

  // Value comparison for an already-matched identity.
  function leagueDiff(local, shared){
    var diffs = [];
    if (fold(FXE.leagueKey, local.flashscoreLeague) !== fold(FXE.leagueKey, shared.flashscoreLeague) ||
        (trim(local.flashscoreLeague) === "") !== (trim(shared.flashscoreLeague) === "")) {
      diffs.push({ field: "flashscoreLeague", local: trim(local.flashscoreLeague), shared: trim(shared.flashscoreLeague) });
    }
    if ((local.active !== false) !== (shared.active !== false)) {
      diffs.push({ field: "active", local: String(local.active !== false), shared: String(shared.active !== false) });
    }
    return diffs;
  }
  function teamDiff(local, shared){
    var diffs = [];
    if (fold(FXE.teamKey, local.bcmTeam) !== fold(FXE.teamKey, shared.bcmTeam)) {
      diffs.push({ field: "bcmTeam", local: trim(local.bcmTeam), shared: trim(shared.bcmTeam) });
    }
    if ((local.active !== false) !== (shared.active !== false)) {
      diffs.push({ field: "active", local: String(local.active !== false), shared: String(shared.active !== false) });
    }
    return diffs;
  }

  /* ---------------------------------------------------------------
     Row validation: raw Supabase row -> normalized PLFM record
     (mirrors the database CHECK constraints and MSFM's validation)
     --------------------------------------------------------------- */
  function mapLeagueRow(r){
    if (!r || typeof r !== "object") { return { ok: false, reason: "row is not an object" }; }
    var sport = FXE.canonSport(r.sport);
    var country = trim(r.country);
    var pl = trim(r.priority_league);
    if (!sport) { return { ok: false, reason: "unknown sport \"" + trim(r.sport) + "\"" }; }
    if (!country) { return { ok: false, reason: "blank country" }; }
    if (!pl) { return { ok: false, reason: "blank priority league" }; }
    return { ok: true, rec: { sport: sport, country: country, priorityLeague: pl,
                              flashscoreLeague: trim(r.flashscore_league), active: r.active !== false } };
  }
  function mapTeamRow(r){
    if (!r || typeof r !== "object") { return { ok: false, reason: "row is not an object" }; }
    var sport = FXE.canonSport(r.sport);
    var country = trim(r.country);
    var fl = trim(r.flashscore_league);
    var ft = trim(r.flashscore_team);
    var bt = trim(r.bcm_team);
    if (!sport) { return { ok: false, reason: "unknown sport \"" + trim(r.sport) + "\"" }; }
    if (!country) { return { ok: false, reason: "blank country" }; }
    if (!fl) { return { ok: false, reason: "blank Flashscore league" }; }
    if (!ft) { return { ok: false, reason: "blank Flashscore team" }; }
    if (!bt) { return { ok: false, reason: "blank BCM team" }; }
    return { ok: true, rec: { sport: sport, country: country, flashscoreLeague: fl,
                              flashscoreTeam: ft, bcmTeam: bt, active: r.active !== false } };
  }

  /* ---------------------------------------------------------------
     Merge planning (PURE: reads local + shared, writes nothing)
     --------------------------------------------------------------- */
  function planMerge(kind, localRaw, sharedRows){
    var isLeague = kind === "league";
    var mapRow = isLeague ? mapLeagueRow : mapTeamRow;
    var identity = isLeague ? leagueIdentity : teamIdentity;
    var labelOf = isLeague ? leagueLabel : teamLabel;
    var diffOf = isLeague ? leagueDiff : teamDiff;

    var rows = Array.isArray(sharedRows) ? sharedRows : [];
    var local = Array.isArray(localRaw) ? localRaw.filter(function(x){ return x && typeof x === "object"; }) : [];

    var plan = {
      kind: kind, toAdd: [], conflicts: [], invalid: [], duplicates: [],
      summary: { fetched: rows.length, valid: 0, invalid: 0, uniqueShared: 0, added: 0,
                 alreadyPresent: 0, duplicates: 0, conflicts: 0 }
    };

    // 1) validate + group shared rows by identity (first-seen order kept)
    var groups = Object.create(null), order = [];
    rows.forEach(function(row, i){
      var m = mapRow(row);
      if (!m.ok) { plan.invalid.push({ index: i, reason: m.reason }); return; }
      plan.summary.valid++;
      var k = identity(m.rec);
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(m.rec);
    });
    plan.summary.invalid = plan.invalid.length;

    // 2) local index by identity (ALL local records, active or not)
    var localIdx = Object.create(null);
    local.forEach(function(rec){
      var k = identity(rec);
      (localIdx[k] = localIdx[k] || []).push(rec);
    });

    // 3) decide each unique shared identity
    order.forEach(function(k){
      var grp = groups[k];
      var first = grp[0];

      // duplicates inside the shared payload
      var internalConflict = false;
      if (grp.length > 1) {
        for (var g = 1; g < grp.length; g++) {
          if (diffOf(first, grp[g]).length) { internalConflict = true; break; }
        }
        if (internalConflict) {
          plan.conflicts.push({ kind: "shared-internal", label: labelOf(first), local: null, shared: first,
                                differing: [{ field: "(multiple shared rows differ)", local: "", shared: grp.length + " rows" }] });
          return; // ambiguous: do not load this identity
        }
        plan.duplicates.push({ label: labelOf(first), count: grp.length });
        plan.summary.duplicates += grp.length - 1;
      }
      plan.summary.uniqueShared++;

      var locals = localIdx[k];
      if (!locals || !locals.length) { plan.toAdd.push(first); return; }

      // identical to ANY local record on this identity -> already present
      var firstDiffs = null;
      for (var i = 0; i < locals.length; i++) {
        var d = diffOf(locals[i], first);
        if (!d.length) { plan.summary.alreadyPresent++; return; }
        if (!firstDiffs) { firstDiffs = { local: locals[i], diffs: d }; }
      }
      plan.conflicts.push({ kind: "value-differs", label: labelOf(first), local: firstDiffs.local,
                            shared: first, differing: firstDiffs.diffs });
    });

    plan.summary.added = plan.toAdd.length;
    plan.summary.conflicts = plan.conflicts.length;
    return plan;
  }

  function planLeagueMerge(localRaw, rows){ return planMerge("league", localRaw, rows); }
  function planTeamMerge(localRaw, rows){ return planMerge("team", localRaw, rows); }

  /* ---------------------------------------------------------------
     MSFM-compatible sync marker (msfm_shared_mapping_sync_v1).
     These two functions reproduce MSFM's mappingSignature()/hashStr()
     EXACTLY so MSFM's "do I have unshared local edits?" check agrees.
     --------------------------------------------------------------- */
  function mappingSignature(list){
    return list.map(function(m){
      return [FXE.canonSport(m.sport) || String(m.sport == null ? "" : m.sport),
              m.country, m.priorityLeague, m.flashscoreLeague, m.active !== false ? 1 : 0].join("\u0001");
    }).join("\u0002");
  }
  function hashStr(s){
    var h = 5381;
    for (var i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
    return (h >>> 0).toString(36) + ":" + s.length;
  }

  /* ---------------------------------------------------------------
     Remote error wording (same as MSFM's describeRemoteError)
     --------------------------------------------------------------- */
  function describeRemoteError(table, status, body){
    var b = String(body || "");
    if (status === 404 || /PGRST205|42P01|does not exist|Could not find the table/i.test(b)) {
      return "the shared table \"" + table + "\" does not exist yet (run its setup SQL in Supabase).";
    }
    if (status === 401 || status === 403 || /42501|permission denied/i.test(b)) {
      return "Supabase refused read access to \"" + table + "\" for this browser key (the project owner must allow read access, see the read-access options in the setup SQL).";
    }
    return "Supabase returned HTTP " + status + ".";
  }

  /* ---------------------------------------------------------------
     Test-mode fetch hook (same convention as MSFM: tests inject a fake
     fetch on the parent window; with none supplied the feature is
     disabled so tests never touch the network).
     --------------------------------------------------------------- */
  function defaultGetFetch(){
    try {
      if (/plfm-test/.test(window.location.hash) && window.parent !== window) {
        return window.parent.__PLFM_TEST_FETCH || null;
      }
    } catch (e) { return null; }
    return typeof window.fetch === "function" ? window.fetch.bind(window) : null;
  }

  /* ---------------------------------------------------------------
     Instance: network + apply, bound to the host's adapter/reactive
     --------------------------------------------------------------- */
  function create(ctx){
    ctx = ctx || {};
    var adapter = ctx.adapter || window.PLFM_ADAPTER;
    var reactive = ctx.reactive || (window.__PLFM && window.__PLFM.reactive);
    var getFetch = ctx.getFetch || defaultGetFetch;
    var cfg = ctx.config || CONFIG;
    if (!adapter || !adapter.priorityStore || !adapter.teamStore) {
      throw new Error("plfm-shared.js requires PLFM_ADAPTER (priorityStore/teamStore).");
    }
    if (!reactive || !reactive.datasets || typeof reactive.datasets.commit !== "function") {
      throw new Error("plfm-shared.js requires a reactive context with datasets.commit.");
    }

    var inflight = { league: null, team: null };
    var last = { league: null, team: null };

    // GET-only paged read. Returns {ok:true,rows} | {ok:false,reason,status?,disabled?}.
    function fetchTable(def){
      var f = getFetch();
      if (!f) { return Promise.resolve({ ok: false, disabled: true, reason: "Shared mappings are not available in this browser." }); }
      var rows = [];
      function page(n){
        if (n >= cfg.maxPages) { return Promise.resolve({ ok: false, reason: "the shared list is unexpectedly large (stopped after " + cfg.maxPages + " pages)." }); }
        var url = cfg.url + "/rest/v1/" + def.table + "?select=" + def.select +
                  "&order=" + def.order + "&limit=" + cfg.pageSize + "&offset=" + (n * cfg.pageSize);
        return f(url, { method: "GET",
                        headers: { apikey: cfg.key, Authorization: "Bearer " + cfg.key, Accept: "application/json" } })
          .then(function(res){
            if (!res.ok) {
              return Promise.resolve(res.text ? res.text() : "").catch(function(){ return ""; }).then(function(body){
                return { ok: false, status: res.status, reason: describeRemoteError(def.table, res.status, body) };
              });
            }
            return res.json().then(function(data){
              if (!Array.isArray(data)) { return { ok: false, reason: "Supabase sent an unexpected response." }; }
              Array.prototype.push.apply(rows, data);
              if (data.length < cfg.pageSize) { return { ok: true, rows: rows }; }
              return page(n + 1);
            });
          });
      }
      return page(0).catch(function(e){
        return { ok: false, reason: "could not reach Supabase (" + (e && e.message || "network error") + ")." };
      });
    }

    // Apply = append ONLY the planned new records, ONE commit. Existing local
    // records are never touched.
    function applyLeague(plan){
      if (!plan.toAdd.length) { return { committed: false, persisted: true }; }
      var next = adapter.priorityStore.read().concat(plan.toAdd.map(function(r){
        return { id: adapter.uid(), sport: r.sport, country: r.country, priorityLeague: r.priorityLeague,
                 flashscoreLeague: r.flashscoreLeague, active: r.active };
      }));
      var ok = reactive.datasets.commit("priority", next);
      return { committed: true, persisted: ok !== false };
    }
    function applyTeam(plan){
      if (!plan.toAdd.length) { return { committed: false, persisted: true }; }
      var next = adapter.teamStore.read().concat(plan.toAdd.map(function(r){
        return { id: adapter.uid(), sport: r.sport, country: r.country, flashscoreLeague: r.flashscoreLeague,
                 flashscoreTeam: r.flashscoreTeam, bcmTeam: r.bcmTeam, active: r.active };
      }));
      var ok = reactive.datasets.commit("team", next);
      return { committed: true, persisted: ok !== false };
    }

    // Record the MSFM sync marker ONLY when the local league list is now exactly
    // the shared list (nothing local-only, nothing skipped, nothing in conflict).
    function maybeRecordLeagueSync(plan){
      var s = plan.summary;
      if (s.conflicts || s.invalid) { return false; }
      var list = adapter.priorityStore.read();
      if (list.length !== s.uniqueShared) { return false; }
      var meta = { hash: hashStr(mappingSignature(list)), at: new Date().toISOString(), count: list.length };
      return !!adapter.store.safeSet(adapter.priorityStore.syncKey, JSON.stringify(meta));
    }

    function reload(kind){
      if (inflight[kind]) { return inflight[kind]; }          // safe against double-clicks
      var def = kind === "league" ? cfg.league : cfg.team;
      var p = fetchTable(def).then(function(res){
        if (!res.ok) { return res; }
        var plan, applied, synced = false;
        if (kind === "league") {
          plan = planLeagueMerge(adapter.priorityStore.read(), res.rows);
          applied = applyLeague(plan);
          if (applied.persisted) { synced = maybeRecordLeagueSync(plan); }
        } else {
          plan = planTeamMerge(adapter.teamStore.read(), res.rows);
          applied = applyTeam(plan);
        }
        var out = { ok: true, kind: kind, plan: plan, summary: plan.summary, conflicts: plan.conflicts,
                    invalid: plan.invalid, duplicates: plan.duplicates, committed: applied.committed,
                    persisted: applied.persisted, syncMarkerWritten: synced, at: new Date().toISOString() };
        last[kind] = out;
        return out;
      }).then(function(out){ inflight[kind] = null; return out; },
              function(e){ inflight[kind] = null; return { ok: false, reason: String(e && e.message || e) }; });
      inflight[kind] = p;
      return p;
    }

    return {
      reloadLeagues: function(){ return reload("league"); },
      reloadTeams: function(){ return reload("team"); },
      last: function(kind){ return last[kind] || null; },
      fetchTable: fetchTable,
      config: cfg
    };
  }

  window.PLFM_SHARED = {
    create: create,
    CONFIG: CONFIG,
    // pure helpers (exposed for the test harness)
    planLeagueMerge: planLeagueMerge,
    planTeamMerge: planTeamMerge,
    mapLeagueRow: mapLeagueRow,
    mapTeamRow: mapTeamRow,
    leagueIdentity: leagueIdentity,
    teamIdentity: teamIdentity,
    mappingSignature: mappingSignature,
    hashStr: hashStr,
    describeRemoteError: describeRemoteError
  };
})();
