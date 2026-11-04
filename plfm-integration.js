/* =====================================================================
   plfm-integration.js  (window.PLFM_ADAPTER)  -- ADDITIVE adapter layer.

   ADAPTER DECISION (resolved for Task 1, implemented in Task 2):

   - FXE (engine.js, window.FXE) is the SOLE matching / normalization /
     classification / CSV engine. It is NEVER copied. There is exactly one
     source of truth for matching logic, shared with MSFM. Every normalization
     call below (canonSport/sportKey/dateKey/timeKey/countryKey/leagueKey/
     teamKey/eventIdKey) and classification (classifyFixtures) is delegated to
     FXE, never reimplemented.

   - The small set of pure, DOM-free MSFM-only helpers (the Flashscore and
     worked paste parsers, fixtureIdentity, the playoff detection) are PORTED
     into this file VERBATIM from their MSFM / datafeed-check.html origin
     (design Option B), each pinned by a mandatory characterization test in
     plfm-tests.html that asserts behavioral equivalence to its origin on
     shared inputs.

   - The mapping stores are NOT re-implemented as a competing source of truth:
     priorityStore/teamStore read and write the EXACT same localStorage keys
     and record shapes MSFM uses, so PLFM and MSFM share one dataset.

   PORT PROVENANCE (origin line numbers at time of porting):
     - parseFlashscorePaste  <- MSFM parseFixturesDetailed (~l.1414) + parseFixtures
                                (~l.1377) + helpers cleanLines (~l.1321), timeLine
                                (~l.1366), isStatusToken (~l.1376), isCountryHeading,
                                titleCaseCountry (~l.1320), KNOWN_HEADING_COUNTRIES.
     - fixtureIdentity       <- MSFM fixtureIdentity (~l.1413), VERBATIM.
     - reviewIdentity        <- fixtureIdentity tuple MINUS timeKey (design C5a / Req 17).
     - playoffFlag           <- MSFM PLAYOFF_RE + playoffAlerts detection (~l.1472).
     - parseWorkedPaste      <- MSFM parseWorkedPaste (~l.1610), VERBATIM.
     - parseBetradarWorkbook <- datafeed-check.html brRowFields (~l.790),
                                formatBetradarDate (~l.1112), excelSerialToParts
                                (~l.1049), pad, addMinutes, and the verified
                                XLSX.read/sheet_to_json options (~l.861).
     - resolveBcm            <- MSFM bcmResolveBatch resolve logic (~l.2242) +
                                teamMapKey (~l.1853).

   This module depends on the engine; it asserts window.FXE is present on load.
   ===================================================================== */
(function(){
  "use strict";

  if (typeof window === "undefined") { return; }
  if (!window.FXE) {
    throw new Error("plfm-integration.js requires engine.js (window.FXE) to be loaded first.");
  }

  var FXE = window.FXE;
  // Sole-engine delegation. Never reimplemented here.
  var canonSport  = FXE.canonSport;
  var sportKey    = FXE.sportKey;
  var dateKey     = FXE.dateKey;
  var timeKey     = FXE.timeKey;
  var countryKey  = FXE.countryKey;
  var leagueKey   = FXE.leagueKey;
  var teamKey     = FXE.teamKey;
  var eventIdKey  = FXE.eventIdKey;

  var MAX_INVALID_RECORDS = 50; // mirrors MSFM constant

  /* =================================================================
     STORE helper -- mirrors MSFM safeSet / readRaw / readJSON semantics.
     localStorage is primary. When the host page is opened with #plfm-test
     inside an iframe whose parent exposes __PLFM_TEST_STORE, that in-memory
     store is used so tests never touch real browser data. The adapter uses
     the SAME backend the host page selected: the host page exposes it on
     window.__PLFM.store once booted; before that (adapter loads first) we
     replicate the identical selection logic.
     ================================================================= */
  function pickBackend(){
    // Prefer the backend the host page already chose, if it has booted.
    try{ if(window.__PLFM && window.__PLFM.store) return window.__PLFM.store; }catch(e){}
    var testMode = false;
    try{ testMode = /plfm-test/.test(window.location.hash); }catch(e){}
    if(testMode){
      try{ if(window.parent!==window && window.parent.__PLFM_TEST_STORE) return window.parent.__PLFM_TEST_STORE; }catch(e){}
    }
    try{ return window.localStorage; }catch(e){ return null; }
  }
  var store = {
    backend: pickBackend,
    safeSet:function(key,value){ try{ var b=pickBackend(); if(!b) throw new Error("NoStorage"); b.setItem(key,value); return true; }catch(e){ return false; } },
    readRaw:function(key){ try{ var b=pickBackend(); return b?b.getItem(key):null; }catch(e){ return null; } },
    readJSON:function(key,fallback){ var raw=this.readRaw(key); if(raw==null) return fallback; try{ return JSON.parse(raw); }catch(e){ return fallback; } },
    remove:function(key){ try{ var b=pickBackend(); if(b) b.removeItem(key); return true; }catch(e){ return false; } }
  };

  /* =================================================================
     uid -- mirrors MSFM uid() so adapter-written records carry the same
     id shape MSFM writes (prefix "map-").
     ================================================================= */
  var uidCounter = 0;
  function uid(){ return "map-"+Date.now().toString(36)+"-"+(uidCounter++).toString(36)+"-"+Math.random().toString(36).slice(2,7); }

  /* =================================================================
     priorityStore -- over basketball_priority_league_mappings_v2.
     MSFM record shape (verbatim from MSFM loadMappings / importMappingCSV):
       { id, sport, country, priorityLeague, flashscoreLeague, active }
     MSFM stores the array directly (readJSON(STORAGE.mappings,[])), so this
     store reads/writes a plain JSON array at the same key.
     ================================================================= */
  var PRIORITY_KEY = "basketball_priority_league_mappings_v2";
  var SHARED_SYNC_KEY = "msfm_shared_mapping_sync_v1";

  function normalizePriorityRecord(m){
    if(!m || typeof m!=="object") return null;
    var rec = {
      id: (typeof m.id==="string" && m.id) ? m.id : uid(),
      sport: canonSport(m.sport) || (m.sport ? String(m.sport).trim() : "Basketball"),
      country: String(m.country==null?"":m.country),
      priorityLeague: String(m.priorityLeague==null?"":m.priorityLeague),
      flashscoreLeague: String(m.flashscoreLeague==null?"":m.flashscoreLeague),
      active: m.active!==false
    };
    // Optional fields are preserved ONLY when populated so a record without them
    // keeps the exact MSFM field set (byte-shape compatible). betradarLeague is
    // used for the FS<->BR league pairing (Req 6.3 / 8.4); notes is operator free
    // text (Req 8.1). Both are additive and ignored by MSFM.
    if(m.betradarLeague!=null && String(m.betradarLeague).trim()!=="") rec.betradarLeague = String(m.betradarLeague);
    if(m.notes!=null && String(m.notes).trim()!=="") rec.notes = String(m.notes);
    // Prepare-Mapping additive lifecycle fields (Req 8.5, 11.3, 11.9, 17.1). These
    // are preserved ONLY when populated so a record without them keeps the exact
    // MSFM field set (byte-shape compatible) and is ignored by MSFM. reviewState
    // is a Prepare-Mapping-namespaced object; confirmedAt/confirmedBy accompany a
    // CONFIRMED betradarLeague relationship.
    if(m.reviewState!=null && typeof m.reviewState==="object") rec.reviewState = m.reviewState;
    if(m.confirmedAt!=null && String(m.confirmedAt).trim()!=="") rec.confirmedAt = String(m.confirmedAt);
    if(m.confirmedBy!=null && String(m.confirmedBy).trim()!=="") rec.confirmedBy = String(m.confirmedBy);
    return rec;
  }
  function priorityMergeKey(m){ return canonSport(m.sport)+"|"+countryKey(m.country)+"|"+leagueKey(m.priorityLeague); }

  var priorityStore = {
    key: PRIORITY_KEY,
    syncKey: SHARED_SYNC_KEY,
    read:function(){ var raw=store.readJSON(PRIORITY_KEY,[]); return Array.isArray(raw)?raw:[]; },
    write:function(list){ return store.safeSet(PRIORITY_KEY, JSON.stringify(Array.isArray(list)?list:[])); },
    list:function(){ return this.read().map(normalizePriorityRecord).filter(Boolean); },
    get:function(id){ return this.list().find(function(m){ return m.id===id; }) || null; },
    add:function(rec){
      var item=normalizePriorityRecord(rec); var list=this.read();
      list.push(item); this.write(list); return item;
    },
    update:function(id,patch){
      var list=this.read(); var found=null;
      for(var i=0;i<list.length;i++){ if(list[i] && list[i].id===id){ list[i]=normalizePriorityRecord(Object.assign({},list[i],patch,{id:id})); found=list[i]; break; } }
      if(found) this.write(list); return found;
    },
    remove:function(id){
      var list=this.read(); var next=list.filter(function(m){ return !(m&&m.id===id); });
      var removed=next.length!==list.length; if(removed) this.write(next); return removed;
    },
    activate:function(id){ return this.update(id,{active:true}); },
    deactivate:function(id){ return this.update(id,{active:false}); },
    mergeKey: priorityMergeKey
  };

  /* =================================================================
     teamStore -- over msfm_team_mappings_v1.
     MSFM record shape (verbatim from MSFM loadTeamMappings):
       { id, sport, country, flashscoreLeague, flashscoreTeam, bcmTeam, active }
     ================================================================= */
  var TEAM_KEY = "msfm_team_mappings_v1";

  function normalizeTeamRecord(m){
    if(!m || typeof m!=="object") return null;
    var rec = {
      id: (typeof m.id==="string" && m.id) ? m.id : uid(),
      sport: canonSport(m.sport) || (m.sport ? String(m.sport).trim() : "Basketball"),
      country: String(m.country==null?"":m.country),
      flashscoreLeague: String(m.flashscoreLeague==null?"":m.flashscoreLeague),
      flashscoreTeam: String(m.flashscoreTeam==null?"":m.flashscoreTeam),
      bcmTeam: String(m.bcmTeam==null?"":m.bcmTeam),
      active: m.active!==false
    };
    // Prepare-Mapping additive fields (Req 9.11, 9.12, 9.13, 11.3, 11.4, 11.9,
    // 17.1). Mirrors normalizePriorityRecord: each is preserved ONLY when
    // populated so a record without them keeps the EXACT MSFM field set
    // (byte-shape compatible) and is read/written by MSFM with no migration.
    //   - betradarTeam: the confirmed FS<->BR team alias. May be a single alias
    //     (string) OR an array of confirmed aliases for the same scope (Req 9.13).
    //   - reviewState: Prepare-Mapping-namespaced lifecycle object (never read by
    //     MSFM); confirmedAt/confirmedBy accompany a CONFIRMED betradarTeam.
    if(Array.isArray(m.betradarTeam)){
      var aliases = [];
      for(var ai=0; ai<m.betradarTeam.length; ai++){
        var av = m.betradarTeam[ai];
        if(av!=null && String(av).trim()!=="") aliases.push(String(av));
      }
      if(aliases.length) rec.betradarTeam = aliases;
    } else if(m.betradarTeam!=null && String(m.betradarTeam).trim()!==""){
      rec.betradarTeam = String(m.betradarTeam);
    }
    if(m.reviewState!=null && typeof m.reviewState==="object") rec.reviewState = m.reviewState;
    if(m.confirmedAt!=null && String(m.confirmedAt).trim()!=="") rec.confirmedAt = String(m.confirmedAt);
    if(m.confirmedBy!=null && String(m.confirmedBy).trim()!=="") rec.confirmedBy = String(m.confirmedBy);
    return rec;
  }
  // Exact, normalised composite key. Reuses FXE teamKey (accent/case/space/punct folding).
  // Mirrors MSFM teamMapKey VERBATIM (uses \u0001 separator).
  function teamMapKey(sport,country,league,team){
    return [canonSport(sport)||String(sport==null?"":sport).trim(),countryKey(country),leagueKey(league),teamKey(team)].join("\u0001");
  }

  var teamStore = {
    key: TEAM_KEY,
    read:function(){ var raw=store.readJSON(TEAM_KEY,[]); return Array.isArray(raw)?raw:[]; },
    write:function(list){ return store.safeSet(TEAM_KEY, JSON.stringify(Array.isArray(list)?list:[])); },
    list:function(){ return this.read().map(normalizeTeamRecord).filter(Boolean); },
    get:function(id){ return this.list().find(function(m){ return m.id===id; }) || null; },
    add:function(rec){ var item=normalizeTeamRecord(rec); var list=this.read(); list.push(item); this.write(list); return item; },
    update:function(id,patch){
      var list=this.read(); var found=null;
      for(var i=0;i<list.length;i++){ if(list[i] && list[i].id===id){ list[i]=normalizeTeamRecord(Object.assign({},list[i],patch,{id:id})); found=list[i]; break; } }
      if(found) this.write(list); return found;
    },
    remove:function(id){
      var list=this.read(); var next=list.filter(function(m){ return !(m&&m.id===id); });
      var removed=next.length!==list.length; if(removed) this.write(next); return removed;
    },
    mapKey: teamMapKey
  };

  /* =================================================================
     Flashscore paste parser -- ported VERBATIM from MSFM.
     The only change: cleanLines reads known countries from the LIVE priority
     store (MSFM read its `mappings` global; the adapter reads priorityStore)
     so the known-country split behaves identically given the same mappings.
     ================================================================= */
  var KNOWN_HEADING_COUNTRIES = ["EUROPE","AFRICA","AMERICA","SOUTH AMERICA","NORTH AMERICA","CENTRAL AMERICA","ASIA","OCEANIA","AUSTRALIA & OCEANIA","WORLD","INTERNATIONAL",
    "ALBANIA","ANDORRA","ARGENTINA","ARMENIA","AUSTRALIA","AUSTRIA","AZERBAIJAN","BAHRAIN","BELARUS","BELGIUM","BOSNIA","BOSNIA AND HERZEGOVINA","BRAZIL","BULGARIA","CANADA","CHILE","CHINA",
    "COLOMBIA","CROATIA","CYPRUS","CZECH REPUBLIC","DENMARK","DOMINICAN REPUBLIC","ECUADOR","EGYPT","ENGLAND","ESTONIA","FINLAND","FRANCE","GEORGIA","GERMANY","GREAT BRITAIN","GREECE",
    "HONG KONG","HUNGARY","ICELAND","INDONESIA","IRAN","IRELAND","ISRAEL","ITALY","JAPAN","JORDAN","KAZAKHSTAN","KOSOVO","KUWAIT","LATVIA","LEBANON","LITHUANIA","LUXEMBOURG",
    "MALAYSIA","MALTA","MEXICO","MONTENEGRO","MOROCCO","NETHERLANDS","NEW ZEALAND","NORTH MACEDONIA","NORWAY","PARAGUAY","PERU","PHILIPPINES","POLAND","PORTUGAL","PUERTO RICO","QATAR",
    "ROMANIA","RUSSIA","SAUDI ARABIA","SCOTLAND","SERBIA","SLOVAKIA","SLOVENIA","SOUTH AFRICA","SOUTH KOREA","SPAIN","SWEDEN","SWITZERLAND","TAIWAN","THAILAND","TUNISIA","TURKEY",
    "UK","UKRAINE","UNITED KINGDOM","UNITED STATES","URUGUAY","USA","VENEZUELA","VIETNAM","WALES"];

  function titleCaseCountry(value){ return value.toLowerCase().replace(/\b[a-z\u00e0-\u024f]/g,function(c){return c.toUpperCase();}); }

  function cleanLines(text){
    var sourceLines=text.split(/\r?\n/).map(function(x){return x.trim();}).filter(Boolean),lines=[];
    var mappings = priorityStore.list();
    var knownCountries=Array.from(new Set(mappings.map(function(m){return m.country;}).concat(KNOWN_HEADING_COUNTRIES)))
      .map(function(x){return String(x).trim().toUpperCase();}).filter(Boolean).sort(function(a,b){return b.length-a.length;});
    var escapeRe=function(s){return s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");};
    var countryRes=knownCountries.map(function(c){return [c,new RegExp("^(.+?)("+escapeRe(c)+"):(?:\\s*(?:Standings|Draw))?$")];});
    var genericRe=/^(.*?[a-z0-9)\]])([A-Z][A-Z\u00c0-\u00dd .&'-]*[A-Z]):(?:\s*(?:Standings|Draw))?$/;
    var knownSet=new Set(knownCountries);
    for(var si=0;si<sourceLines.length;si++){
      var sourceLine=sourceLines[si];
      if(/^(?:standings|draw)$/i.test(sourceLine)||/^-+$/.test(sourceLine))continue;
      var split=false;
      var whole=sourceLine.replace(/:.*$/,"").trim().toUpperCase();
      for(var ci=0;ci<countryRes.length;ci++){
        var country=countryRes[ci][0],re=countryRes[ci][1];
        var match=sourceLine.match(re);
        if(!match)continue;
        var glued=/[a-z]/.test(match[1])||(match[1].length>=2&&!/\s$/.test(match[1])&&!knownSet.has(whole));
        if(glued){lines.push(match[1].trim());lines.push(match[2].toUpperCase()+":");split=true;break;}
      }
      if(!split){
        var g=sourceLine.match(genericRe);
        if(g&&!/^\d{1,2}:\d{2}/.test(sourceLine)){lines.push(g[1].trim());lines.push(g[2].trim()+":");split=true;}
      }
      if(split)continue;
      var compact=sourceLine.match(/^(\d{1,2}:\d{2})(.+)--$/);
      if(compact){
        var next=sourceLines[si+1]||"",n2=sourceLines[si+2]||"";
        if(next!==compact[1]&&(next+n2).replace(/\s+/g,"")===compact[2].replace(/\s+/g,"")&&!/^\d{1,2}:\d{2}$/.test(next))lines.push(compact[1]);
        continue;
      }
      lines.push(sourceLine);
    }
    return lines;
  }
  function isCountryHeading(line){ return /^[A-Z\u00c0-\u00dd][A-Z\u00c0-\u00dd\s&.'()-]*:\s*$/.test(line); }
  function timeLine(l){
    var m=String(l==null?"":l).match(/^(?:(\d{1,2})\.(\d{1,2})\.(\d{4})?\s*)?(\d{1,2}:\d{2})$/);
    return m?{time:m[4],d:m[1]?+m[1]:0,mo:m[2]?+m[2]:0,y:m[3]?+m[3]:0}:null;
  }
  function isStatusToken(l){
    var s=String(l==null?"":l).trim();
    if(s==="")return false;
    return /^(?:FRO|AOT|AET|AP|AWO|WO|Ret\.?|Abn\.?|Canc\.?|Cancelled|Postp\.?|Postponed|Awarded|Susp\.?|Suspended|Interrupted|Live|Finished|After\s+(?:Pen\.?|OT|ET)|Pen\.?|OT|ET)$/i.test(s);
  }
  // FXE date helpers used by the parser (same ones MSFM used).
  var isoFromParts = FXE.isoFromParts;

  function parseFixtures(raw,sport,date){
    var lines=cleanLines(raw),rows=[];var league="",country="",leagueLine=-1;
    var isTime=function(l){return !!timeLine(l);};
    var selISO=dateKey(date),selY=selISO?+selISO.slice(0,4):0;
    for(var i=0;i<lines.length;i++){
      var line=lines[i];
      if(isCountryHeading(line)){
        country=titleCaseCountry(line.replace(/:\s*$/,"").trim());
        var prev=lines[i-1];
        if(leagueLine!==i-1&&!(prev&&isCountryHeading(prev)))league="";
        continue;
      }
      if(i+1<lines.length&&isCountryHeading(lines[i+1])&&!isTime(line)){league=line;leagueLine=i;continue;}
      var tl=timeLine(line);
      if(tl){
        var hi=i+1;
        while(hi<lines.length&&isStatusToken(lines[hi]))hi++;
        var home=lines[hi],away=lines[hi+1];
        if(!home||!away||isTime(home)||isTime(away)||isCountryHeading(home)||isCountryHeading(away))continue;
        var row={Sport:sport,Date:date,Time:tl.time,Country:country,DetectedLeague:league,Home:home,Away:away};
        Object.defineProperties(row,{SourceLine:{value:i+1},SourceContext:{value:lines.slice(Math.max(0,i-1),hi+2).join(" | ")}});
        if(tl.d&&selISO){
          var iso=isoFromParts(tl.y||selY,tl.mo,tl.d),prefix=String(tl.d).padStart(2,"0")+"."+String(tl.mo).padStart(2,"0")+"."+(tl.y||"");
          if(!iso)Object.defineProperty(row,"MalformedDateReason",{value:"Malformed or unsupported date prefix "+prefix});
          else if(iso!==selISO)row.DateNote="Flashscore lists this fixture on "+prefix+", not on the selected date "+date+", so it was not collected under "+date+".";
        }
        rows.push(row);i=hi+1;
      }
    }
    return rows.filter(function(r){return r.Home&&r.Away;});
  }

  // VERBATIM MSFM fixtureIdentity (time-INCLUSIVE). Used for duplicate detection
  // parity with MSFM (the dedup key in parseFixturesDetailed). The tuple is:
  //   [sportKey, dateKey||String(Date), timeKey||String(Time), countryKey,
  //    leagueKey(DetectedLeague||Flashscore League Name||League),
  //    teamKey(Home), teamKey(Away), eventIdKey(Event ID||EventID)].join('|')
  function fixtureIdentity(f){
    return [sportKey(f.Sport),dateKey(f.Date)||String(f.Date||""),timeKey(f.Time)||String(f.Time||""),countryKey(f.Country),leagueKey(f.DetectedLeague||f["Flashscore League Name"]||f.League),teamKey(f.Home),teamKey(f.Away),eventIdKey(f["Event ID"]||f.EventID)].join("|");
  }

  // reviewIdentity -- the SAME tuple as fixtureIdentity but WITHOUT the timeKey
  // element. Used for Review_Decision keying per design C5a / Req 17: a kickoff
  // time change must not orphan a prior decision, so time is excluded from the
  // identity used to re-associate operator decisions across re-import.
  function reviewIdentity(f){
    return [sportKey(f.Sport),dateKey(f.Date)||String(f.Date||""),countryKey(f.Country),leagueKey(f.DetectedLeague||f["Flashscore League Name"]||f.League),teamKey(f.Home),teamKey(f.Away),eventIdKey(f["Event ID"]||f.EventID)].join("|");
  }

  function parseFixturesDetailed(raw,sport,date){
    var inputLines=String(raw==null?"":raw).split(/\r?\n/).filter(function(x){return x.trim();}).length,all=parseFixtures(raw,sport,date),seen=new Set(),rows=[],duplicates=[],duplicateRecords=[];
    for(var a=0;a<all.length;a++){var f=all[a];var key=fixtureIdentity(f);if(seen.has(key)){var reason="Duplicate source fixture; the first identical row was retained.";duplicates.push(Object.assign({},f,{Category:"Duplicate",Reason:reason}));duplicateRecords.push({line:f.SourceLine||1,reason:reason,context:f.SourceContext||(f.Time+" | "+f.Home+" | "+f.Away)});continue;}seen.add(key);rows.push(f);}
    var clean=cleanLines(raw),invalidRecords=[];
    for(var b=0;b<all.length;b++){if(all[b].MalformedDateReason)invalidRecords.push({line:all[b].SourceLine||1,reason:all[b].MalformedDateReason,context:all[b].SourceContext||(all[b].Time+" | "+all[b].Home+" | "+all[b].Away)});}
    for(var i=0;i<clean.length;i++){var tl=timeLine(clean[i]);if(!tl)continue;var hi=i+1;while(hi<clean.length&&isStatusToken(clean[hi]))hi++;var home=clean[hi],away=clean[hi+1];if(!home||!away||timeLine(home)||timeLine(away)||isCountryHeading(home)||isCountryHeading(away))invalidRecords.push({line:i+1,reason:"Time was not followed by valid home and away team lines",context:clean.slice(Math.max(0,i-1),hi+2).join(" | ")});}
    if(!all.length&&String(raw).trim())invalidRecords.push({line:1,reason:"No complete fixture groups were detected",context:String(raw).trim().slice(0,240)});
    var issueRecords=invalidRecords.concat(duplicateRecords).sort(function(x,y){return x.line-y.line;});
    return {rows:rows,duplicates:duplicates,inputLines:inputLines,invalidRecords:issueRecords.slice(0,MAX_INVALID_RECORDS),invalidCount:invalidRecords.length};
  }

  // Adapter entry point. Mirrors parseFixturesDetailed output and also returns a
  // normalized {records, warnings, errors} shape the pages consume. `records`
  // === parseFixturesDetailed.rows; `warnings` carries wrong-date notes; `errors`
  // carries invalid/duplicate issue records.
  function parseFlashscorePaste(text,opts){
    opts=opts||{};
    var sport=canonSport(opts.sport)||opts.sport||"";
    var date=opts.date||"";
    var detail=parseFixturesDetailed(text,sport,date);
    var warnings=[];
    detail.rows.forEach(function(r){ if(r.DateNote) warnings.push({line:r.SourceLine||0,reason:r.DateNote,context:(r.Time+" | "+r.Home+" | "+r.Away)}); });
    return {
      records: detail.rows,
      warnings: warnings,
      errors: detail.invalidRecords,
      duplicates: detail.duplicates,
      inputLines: detail.inputLines,
      invalidCount: detail.invalidCount,
      detail: detail
    };
  }

  /* =================================================================
     Worked paste parser -- ported VERBATIM from MSFM parseWorkedPaste.
     Depends on a small delimited-line splitter equivalent to MSFM's
     parseDelimited (CSV/TSV aware). Ported minimally and verbatim in behavior.
     ================================================================= */
  function normalizeForHeader(value){ return String(value==null?"":value).normalize("NFKC").trim().replace(/\s+/g," ").toLocaleLowerCase(); }

  // Minimal delimited parser equivalent to MSFM parseDelimited: splits rows on
  // newlines and each row into fields on the chosen delimiter, honoring simple
  // double-quote quoting (so a delimiter inside quotes does not split).
  function parseDelimited(text,delim){
    var out=[]; var rows=String(text==null?"":text).split(/\r?\n/);
    for(var i=0;i<rows.length;i++){
      var line=rows[i];
      if(line==="" ) { continue; }
      var fields=[],cur="",inQ=false;
      for(var j=0;j<line.length;j++){
        var ch=line[j];
        if(inQ){
          if(ch==='"'){ if(line[j+1]==='"'){cur+='"';j++;} else {inQ=false;} }
          else cur+=ch;
        } else {
          if(ch==='"') inQ=true;
          else if(ch===delim){ fields.push(cur); cur=""; }
          else cur+=ch;
        }
      }
      fields.push(cur);
      out.push(fields);
    }
    return out;
  }

  function parseWorkedPaste(text){
    var t=String(text==null?"":text).replace(/^\uFEFF/,"");
    var rows=[],skipped=[];
    if(!t.trim())return {rows:rows,skipped:skipped};
    var firstLine=t.split(/\r?\n/).find(function(l){return l.trim();})||"";
    var delim=t.indexOf("\t")>=0?"\t":(firstLine.split(";").length>=7?";":",");
    var recs=parseDelimited(t,delim);
    var n=0;
    recs.forEach(function(c,i){
      var first=normalizeForHeader(c[0]);
      if(i===0&&/^sport( name)?$/.test(first))return;
      n++;
      if(c.length<7){skipped.push({row:n,reason:"only "+c.length+" column(s); 7\u20138 expected",text:c.join(" | ")});return;}
      var cell=function(k){return String(c[k]==null?"":c[k]).trim();};
      rows.push({Sport:cell(0),Date:cell(1),Time:cell(2),Country:cell(3),League:cell(4),Home:cell(5),Away:cell(6),"Event ID":cell(7),rowNo:n});
    });
    return {rows:rows,skipped:skipped};
  }

  /* =================================================================
     Betradar workbook parser -- ported from datafeed-check.html.
     Reuses the vendored SheetJS (window.XLSX) and the verified read options.
     brRowFields + formatBetradarDate + excelSerialToParts + pad + addMinutes
     are reproduced verbatim (as plain functions, not object methods).
     ================================================================= */
  function pad(n){ return String(n).padStart(2,"0"); }
  function excelSerialToParts(num){
    var wholeDays=Math.floor(num);
    var timeFraction=num-wholeDays;
    var dayCount=wholeDays-1;
    if(dayCount>=60)dayCount--;
    var year=1900;
    var diy=function(y){return ((y%4===0&&y%100!==0)||y%400===0)?366:365;};
    while(dayCount>=diy(year)){dayCount-=diy(year);year++;}
    var dim=[31,((year%4===0&&year%100!==0)||year%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];
    var mo=0;
    while(dayCount>=dim[mo]){dayCount-=dim[mo];mo++;}
    var totalMin=Math.round(timeFraction*1440);
    return {y:year,mo:mo+1,d:dayCount+1,h:Math.floor(totalMin/60),mi:totalMin%60};
  }
  function formatBetradarDate(dateVal,timeVal){
    var mo,d,y,h="00",mi="00";
    var dNum=Number(dateVal);
    if(dateVal!==""&&!isNaN(dNum)&&dNum>30000&&dNum<100000){
      var p=excelSerialToParts(dNum);
      mo=p.mo;d=p.d;y=p.y;h=p.h;mi=p.mi;
    }else if(dateVal instanceof Date){
      mo=dateVal.getMonth()+1;d=dateVal.getDate();y=dateVal.getFullYear();
      h=dateVal.getHours();mi=dateVal.getMinutes();
    }else{
      var ds=String(dateVal||"").trim();
      var m=ds.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:[ T]+(\d{1,2}):(\d{2}))?/);
      if(m){
        d=parseInt(m[1]);mo=parseInt(m[2]);y=parseInt(m[3]);
        if(m[4]){h=parseInt(m[4]);mi=parseInt(m[5]);}
      }else{
        return String(dateVal||"");
      }
    }
    var tNum=(timeVal===""||timeVal===null||timeVal===undefined)?NaN:Number(timeVal);
    if(timeVal instanceof Date){
      h=timeVal.getHours();mi=timeVal.getMinutes();
    }else if(!isNaN(tNum)&&tNum>=0&&(tNum<1||(tNum>30000&&tNum<100000))){
      var totalMin=Math.round((tNum-Math.floor(tNum))*1440)%1440;
      h=Math.floor(totalMin/60);mi=totalMin%60;
    }else{
      var ts=String(timeVal||"").trim();
      var tm=ts.match(/(\d{1,2}):(\d{2})/);
      if(tm){h=parseInt(tm[1]);mi=parseInt(tm[2]);}
    }
    return pad(mo)+"-"+pad(d)+"-"+y+" "+pad(h)+":"+pad(mi);
  }
  // Ported from datafeed-check.html brRowFields, extended additively to also
  // recognize a SECOND Betradar export schema (header-detected, no separate
  // branch): the "Sorted_Fixtures" shape with columns
  //   Sport | Date | Time | Country | League | Home | Away
  // Format 1 (datafeed-check): EventId, Day, Date, Time, Sport, Category,
  //   Unique Tournament, Tournament, Event, Hometeam, Awayteam.
  // The two schemas use DISJOINT team/league headers, so a single key-based
  // lookup unambiguously handles both:
  //   teams  -> Hometeam/Awayteam (fmt1)  OR  Home/Away (fmt2)
  //   league -> Unique Tournament/Tournament/Category (fmt1)  OR  League (fmt2)
  // Date/Time/Sport/Country keys already overlap and are shared.
  function brRowFields(row){
    var home=String(row["Hometeam"]||row["hometeam"]||row["Home"]||row["home"]||"").trim();
    var away=String(row["Awayteam"]||row["awayteam"]||row["Away"]||row["away"]||"").trim();
    var name=(home&&away)?(home+" v "+away):String(row["Event"]||row["event"]||"").trim();
    var league=String(row["Unique Tournament"]||row["unique tournament"]||row["Tournament"]||row["tournament"]||row["League"]||row["league"]||row["Category"]||row["category"]||"").trim();
    var dt=formatBetradarDate(row["Date"]||row["date"]||row["Day"]||"",row["Time"]||row["time"]||"");
    return {name:name,home:home,away:away,league:league,dt:dt};
  }
  // Country column is present in many Betradar exports under "Category" (region)
  // or an explicit "Country" column. We surface it when present (advisory only).
  function brCountry(row){
    return String(row["Country"]||row["country"]||row["Category"]||row["category"]||"").trim();
  }
  // Sport column, when the export carries one.
  function brSport(row){ return String(row["Sport"]||row["sport"]||"").trim(); }

  // Split "mm-dd-YYYY hh:mm" (formatBetradarDate output) into display date/time.
  function splitBrDt(dt){
    var m=String(dt||"").match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})$/);
    if(!m) return {date:String(dt||""),time:""};
    return {date:m[1]+"-"+m[2]+"-"+m[3],time:m[4]+":"+m[5]};
  }

  // -----------------------------------------------------------------
  // Format1_Parser core (betradar-format2-support, Task 1.2).
  // This is the verbatim original body of parseBetradarWorkbook: the
  // SheetJS read + brRowFields + splitBrDt pipeline. It is extracted into
  // an internal function with NO behavioral change so that the public
  // adapter parseBetradarWorkbook can later detect the format and delegate
  // to either this Format 1 core or the new Format 2 parser. The {rows,errors}
  // return contract is unchanged (Requirements 2.1, 2.2, 2.3).
  // -----------------------------------------------------------------
  function parseBetradarFormat1(arrayBuffer){
    var errors=[];
    if(typeof window.XLSX==="undefined"||!window.XLSX){
      return {rows:[],errors:[{reason:"SheetJS (XLSX) is not loaded; cannot parse the Betradar workbook."}]};
    }
    var wb,sheet,raw;
    try{
      var data=(arrayBuffer instanceof Uint8Array)?arrayBuffer:new Uint8Array(arrayBuffer);
      wb=window.XLSX.read(data,{type:"array",cellText:true,cellDates:false,raw:false});
      if(!wb.SheetNames||!wb.SheetNames.length){ return {rows:[],errors:[{reason:"The workbook has no sheets."}]}; }
      sheet=wb.Sheets[wb.SheetNames[0]];
      raw=window.XLSX.utils.sheet_to_json(sheet,{defval:"",raw:false});
    }catch(e){
      return {rows:[],errors:[{reason:"Could not read the workbook: "+(e&&e.message?e.message:String(e))}]};
    }
    var rows=[];
    for(var i=0;i<raw.length;i++){
      var r=raw[i];
      var fields=brRowFields(r);
      var parts=splitBrDt(fields.dt);
      var sport=brSport(r);
      var country=brCountry(r);
      var rec={
        sport:sport,
        country:country,
        league:fields.league,
        home:fields.home,
        away:fields.away,
        date:parts.date,
        time:parts.time,
        name:fields.name,
        source:"betradar",
        raw:r
      };
      if(!fields.home&&!fields.away&&!fields.name){ errors.push({row:i+2,reason:"Row has no recognizable team/event columns (Hometeam/Awayteam/Event)",context:JSON.stringify(r).slice(0,200)}); continue; }
      if(!fields.league) errors.push({row:i+2,reason:"Missing league (Unique Tournament/Tournament/Category)",context:fields.name});
      rows.push(rec);
    }
    return {rows:rows,errors:errors};
  }

  // -----------------------------------------------------------------
  // Format_Detector (betradar-format2-support, Task 1.4).
  // Content-based sniffer that classifies an uploaded Betradar buffer as
  // exactly one of "format1" | "format2" | "unidentified". The decision is
  // made from the file's CONTENT only -- the ".xls" extension is NEVER used as
  // the deciding signal (Requirements 1.2, 1.6). Format 2 is an Excel 2003 XML
  // Spreadsheet (SpreadsheetML) that carries a ".xls" name but is really XML,
  // so we sniff the leading text for the SpreadsheetML signature first; only if
  // that is absent do we attempt a SheetJS standard/binary read and look for the
  // Format 1 columns.
  //
  // Pure function of the input bytes. Accepts an ArrayBuffer or a Uint8Array.
  // -----------------------------------------------------------------
  // Normalize an incoming buffer-like value to a Uint8Array WITHOUT relying on
  // `instanceof`. The Betradar file may arrive as an ArrayBuffer, a typed-array
  // view, or a Node Buffer, and -- critically -- it may have been constructed in
  // a different JavaScript realm (e.g. the test harness window vs. the app
  // iframe). Cross-realm values fail `x instanceof ArrayBuffer` because each
  // realm has its own constructor, so we duck-type on structural traits instead.
  // Returns null when the value is not a readable buffer.
  function toUint8Array(bytes){
    if(!bytes) return null;
    try{
      // Already a typed-array / DataView view (has a .buffer + byteLength).
      if(typeof bytes.byteLength==="number" && bytes.buffer &&
         typeof bytes.buffer.byteLength==="number" &&
         typeof bytes.byteOffset==="number"){
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      }
      // A raw ArrayBuffer (has byteLength but is not itself a view).
      if(typeof bytes.byteLength==="number" && bytes.buffer===undefined){
        return new Uint8Array(bytes);
      }
      // A view-like object exposing only .buffer (defensive fallback).
      if(bytes.buffer && typeof bytes.buffer.byteLength==="number"){
        return new Uint8Array(bytes.buffer);
      }
      // Last resort: let Uint8Array coerce array-likes.
      if(typeof bytes.length==="number"){ return new Uint8Array(bytes); }
    }catch(e){ return null; }
    return null;
  }

  function detectBetradarFormat(bytes){
    // Normalize to a Uint8Array without mutating the caller's buffer.
    // Realm-safe: do NOT use `instanceof` (see toUint8Array).
    var u8=toUint8Array(bytes);
    if(!u8||!u8.length) return "unidentified";

    // 1) SpreadsheetML (Format 2) content signature.
    // Decode the first chunk of the buffer as text and look for the Excel 2003
    // XML Spreadsheet markers: the "<?xml" prolog together with the SpreadsheetML
    // namespace, or a <Workbook>/<Worksheet> element. We only need to decode the
    // head of the file -- SpreadsheetML always declares these near the top.
    var head=decodeHeadAsText(u8, 8192);
    if(head){
      var hasXmlProlog=/<\?xml[\s>]/i.test(head);
      var hasSpreadsheetNs=/urn:schemas-microsoft-com:office:spreadsheet/i.test(head);
      var hasWorkbookEl=/<(?:\w+:)?Workbook[\s>]/i.test(head);
      var hasWorksheetEl=/<(?:\w+:)?Worksheet[\s>]/i.test(head);
      // SpreadsheetML signature: an XML prolog combined with the spreadsheet
      // namespace or a Workbook/Worksheet element, OR the namespace / elements
      // appearing on their own (some exports omit/relocate the prolog).
      if((hasXmlProlog&&(hasSpreadsheetNs||hasWorkbookEl||hasWorksheetEl))
         || hasSpreadsheetNs
         || (hasWorkbookEl&&hasWorksheetEl)){
        return "format2";
      }
    }

    // 2) Format 1: a successful SheetJS standard/binary read that exposes the
    // Format 1 columns. If SheetJS is unavailable we cannot confirm Format 1 and
    // fall through to "unidentified".
    if(typeof window.XLSX!=="undefined"&&window.XLSX){
      try{
        var wb=window.XLSX.read(u8,{type:"array",cellText:true,cellDates:false,raw:false});
        if(wb&&wb.SheetNames&&wb.SheetNames.length){
          var sheet=wb.Sheets[wb.SheetNames[0]];
          var rows=window.XLSX.utils.sheet_to_json(sheet,{defval:"",raw:false});
          if(rows&&rows.length&&format1ColumnsPresent(rows[0])){
            return "format1";
          }
        }
      }catch(e){ /* not a readable standard/binary workbook -> unidentified */ }
    }

    return "unidentified";
  }

  // Decode the first `limit` bytes of a Uint8Array as text for content sniffing.
  // Prefers TextDecoder (UTF-8, errors ignored) and falls back to a latin1-style
  // char-code decode when TextDecoder is unavailable. Returns "" on failure.
  function decodeHeadAsText(u8, limit){
    var slice=u8.subarray(0, Math.min(u8.length, limit||8192));
    try{
      if(typeof TextDecoder!=="undefined"){
        return new TextDecoder("utf-8",{fatal:false}).decode(slice);
      }
    }catch(e){ /* fall through to manual decode */ }
    try{
      var s="";
      for(var i=0;i<slice.length;i++){ s+=String.fromCharCode(slice[i]); }
      return s;
    }catch(e2){ return ""; }
  }

  // Returns true when a parsed row object exposes the Format 1 (or the
  // header-compatible Sorted_Fixtures) Betradar columns. Matches the key set
  // recognized by brRowFields/brSport/brCountry: team columns plus a
  // league/competition column.
  function format1ColumnsPresent(row){
    if(!row||typeof row!=="object") return false;
    function has(){ for(var i=0;i<arguments.length;i++){ if(Object.prototype.hasOwnProperty.call(row,arguments[i])) return true; } return false; }
    var hasTeams=has("Hometeam","hometeam","Home","home")&&has("Awayteam","awayteam","Away","away");
    var hasEvent=has("Event","event");
    var hasLeague=has("Unique Tournament","unique tournament","Tournament","tournament","League","league","Category","category");
    // Format 1 rows carry disjoint team headers OR an Event column, together
    // with a league/competition column.
    return (hasTeams||hasEvent)&&hasLeague;
  }

  // =================================================================
  // Format 2 SpreadsheetML worksheet loader (betradar-format2-support,
  // Task 3.1) -- self-contained block.
  //
  // loadFixtureSheet(xmlText) parses an Excel 2003 XML Spreadsheet
  // (SpreadsheetML) document, locates the Worksheet named "Fixture", and
  // returns its ordered rows. Each row is an ordered list of cells addressable
  // by their 1-based SpreadsheetML column position: SpreadsheetML cells carry
  // an optional ss:Index attribute that jumps the cursor to an explicit column,
  // and cells without it advance by one from the previous position. Honoring
  // ss:Index is essential so that blank / trailing cells line up at the correct
  // column index for later classifyRow / locateColumns logic (Req 3.5-3.7).
  //
  // Each returned cell exposes the cell's RAW <Data> XML text content (the text
  // exactly as it appears in the XML, BEFORE any numeric parsing) so that later
  // fixture parsing can preserve the exact Match_ID string with full precision
  // (Req 6.9, 6.10). The raw cell text is captured verbatim; no Number
  // conversion is performed here.
  //
  // Return shape (success):
  //   { failed:false, rows:[ { cells:[ {index:Number, text:String,
  //       type:String|null} , ... ] }, ... ], errors:[] }
  //   - rows preserves worksheet row order.
  //   - cells within a row are ordered by ascending 1-based column index.
  //   - cells[i].index is the 1-based SpreadsheetML column position.
  //
  // Return shape (fatal -- "Fixture" worksheet absent, Req 3.1/3.4):
  //   { failed:true, rows:[], errors:[ { reason:"\"Fixture\" worksheet was not
  //       found" } ] }
  //
  // A document that cannot be parsed as XML is likewise reported as a fatal
  // file-level error with rows:[].
  // -----------------------------------------------------------------
  function loadFixtureSheet(xmlText){
    // --- Guard: input must be a non-empty string of XML text. ---
    if(typeof xmlText!=="string"||!xmlText.length){
      return {failed:true,rows:[],errors:[{reason:"Format 2 XML content could not be read"}]};
    }

    // --- Parse the SpreadsheetML document via DOMParser. ---
    if(typeof DOMParser==="undefined"){
      return {failed:true,rows:[],errors:[{reason:"DOMParser is not available to read Format 2 XML"}]};
    }
    var doc;
    try{
      doc=new DOMParser().parseFromString(xmlText,"application/xml");
    }catch(e){
      return {failed:true,rows:[],errors:[{reason:"Format 2 XML could not be parsed"}]};
    }
    // DOMParser reports malformed XML via a <parsererror> element rather than
    // throwing. Treat that as a fatal, unreadable document.
    if(!doc||!doc.documentElement||doc.getElementsByTagName("parsererror").length){
      return {failed:true,rows:[],errors:[{reason:"Format 2 XML could not be parsed"}]};
    }

    // --- Locate the Worksheet named "Fixture". ---
    // SpreadsheetML elements live in the office:spreadsheet namespace and are
    // typically prefixed (e.g. <Worksheet ss:Name="Fixture">). Match on the
    // local element name so the lookup is prefix-agnostic, and read the Name
    // attribute in a namespace-tolerant way.
    var worksheet=findFixtureWorksheet(doc);
    if(!worksheet){
      return {failed:true,rows:[],errors:[{reason:"\"Fixture\" worksheet was not found"}]};
    }

    // --- Collect the worksheet's rows in document order. ---
    // A Worksheet contains a single Table whose children are Row elements. We
    // walk descendants by local name so nested-prefix variations are tolerated.
    var rowEls=childrenByLocalName(worksheet,"Row",true);
    var rows=[];
    for(var r=0;r<rowEls.length;r++){
      rows.push({cells:readRowCells(rowEls[r])});
    }
    return {failed:false,rows:rows,errors:[]};
  }

  // Return the <Worksheet> element whose ss:Name attribute equals "Fixture".
  // Prefix- and namespace-tolerant: matches the element's local name and reads
  // the Name attribute regardless of the declaring prefix.
  function findFixtureWorksheet(doc){
    var worksheets=childrenByLocalName(doc.documentElement,"Worksheet",true);
    // Include the document element itself in case it is a Worksheet.
    if(localName(doc.documentElement)==="Worksheet"){ worksheets=[doc.documentElement].concat(worksheets); }
    for(var i=0;i<worksheets.length;i++){
      if(getSsAttribute(worksheets[i],"Name")==="Fixture"){ return worksheets[i]; }
    }
    return null;
  }

  // Read the ordered cells of a SpreadsheetML <Row>, honoring ss:Index.
  // Returns an array of {index, text, type} where index is the 1-based column
  // position, text is the raw <Data> XML text content (before any numeric
  // parsing), and type is the ss:Type of the <Data> element (e.g. "Number",
  // "String") when present, else null.
  function readRowCells(rowEl){
    var cells=[];
    var cellEls=childrenByLocalName(rowEl,"Cell",false);
    // SpreadsheetML column cursor is 1-based. A cell with ss:Index="N" jumps
    // the cursor to column N; a cell without ss:Index occupies the column one
    // past the previous cell (Req 3.5-3.7).
    var col=0;
    for(var i=0;i<cellEls.length;i++){
      var cellEl=cellEls[i];
      var explicit=getSsAttribute(cellEl,"Index");
      if(explicit!==null&&explicit!==""){
        var parsedIndex=parseInt(explicit,10);
        if(!isNaN(parsedIndex)&&parsedIndex>0){ col=parsedIndex; }
        else { col=col+1; }
      }else{
        col=col+1;
      }
      // The cell's value lives in its <Data> child. Capture the raw text
      // content verbatim (no numeric parsing) and the declared ss:Type.
      var dataEl=firstChildByLocalName(cellEl,"Data");
      var rawText="";
      var dataType=null;
      if(dataEl){
        rawText=(dataEl.textContent!=null)?dataEl.textContent:"";
        dataType=getSsAttribute(dataEl,"Type");
      }
      // ss:MergeAcross="N" means the cell spans N ADDITIONAL columns to the
      // right (so it occupies N+1 columns total). Betradar Format 2 section-
      // header rows are a single cell merged across all fixture columns
      // (e.g. ss:MergeAcross="5" over the 6 fixture columns). We capture the
      // span so classifyRow can recognize a merged banner row as a section
      // header rather than mistaking its leading column for fixture data, and
      // we advance the column cursor past the merged span for any following
      // cells (Req 3.5-3.7).
      var mergeAcross=0;
      var mergeAttr=getSsAttribute(cellEl,"MergeAcross");
      if(mergeAttr!==null&&mergeAttr!==""){
        var parsedMerge=parseInt(mergeAttr,10);
        if(!isNaN(parsedMerge)&&parsedMerge>0){ mergeAcross=parsedMerge; }
      }
      cells.push({index:col,text:rawText,type:dataType,mergeAcross:mergeAcross});
      // Advance the cursor past the merged span so a subsequent cell without
      // ss:Index lands in the correct column.
      if(mergeAcross>0){ col=col+mergeAcross; }
    }
    return cells;
  }

  // --- Small, prefix/namespace-tolerant DOM helpers (Format 2 loader) ---

  // Local name of an element, stripping any namespace prefix.
  function localName(el){
    if(!el) return "";
    if(el.localName) return el.localName;
    var n=el.nodeName||el.tagName||"";
    var colon=n.indexOf(":");
    return colon>=0?n.substring(colon+1):n;
  }

  // All descendant (or direct-child) elements whose local name matches `name`.
  // When `deep` is true, searches all descendants; otherwise only direct
  // element children of `parent`.
  function childrenByLocalName(parent,name,deep){
    var out=[];
    if(!parent) return out;
    if(deep){
      // Prefer the namespace-agnostic wildcard lookup, then filter by local
      // name so prefixed and unprefixed elements are both captured.
      var all=parent.getElementsByTagName("*");
      for(var i=0;i<all.length;i++){ if(localName(all[i])===name){ out.push(all[i]); } }
      return out;
    }
    var child=parent.firstChild;
    while(child){
      if(child.nodeType===1&&localName(child)===name){ out.push(child); }
      child=child.nextSibling;
    }
    return out;
  }

  // First direct-child element with the given local name, else null.
  function firstChildByLocalName(parent,name){
    if(!parent) return null;
    var child=parent.firstChild;
    while(child){
      if(child.nodeType===1&&localName(child)===name){ return child; }
      child=child.nextSibling;
    }
    return null;
  }

  // Read a SpreadsheetML ss:* attribute (e.g. ss:Name, ss:Index, ss:Type)
  // regardless of the declaring prefix. Returns the attribute string, or null
  // when absent. Checks the office:spreadsheet namespace first, then falls back
  // to a local-name scan of the attribute list for environments that do not
  // expose namespaced attributes.
  function getSsAttribute(el,attrLocalName){
    if(!el||!el.attributes) return null;
    var ns="urn:schemas-microsoft-com:office:spreadsheet";
    if(typeof el.getAttributeNS==="function"){
      var v=el.getAttributeNS(ns,attrLocalName);
      if(v!==null&&v!=="") return v;
    }
    var attrs=el.attributes;
    for(var i=0;i<attrs.length;i++){
      var a=attrs[i];
      var an=a.localName||a.name||a.nodeName||"";
      var colon=an.indexOf(":");
      if(colon>=0){ an=an.substring(colon+1); }
      if(an===attrLocalName){ return a.value!=null?a.value:a.nodeValue; }
    }
    return null;
  }

  // -----------------------------------------------------------------
  // Column location (betradar-format2-support, Task 3.2) -- self-contained.
  //
  // locateColumns(headerRow) maps the six required Format 2 fixture column
  // names to their 1-based SpreadsheetML column indices, reading the header
  // row produced by loadFixtureSheet (shape: { cells:[ {index, text, type} ]
  // }). Matching is case-insensitive and whitespace-tolerant (leading/trailing
  // whitespace trimmed, internal runs collapsed) so that cosmetic variations in
  // the exported header text do not break column detection (Req 3.2).
  //
  // The required columns and their output keys are:
  //   "Date"           -> date
  //   "KO"             -> ko
  //   "Home Team"      -> homeTeam
  //   "Away Team"      -> awayTeam
  //   "Neutral ground" -> neutralGround
  //   "Match Id"       -> matchId
  //
  // Return shape (success -- every required column located):
  //   { failed:false, columns:{ date:N, ko:N, homeTeam:N, awayTeam:N,
  //       neutralGround:N, matchId:N }, errors:[] }
  //   where each N is the 1-based column index of that header cell.
  //
  // Return shape (fatal -- one or more required columns absent, Req 3.3):
  //   { failed:true, rows:[], errors:[ { reason:"required column \"<name>\"
  //       was not found" }, ... ] }
  //   One error is recorded per missing column, naming it; if several are
  //   missing, each is named (the first is always present).
  // -----------------------------------------------------------------
  var FORMAT2_REQUIRED_COLUMNS = [
    { key:"date",          name:"Date" },
    { key:"ko",            name:"KO" },
    { key:"homeTeam",      name:"Home Team" },
    { key:"awayTeam",      name:"Away Team" },
    { key:"neutralGround", name:"Neutral ground" },
    { key:"matchId",       name:"Match Id" }
  ];

  // Normalize a header cell / column name for case-insensitive, whitespace-
  // tolerant comparison: trim, collapse internal whitespace runs to a single
  // space, and lower-case.
  function normalizeHeaderText(value){
    return String(value==null?"":value).replace(/\s+/g," ").trim().toLowerCase();
  }

  function locateColumns(headerRow){
    // Build a lookup from normalized header text -> 1-based column index. The
    // header row is a loadFixtureSheet row ({cells:[{index,text,type}]}); guard
    // defensively against a missing/!array cells list so a malformed header
    // row still produces a clear "missing column" result rather than throwing.
    var byText={};
    var cells=(headerRow&&Array.isArray(headerRow.cells))?headerRow.cells:[];
    for(var i=0;i<cells.length;i++){
      var cell=cells[i];
      if(!cell) continue;
      var norm=normalizeHeaderText(cell.text);
      if(norm==="") continue;
      // Keep the FIRST occurrence of a given header text so duplicate/trailing
      // blank-labeled cells never shadow the real column.
      if(!Object.prototype.hasOwnProperty.call(byText,norm)){
        byText[norm]=cell.index;
      }
    }

    var columns={};
    var errors=[];
    for(var c=0;c<FORMAT2_REQUIRED_COLUMNS.length;c++){
      var req=FORMAT2_REQUIRED_COLUMNS[c];
      var key=normalizeHeaderText(req.name);
      if(Object.prototype.hasOwnProperty.call(byText,key)){
        columns[req.key]=byText[key];
      }else{
        errors.push({reason:"required column \""+req.name+"\" was not found"});
      }
    }

    if(errors.length){
      // Missing required column -> fatal file-level error (Req 3.3): empty,
      // failed result naming the missing column(s).
      return {failed:true,rows:[],errors:errors};
    }
    return {failed:false,columns:columns,errors:[]};
  }

  // -----------------------------------------------------------------
  // Row classification (betradar-format2-support, Task 4.1) -- self-contained.
  //
  // classifyRow(row, columns) classifies a single loadFixtureSheet row (shape:
  // { cells:[ {index, text, type} ] }) as exactly one of:
  //   "columnHeader" | "sectionHeader" | "fixture" | "empty" | "malformed"
  //
  // CRITICAL (Req 3.6, 3.7): classification uses the actual SpreadsheetML cell
  // POSITIONS and CONTENTS -- NOT merely the count of populated cells. A
  // legitimate section-header or fixture row must never be rejected solely
  // because blank / trailing cells are represented differently (SpreadsheetML
  // may omit trailing blanks or jump columns with ss:Index). We therefore index
  // cells by their 1-based column position and inspect the specific located
  // fixture columns (Date / Home Team / Away Team / Match Id) by position.
  //
  // The optional `columns` argument is the located column map returned by
  // locateColumns ({date, ko, homeTeam, awayTeam, neutralGround, matchId}).
  // When provided, fixture detection reads the fixture-shaped columns by their
  // true positions. When omitted (e.g. the header row has not been located
  // yet), fixture detection falls back to a position-tolerant heuristic.
  //
  // Classification order (first match wins):
  //   1. empty          -- every cell blank/whitespace-only (no populated cell).
  //   2. columnHeader    -- the row carries the Format 2 column labels.
  //   3. fixture         -- fixture-shaped data populated in the located
  //                         fixture columns (Date + Home + Away + Match Id).
  //   4. sectionHeader   -- a single meaningful text value, not fixture-shaped
  //                         and not the column header (the dotted
  //                         "Sport.Country.League[, week NN]" string).
  //   5. malformed       -- a non-empty row that fits none of the above.
  // -----------------------------------------------------------------

  // Build a position -> trimmed-text map for a row, keyed by 1-based column
  // index. Only cells with non-blank (after trim) text are recorded, so blank
  // and trailing cells are naturally ignored regardless of how SpreadsheetML
  // represented them (Req 3.6, 3.7).
  function rowTextByIndex(row){
    var byIndex={};
    var cells=(row&&Array.isArray(row.cells))?row.cells:[];
    for(var i=0;i<cells.length;i++){
      var cell=cells[i];
      if(!cell) continue;
      var txt=(cell.text==null)?"":String(cell.text);
      if(txt.trim()==="") continue;
      // First populated value at a given index wins (defensive against dupes).
      if(!Object.prototype.hasOwnProperty.call(byIndex,cell.index)){
        byIndex[cell.index]=txt;
      }
    }
    return byIndex;
  }

  // How many of the required Format 2 column labels appear anywhere in the row.
  function countHeaderLabelMatches(byIndex){
    var present={};
    for(var k in byIndex){
      if(!Object.prototype.hasOwnProperty.call(byIndex,k)) continue;
      present[normalizeHeaderText(byIndex[k])]=true;
    }
    var matches=0;
    for(var c=0;c<FORMAT2_REQUIRED_COLUMNS.length;c++){
      if(present[normalizeHeaderText(FORMAT2_REQUIRED_COLUMNS[c].name)]){ matches++; }
    }
    return matches;
  }

  function classifyRow(row, columns){
    // (1) empty: no populated (non-whitespace) cells, regardless of how many
    // blank/trailing cells SpreadsheetML emitted (Req 3.6, 3.7).
    var byIndex=rowTextByIndex(row);
    var populatedIndexes=Object.keys(byIndex);
    if(populatedIndexes.length===0){ return "empty"; }

    // (2) columnHeader: the row carrying the Format 2 column labels. Detect by
    // matching those header labels (case-insensitive, whitespace-tolerant).
    // Require a majority of the six labels so a lone cell that merely happens
    // to read like a header word (e.g. a section header "KO ...") is not
    // misclassified as the column-header row.
    if(countHeaderLabelMatches(byIndex)>=4){ return "columnHeader"; }

    // (3) sectionHeader: a competition banner row. In real Betradar Format 2
    // exports the section header is a SINGLE cell merged across all fixture
    // columns (ss:MergeAcross), so its one populated cell lands in column 1 --
    // which collides with the located Date column. We therefore detect the
    // section header BEFORE the fixture-column check, so a merged banner is
    // never mistaken for partial fixture data (Req 3.5-3.7).
    //
    // A row is a section header when it has exactly one populated cell AND
    // either (a) that cell is merged across one or more columns (ss:MergeAcross
    // > 0), or (b) there is no column map yet, or (c) the single cell is NOT in
    // a position that could, together with others, form a fixture. Because a
    // fixture row always populates Home Team, Away Team and Match Id (at least
    // three distinct columns), a lone populated cell can never be a valid
    // fixture -- so a single-populated-cell row is a section header regardless
    // of which column that cell occupies.
    if(populatedIndexes.length===1){
      return "sectionHeader";
    }

    // (4) fixture: fixture-shaped data present in the LOCATED fixture columns,
    // inspected by their true 1-based positions (Req 3.6). A fixture must carry
    // the core identifying fields: Date, Home Team, Away Team, and Match Id.
    if(columns&&columns.date&&columns.homeTeam&&columns.awayTeam&&columns.matchId){
      var hasDate=Object.prototype.hasOwnProperty.call(byIndex,columns.date);
      var hasHome=Object.prototype.hasOwnProperty.call(byIndex,columns.homeTeam);
      var hasAway=Object.prototype.hasOwnProperty.call(byIndex,columns.awayTeam);
      var hasMatchId=Object.prototype.hasOwnProperty.call(byIndex,columns.matchId);
      if(hasDate&&hasHome&&hasAway&&hasMatchId){ return "fixture"; }
      // A row that populates SOME but not all of the fixture columns is partial
      // fixture data: it cannot be a valid fixture -> malformed (Req 3.5).
      if(hasDate||hasHome||hasAway||hasMatchId){ return "malformed"; }
    }

    // (5) malformed: a non-empty row fitting none of the above (e.g. several
    // populated cells that are neither the header row nor a fixture row).
    return "malformed";
  }

  // -----------------------------------------------------------------
  // Section-header parsing (betradar-format2-support, Task 5.1) --
  // self-contained block.
  //
  // parseSectionHeader(text, rowNum) interprets a Section_Header_String of the
  // Dotted_Header_Structure `Sport.Country.League[, week NN]` and resolves the
  // Current_Competition fields it carries. The algorithm follows design.md
  // section "Section-header parsing -- parseSectionHeader(text)" exactly:
  //
  //   1. Week removal (Req 4.2). Trim the raw text, then strip ONLY a trailing
  //      Week segment matching: a comma, an optional single space, the
  //      case-insensitive literal "week", an optional single space, and a
  //      1-to-3 digit integer in the range 1..999, anchored at the end of the
  //      string. When matched, capture that integer as Week_Number and remove
  //      only that trailing segment; otherwise Week_Number is null.
  //   2. First-two-dots split (Req 4.3). On the Week-removed remainder, split on
  //      ONLY the first two dots: Sport = text before the first dot, Country =
  //      text between the first and second dot, League = everything after the
  //      second dot. Each of the three is whitespace-trimmed.
  //   3. Preserve League (Req 4.4, 4.6). The League segment is kept exactly as
  //      extracted (inner dots / commas / punctuation preserved, never split
  //      further) up to a maximum of 255 characters.
  //   4. Non-conforming degrade (Req 4.5). If fewer than two dots remain after
  //      Week removal, OR any of Sport / Country / League is empty after
  //      extraction, assign the WHOLE trimmed, Week-removed string to League,
  //      leave Sport and Country blank, and attach a warning referencing rowNum.
  //   5. Invalid header (Req 4.8). If the resulting League is empty / whitespace-
  //      only (after trim + Week removal), reject the row with an error by
  //      rowNum; the caller MUST leave Current_Competition unchanged.
  //   6. Set Current_Competition (Req 4.7). A non-empty League produces the
  //      competition {sport, country, league, week}.
  //
  // Return shape (consumed later by Task 6.3 competition-association walk):
  //   success / degrade:
  //     { ok:true, competition:{sport,country,league,week},
  //       warning?:{row,reason,warning:true} }
  //   invalid (empty League) rejection:
  //     { ok:false, error:{row,reason} }
  //
  // `week` is a Number (1..999) when a Week segment was present, else null.
  // The `warning` key is present ONLY for a non-conforming (degraded) header.
  // -----------------------------------------------------------------
  var FORMAT2_LEAGUE_MAX_LEN = 255;

  // Trailing Week segment: comma, optional single space, case-insensitive
  // "week", optional single space, integer 1..999 (1-3 digits), anchored at end.
  // The leading 0 exclusion / 1..999 range is enforced after the match by range
  // checking the captured integer so "week 0" / "week 1000" are not stripped.
  var FORMAT2_WEEK_RE = /,[ ]?week[ ]?(\d{1,3})$/i;

  function parseSectionHeader(text, rowNum){
    // --- Step 1: trim + Week removal (Req 4.1, 4.2). ---
    var trimmed = String(text==null?"":text).trim();
    var week = null;
    var weekRemoved = trimmed;

    var m = FORMAT2_WEEK_RE.exec(trimmed);
    if(m){
      var n = parseInt(m[1],10);
      // Only treat as a Week segment when the integer is in range 1..999.
      if(n>=1 && n<=999){
        week = n;
        weekRemoved = trimmed.slice(0, m.index).trim();
      }
    }

    // --- Step 2: first-two-dots split (Req 4.3). ---
    var sport = "";
    var country = "";
    var league = "";
    var conforming = false;

    var firstDot = weekRemoved.indexOf(".");
    if(firstDot !== -1){
      var secondDot = weekRemoved.indexOf(".", firstDot+1);
      if(secondDot !== -1){
        sport   = weekRemoved.slice(0, firstDot).trim();
        country = weekRemoved.slice(firstDot+1, secondDot).trim();
        // League = everything after the SECOND dot, preserved exactly
        // (inner dots/commas kept, no further splitting) -- Req 4.4, 4.6.
        league  = weekRemoved.slice(secondDot+1).trim();
        // Conforming only when all three extracted segments are non-empty.
        conforming = sport!=="" && country!=="" && league!=="";
      }
    }

    // --- Step 4: non-conforming degrade (Req 4.5). ---
    // Fewer than two dots after Week removal OR an empty Sport/Country/League
    // -> assign the whole trimmed, Week-removed string to League, blank
    // Sport/Country, and emit a warning by row number.
    var degraded = false;
    if(!conforming){
      sport = "";
      country = "";
      league = weekRemoved;
      degraded = true;
    }

    // Enforce the 255-char League cap AFTER selecting the League text (applies
    // equally to conforming and degraded paths) -- Req 4.4.
    if(league.length > FORMAT2_LEAGUE_MAX_LEN){
      league = league.slice(0, FORMAT2_LEAGUE_MAX_LEN);
    }

    // --- Step 5: invalid header rejection (Req 4.8). ---
    // Empty/whitespace-only League after trim + Week removal -> reject by row
    // number; caller leaves Current_Competition unchanged.
    if(league.trim()===""){
      return {
        ok:false,
        error:{ row:rowNum, reason:"invalid section header (empty league) at row "+rowNum }
      };
    }

    // --- Step 6: set Current_Competition (Req 4.7). ---
    var result = {
      ok:true,
      competition:{ sport:sport, country:country, league:league, week:week }
    };
    if(degraded){
      result.warning = {
        row:rowNum,
        reason:"non-conforming section header at row "+rowNum+"; whole text used as league",
        warning:true
      };
    }
    return result;
  }

  // -----------------------------------------------------------------
  // Format 2 date/time extraction helpers (betradar-format2-support, Task 6.1).
  //
  // These are small PURE helpers used by parseFixtureRow (Task 6.2). They
  // interpret the confirmed Format 2 representations:
  //   Format2_Date : "DD/MM YY"  (e.g. "28/10 26" -> 28 Oct 2026)
  //   Format2_Time : "HH:MM"     (24-hour, e.g. "20:45")
  // and a defensive Excel-serial fallback for cells that arrive as numbers
  // (not exercised by the confirmed Sample_File, whose Date/KO cells are XML
  // text, but retained for robustness -- Req 6.5).
  //
  // CRITICAL (Req 6.3 / Property 8): the two-digit year is resolved
  // ARITHMETICALLY as 2000 + YY. JavaScript automatic `Date` string parsing is
  // NEVER used. Each helper returns a clear {ok:true,...} / {ok:false} result
  // so parseFixtureRow can surface invalid-date / invalid-time row rejections
  // (Req 6.7, 6.8).
  // -----------------------------------------------------------------

  // Days-in-month for range validation (index 0 = January). February uses a
  // Gregorian leap-year test on the resolved 4-digit year.
  function format2DaysInMonth(mo, y){
    var dim=[31,((y%4===0&&y%100!==0)||y%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];
    return dim[mo-1];
  }

  // Decide whether a cell value is a numeric Excel serial (defensive fallback).
  // A blank/empty string is NOT a serial; only a finite number (or a numeric
  // string) in the plausible SpreadsheetML serial range qualifies.
  function format2IsSerial(cell){
    if(cell===null||cell===undefined) return false;
    if(typeof cell==="number") return isFinite(cell);
    var s=String(cell).trim();
    if(s==="") return false;
    // A serial must be a bare number with no "/", ":" or letters.
    if(!/^\d+(\.\d+)?$/.test(s)) return false;
    return isFinite(Number(s));
  }

  // parseFormat2Date(cell) -> {ok:true, y, mo, d} | {ok:false}
  // Parses "DD/MM YY" explicitly (NO `new Date(string)`); year = 2000 + YY.
  // Defensive serial fallback via excelSerialToParts for numeric cells (Req 6.5).
  var FORMAT2_DATE_RE = /^(\d{1,2})\/(\d{1,2})\s+(\d{2})$/;
  function parseFormat2Date(cell){
    // --- Defensive Excel-serial fallback (Req 6.5). ---
    if(typeof cell==="number" || (format2IsSerial(cell) && String(cell).indexOf("/")===-1)){
      var sNum=Number(cell);
      if(!isFinite(sNum)||sNum<=0) return {ok:false};
      var sp=excelSerialToParts(sNum);
      return {ok:true, y:sp.y, mo:sp.mo, d:sp.d};
    }

    var s=String(cell==null?"":cell).trim();
    var m=FORMAT2_DATE_RE.exec(s);
    if(!m) return {ok:false};

    var d=parseInt(m[1],10);
    var mo=parseInt(m[2],10);
    // Two-digit year resolved ARITHMETICALLY as 2000 + YY (Req 6.3, Property 8).
    var y=2000 + parseInt(m[3],10);

    // Range validation: month 1-12, day 1..daysInMonth (leap-year aware).
    if(mo<1 || mo>12) return {ok:false};
    if(d<1 || d>format2DaysInMonth(mo, y)) return {ok:false};

    return {ok:true, y:y, mo:mo, d:d};
  }

  // parseFormat2Time(cell) -> {ok:true, h, mi} | {ok:false}
  // Parses "HH:MM" as a 24-hour time (hours 0-23, minutes 0-59).
  // Defensive serial-fraction fallback via excelSerialToParts for numeric cells.
  var FORMAT2_TIME_RE = /^(\d{1,2}):(\d{2})$/;
  function parseFormat2Time(cell){
    // --- Defensive Excel-serial (day-fraction) fallback (Req 6.5). ---
    if(typeof cell==="number" || (format2IsSerial(cell) && String(cell).indexOf(":")===-1)){
      var tNum=Number(cell);
      if(!isFinite(tNum)||tNum<0) return {ok:false};
      var tp=excelSerialToParts(tNum);
      return {ok:true, h:tp.h, mi:tp.mi};
    }

    var s=String(cell==null?"":cell).trim();
    var m=FORMAT2_TIME_RE.exec(s);
    if(!m) return {ok:false};

    var h=parseInt(m[1],10);
    var mi=parseInt(m[2],10);
    if(h<0 || h>23) return {ok:false};
    if(mi<0 || mi>59) return {ok:false};

    return {ok:true, h:h, mi:mi};
  }

  // combineFormat2DateTime(dateParts, timeParts) -> {date, time}
  // Produces the PLFM display shape by building the existing
  // "mm-dd-YYYY hh:mm" string (same as formatBetradarDate output) and running
  // it through splitBrDt, so Format 2 date/time output matches Format 1 EXACTLY.
  // Applies NO timezone conversion (Req 6.6). Callers pass the {ok:true,...}
  // results of parseFormat2Date / parseFormat2Time.
  function combineFormat2DateTime(dateParts, timeParts){
    var dt = pad(dateParts.mo)+"-"+pad(dateParts.d)+"-"+dateParts.y+" "+
             pad(timeParts.h)+":"+pad(timeParts.mi);
    return splitBrDt(dt);
  }

  // -----------------------------------------------------------------
  // Fixture-row parsing (betradar-format2-support, Task 6.2) --
  // self-contained block.
  //
  // parseFixtureRow(row, columns, current, rowNum) builds a single shared
  // Fixture_Record from a classified Format 2 "fixture" row, OR returns a
  // row-level rejection when the row cannot be interpreted. It is a pure
  // function of its inputs (no shared mutable state).
  //
  // SIGNATURE (matches what the Task 6.3 competition-association walk calls):
  //   parseFixtureRow(row, columns, current, rowNum)
  //     row     : a loadFixtureSheet row -> { cells:[ {index, text, type} ] },
  //               where `text` is the RAW XML cell text (pre-numeric-parse).
  //     columns : the located column map from locateColumns ->
  //               { date, ko, homeTeam, awayTeam, neutralGround, matchId }
  //               (1-based SpreadsheetML column indices). Passed in so cells
  //               are read by their true position (Req 3.6, 3.7).
  //     current : the Current_Competition set by parseSectionHeader ->
  //               { sport, country, league, week }. The caller (6.3) is
  //               responsible for the "no Current_Competition yet" rejection
  //               (Req 5.4); when provided here its sport/country/league/week
  //               are copied onto the record (Req 5.1, 6.14).
  //     rowNum  : 1-based source row number, used in every error descriptor.
  //
  // RETURN SHAPE (consumed by the Task 6.3 association walk):
  //   success  : { ok:true,  record:{ ...Fixture_Record } }
  //   rejection: { ok:false, error:{ row:rowNum, reason:string } }
  //
  // The emitted Fixture_Record has EXACTLY the shared top-level keys
  //   { sport, country, league, home, away, date, time, name, source, raw }
  // in the same order as the Format 1 record, and `raw` contains ONLY
  //   { matchId, neutralGround, week }
  // so Property 12 (record-shape invariance) holds (Req 6.13, 7.1).
  //
  // Field rules:
  //  - Home / Away team text is preserved UNALTERED (Req 6.2, Property 10).
  //    Only surrounding whitespace is trimmed; inner text is kept exactly.
  //  - name = home + " v " + away; source = "betradar".
  //  - Match_ID is captured as the EXACT raw-XML cell string straight from
  //    `cell.text` BEFORE any numeric parsing (never Number()-ed, never
  //    reformatted), so precision is preserved for values beyond
  //    Number.MAX_SAFE_INTEGER (Req 6.9, 6.10, Property 9). A missing/blank
  //    Match_ID is a row-level rejection (Req 6.4 / 8.4).
  //  - Date -> parseFormat2Date, Time -> parseFormat2Time, combined via
  //    combineFormat2DateTime to the shared PLFM "mm-dd-YYYY" / "HH:MM" shape
  //    (Req 6.6). Invalid date -> invalid-date rejection (Req 6.7); invalid
  //    time -> invalid-time rejection (Req 6.8).
  //  - raw.neutralGround preserves the original "Yes"/"No" text; a BLANK cell
  //    becomes the UNKNOWN value "" (empty string) and is NEVER auto-converted
  //    to "No" (Req 6.11, 6.12, Property 11).
  //  - raw.week = current.week (null when the header carried no Week segment).
  //  - sport/country/league come from `current` (Req 5.1, 6.14).
  //
  // UNKNOWN Neutral_Ground value: the empty string "". Chosen because the
  // shared record already uses "" for absent string fields and because it is
  // falsy/distinct from the literal "No", making "blank was never auto-No"
  // trivially checkable downstream.
  // -----------------------------------------------------------------
  var FORMAT2_NEUTRAL_UNKNOWN = ""; // UNKNOWN Neutral_Ground representation.

  function parseFixtureRow(row, columns, current, rowNum){
    // Build a position -> RAW cell text lookup keyed by 1-based column index.
    // Unlike rowTextByIndex (which drops blanks), we keep the EXACT raw text
    // here so Match_ID precision and team text are preserved untouched. The
    // first cell seen at a given index wins (defensive against duplicates).
    var rawByIndex = {};
    var cells = (row && Array.isArray(row.cells)) ? row.cells : [];
    for(var i=0;i<cells.length;i++){
      var cell = cells[i];
      if(!cell) continue;
      if(!Object.prototype.hasOwnProperty.call(rawByIndex, cell.index)){
        rawByIndex[cell.index] = (cell.text==null) ? "" : String(cell.text);
      }
    }

    function rawAt(colIndex){
      if(colIndex==null) return "";
      return Object.prototype.hasOwnProperty.call(rawByIndex, colIndex) ? rawByIndex[colIndex] : "";
    }

    // --- Match_ID: EXACT raw-XML string, captured BEFORE any numeric parsing
    // (Req 6.9, 6.10). Do NOT Number() or reformat. Missing/blank -> reject
    // (Req 6.4 / 8.4). A light trim decides presence, but the STORED value is
    // the trimmed raw string (no scientific notation / ".0" / rounding). ---
    var matchIdRaw = rawAt(columns && columns.matchId);
    var matchId = matchIdRaw.trim();
    if(matchId===""){
      return { ok:false, error:{ row:rowNum, reason:"missing Match_ID at row "+rowNum } };
    }

    // --- Team names: preserved unaltered (Req 6.2, Property 10). Only
    // surrounding whitespace is trimmed; inner characters are kept exactly. ---
    var home = rawAt(columns && columns.homeTeam).trim();
    var away = rawAt(columns && columns.awayTeam).trim();

    // --- Date / time (Req 6.3-6.8). Invalid -> row-level rejection. ---
    var dateParts = parseFormat2Date(rawAt(columns && columns.date));
    if(!dateParts.ok){
      return { ok:false, error:{ row:rowNum, reason:"invalid date at row "+rowNum } };
    }
    var timeParts = parseFormat2Time(rawAt(columns && columns.ko));
    if(!timeParts.ok){
      return { ok:false, error:{ row:rowNum, reason:"invalid time at row "+rowNum } };
    }
    var dt = combineFormat2DateTime(dateParts, timeParts);

    // --- Neutral ground: preserve original "Yes"/"No"; blank -> UNKNOWN ""
    // and NEVER auto-"No" (Req 6.11, 6.12, Property 11). ---
    var neutralRaw = rawAt(columns && columns.neutralGround).trim();
    var neutralGround = (neutralRaw==="") ? FORMAT2_NEUTRAL_UNKNOWN : neutralRaw;

    // --- Current_Competition values (Req 5.1, 6.14). ---
    var comp = current || {};

    // Shared Fixture_Record. Top-level keys EXACTLY match the Format 1 record
    // (same keys, same order) so Property 12 holds; `raw` holds ONLY matchId,
    // neutralGround, week (Req 6.13).
    var record = {
      sport:   comp.sport!=null ? comp.sport : "",
      country: comp.country!=null ? comp.country : "",
      league:  comp.league!=null ? comp.league : "",
      home:    home,
      away:    away,
      date:    dt.date,
      time:    dt.time,
      name:    home + " v " + away,
      source:  "betradar",
      raw: {
        matchId:       matchId,
        neutralGround: neutralGround,
        week:          (comp.week!=null ? comp.week : null)
      }
    };

    return { ok:true, record:record };
  }

  // -----------------------------------------------------------------
  // Decode an ENTIRE Uint8Array as text (betradar-format2-support, Task 6.3).
  //
  // decodeHeadAsText only decodes a head chunk for content sniffing; the
  // Format 2 parser needs the FULL SpreadsheetML document. This mirrors the
  // test harness's bufferToText: prefer TextDecoder (UTF-8, errors ignored),
  // and fall back to a char-code decode (chunked so very large files do not
  // blow the call stack via String.fromCharCode.apply) when TextDecoder is
  // unavailable. Returns "" on failure / non-buffer input.
  // -----------------------------------------------------------------
  function decodeAllAsText(u8){
    if(!u8||typeof u8.length!=="number"){ return ""; }
    try{
      if(typeof TextDecoder!=="undefined"){
        return new TextDecoder("utf-8",{fatal:false}).decode(u8);
      }
    }catch(e){ /* fall through to manual decode */ }
    try{
      var out="";
      var CHUNK=0x8000;
      for(var i=0;i<u8.length;i+=CHUNK){
        var slice=u8.subarray(i, Math.min(u8.length, i+CHUNK));
        out+=String.fromCharCode.apply(null, slice);
      }
      return out;
    }catch(e2){ return ""; }
  }

  // -----------------------------------------------------------------
  // Format2_Parser -- parseBetradarFormat2(bytes) (betradar-format2-support,
  // Task 6.3: competition association walk).
  //
  // Orchestrates the already-built pure sub-components into the real Format 2
  // parse. The router passes a Uint8Array.
  //
  // Steps:
  //   1. Decode the bytes to the FULL XML text (decodeAllAsText).
  //   2. loadFixtureSheet(xmlText): fatal (missing "Fixture" worksheet /
  //      unreadable XML) -> return the fatal Parse_Result as-is
  //      ({rows:[], errors, failed:true}) (Req 3.4, fatal).
  //   3. Locate the column-header row: walk rows, classifyRow(row) (WITHOUT
  //      columns) to find the "columnHeader" row, then locateColumns(headerRow).
  //      locateColumns fatal (missing required column) -> return fatal
  //      Parse_Result as-is (Req 3.3). If no column-header row exists at all,
  //      that is likewise a fatal "required column(s) not found" result.
  //   4. Competition association walk: iterate rows IN ORDER maintaining
  //      `current` (Current_Competition, initially null). classifyRow(row,
  //      columns):
  //        - columnHeader : skip, retain current.
  //        - empty        : skip, NO error (Req 8.2), retain current.
  //        - sectionHeader: parseSectionHeader(text, rowNum). ok -> set current
  //          = competition (and push any warning, warning:true); !ok -> push
  //          the error and LEAVE current unchanged (Req 4.8).
  //        - fixture      : current===null -> row-level error "fixture row
  //          before a valid competition header" by rowNum, emit no record
  //          (Req 5.4). Else parseFixtureRow(row, columns, current, rowNum):
  //          ok -> push record; !ok -> push the error.
  //        - malformed    : row-level error by rowNum (Req 8.3), no record.
  //   5. Return { rows:[...records], errors:[...], failed:false,
  //      successCount, rejectedCount }. failed stays false for ALL row-level
  //      errors (partial import, Req 8.9). The router's finalize PREFERS these
  //      parser-provided counts (Task 8.1) and only falls back to its own
  //      heuristic when a result does not supply them (e.g. Format 1).
  //
  // ROW RECONCILIATION (Task 8.1, Req 8.1, 8.2, 8.6, 8.7) -- EXACT DEFINITIONS:
  //
  //   The reconciliation invariant (Req 8.7, Property 13) is:
  //       successCount + rejectedCount == (number of NON-EMPTY,
  //                                        NON-Section_Header_Row rows read)
  //
  //   Rather than depend on a post-hoc heuristic over the `errors` list, the
  //   walk itself counts the two categories AS it classifies each row, and we
  //   define the reconciliation denominator as EXACTLY the rows that become
  //   either a Fixture_Record or a row-level fixture rejection. Concretely, by
  //   row kind:
  //     - fixture (accepted)  -> successCount  (counts toward denominator)
  //     - fixture (rejected: before-header / missing Match_ID / invalid
  //       date / invalid time)             -> rejectedCount (counts)
  //     - malformed           -> rejectedCount (counts; it is a non-empty,
  //                              non-section-header row)
  //     - empty               -> counted in NEITHER; pushes NO error (Req 8.2)
  //     - sectionHeader       -> counted in NEITHER (it IS a section-header
  //                              row, excluded from the denominator by Req
  //                              8.7). This holds for BOTH a valid header AND
  //                              an invalid empty-league header: the invalid
  //                              header still pushes an error, but that error
  //                              is NOT a rejected fixture and is NOT counted
  //                              in rejectedCount (no double counting).
  //                              A non-conforming-header warning is likewise
  //                              not counted.
  //     - columnHeader        -> counted in NEITHER. Although the worksheet
  //                              column-label row is non-empty and is not a
  //                              Section_Header_Row, it is STRUCTURAL metadata
  //                              (it names the fixture columns), not a fixture
  //                              and not a data row. Counting it would break
  //                              reconciliation because it becomes neither a
  //                              success nor a rejection. We therefore treat
  //                              it like a section header for reconciliation
  //                              purposes and exclude it from the denominator.
  //                              This matches the verified Sample_File baseline
  //                              (2482 = 248 section headers + 2233 fixtures +
  //                              0 empty, with NO separate column-header term),
  //                              so the fixture reconciliation
  //                              successCount + rejectedCount == 2233 holds.
  //
  //   In short: successCount + rejectedCount counts PRECISELY the fixture and
  //   malformed rows, which is exactly "non-empty, non-section-header,
  //   non-column-header data rows read". Every counted rejected row also
  //   appears in `errors` with its source row number and a reason (Req 8.10).
  //
  // ROW NUMBER BASIS: `rowNum` is the 1-based position of the row within the
  // worksheet rows returned by loadFixtureSheet (i.e. the rows-array index + 1).
  // loadFixtureSheet preserves worksheet row order, so this is a stable,
  // consistent "source row number" for every row-level error and warning.
  // -----------------------------------------------------------------
  var parseBetradarFormat2 = function parseBetradarFormat2(bytes){
    // (1) Decode the full SpreadsheetML document text.
    var xmlText=decodeAllAsText(bytes);

    // (2) Load the "Fixture" worksheet. Fatal results (missing worksheet /
    // unreadable XML) are returned as-is: {rows:[], errors, failed:true}.
    var sheet=loadFixtureSheet(xmlText);
    if(sheet.failed){
      return {rows:[],errors:sheet.errors||[],failed:true};
    }
    var rows=Array.isArray(sheet.rows)?sheet.rows:[];

    // (3) Locate the column-header row, then its columns. Walk rows (WITHOUT
    // columns) to find the "columnHeader" row.
    var headerRow=null;
    for(var h=0;h<rows.length;h++){
      if(classifyRow(rows[h])==="columnHeader"){ headerRow=rows[h]; break; }
    }
    var located=locateColumns(headerRow);
    if(located.failed){
      // Missing required column(s) -> fatal Parse_Result (Req 3.3). When no
      // column-header row was found at all, locateColumns(null) still reports
      // the missing columns, which is the correct fatal cause.
      return {rows:[],errors:located.errors||[],failed:true};
    }
    var columns=located.columns;

    // (4) Competition association walk over rows IN ORDER (Req 5.1-5.4).
    var records=[];
    var errors=[];
    var current=null; // Current_Competition; null until a valid header is read.

    // Row reconciliation counters (Task 8.1, Req 8.6, 8.7). These are counted
    // AS rows are classified so the invariant
    //   successCount + rejectedCount == non-empty, non-section-header,
    //                                   non-column-header data rows read
    // holds by construction (see ROW RECONCILIATION note above). Section
    // headers (valid or invalid), warnings, column headers, and empty rows are
    // deliberately counted in NEITHER category.
    var rejectedCount=0;

    for(var r=0;r<rows.length;r++){
      var row=rows[r];
      var rowNum=r+1; // 1-based source row number (see ROW NUMBER BASIS above).
      var kind=classifyRow(row, columns);

      if(kind==="columnHeader"){
        // The worksheet column-label row: structural, excluded from the
        // reconciliation denominator. Skip, retain current (Req 3.5).
        continue;
      }
      if(kind==="empty"){
        // Completely empty row: skip, NO error (Req 8.2), counted in NEITHER
        // category. Retain current.
        continue;
      }
      if(kind==="sectionHeader"){
        // Extract the header text from the row's single populated cell.
        var byIndex=rowTextByIndex(row);
        var headerText="";
        for(var k in byIndex){
          if(Object.prototype.hasOwnProperty.call(byIndex,k)){ headerText=byIndex[k]; break; }
        }
        var parsed=parseSectionHeader(headerText, rowNum);
        if(parsed.ok){
          current=parsed.competition; // New header replaces Current_Competition (Req 5.2).
          if(parsed.warning){ errors.push(parsed.warning); } // Non-conforming degrade (Req 4.5).
        }else{
          // Invalid header (empty league): record error, LEAVE current
          // unchanged (Req 4.8). This is a SECTION-HEADER row -> excluded from
          // the reconciliation denominator, so it is NOT counted as a rejected
          // fixture (no double counting).
          errors.push(parsed.error);
        }
        continue;
      }
      if(kind==="fixture"){
        if(current===null){
          // Fixture before any valid competition header (Req 5.4): row-level
          // error by source row number, emit no record. Counts as a rejected
          // data row (non-empty, non-section-header).
          errors.push({row:rowNum,reason:"fixture row before a valid competition header at row "+rowNum});
          rejectedCount++;
          continue;
        }
        var fx=parseFixtureRow(row, columns, current, rowNum);
        if(fx.ok){ records.push(fx.record); }           // success (counted via records.length)
        else { errors.push(fx.error); rejectedCount++; } // rejected fixture (counts)
        continue;
      }
      // kind === "malformed": row-level error by source row number (Req 8.3),
      // no record. It is a non-empty, non-section-header data row -> counts as
      // a rejected row. Retain current.
      errors.push({row:rowNum,reason:"malformed row at row "+rowNum});
      rejectedCount++;
    }

    // (5) Partial import: row-level errors never set failed (Req 8.9).
    // successCount = Fixture_Records produced; rejectedCount = rejected data
    // rows counted during the walk. By construction (see ROW RECONCILIATION),
    //   successCount + rejectedCount == non-empty, non-section-header,
    //                                   non-column-header data rows read
    // (Req 8.6, 8.7). The router's finalize PREFERS these parser-provided
    // counts over its own heuristic.
    return {
      rows:records,
      errors:errors,
      failed:false,
      successCount:records.length,
      rejectedCount:rejectedCount
    };
  };

  // -----------------------------------------------------------------
  // Preserved public adapter entry point, now a detecting ROUTER
  // (betradar-format2-support, Task 2.1).
  //
  // Responsibilities:
  //  1. Empty/unreadable-buffer guard -> fatal Parse_Result
  //     (rows:[], error "file could not be read", failed:true) (Req 1.7).
  //  2. Call detectBetradarFormat BEFORE any parser runs (Req 1.2), then route:
  //       format1      -> Format1_Parser (parseBetradarFormat1)   (Req 1.3)
  //       format2      -> parseBetradarFormat2                    (Req 1.4)
  //       unidentified -> fatal Parse_Result                      (Req 1.5)
  //         (rows:[], error "format could not be identified", failed:true)
  //  3. Attach ADDITIVE metadata (format, successCount, rejectedCount, failed)
  //     to the returned object WITHOUT changing the type/meaning of
  //     rows/errors, so existing consumers reading only {rows, errors} keep
  //     working (Req 9.1, 9.2, 9.3).
  // -----------------------------------------------------------------
  function parseBetradarWorkbook(arrayBuffer){
    // (1) Empty / unreadable buffer guard (Req 1.7). Normalize to a byte view
    // first; anything that is not a readable buffer, or is zero-length, is a
    // fatal file-level error.
    // Realm-safe normalization (do NOT use `instanceof`: the buffer may be from
    // another realm, e.g. a parent window vs. this iframe -- see toUint8Array).
    var u8=toUint8Array(arrayBuffer);
    if(!u8||!u8.length){
      return finalizeBetradarResult(
        {rows:[],errors:[{reason:"file could not be read"}],failed:true},
        "unidentified"
      );
    }

    // (2) Content-based detection BEFORE any parser is invoked (Req 1.2).
    var format=detectBetradarFormat(u8);

    // (3) Route by detected format.
    if(format==="format1"){
      // Existing Format 1 core, unchanged behavior (Req 1.3, 2.1-2.3).
      return finalizeBetradarResult(parseBetradarFormat1(u8), "format1");
    }
    if(format==="format2"){
      // Format 2 parser (stub until later tasks replace it) (Req 1.4).
      return finalizeBetradarResult(parseBetradarFormat2(u8), "format2");
    }
    // Unidentified -> fatal Parse_Result (Req 1.5).
    return finalizeBetradarResult(
      {rows:[],errors:[{reason:"format could not be identified"}],failed:true},
      "unidentified"
    );
  }

  // Attach additive, backward-compatible Parse_Result metadata (Req 9.2).
  // The underlying {rows, errors} are preserved exactly as produced by the
  // routed parser; only the additive fields (format, successCount,
  // rejectedCount, failed) are layered on. Existing consumers reading only
  // rows/errors are unaffected (Req 9.3).
  //
  // Count resolution (Task 8.1):
  //   - PREFER parser-provided counts. When the routed parser supplies numeric
  //     successCount / rejectedCount on its result (the Format 2 parser does,
  //     counting rows exactly during its association walk so the Req 8.7
  //     reconciliation holds by construction), those values are used verbatim.
  //     This keeps reconciliation independent of any heuristic over `errors`.
  //   - FALL BACK to the heuristic only when the parser did NOT supply them
  //     (e.g. the Format 1 core, or a fatal file-level result). In that case:
  //       - successCount = number of Fixture_Records produced (rows.length).
  //       - rejectedCount = number of row-level error descriptors that carry a
  //         source row number; warnings (warning:true) and fatal file-level
  //         errors (no `row`) are NOT counted as rejected rows. This preserves
  //         the pre-existing Format 1 behavior exactly (Format 1 non-fatal
  //         keep-the-row advisories carry warning:true and are excluded).
  //   - failed = the parser's own fatal flag when present, otherwise false.
  function finalizeBetradarResult(result, format){
    result=result||{};
    var rows=Array.isArray(result.rows)?result.rows:[];
    var errors=Array.isArray(result.errors)?result.errors:[];
    result.rows=rows;
    result.errors=errors;
    result.format=format;

    // PREFER parser-provided counts when present (Task 8.1). Only fall back to
    // the heuristic when the parser did not supply numeric counts.
    if(typeof result.successCount==="number"){
      // keep as-is
    }else{
      result.successCount=rows.length;
    }
    if(typeof result.rejectedCount==="number"){
      // keep as-is
    }else{
      var rejected=0;
      for(var i=0;i<errors.length;i++){
        var e=errors[i];
        if(e&&!e.warning&&typeof e.row==="number"){ rejected++; }
      }
      result.rejectedCount=rejected;
    }

    result.failed=(result.failed===true);
    return result;
  }

  /* =================================================================
     resolveBcm -- exact composite-key, ACTIVE-only lookup over teamStore.
     Ported from MSFM bcmResolveBatch resolve logic: active mappings are grouped
     by composite key into a Set of DISTINCT bcmTeam names. Exactly one distinct
     name -> MAPPED; zero -> UNMAPPED; two or more distinct names -> CONFLICT.
     NEVER fuzzy, never an arbitrary pick. (Two active records with the SAME
     bcmTeam collapse to one and resolve MAPPED, matching MSFM.)
     ================================================================= */
  function resolveBcm(team,scope){
    scope=scope||{};
    var sport=scope.sport,country=scope.country,league=scope.league;
    if(!team||!String(team).trim()) return {status:"UNMAPPED",bcm:""};
    var map=new Map();
    var list=teamStore.list();
    for(var i=0;i<list.length;i++){
      var m=list[i];
      if(m.active===false)continue;
      if(canonSport(m.sport)!==canonSport(sport))continue;
      var k=teamMapKey(m.sport,m.country,m.flashscoreLeague,m.flashscoreTeam);
      if(!map.has(k))map.set(k,new Set());
      map.get(k).add(m.bcmTeam);
    }
    var key=teamMapKey(sport,country,league,team);
    var set=map.get(key);
    if(!set||!set.size) return {status:"UNMAPPED",bcm:""};
    if(set.size>1) return {status:"CONFLICT",bcm:"",options:Array.from(set)};
    return {status:"MAPPED",bcm:Array.from(set)[0]};
  }

  /* =================================================================
     classify -- delegates to FXE.classifyFixtures (sole engine). No local
     classification logic. Returns the FXE result object:
     {newMatches, alreadyWorked, possible, timeChanged, conflicts, ...}.
     ================================================================= */
  function classify(currentFixtures,workedRows){
    return FXE.classifyFixtures(currentFixtures||[],workedRows||[]);
  }

  /* =================================================================
     playoffFlag -- ported from MSFM PLAYOFF_RE + playoffAlerts detection.
     Returns {flag, label, base} for a single fixture. `flag` is true when the
     fixture's league name matches the playoff/knockout indicators AND (per
     MSFM playoffAlerts) the league-minus-stage-suffix is an active priority
     league in that country, OR a waiting (blank/inactive) priority mapping for
     that stage exists. Mapping context is read from priorityStore so the
     detection matches MSFM given the same mappings.
     ================================================================= */
  var PLAYOFF_RE=/\bplay[\s-]?offs?\b|\bplay[\s-]?outs?\b|\bplay[\s-]?downs?\b|\bpromotion\b|\brelegation\b|\bkvalserien\b/i;

  function playoffFlag(fixture){
    fixture=fixture||{};
    var league=String(fixture.DetectedLeague||fixture["Flashscore League Name"]||fixture.League||"");
    var sport=fixture.Sport;
    if(!league||!PLAYOFF_RE.test(league)) return {flag:false,label:"",base:""};
    var sp=canonSport(sport);
    var mappings=priorityStore.list();
    var sm=mappings.filter(function(m){return canonSport(m.sport)===sp;});
    var ck=countryKey(fixture.Country);
    var base=leagueKey(league.slice(0,league.search(PLAYOFF_RE)).replace(/[\s\-\u2013:(,]+$/,""));
    var inCountry=sm.filter(function(m){return countryKey(m.country)===ck;});
    var regular=base?inCountry.filter(function(m){return m.active!==false&&leagueKey(m.flashscoreLeague)===base;}):[];
    var waiting=inCountry.filter(function(m){return PLAYOFF_RE.test(m.priorityLeague)&&(leagueKey(m.flashscoreLeague)===""||m.active===false);});
    var stems=[base].concat(regular.map(function(m){return leagueKey(m.priorityLeague);})).filter(Boolean);
    var related=waiting.filter(function(m){return stems.some(function(s){return leagueKey(m.priorityLeague).includes(s);});});
    if(related.length)waiting=related;else if(!regular.length&&base)waiting=[];
    if(!waiting.length&&!regular.length) return {flag:false,label:"",base:base};
    return {
      flag:true,
      label:"Possible playoff/knockout stage of a priority league \u2014 review required",
      base:base,
      regular:Array.from(new Set(regular.map(function(m){return m.priorityLeague;}))),
      waiting:waiting.map(function(m){return m.priorityLeague;})
    };
  }

  /* =================================================================
     Mapping import/export helpers (MSFM column conventions).
     priorityStore/teamStore read/write the MSFM record shape; these helpers
     expose an import/export surface consistent with MSFM importMappingCSV /
     buildMappingSQL column conventions. Full UI wiring is Task 5; here we
     provide the pure shape helpers the UI will reuse.
     ================================================================= */
  function escapeCSV(v){ return FXE.escapeCSV ? FXE.escapeCSV(v) : String(v==null?"":v); }

  // Priority export columns mirror MSFM importMappingCSV conventions.
  function priorityToRows(list){
    var header=["Sport","Country","Flashscore League Name","Priority League","Active"];
    var out=[header];
    (list||priorityStore.list()).forEach(function(m){
      out.push([m.sport,m.country,m.flashscoreLeague,m.priorityLeague,m.active!==false?"true":"false"]);
    });
    return out;
  }
  function teamToRows(list){
    var header=["Sport","Country","Flashscore League","Flashscore Team","BCM Team","Active"];
    var out=[header];
    (list||teamStore.list()).forEach(function(m){
      out.push([m.sport,m.country,m.flashscoreLeague,m.flashscoreTeam,m.bcmTeam,m.active!==false?"true":"false"]);
    });
    return out;
  }

  /* =================================================================
     Priority-mapping import (MSFM importMappingCSV conventions).
     Pure, DOM-free, backend-free. Reads a delimited text block (CSV/TSV) OR a
     parsed array-of-arrays (from SheetJS sheet_to_json({header:1})) and returns:
       { headerError, required, imported, skipped, duplicates }
     - Header row matched CASE-INSENSITIVELY (mirrors MSFM headerIndex aliases).
     - REQUIRED columns: Country, Priority League, Flashscore League (MSFM parity).
       If any required column is missing -> headerError is set and imported is []
       (the caller MUST NOT mutate stored data: this is the reject-whole-file path).
     - Each data row validated independently; invalid rows -> skipped[{row,reason}].
     - Duplicate composite keys WITHIN the file -> duplicates[] (first wins),
       so re-importing the same file is idempotent.
     Columns (case-insensitive, MSFM aliases):
       Sport|Sport Name, Country|Region|Country Region|Country / Region,
       Priority League|PriorityLeague, Flashscore League Name|Flashscore League|
       FlashscoreLeague Name|Flashscore, Active|Status|Enabled,
       Betradar League (optional), Notes (optional).
     ================================================================= */
  // PLFM composite key per design C4 (priority: Sport + Country + Flashscore
  // League). This is the key PLFM uses for duplicate PREVENTION, in-file import
  // dedup, update-in-place, and conflict detection -- and it is exactly the key
  // the priority filter (plfm-priority.js) matches on, so "two active records on
  // one key" is a real priority-resolution conflict. (MSFM's own import dedupes
  // on priorityLeague; PLFM's composite-key semantics are additive and never
  // change the stored MSFM-shaped record.)
  function priorityCompositeKey(m){ return canonSport(m.sport)+"|"+countryKey(m.country)+"|"+leagueKey(m.flashscoreLeague); }

  function normHeaderCell(v){ return String(v==null?"":v).replace(/^\uFEFF/,"").trim().toLowerCase(); }
  function headerIndexOf(headers,aliases){
    for(var i=0;i<headers.length;i++){ if(aliases.indexOf(headers[i])>=0) return i; }
    return -1;
  }
  // activeFlag mirrors MSFM: false only for the explicit falsey tokens, else true.
  function importActiveFlag(v){
    var s=String(v==null?"":v).trim().toLowerCase();
    if(["false","0","no","n","inactive","off"].indexOf(s)>=0) return false;
    return true;
  }
  // Rows source -> array of arrays. Accepts a string (CSV/TSV) or an array of arrays.
  function toAOA(input){
    if(Array.isArray(input)){
      return input.map(function(r){ return Array.isArray(r)?r.map(function(c){return String(c==null?"":c);}):[String(r==null?"":r)]; });
    }
    var t=String(input==null?"":input).replace(/^\uFEFF/,"");
    var firstLine=t.split(/\r?\n/).find(function(l){return l.trim();})||"";
    var delim=t.indexOf("\t")>=0?"\t":(firstLine.indexOf(";")>=0 && firstLine.indexOf(",")<0 ? ";" : ",");
    return parseDelimited(t,delim).map(function(r){ return r.map(function(c){return String(c==null?"":c);}); });
  }

  function importPriorityRows(input,opts){
    opts=opts||{};
    var defaultSport = canonSport(opts.defaultSport) || opts.defaultSport || "Basketball";
    var aoa=toAOA(input);
    // Drop fully-blank trailing rows but keep the header.
    var rows=aoa.filter(function(r,i){ return i===0 || r.some(function(c){return String(c).trim()!=="";}); });
    if(rows.length<1){ return {headerError:"The file has no rows.",required:["Country","Priority League","Flashscore League Name"],imported:[],skipped:[],duplicates:[]}; }
    var headers=rows[0].map(normHeaderCell);
    var sportI=headerIndexOf(headers,["sport","sport name"]);
    var countryI=headerIndexOf(headers,["country","region","country region","country / region"]);
    var priorityI=headerIndexOf(headers,["priority league","priorityleague"]);
    var flashI=headerIndexOf(headers,["flashscore league name","flashscore league","flashscoreleague name","flashscore"]);
    var activeI=headerIndexOf(headers,["active","status","enabled"]);
    var betradarI=headerIndexOf(headers,["betradar league","betradar"]);
    var notesI=headerIndexOf(headers,["notes","note","comment","comments"]);
    var missing=[];
    if(countryI<0) missing.push("Country");
    if(priorityI<0) missing.push("Priority League");
    if(flashI<0) missing.push("Flashscore League Name");
    if(missing.length){
      return {headerError:"Missing required column(s): "+missing.join(", ")+". Required columns: Country, Priority League, Flashscore League Name.",
              required:["Country","Priority League","Flashscore League Name"],imported:[],skipped:[],duplicates:[]};
    }
    var imported=[],skipped=[],duplicates=[],seen=new Map();
    for(var i=1;i<rows.length;i++){
      var r=rows[i],rowNo=i+1;
      var cell=function(k){ return k>=0 ? String(r[k]==null?"":r[k]).trim() : ""; };
      var country=cell(countryI), priorityLeague=cell(priorityI), flashscoreLeague=cell(flashI);
      if(!country||!priorityLeague){
        skipped.push({row:rowNo,reason:[!country?"Country is blank":"",!priorityLeague?"Priority League is blank":""].filter(Boolean).join("; "),text:r.join(" | ")});
        continue;
      }
      var sport=defaultSport;
      if(sportI>=0){ var raw=cell(sportI); if(raw){ var cs=canonSport(raw); sport = cs || raw; } }
      var rec={
        sport:sport, country:country, priorityLeague:priorityLeague, flashscoreLeague:flashscoreLeague,
        active: activeI>=0 ? importActiveFlag(r[activeI]) : true
      };
      var bl=cell(betradarI); if(bl) rec.betradarLeague=bl;
      var nt=cell(notesI); if(nt) rec.notes=nt;
      var key=priorityCompositeKey(rec);
      if(seen.has(key)){ duplicates.push({row:rowNo,firstRow:seen.get(key),reason:"Duplicate sport + country + flashscore league within the file",key:key}); continue; }
      seen.set(key,rowNo);
      rec.rowNo=rowNo;
      imported.push(rec);
    }
    return {headerError:null,required:["Country","Priority League","Flashscore League Name"],imported:imported,skipped:skipped,duplicates:duplicates};
  }

  // Read an Excel/CSV ArrayBuffer workbook -> array-of-arrays, then importPriorityRows.
  function importPriorityWorkbook(arrayBuffer,opts){
    if(typeof window.XLSX==="undefined"||!window.XLSX){
      return {headerError:"SheetJS (XLSX) is not loaded; cannot read the workbook.",required:["Country","Priority League","Flashscore League Name"],imported:[],skipped:[],duplicates:[]};
    }
    var aoa;
    try{
      var data=(arrayBuffer instanceof Uint8Array)?arrayBuffer:new Uint8Array(arrayBuffer);
      var wb=window.XLSX.read(data,{type:"array",cellText:true,cellDates:false,raw:false});
      if(!wb.SheetNames||!wb.SheetNames.length){ return {headerError:"The workbook has no sheets.",required:["Country","Priority League","Flashscore League Name"],imported:[],skipped:[],duplicates:[]}; }
      var sheet=wb.Sheets[wb.SheetNames[0]];
      aoa=window.XLSX.utils.sheet_to_json(sheet,{header:1,defval:"",raw:false});
    }catch(e){
      return {headerError:"Could not read the workbook: "+(e&&e.message?e.message:String(e)),required:["Country","Priority League","Flashscore League Name"],imported:[],skipped:[],duplicates:[]};
    }
    return importPriorityRows(aoa,opts);
  }

  /* =================================================================
     Priority-mapping export.
     - exportPriorityCSV: re-importable CSV using FXE.buildCSV (header order that
       importPriorityRows accepts) -> export->import round-trips.
     - exportPrioritySQL: Supabase SQL mirroring MSFM buildMappingSQL column
       convention (sport, country, priority_league, flashscore_league, active,
       sort_order) with a per-sport delete+insert transaction.
     ================================================================= */
  var PRIORITY_EXPORT_HEADERS=["Sport","Country","Priority League","Flashscore League Name","Betradar League","Active","Notes"];
  function exportPriorityCSV(list){
    var items=(list||priorityStore.list());
    var rows=items.map(function(m){
      return {
        "Sport": m.sport||"",
        "Country": m.country||"",
        "Priority League": m.priorityLeague||"",
        "Flashscore League Name": m.flashscoreLeague||"",
        "Betradar League": m.betradarLeague||"",
        "Active": m.active!==false ? "true":"false",
        "Notes": m.notes||""
      };
    });
    if(FXE.buildCSV) return FXE.buildCSV(PRIORITY_EXPORT_HEADERS,rows);
    // Fallback correct CSV builder (should not be reached; FXE.buildCSV exists).
    var esc=function(v){ var s=String(v==null?"":v); return '"'+s.replace(/"/g,'""')+'"'; };
    return [PRIORITY_EXPORT_HEADERS.map(esc).join(",")].concat(rows.map(function(row){ return PRIORITY_EXPORT_HEADERS.map(function(h){return esc(row[h]);}).join(","); })).join("\r\n");
  }
  function sqlStr(v){ return "'"+String(v==null?"":v).replace(/'/g,"''")+"'"; }
  function exportPrioritySQL(list){
    var SHARED_TABLE="msfm_priority_mappings";
    var items=(list||priorityStore.list()).filter(function(m){ return canonSport(m.sport); });
    // Preserve FXE.SPORTS order, then any other sports.
    var sportsOrder=(FXE.SPORTS||[]).slice();
    var present=[];
    items.forEach(function(m){ var s=canonSport(m.sport); if(present.indexOf(s)<0) present.push(s); });
    var sports=sportsOrder.filter(function(s){ return present.indexOf(s)>=0; })
      .concat(present.filter(function(s){ return sportsOrder.indexOf(s)<0; }));
    var order={};
    var values=[];
    sports.forEach(function(s){
      items.filter(function(m){ return canonSport(m.sport)===s; }).forEach(function(m){
        order[s]=(order[s]||0)+1;
        values.push("  ("+sqlStr(s)+", "+sqlStr(m.country)+", "+sqlStr(m.priorityLeague)+", "+sqlStr(m.flashscoreLeague)+", "+(m.active!==false?"true":"false")+", "+order[s]+")");
      });
    });
    var head=["-- Priority League Fixture Manager: shared priority league mappings",
      "-- Generated "+new Date().toISOString()+" \u2014 "+values.length+" mappings for: "+sports.join(", "),
      "-- Replaces the shared mappings of ONLY these sports (per-sport delete + insert in one transaction)."];
    if(!values.length) return head.join("\n")+"\n-- (no mappings to write)\n";
    return head.concat(["begin;",
      "delete from public."+SHARED_TABLE+" where sport in ("+sports.map(sqlStr).join(", ")+");",
      "insert into public."+SHARED_TABLE+" (sport, country, priority_league, flashscore_league, active, sort_order) values",
      values.join(",\n")+";","commit;",""]).join("\n");
  }

  // Conflict detection over a mapping list: a composite key with 2+ ACTIVE
  // records -> a conflict (Req 8.6/8.7 post-import conflict count).
  function priorityConflicts(list){
    var items=(list||priorityStore.list());
    var byKey=new Map();
    items.forEach(function(m){
      if(m.active===false) return;
      var k=priorityCompositeKey(m);
      if(!byKey.has(k)) byKey.set(k,[]);
      byKey.get(k).push(m);
    });
    var out=[];
    byKey.forEach(function(arr,k){ if(arr.length>1) out.push({key:k,count:arr.length,records:arr}); });
    return out;
  }

  var priorityImport = {
    importText: importPriorityRows,          // text (CSV/TSV) OR array-of-arrays
    importRows: importPriorityRows,
    importWorkbook: importPriorityWorkbook,  // ArrayBuffer (Excel/CSV via SheetJS)
    exportCSV: exportPriorityCSV,
    exportSQL: exportPrioritySQL,
    conflicts: priorityConflicts,
    mergeKey: priorityCompositeKey,
    activeFlag: importActiveFlag,
    EXPORT_HEADERS: PRIORITY_EXPORT_HEADERS
  };

  /* =================================================================
     Team-mapping import/export (MSFM team conventions, Task 5.2).

     Mirrors priorityImport but over the team record shape and the FULL
     composite key (Sport + Country + Flashscore League + Flashscore Team).
     Pure, DOM-free, backend-free.

     REQUIRED columns (MSFM teamRowsFromMatrix parity): Sport, Country,
     Flashscore League, Flashscore Team, BCM Team. If any required column is
     missing -> headerError is set and imported is [] (the caller MUST NOT
     mutate stored data: reject-whole-file path). Each data row validated
     independently; invalid rows -> skipped[{row,reason}]. Duplicate composite
     keys WITHIN the file -> duplicates[] (first wins) so re-import is
     idempotent. Header row matched CASE-INSENSITIVELY (MSFM aliases).
     ================================================================= */
  // PLFM team composite key = the EXACT teamMapKey used by resolveBcm, so "two
  // active records on one key" is a real BCM-resolution conflict.
  function teamCompositeKey(m){ return teamMapKey(m.sport,m.country,m.flashscoreLeague,m.flashscoreTeam); }

  function importTeamRows(input,opts){
    opts=opts||{};
    var defaultSport = canonSport(opts.defaultSport) || opts.defaultSport || "Basketball";
    var REQUIRED=["Sport","Country","Flashscore League","Flashscore Team","BCM Team"];
    var aoa=toAOA(input);
    var rows=aoa.filter(function(r,i){ return i===0 || r.some(function(c){return String(c).trim()!=="";}); });
    if(rows.length<1){ return {headerError:"The file has no rows.",required:REQUIRED,imported:[],skipped:[],duplicates:[]}; }
    var headers=rows[0].map(normHeaderCell);
    // Match MSFM teamRowsFromMatrix aliases (underscores/dashes folded to spaces).
    var foldHeader=headers.map(function(h){ return h.replace(/[_-]/g," ").replace(/\s+/g," ").trim(); });
    function hidx(aliases){ for(var i=0;i<foldHeader.length;i++){ if(aliases.indexOf(foldHeader[i])>=0) return i; } return -1; }
    var sportI=hidx(["sport","sport name"]);
    var countryI=hidx(["country","region","country region"]);
    var leagueI=hidx(["flashscore league","flashscore league name","league","fs league"]);
    var fsTeamI=hidx(["flashscore team","fs team","flashscore","team"]);
    var bcmI=hidx(["bcm team","bcm","bcm name","bcm team name"]);
    var activeI=hidx(["active","status","enabled"]);
    var missing=[];
    if(sportI<0) missing.push("Sport");
    if(countryI<0) missing.push("Country");
    if(leagueI<0) missing.push("Flashscore League");
    if(fsTeamI<0) missing.push("Flashscore Team");
    if(bcmI<0) missing.push("BCM Team");
    if(missing.length){
      return {headerError:"Missing required column(s): "+missing.join(", ")+". Required columns: Sport, Country, Flashscore League, Flashscore Team, BCM Team.",
              required:REQUIRED,imported:[],skipped:[],duplicates:[]};
    }
    var imported=[],skipped=[],duplicates=[],seen=new Map();
    for(var i=1;i<rows.length;i++){
      var r=rows[i],rowNo=i+1;
      var cell=function(k){ return k>=0 ? String(r[k]==null?"":r[k]).trim() : ""; };
      var sportRaw=cell(sportI), country=cell(countryI), flashscoreLeague=cell(leagueI),
          flashscoreTeam=cell(fsTeamI), bcmTeam=cell(bcmI);
      var reasons=[];
      var sport;
      if(!sportRaw){ reasons.push("Sport is blank"); }
      else { var cs=canonSport(sportRaw); sport = cs || sportRaw; }
      if(!country) reasons.push("Country is blank");
      if(!flashscoreLeague) reasons.push("Flashscore League is blank");
      if(!flashscoreTeam) reasons.push("Flashscore Team is blank");
      if(!bcmTeam) reasons.push("BCM Team is blank");
      if(reasons.length){
        skipped.push({row:rowNo,reason:reasons.join("; "),text:r.join(" | ")});
        continue;
      }
      var rec={
        sport:sport, country:country, flashscoreLeague:flashscoreLeague,
        flashscoreTeam:flashscoreTeam, bcmTeam:bcmTeam,
        active: activeI>=0 ? importActiveFlag(r[activeI]) : true
      };
      var key=teamCompositeKey(rec);
      if(seen.has(key)){ duplicates.push({row:rowNo,firstRow:seen.get(key),reason:"Duplicate sport + country + flashscore league + flashscore team within the file",key:key}); continue; }
      seen.set(key,rowNo);
      rec.rowNo=rowNo;
      imported.push(rec);
    }
    return {headerError:null,required:REQUIRED,imported:imported,skipped:skipped,duplicates:duplicates};
  }

  function importTeamWorkbook(arrayBuffer,opts){
    var REQUIRED=["Sport","Country","Flashscore League","Flashscore Team","BCM Team"];
    if(typeof window.XLSX==="undefined"||!window.XLSX){
      return {headerError:"SheetJS (XLSX) is not loaded; cannot read the workbook.",required:REQUIRED,imported:[],skipped:[],duplicates:[]};
    }
    var aoa;
    try{
      var data=(arrayBuffer instanceof Uint8Array)?arrayBuffer:new Uint8Array(arrayBuffer);
      var wb=window.XLSX.read(data,{type:"array",cellText:true,cellDates:false,raw:false});
      if(!wb.SheetNames||!wb.SheetNames.length){ return {headerError:"The workbook has no sheets.",required:REQUIRED,imported:[],skipped:[],duplicates:[]}; }
      var sheet=wb.Sheets[wb.SheetNames[0]];
      aoa=window.XLSX.utils.sheet_to_json(sheet,{header:1,defval:"",raw:false});
    }catch(e){
      return {headerError:"Could not read the workbook: "+(e&&e.message?e.message:String(e)),required:REQUIRED,imported:[],skipped:[],duplicates:[]};
    }
    return importTeamRows(aoa,opts);
  }

  /* Team export: re-importable CSV with the canonical columns via FXE.buildCSV. */
  var TEAM_EXPORT_HEADERS=["Sport","Country","Flashscore League","Flashscore Team","BCM Team","Active"];
  function exportTeamCSV(list){
    var items=(list||teamStore.list());
    var rows=items.map(function(m){
      return {
        "Sport": m.sport||"",
        "Country": m.country||"",
        "Flashscore League": m.flashscoreLeague||"",
        "Flashscore Team": m.flashscoreTeam||"",
        "BCM Team": m.bcmTeam||"",
        "Active": m.active!==false ? "true":"false"
      };
    });
    if(FXE.buildCSV) return FXE.buildCSV(TEAM_EXPORT_HEADERS,rows);
    var esc=function(v){ var s=String(v==null?"":v); return '"'+s.replace(/"/g,'""')+'"'; };
    return [TEAM_EXPORT_HEADERS.map(esc).join(",")].concat(rows.map(function(row){ return TEAM_EXPORT_HEADERS.map(function(h){return esc(row[h]);}).join(","); })).join("\r\n");
  }

  // Supabase SQL mirroring MSFM buildTeamMappingSQL: idempotent upsert into
  // public.msfm_team_mappings on conflict key (sport,country,flashscore_league,
  // flashscore_team), in one begin/commit transaction.
  function exportTeamSQL(list){
    var items=(list||teamStore.list());
    var lines=[];
    lines.push("-- Priority League Fixture Manager: team mappings export (review before running).");
    lines.push("-- Target table: public.msfm_team_mappings (see msfm_team_mappings_setup.sql). Run that setup first.");
    lines.push("-- Idempotent upsert on the unique key (sport, country, flashscore_league, flashscore_team).");
    lines.push("-- Generated "+new Date().toISOString()+" \u2014 "+items.length+" team mapping(s).");
    if(!items.length) return lines.join("\n")+"\n-- (no team mappings to write)\n";
    lines.push("begin;");
    items.forEach(function(m){
      var vals=[sqlStr(m.sport),sqlStr(m.country),sqlStr(m.flashscoreLeague),sqlStr(m.flashscoreTeam),sqlStr(m.bcmTeam),(m.active!==false?"true":"false")].join(",");
      lines.push("insert into public.msfm_team_mappings (sport,country,flashscore_league,flashscore_team,bcm_team,active) values ("+vals+")");
      lines.push("  on conflict (sport,country,flashscore_league,flashscore_team) do update set bcm_team=excluded.bcm_team, active=excluded.active;");
    });
    lines.push("commit;");
    lines.push("");
    return lines.join("\n");
  }

  // Conflict detection over a team list: a composite key with 2+ ACTIVE records
  // that resolve to DIFFERENT bcmTeam -> a conflict (matches resolveBcm CONFLICT).
  // Two active records with the SAME bcmTeam collapse to MAPPED (not a conflict).
  function teamConflicts(list){
    var items=(list||teamStore.list());
    var byKey=new Map();
    items.forEach(function(m){
      if(m.active===false) return;
      var k=teamCompositeKey(m);
      if(!byKey.has(k)) byKey.set(k,[]);
      byKey.get(k).push(m);
    });
    var out=[];
    byKey.forEach(function(arr,k){
      var distinct=new Set(arr.map(function(m){ return m.bcmTeam; }));
      if(arr.length>1 && distinct.size>1) out.push({key:k,count:arr.length,records:arr});
    });
    return out;
  }

  // Missing-mapping identification: given a list of fixtures (each carrying
  // sport/country/league + home/away team names), return the DISTINCT team
  // scopes that do NOT resolve to a single active BCM mapping (UNMAPPED), so the
  // UI can flag what still needs mapping. Fixtures accept either normalized or
  // display field names (home/Home/homeTeam etc).
  function teamMissingFor(fixtures){
    var seen=new Map();
    (fixtures||[]).forEach(function(f){
      if(!f) return;
      var sport=f.sport||f.Sport||"";
      var country=f.country||f.Country||"";
      var league=f.league||f.DetectedLeague||f.flashscoreLeague||f.League||"";
      [f.home||f.Home||f.homeTeam, f.away||f.Away||f.awayTeam].forEach(function(team){
        if(!team||!String(team).trim()) return;
        var r=resolveBcm(team,{sport:sport,country:country,league:league});
        if(r.status==="UNMAPPED"){
          var k=teamMapKey(sport,country,league,team);
          if(!seen.has(k)) seen.set(k,{sport:sport,country:country,flashscoreLeague:league,flashscoreTeam:String(team),status:"UNMAPPED"});
        }
      });
    });
    return Array.from(seen.values());
  }

  var teamImport = {
    importText: importTeamRows,            // text (CSV/TSV) OR array-of-arrays
    importRows: importTeamRows,
    importWorkbook: importTeamWorkbook,    // ArrayBuffer (Excel/CSV via SheetJS)
    exportCSV: exportTeamCSV,
    exportSQL: exportTeamSQL,
    conflicts: teamConflicts,
    missingFor: teamMissingFor,
    mergeKey: teamCompositeKey,
    activeFlag: importActiveFlag,
    EXPORT_HEADERS: TEAM_EXPORT_HEADERS
  };

  var PLFM_ADAPTER = {
    scaffold: true,            // retained so the harness scaffold checks still pass
    implemented: true,         // marks Task 2 real implementations present
    // low-level store (Task 2.1)
    store: store,
    uid: uid,
    // parsers (Task 2.2)
    parseFlashscorePaste: parseFlashscorePaste,
    parseWorkedPaste: parseWorkedPaste,
    parseBetradarWorkbook: parseBetradarWorkbook,
    // stores (Task 2.1)
    priorityStore: priorityStore,
    teamStore: teamStore,
    teamMapKey: teamMapKey,
    // mapping import/export (Task 5.1 / 5.2)
    priorityImport: priorityImport,
    teamImport: teamImport,
    // resolution / identity / classification / playoff (Task 2.3)
    resolveBcm: resolveBcm,
    classify: classify,
    playoffFlag: playoffFlag,
    fixtureIdentity: fixtureIdentity,   // VERBATIM MSFM port (time-INCLUSIVE)
    reviewIdentity: reviewIdentity,     // same tuple MINUS time (design C5a / Req 17)
    // exposed ported internals (for characterization tests / reuse)
    _internal: {
      cleanLines: cleanLines,
      timeLine: timeLine,
      isStatusToken: isStatusToken,
      isCountryHeading: isCountryHeading,
      parseFixtures: parseFixtures,
      parseFixturesDetailed: parseFixturesDetailed,
      parseBetradarFormat1: parseBetradarFormat1,
      parseBetradarFormat2: parseBetradarFormat2,
      detectBetradarFormat: detectBetradarFormat,
      decodeAllAsText: decodeAllAsText,
      loadFixtureSheet: loadFixtureSheet,
      locateColumns: locateColumns,
      classifyRow: classifyRow,
      parseSectionHeader: parseSectionHeader,
      parseFormat2Date: parseFormat2Date,
      parseFormat2Time: parseFormat2Time,
      combineFormat2DateTime: combineFormat2DateTime,
      parseFixtureRow: parseFixtureRow,
      brRowFields: brRowFields,
      formatBetradarDate: formatBetradarDate,
      excelSerialToParts: excelSerialToParts,
      PLAYOFF_RE: PLAYOFF_RE,
      priorityToRows: priorityToRows,
      teamToRows: teamToRows
    }
  };

  window.PLFM_ADAPTER = PLFM_ADAPTER;
})();
