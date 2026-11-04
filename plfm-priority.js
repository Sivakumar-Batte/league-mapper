/* =====================================================================
   plfm-priority.js  (window.PLFM_PRIORITY)  -- ADDITIVE priority-filter module.

   Implements Task 3.3 "priority-filter projection" (design C1a reactive model,
   C6b sport extensibility; Req 4.1, 4.3, 4.4, 4.5, 4.6).

   WHAT THIS PRODUCES
   ------------------
   A single REACTIVE selector (built with reactive.derive(['collection',
   'priority'], computePriority)) that, from the seven-day collection + the
   ACTIVE priority mappings, partitions every collected fixture into three
   mutually exclusive sets:

     priority    -- the PRIORITY fixture set: every collection fixture whose
                    composed FXE key matches an ACTIVE priority mapping's
                    composed FXE key (match on the Flashscore league identifier).
     unmapped    -- the UNMAPPED-league set: fixtures whose league matches NO
                    priority mapping at all (active or inactive). Retained and
                    flagged, NEVER dropped (Req 4.4).
     nonPriority -- the NON-PRIORITY set: fixtures whose league maps ONLY to
                    inactive/non-priority mappings (a mapping exists for the key
                    but none of the matching mappings is active). Req 4.3: an
                    inactive mapping never qualifies a league.

   MATCHING (composed FXE keys ONLY -- no new matching logic)
   ----------------------------------------------------------
   The match key for BOTH a fixture and a mapping is composed purely from FXE
   normalization primitives, reusing the adapter/FXE engine (the sole source of
   truth):

     fixture key  = sportToken(Sport) | countryKey(Country) | leagueKey(league)
                    where league = DetectedLeague || "Flashscore League Name" || League
     mapping key  = sportToken(m.sport) | countryKey(m.country) | leagueKey(m.flashscoreLeague)

   The Flashscore league identifier on the mapping is `flashscoreLeague` (the
   SAME field makeMatcher/the adapter key off), so this composes exactly the
   keys FXE already uses -- it does not invent a second matching path.

   SPORT-AGNOSTIC (design C6b, Req 4.5, 4.6)
   -----------------------------------------
   `sportToken` is `canonSport(sport) || trimmed(sport)`. FXE.canonSport returns
   "" for any sport NOT in FXE.SPORTS, so a fixture/mapping carrying a sport the
   engine does not enumerate still gets a stable, normalized sport token and
   priority-matches by the SAME key composition. There is NO enumerated sport
   list in the matching. FXE.SPORTS is used only to populate dropdowns elsewhere.

   REACTIVE (design C1a)
   ---------------------
   The selector is registered through the host's reactive context over the
   ['collection','priority'] dataset keys, so it auto-refreshes (lazily, on
   access/render) whenever the collection OR the priority mappings change -- no
   manual rebuild (Req 12.4/12.6, and the auto-refresh tie for Property 15).

   DEPENDS ON: window.FXE (canonSport, countryKey, leagueKey),
   window.PLFM_ADAPTER (priorityStore), and a reactive context created by
   window.PLFM_REACTIVE. Wired into the host page after plfm-collection.js and
   exposed on window.__PLFM.priority.
   ===================================================================== */
(function(){
  "use strict";
  if (typeof window === "undefined") { return; }
  if (!window.FXE) {
    throw new Error("plfm-priority.js requires engine.js (window.FXE) to be loaded first.");
  }
  if (!window.PLFM_ADAPTER) {
    throw new Error("plfm-priority.js requires plfm-integration.js (window.PLFM_ADAPTER) to be loaded first.");
  }

  var FXE = window.FXE;
  var canonSport = FXE.canonSport;
  var countryKey = FXE.countryKey;
  var leagueKey  = FXE.leagueKey;

  // Sport token: normalized canonical sport when the engine knows it, else the
  // trimmed raw sport string. This is what makes matching sport-AGNOSTIC: an
  // unknown sport (not in FXE.SPORTS) still yields a stable token and matches by
  // the same key composition. Mirrors the adapter store normalization exactly.
  function sportToken(sport){
    return canonSport(sport) || (sport == null ? "" : String(sport).trim());
  }

  // The league string on a collected fixture, in the SAME precedence the adapter
  // fixtureIdentity / FXE prepFixture use.
  function fixtureLeague(f){
    return (f && (f.DetectedLeague || f["Flashscore League Name"] || f.League)) || "";
  }

  // Composed FXE key for a collected fixture.
  function fixtureKey(f){
    f = f || {};
    return sportToken(f.Sport) + "|" + countryKey(f.Country) + "|" + leagueKey(fixtureLeague(f));
  }

  // Composed FXE key for a priority mapping (keyed on the Flashscore league id).
  function mappingKey(m){
    m = m || {};
    return sportToken(m.sport) + "|" + countryKey(m.country) + "|" + leagueKey(m.flashscoreLeague);
  }

  // Flatten the seven-day collection into a single fixture list.
  function flattenCollection(collection){
    var out = [];
    var byDate = (collection && collection.byDate) ? collection.byDate : {};
    Object.keys(byDate).forEach(function(dk){
      var entry = byDate[dk];
      var bySport = (entry && entry.bySport) ? entry.bySport : {};
      Object.keys(bySport).forEach(function(sp){
        var arr = bySport[sp];
        if (Array.isArray(arr)) {
          for (var i = 0; i < arr.length; i++) {
            out.push({ fixture: arr[i], date: dk, sportBucket: sp });
          }
        }
      });
    });
    return out;
  }

  /* =================================================================
     computePriority(collection, priorityMappings) -> partition.

     Builds two sets of mapping keys from the raw priority mappings:
       activeKeys    -- keys that have at least one ACTIVE mapping.
       anyKeys       -- keys that have ANY mapping (active or inactive).
     Then, for every collected fixture, by its composed key:
       in activeKeys            -> PRIORITY        (Req 4.1)
       in anyKeys but not active -> NON-PRIORITY   (Req 4.3: inactive never qualifies)
       in neither                -> UNMAPPED       (Req 4.4: retained + flagged)

     `priorityMappings` is the RAW mapping array (each record carries .active);
     we read `.active` here so that inactive mappings never qualify a league but
     still count as "mapped" for the non-priority vs unmapped distinction.
     ================================================================= */
  function computePriority(collection, priorityMappings){
    var mappings = Array.isArray(priorityMappings) ? priorityMappings : [];

    var activeKeys = Object.create(null);   // key -> [active mapping,...]
    var anyKeys = Object.create(null);      // key -> [mapping,...] (active or not)

    for (var i = 0; i < mappings.length; i++) {
      var m = mappings[i];
      if (!m || typeof m !== "object") { continue; }
      var k = mappingKey(m);
      (anyKeys[k] = anyKeys[k] || []).push(m);
      if (m.active !== false) {
        (activeKeys[k] = activeKeys[k] || []).push(m);
      }
    }

    var priority = [], unmapped = [], nonPriority = [];
    var flat = flattenCollection(collection);

    for (var f = 0; f < flat.length; f++) {
      var item = flat[f];
      var key = fixtureKey(item.fixture);
      var rec = {
        fixture: item.fixture,
        date: item.date,
        key: key,
        league: fixtureLeague(item.fixture)
      };
      if (activeKeys[key]) {
        rec.matchedMappings = activeKeys[key];
        priority.push(rec);
      } else if (anyKeys[key]) {
        // A mapping exists for this key, but no ACTIVE one -> non-priority.
        rec.inactiveMappings = anyKeys[key];
        rec.reason = "League maps only to inactive/non-priority mappings.";
        nonPriority.push(rec);
      } else {
        // No mapping at all -> unmapped, retained and flagged.
        rec.flag = "UNMAPPED_LEAGUE";
        rec.reason = "No priority mapping matches this league; fixture retained and flagged.";
        unmapped.push(rec);
      }
    }

    return {
      priority: priority,
      unmapped: unmapped,
      nonPriority: nonPriority,
      counts: {
        total: flat.length,
        priority: priority.length,
        unmapped: unmapped.length,
        nonPriority: nonPriority.length
      }
    };
  }

  /* =================================================================
     create(ctx) -> the priority-filter facade.
       ctx.reactive  -- a PLFM_REACTIVE context (required for the reactive
                        selector). Falls back to window.__PLFM.reactive.
       ctx.adapter   -- PLFM_ADAPTER (for priorityStore). Falls back to
                        window.PLFM_ADAPTER.

     The reactive selector is derived over ['collection','priority']. The
     'collection' dataset value is the raw SevenDayCollection; the 'priority'
     dataset value is the RAW mapping array stored under the shared key. We read
     mappings from the reactive 'priority' dataset value directly (NOT a second
     read of priorityStore) so the selector's cache invalidates purely on the
     'priority' dataset version -- keeping it a true derived-of-datasets view.
     ================================================================= */
  function create(ctx){
    ctx = ctx || {};
    var reactive = ctx.reactive || (window.__PLFM && window.__PLFM.reactive);
    var adapter  = ctx.adapter  || window.PLFM_ADAPTER;
    if (!reactive || typeof reactive.derive !== "function" || !reactive.datasets) {
      throw new Error("plfm-priority.js requires a reactive context (PLFM_REACTIVE.create).");
    }
    if (!adapter || !adapter.priorityStore) {
      throw new Error("plfm-priority.js requires PLFM_ADAPTER with priorityStore.");
    }

    // Normalize whatever is in the 'priority' dataset into the raw mapping array.
    // The shared key stores a plain JSON array of MSFM-shaped records.
    function mappingsFromDataset(raw){
      return Array.isArray(raw) ? raw : [];
    }

    // The reactive, memoized selector. Auto-refreshes when collection OR
    // priority mappings change; recomputes lazily on access.
    var selector = reactive.derive(["collection", "priority"], function(inputs){
      return computePriority(inputs.collection, mappingsFromDataset(inputs.priority));
    });

    // Convenience reads over the selector.
    function result(){ return selector(); }
    function priorityFixtures(){ return selector().priority; }
    function unmappedFixtures(){ return selector().unmapped; }
    function nonPriorityFixtures(){ return selector().nonPriority; }
    function counts(){ return selector().counts; }

    // A direct (non-reactive) computation helper for callers that already hold a
    // collection + mappings (e.g. tests / one-off previews). Uses the SAME logic.
    function computeFrom(collection, mappings){
      return computePriority(collection, mappingsFromDataset(mappings));
    }

    return {
      selector: selector,
      result: result,
      priorityFixtures: priorityFixtures,
      unmappedFixtures: unmappedFixtures,
      nonPriorityFixtures: nonPriorityFixtures,
      counts: counts,
      computeFrom: computeFrom,
      // exposed pure helpers for reuse / tests
      _fixtureKey: fixtureKey,
      _mappingKey: mappingKey,
      _sportToken: sportToken,
      _computePriority: computePriority
    };
  }

  window.PLFM_PRIORITY = {
    create: create,
    computePriority: computePriority,
    // exposed pure helpers for reuse / tests
    fixtureKey: fixtureKey,
    mappingKey: mappingKey,
    sportToken: sportToken
  };
})();
