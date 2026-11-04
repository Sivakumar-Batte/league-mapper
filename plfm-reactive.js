/* =====================================================================
   plfm-reactive.js  (window.PLFM_REACTIVE)  -- ADDITIVE reactive layer.

   Implements design component C1a "Reactive derivation model (automatic, no
   manual rebuild)". This is a small, self-contained reactive layer that makes
   every derived view (Overview counts/comparison, worked classification,
   workbench rows, BCM resolution) ALWAYS correct WITHOUT any operator-triggered
   rebuild (Req 12.4, 12.5, 12.6, 17.3). Recomputation is lazy-but-correct:
   selectors recompute on access iff an input dataset version changed.

   This file is ADDITIVE and depends on plfm-integration.js (window.PLFM_ADAPTER)
   for the single storage backend (adapter.store.safeSet / readRaw / readJSON),
   which already targets the right backend including the #plfm-test in-memory
   store. It NEVER creates a second storage path.

   PUBLIC SHAPE
   ------------
   window.PLFM_REACTIVE.create(opts) -> a reactive context with:

     datasets.commit(key, value)   The SINGLE mutation funnel. Persists via the
                                   adapter store, bumps an in-memory monotonic
                                   version[key], and emits a change event to
                                   subscribers of key. Returns true on success.
     datasets.get(key)             Current in-memory value for key.
     datasets.version(key)         Current monotonic version counter for key.
     datasets.hydrate()            Loads all six dataset keys from storage on
                                   boot and seeds version[key]=1 for each.
                                   Selector caches are left EMPTY.
     datasets.keys                 The fixed map of logical key -> storage key.

     derive(inputKeys, computeFn)  Returns a memoized selector function. On
                                   access it recomputes iff any input version
                                   changed (or the cache is empty), else returns
                                   the cache. The selector exposes
                                   .inputs / .recomputeCount for inspection.

     onChange(key, cb)             Subscribe to a dataset change. Returns an
                                   unsubscribe function.
     scheduleRender(renderFn)      Registers a render fn run on the next frame
                                   whenever a relevant dataset changes.
     invalidationMap               The fixed invalidation mapping from C1a.
     dependentsOf(key)             The derived-view ids that depend on a key.

   INVALIDATION MAPPING (C1a, explicit and fixed)
   ----------------------------------------------
     overview   <- collection, betradar, priority, team
     worked     <- collection, priority, worked
     exclusions <- worked, review            (worked classification + review)
     workbench  <- collection, priority, review, team
   ===================================================================== */
(function(){
  "use strict";
  if (typeof window === "undefined") { return; }

  // The six persisted dataset keys (logical name -> storage key). These are the
  // EXACT adapter/host storage keys; no new keys are invented here.
  var DATASET_KEYS = {
    collection: "basketball_7day_fixture_collection_v1",
    betradar:   "plfm_betradar_dataset_v1",
    worked:     "plfm_worked_v1",
    priority:   "basketball_priority_league_mappings_v2",
    team:       "msfm_team_mappings_v1",
    review:     "plfm_review_decisions_v1"
  };

  // Fixed invalidation mapping (C1a). Derived-view id -> the dataset keys it
  // depends on. Changing an upstream dataset invalidates exactly the downstream
  // selectors that depend on it, and no others.
  var INVALIDATION_MAP = {
    overview:   ["collection", "betradar", "priority", "team"],
    worked:     ["collection", "priority", "worked"],
    exclusions: ["worked", "review"],
    workbench:  ["collection", "priority", "review", "team"]
  };

  // requestAnimationFrame with a setTimeout(0) fallback for headless/non-DOM.
  function scheduleFrame(fn){
    if (typeof window.requestAnimationFrame === "function") {
      return window.requestAnimationFrame(fn);
    }
    return setTimeout(function(){ fn(Date.now()); }, 0);
  }

  function create(opts){
    opts = opts || {};

    // The SINGLE storage backend. Default to the adapter's store (which already
    // handles the #plfm-test backend). Callers may pass an explicit store with
    // safeSet/readRaw/readJSON to pin the backend (e.g. the host page's STORE).
    var store = opts.store ||
      (window.PLFM_ADAPTER && window.PLFM_ADAPTER.store) ||
      null;
    if (!store) {
      throw new Error("plfm-reactive.js requires a storage backend (PLFM_ADAPTER.store or opts.store).");
    }

    var keys = opts.keys || DATASET_KEYS;
    var logicalKeys = Object.keys(keys);

    // In-memory state.
    var values = {};                 // logical key -> parsed value
    var version = {};                // logical key -> monotonic version counter
    var listeners = {};              // logical key -> [cb,...]
    logicalKeys.forEach(function(k){ version[k] = 0; listeners[k] = []; });

    // Render scheduler state.
    var renderFns = [];              // registered render functions
    var frameScheduled = false;
    var dirtyKeys = {};              // logical keys changed since last flush

    function readJSONFor(logicalKey, fallback){
      var sk = keys[logicalKey];
      if (store.readJSON) { return store.readJSON(sk, fallback); }
      // Fallback if the store only exposes getItem.
      try {
        var raw = store.readRaw ? store.readRaw(sk) : (store.getItem ? store.getItem(sk) : null);
        if (raw == null) return fallback;
        return JSON.parse(raw);
      } catch (e) { return fallback; }
    }

    function persist(logicalKey, value){
      var sk = keys[logicalKey];
      var payload = (typeof value === "string") ? value : JSON.stringify(value);
      return store.safeSet(sk, payload);
    }

    function emit(logicalKey){
      var cbs = listeners[logicalKey] || [];
      for (var i = 0; i < cbs.length; i++) {
        try { cbs[i](logicalKey, values[logicalKey]); } catch (e) { /* listener errors never break commit */ }
      }
    }

    function flushRender(){
      frameScheduled = false;
      var changed = dirtyKeys; dirtyKeys = {};
      for (var i = 0; i < renderFns.length; i++) {
        var entry = renderFns[i];
        // A render fn with declared keys runs only when one of its keys changed.
        var relevant = !entry.watch || entry.watch.some(function(k){ return changed[k]; });
        if (relevant) {
          try { entry.fn(changed); } catch (e) { /* render errors never break the loop */ }
        }
      }
    }

    function scheduleRenderFlush(logicalKey){
      dirtyKeys[logicalKey] = true;
      if (frameScheduled) return;
      frameScheduled = true;
      scheduleFrame(flushRender);
    }

    var datasets = {
      keys: keys,
      get: function(logicalKey){ return values[logicalKey]; },
      version: function(logicalKey){ return version[logicalKey] || 0; },
      snapshot: function(){
        var out = {}; logicalKeys.forEach(function(k){ out[k] = values[k]; }); return out;
      },
      versions: function(){
        var out = {}; logicalKeys.forEach(function(k){ out[k] = version[k]; }); return out;
      },
      // The SINGLE mutation funnel.
      commit: function(logicalKey, value){
        if (!(logicalKey in keys)) {
          throw new Error("PLFM_REACTIVE.commit: unknown dataset key '" + logicalKey + "'");
        }
        var ok = persist(logicalKey, value);     // persist via the adapter store
        values[logicalKey] = value;              // update in-memory value
        version[logicalKey] = (version[logicalKey] || 0) + 1; // bump monotonic version
        emit(logicalKey);                        // notify subscribers synchronously
        scheduleRenderFlush(logicalKey);         // schedule a re-render next frame
        return ok;
      },
      // Boot hydration: load all six datasets from storage; seed version[key]=1.
      // Selector caches are NOT touched (they start / stay empty).
      hydrate: function(fallbacks){
        fallbacks = fallbacks || {};
        logicalKeys.forEach(function(k){
          values[k] = readJSONFor(k, (k in fallbacks) ? fallbacks[k] : null);
          version[k] = 1;
        });
        return datasets.snapshot();
      }
    };

    // derive(inputKeys, computeFn) -> memoized, version-tracked selector.
    function derive(inputKeys, computeFn){
      var cache;            // last computed result
      var cached = false;   // whether cache holds a value
      var cachedVersions = null; // input versions the cache was computed from
      var recomputeCount = 0;

      function currentVersions(){
        return inputKeys.map(function(k){ return version[k] || 0; });
      }
      function sameVersions(a, b){
        if (!a || !b || a.length !== b.length) return false;
        for (var i = 0; i < a.length; i++) { if (a[i] !== b[i]) return false; }
        return true;
      }

      function selector(){
        var now = currentVersions();
        if (cached && sameVersions(now, cachedVersions)) {
          return cache; // nothing changed -> return the memoized cache
        }
        // Recompute from the current in-memory dataset values.
        var inputValues = {};
        inputKeys.forEach(function(k){ inputValues[k] = values[k]; });
        cache = computeFn(inputValues, datasets);
        cachedVersions = now;
        cached = true;
        recomputeCount++;
        return cache;
      }

      selector.inputs = inputKeys.slice();
      selector.isCached = function(){ return cached; };
      selector.invalidate = function(){ cached = false; cachedVersions = null; };
      Object.defineProperty(selector, "recomputeCount", { get: function(){ return recomputeCount; } });
      return selector;
    }

    function onChange(logicalKey, cb){
      if (!listeners[logicalKey]) listeners[logicalKey] = [];
      listeners[logicalKey].push(cb);
      return function unsubscribe(){
        var arr = listeners[logicalKey] || [];
        var idx = arr.indexOf(cb);
        if (idx >= 0) arr.splice(idx, 1);
      };
    }

    // Register a render fn. watchKeys (optional) restricts it to those datasets;
    // omit to run on every change. Returns an unregister function.
    function scheduleRender(renderFn, watchKeys){
      var entry = { fn: renderFn, watch: watchKeys || null };
      renderFns.push(entry);
      return function unregister(){
        var idx = renderFns.indexOf(entry);
        if (idx >= 0) renderFns.splice(idx, 1);
      };
    }

    function dependentsOf(logicalKey){
      return Object.keys(INVALIDATION_MAP).filter(function(viewId){
        return INVALIDATION_MAP[viewId].indexOf(logicalKey) >= 0;
      });
    }

    return {
      datasets: datasets,
      derive: derive,
      onChange: onChange,
      scheduleRender: scheduleRender,
      invalidationMap: INVALIDATION_MAP,
      dependentsOf: dependentsOf,
      // test/inspection helpers
      _flushRenderNow: flushRender
    };
  }

  window.PLFM_REACTIVE = {
    create: create,
    DATASET_KEYS: DATASET_KEYS,
    INVALIDATION_MAP: INVALIDATION_MAP
  };
})();
