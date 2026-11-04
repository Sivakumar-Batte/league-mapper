/* =====================================================================
   plfm-collection.js  (window.PLFM_COLLECTION)  -- ADDITIVE collection manager.

   Implements Task 3.2 "seven-day collection manager with Correct/Confirm"
   (design C1a/C3, data model SevenDayCollection; Req 2.2-2.8, 17.1, 17.5, 18.2).

   This module consolidates one-day-at-a-time Flashscore imports into the single
   seven-day collection stored under the SHARED MSFM key
   `basketball_7day_fixture_collection_v1`. Every mutation goes through the
   reactive layer's SINGLE mutation funnel `reactive.datasets.commit('collection',
   value)` so dependent derived views (Overview, worked classification, workbench)
   auto-refresh with no manual rebuild. It NEVER opens a second storage path.

   COLLECTION SHAPE (design data model SevenDayCollection):
     {
       byDate: { [dateKey]: { bySport: { [canonSport]: FlashscoreFixture[] } } },
       lastImport
     }

   DEDUPE / RETENTION / CORRECT-CONFIRM:
     - Identity-dedupe (Req 2.5, 17.5): within the target date+sport bucket, a
       record whose adapter.fixtureIdentity already exists UPDATES the existing
       record in place (never adds a duplicate). Re-importing the same day is
       idempotent.
     - Retain other dates (Req 2.4): merging date D never mutates or removes
       fixtures on other dates.
     - Date-discrepancy Correct/Confirm (Req 2.3): when pasted rows carry a date
       different from the selected date, mergeImport returns a `needsDateDecision`
       result listing BOTH the selected date and the pasted date(s) and stores
       NOTHING until the caller re-invokes with confirm:'correct' (operator fixed
       the input so dates agree) or confirm:'confirm' (store under the PASTED
       date, never the selected date, never a silent relabel).

   DEPENDS ON: window.PLFM_ADAPTER (fixtureIdentity, parseFlashscorePaste, store),
   window.FXE (canonSport, dateKey, addDaysISO), and a reactive context created by
   window.PLFM_REACTIVE (datasets.commit/get/version). It is wired into the host
   page after plfm-reactive.js.
   ===================================================================== */
(function(){
  "use strict";
  if (typeof window === "undefined") { return; }
  if (!window.FXE) {
    throw new Error("plfm-collection.js requires engine.js (window.FXE) to be loaded first.");
  }
  if (!window.PLFM_ADAPTER) {
    throw new Error("plfm-collection.js requires plfm-integration.js (window.PLFM_ADAPTER) to be loaded first.");
  }

  var FXE = window.FXE;
  var COLLECTION_KEY = "basketball_7day_fixture_collection_v1";
  var LAST_IMPORT_KEY = "plfm_last_import_v1";

  function canonSportOf(sport){
    return FXE.canonSport(sport) || (sport ? String(sport).trim() : "");
  }

  // Empty, well-formed collection shape.
  function emptyCollection(){ return { byDate: {}, lastImport: null }; }

  // Defensive normalization of whatever is currently stored under the key so a
  // malformed/legacy value never throws and never corrupts a merge.
  function normalizeCollection(value){
    var col = (value && typeof value === "object") ? value : {};
    var out = emptyCollection();
    out.lastImport = (col.lastImport != null) ? col.lastImport : null;
    var byDate = (col.byDate && typeof col.byDate === "object") ? col.byDate : {};
    Object.keys(byDate).forEach(function(dk){
      var entry = byDate[dk];
      var bySport = (entry && entry.bySport && typeof entry.bySport === "object") ? entry.bySport : {};
      var outBySport = {};
      Object.keys(bySport).forEach(function(sp){
        var arr = bySport[sp];
        outBySport[sp] = Array.isArray(arr) ? arr.slice() : [];
      });
      out.byDate[dk] = { bySport: outBySport };
    });
    return out;
  }

  // The pasted date of a single record. parseFlashscorePaste surfaces wrong-date
  // rows via r.DateNote; the row itself does NOT carry its own ISO date (the
  // parser filters/relabels), so we derive the pasted date from the DateNote
  // ("... lists this fixture on DD.MM.YYYY, not on the selected date ...").
  // When a row has no DateNote it agrees with the selected date.
  function pastedDateOf(record, selectedISO){
    if (record && typeof record.DateNote === "string") {
      var m = record.DateNote.match(/lists this fixture on\s+(\d{2})\.(\d{2})\.(\d{4})/);
      if (m) { return FXE.isoFromParts(+m[3], +m[2], +m[1]) || ""; }
      // DateNote without a parseable prefix still signals a discrepancy.
      return "__DISCREPANCY__";
    }
    return selectedISO;
  }

  function create(ctx){
    ctx = ctx || {};
    var reactive = ctx.reactive || (window.__PLFM && window.__PLFM.reactive);
    var adapter  = ctx.adapter  || window.PLFM_ADAPTER;
    if (!reactive || !reactive.datasets || typeof reactive.datasets.commit !== "function") {
      throw new Error("plfm-collection.js requires a reactive context with datasets.commit (PLFM_REACTIVE.create).");
    }
    if (!adapter || typeof adapter.fixtureIdentity !== "function") {
      throw new Error("plfm-collection.js requires PLFM_ADAPTER with fixtureIdentity.");
    }
    // A store for the PLFM-owned last-import timestamp. The collection itself is
    // ALWAYS written via reactive.datasets.commit('collection', ...); lastImport
    // is a PLFM-owned scalar (not a reactive dataset key) written via the same
    // backend the adapter uses so there is still exactly one storage path.
    var store = ctx.store || adapter.store;

    // Read the current collection. Prefer the reactive in-memory value (kept in
    // sync by commit/hydrate); fall back to the backing store so the manager is
    // correct even before the first commit of this session.
    function readCollection(){
      var v = reactive.datasets.get("collection");
      if (v == null && store && store.readJSON) { v = store.readJSON(COLLECTION_KEY, null); }
      return normalizeCollection(v);
    }

    function commitCollection(col){
      col.lastImport = nowISO();
      var ok = reactive.datasets.commit("collection", col);
      writeLastImport(col.lastImport);
      return ok;
    }

    function nowISO(){ return new Date().toISOString(); }
    function writeLastImport(ts){
      try { if (store && store.safeSet) { store.safeSet(LAST_IMPORT_KEY, JSON.stringify({ at: ts })); } } catch (e) {}
    }

    // Ensure the date+sport bucket exists and return it.
    function bucket(col, dateISO, sport){
      if (!Object.prototype.hasOwnProperty.call(col.byDate, dateISO)) { col.byDate[dateISO] = { bySport: {} }; }
      var bs = col.byDate[dateISO].bySport;
      if (!Object.prototype.hasOwnProperty.call(bs, sport) || !Array.isArray(bs[sport])) { bs[sport] = []; }
      return bs[sport];
    }

    // Merge an array of fixture records into a single date+sport bucket with
    // identity-dedupe (existing identity -> UPDATE in place; new identity ->
    // append). Returns {added, updated}.
    function mergeRecordsIntoDate(col, dateISO, sport, records){
      var list = bucket(col, dateISO, sport);
      // Index existing records by identity.
      var indexByIdentity = {};
      for (var i = 0; i < list.length; i++) {
        indexByIdentity[adapter.fixtureIdentity(list[i])] = i;
      }
      var added = 0, updated = 0;
      for (var r = 0; r < records.length; r++) {
        var rec = records[r];
        var id = adapter.fixtureIdentity(rec);
        if (Object.prototype.hasOwnProperty.call(indexByIdentity, id)) {
          list[indexByIdentity[id]] = rec;   // UPDATE in place, never duplicate
          updated++;
        } else {
          indexByIdentity[id] = list.length;
          list.push(rec);
          added++;
        }
      }
      return { added: added, updated: updated };
    }

    /* =================================================================
       mergeImport(parseResult, {sport, date, confirm})
       - parseResult: output of adapter.parseFlashscorePaste (has .records, .warnings).
       - sport, date: the operator's selected sport + date (date may be any
         FXE.dateKey-parseable form; it is canonicalized to ISO).
       - confirm: undefined | 'correct' | 'confirm'
           * undefined: detect date discrepancy; if any pasted date != selected,
             DO NOT store -> return needsDateDecision with both dates.
           * 'correct' : operator fixed the input so dates agree; proceed to
             store under the selected date (records with a lingering discrepancy
             are rejected rather than silently relabelled).
           * 'confirm' : store fixtures under their PASTED date (never the
             selected date, never a silent relabel).
       ================================================================= */
    function mergeImport(parseResult, opts){
      opts = opts || {};
      var sport = canonSportOf(opts.sport);
      var selectedISO = FXE.dateKey(opts.date) || "";
      var confirm = opts.confirm || null;
      var records = (parseResult && Array.isArray(parseResult.records)) ? parseResult.records : [];

      if (!selectedISO) {
        return { ok: false, stored: false, error: "The selected date could not be understood as a date.", added: 0, updated: 0 };
      }

      // Partition records by their pasted date.
      var pastedDates = {};          // isoOrToken -> [records]
      var discrepancyDates = {};     // set of pasted dates != selected
      for (var i = 0; i < records.length; i++) {
        var pd = pastedDateOf(records[i], selectedISO);
        (pastedDates[pd] = pastedDates[pd] || []).push(records[i]);
        if (pd !== selectedISO) { discrepancyDates[pd] = true; }
      }
      var discrepancyList = Object.keys(discrepancyDates);
      var hasDiscrepancy = discrepancyList.length > 0;

      // --- No confirmation yet and a discrepancy exists -> block, ask operator.
      if (hasDiscrepancy && !confirm) {
        return {
          ok: false,
          stored: false,
          needsDateDecision: true,
          selectedDate: selectedISO,
          pastedDates: discrepancyList.filter(function(d){ return d !== "__DISCREPANCY__"; }),
          hasUnparseablePastedDate: discrepancyList.indexOf("__DISCREPANCY__") >= 0,
          counts: Object.keys(pastedDates).reduce(function(acc,k){ acc[k] = pastedDates[k].length; return acc; }, {}),
          added: 0,
          updated: 0,
          message: "Pasted rows carry a date different from the selected date. Choose Correct (fix the input so dates agree and re-submit) or Confirm (store the fixtures under the pasted date)."
        };
      }

      var col = readCollection();
      var totalAdded = 0, totalUpdated = 0, datesTouched = {};

      if (confirm === "confirm") {
        // Store each record under ITS OWN pasted date (never the selected date).
        // A record that agrees with the selected date stores under the selected
        // date; a wrong-date record stores under its pasted date.
        Object.keys(pastedDates).forEach(function(pd){
          if (pd === "__DISCREPANCY__") { return; } // cannot resolve an unparseable date; skip safely
          var res = mergeRecordsIntoDate(col, pd, sport, pastedDates[pd]);
          totalAdded += res.added; totalUpdated += res.updated; datesTouched[pd] = true;
        });
      } else {
        // confirm === 'correct' (or no discrepancy at all): dates must agree.
        // If a discrepancy still lingers we DO NOT silently relabel; reject it.
        if (hasDiscrepancy) {
          return {
            ok: false,
            stored: false,
            needsDateDecision: true,
            selectedDate: selectedISO,
            pastedDates: discrepancyList.filter(function(d){ return d !== "__DISCREPANCY__"; }),
            added: 0,
            updated: 0,
            message: "The input still lists fixtures on a different date. Fix the paste so all dates match the selected date, then re-submit Correct."
          };
        }
        var r2 = mergeRecordsIntoDate(col, selectedISO, sport, records);
        totalAdded += r2.added; totalUpdated += r2.updated; datesTouched[selectedISO] = true;
      }

      var persisted = commitCollection(col);
      return {
        ok: true,
        stored: true,
        // persisted reflects whether the single storage funnel actually wrote
        // through. When storage is unavailable the in-memory collection is still
        // updated (dataset independence: valid data is never discarded), the
        // persistence-status notice is surfaced by safeSet, and callers can warn
        // the operator that the save did not reach storage. Req 18.2, 18.4.
        persisted: persisted !== false,
        needsDateDecision: false,
        selectedDate: selectedISO,
        datesStored: Object.keys(datesTouched),
        added: totalAdded,
        updated: totalUpdated,
        lastImport: col.lastImport
      };
    }

    /* ---------- Views ---------- */

    function listByDate(){
      var col = readCollection();
      var out = {};
      Object.keys(col.byDate).forEach(function(dk){
        var bySport = col.byDate[dk].bySport || {};
        var flat = [];
        Object.keys(bySport).forEach(function(sp){ flat = flat.concat(bySport[sp] || []); });
        out[dk] = flat;
      });
      return out;
    }

    function listBySportAndDate(sport, date){
      var sp = canonSportOf(sport);
      var dk = FXE.dateKey(date) || date;
      var col = readCollection();
      var entry = col.byDate[dk];
      if (!entry || !entry.bySport || !entry.bySport[sp]) { return []; }
      return entry.bySport[sp].slice();
    }

    function dates(){ return Object.keys(readCollection().byDate).sort(); }

    /* ---------- Single-date mutations (never affect other dates) ---------- */

    // replaceDate(date, records[, sport]) -- replace the entire bucket for one
    // date. If sport is given, only that sport bucket for the date is replaced;
    // otherwise records are grouped by each record's canonSport.
    function replaceDate(date, records, sport){
      var dk = FXE.dateKey(date) || date;
      var col = readCollection();
      records = Array.isArray(records) ? records : [];
      if (sport) {
        var sp = canonSportOf(sport);
        if (!col.byDate[dk]) { col.byDate[dk] = { bySport: {} }; }
        col.byDate[dk].bySport[sp] = [];
        mergeRecordsIntoDate(col, dk, sp, records);
      } else {
        col.byDate[dk] = { bySport: {} };
        var byGroup = {};
        records.forEach(function(rec){
          var s = canonSportOf(rec.Sport) || canonSportOf(sport) || "Basketball";
          (byGroup[s] = byGroup[s] || []).push(rec);
        });
        Object.keys(byGroup).forEach(function(s){ mergeRecordsIntoDate(col, dk, s, byGroup[s]); });
      }
      commitCollection(col);
      return true;
    }

    function removeDate(date){
      var dk = FXE.dateKey(date) || date;
      var col = readCollection();
      if (!col.byDate[dk]) { return false; }
      delete col.byDate[dk];
      commitCollection(col);
      return true;
    }

    // removeSportDate(date, sport) -- remove ONLY the given sport's bucket for a
    // single date. Other sports on that date, and all other dates, are left
    // untouched. When removing the sport empties the date entirely the (now
    // empty) date entry is dropped so distinct-date counts stay accurate. Goes
    // through the SAME commit funnel -- no second storage path.
    function removeSportDate(date, sport){
      var dk = FXE.dateKey(date) || date;
      var sp = canonSportOf(sport);
      var col = readCollection();
      var entry = col.byDate[dk];
      if (!entry || !entry.bySport || !Object.prototype.hasOwnProperty.call(entry.bySport, sp)) { return false; }
      delete entry.bySport[sp];
      if (Object.keys(entry.bySport).length === 0) { delete col.byDate[dk]; }
      commitCollection(col);
      return true;
    }

    // clearAll() -- clears the whole collection. The caller is responsible for
    // any confirmation UI; this function just performs the clear.
    function clearAll(){
      var col = emptyCollection();
      commitCollection(col);
      return true;
    }

    function lastImport(){
      try {
        if (store && store.readJSON) { var v = store.readJSON(LAST_IMPORT_KEY, null); if (v && v.at) return v.at; }
      } catch (e) {}
      return readCollection().lastImport || null;
    }

    return {
      key: COLLECTION_KEY,
      lastImportKey: LAST_IMPORT_KEY,
      mergeImport: mergeImport,
      listByDate: listByDate,
      listBySportAndDate: listBySportAndDate,
      dates: dates,
      replaceDate: replaceDate,
      removeDate: removeDate,
      removeSportDate: removeSportDate,
      clearAll: clearAll,
      lastImport: lastImport,
      // inspection/reuse helpers
      _readCollection: readCollection,
      _emptyCollection: emptyCollection,
      _normalizeCollection: normalizeCollection,
      _pastedDateOf: pastedDateOf
    };
  }

  window.PLFM_COLLECTION = { create: create, COLLECTION_KEY: COLLECTION_KEY, LAST_IMPORT_KEY: LAST_IMPORT_KEY };
})();
