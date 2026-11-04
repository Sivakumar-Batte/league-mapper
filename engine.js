"use strict";
/* =====================================================================
   Fixtures Engine (FXE) - shared, pure logic extracted from
   multi-sport-fixtures-manager.html (MSFM).

   PHASE 2 - ENGINE EXTRACTION. This file is the single source of truth for
   the reusable, side-effect-free helpers. MSFM loads this file and aliases
   these functions back to its existing bare identifiers, so every existing
   MSFM call site keeps working unchanged and there is exactly ONE
   implementation. No DOM access, no module state, no network here.

   Everything is exposed on window.FXE. Function semantics and output formats
   are reproduced verbatim from MSFM to preserve the 380/0 regression baseline.
   ===================================================================== */
(function(){
  var FXE = {};

  /* ---------- sports ---------- */
  var SPORTS = ["Basketball","Ice hockey","Floorball","Waterpolo","Bandy","Field hockey"];
  function sportKey(v){return String(v==null?"":v).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g,"");}
  function canonSport(v){var k=sportKey(v);return SPORTS.find(function(s){return sportKey(s)===k;})||"";}
  function sportIndex(v){var i=SPORTS.indexOf(canonSport(v));return i<0?99:i;}

  /* ---------- league / country normalisation ---------- */
  function leagueKey(v){
    return String(v==null?"":v).normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[\u2010-\u2015]/g,"-").replace(/[\u2018\u2019`\u00b4]/g,"'").trim().replace(/\s+/g," ").toLowerCase();
  }
  var COUNTRY_ALIASES = {
    "czech rep":"czech republic","czech rep.":"czech republic","czechia":"czech republic",
    "usa":"united states","u.s.a.":"united states","united states of america":"united states",
    "uk":"united kingdom","u.k.":"united kingdom","great britain":"united kingdom","england":"united kingdom","scotland":"united kingdom","wales":"united kingdom","northern ireland":"united kingdom",
    "turkiye":"turkey","korea republic":"south korea",
    "bosnia":"bosnia and herzegovina","bosnia and herz.":"bosnia and herzegovina",
    "macedonia":"north macedonia",
    "australia and oceania":"oceania"
  };
  function countryKey(v){
    var k=leagueKey(v).replace(/&/g," and ").replace(/\s+/g," ").trim();
    return COUNTRY_ALIASES[k]||k;
  }

  /* ---------- dates ---------- */
  function parseISODate(s){
    var m=String(s==null?"":s).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!m)return"";
    var d=new Date(Date.UTC(+m[1],+m[2]-1,+m[3]));
    return d.getUTCFullYear()===+m[1]&&d.getUTCMonth()===+m[2]-1&&d.getUTCDate()===+m[3]?s:"";
  }
  function formatDate(value){if(!value)return"";var p=value.split("-");return p[2]+"/"+p[1]+"/"+p[0];}
  function isoFromParts(y,mo,d){
    var dt=new Date(Date.UTC(y,mo-1,d));
    if(dt.getUTCFullYear()!==y||dt.getUTCMonth()!==mo-1||dt.getUTCDate()!==d)return"";
    return y+"-"+String(mo).padStart(2,"0")+"-"+String(d).padStart(2,"0");
  }
  var MONTHS={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  function monthNo(w){return MONTHS[String(w).toLowerCase().slice(0,3)]||0;}
  function fullYear(y){return String(y).length===2?2000+Number(y):Number(y);}
  function dateKey(v){
    var s=String(v==null?"":v).trim().replace(/^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i,"");
    var m=s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?!\d)/);
    if(m){var d=+m[1],mo=+m[2];var y=fullYear(m[3]);if(mo>12&&d<=12){var t=d;d=mo;mo=t;}return isoFromParts(y,mo,d);}
    m=s.match(/^(\d{1,2})[-/. ]+([A-Za-z]{3,9})\.?[-/. ,]+(\d{4}|\d{2})(?!\d)/);
    if(m&&monthNo(m[2]))return isoFromParts(fullYear(m[3]),monthNo(m[2]),+m[1]);
    m=s.match(/^([A-Za-z]{3,9})\.?[-/. ]+(\d{1,2}),?[-/. ]+(\d{4})(?!\d)/);
    if(m&&monthNo(m[1]))return isoFromParts(+m[3],monthNo(m[1]),+m[2]);
    m=s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/);
    if(m)return isoFromParts(+m[1],+m[2],+m[3]);
    m=s.match(/^(\d{5})(?:\.\d+)?$/);
    if(m){var n=+m[1];if(n>20000&&n<80000){var dt=new Date(Date.UTC(1899,11,30)+n*864e5);return dt.toISOString().slice(0,10);}}
    return"";
  }
  function addDaysISO(iso,n){var t=Date.parse(String(iso)+"T00:00:00Z");if(isNaN(t))return"";return new Date(t+n*864e5).toISOString().slice(0,10);}

  /* ---------- team-name normalisation + relation (pure) ---------- */
  var GENERIC_TEAM_TOKENS=new Set(["fc","bc","hc","bk","kk","sk","sc","ac","cd","cf","bbc","fbc","team","club","the","basket","basketball","hockey","ice","ik","if","hk","kd","bsk","bkc"]);
  var QUALIFIER_CANON={w:"w",women:"w",womens:"w",ladies:"w",ii:"2",iii:"3",iv:"4",reserve:"res",reserves:"res",res:"res",junior:"jr",juniors:"jr",jr:"jr",youth:"youth",academy:"academy"};
  function canonToken(x){return QUALIFIER_CANON[x]||x;}
  function isQualifier(x,i){return x==="w"||x==="res"||x==="jr"||x==="youth"||x==="academy"||/^u\d{1,2}$/.test(x)||(i>0&&/^\d{1,2}$/.test(x));}
  function foldText(v){
    return String(v==null?"":v).normalize("NFKD").replace(/[\u0300-\u036f]/g,"")
      .replace(/\u00e6/gi,"ae").replace(/\u0153/gi,"oe").replace(/\u00f8/gi,"o").replace(/\u00df/g,"ss").replace(/\u0111/gi,"d").replace(/\u0142/gi,"l").replace(/\u00fe/gi,"th").replace(/\u0131/g,"i")
      .toLowerCase();
  }
  function teamKey(v){return foldText(v).replace(/&/g," and ").replace(/[^a-z0-9]+/g," ").trim().replace(/\s+/g," ");}
  function qualifierKey(key){
    var t=key.split(" ").filter(Boolean).map(canonToken);
    return t.filter(function(x,i){return isQualifier(x,i);}).sort().join(",");
  }
  function levSim(a,b){
    var m=a.length,n=b.length;if(!m||!n)return 0;
    var prev=Array.from({length:n+1},function(_,i){return i;});
    for(var i=1;i<=m;i++){var cur=[i];for(var j=1;j<=n;j++)cur[j]=Math.min(cur[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));prev=cur;}
    return 1-prev[n]/Math.max(m,n);
  }
  function tokenEq(x,y){return x===y||(Math.min(x.length,y.length)>=6&&levSim(x,y)>=0.85);}
  function coreTokens(key){var t=key.split(" ").filter(Boolean).map(canonToken);var core=t.filter(function(x){return !GENERIC_TEAM_TOKENS.has(x);});return core.length?core:t;}
  function teamRelation(a,b){
    var ka=teamKey(a),kb=teamKey(b);
    if(!ka||!kb)return "none";
    if(ka===kb||ka.replace(/ /g,"")===kb.replace(/ /g,""))return "exact";
    if(qualifierKey(ka)!==qualifierKey(kb))return "none";
    var ca=coreTokens(ka),cb=coreTokens(kb);
    if(ca.join(" ")===cb.join(" "))return "similar";
    var pair=ca.length<=cb.length?[ca,cb]:[cb,ca];var short=pair[0],long=pair[1];
    if(short.join("").length>=4&&short.every(function(t){return long.some(function(u){return tokenEq(t,u);});}))return "similar";
    return "none";
  }
  function timeKey(v){
    var s=String(v==null?"":v).trim();if(!s)return"";
    var m=s.match(/^(\d{1,2})[:.h](\d{2})(?::\d{2})?\s*([ap]m)?$/i);
    if(m){var h=+m[1];var mi=+m[2];var ap=(m[3]||"").toLowerCase();if(ap==="pm"&&h<12)h+=12;if(ap==="am"&&h===12)h=0;if(h>23||mi>59)return"";return String(h).padStart(2,"0")+":"+String(mi).padStart(2,"0");}
    m=s.match(/^0?\.\d+$/);
    if(m){var mins=Math.round(parseFloat(s)*1440)%1440;return String(Math.floor(mins/60)).padStart(2,"0")+":"+String(mins%60).padStart(2,"0");}
    return"";
  }
  function eventIdKey(v){
    var s=String(v==null?"":v).trim().replace(/^'+/,"").replace(/\s+/g,"");
    if(/^\d+(?:\.\d+)?e\+?\d+$/i.test(s)){var n=Number(s);if(Number.isSafeInteger(n))s=String(n);}
    return s.replace(/\.0+$/,"").toLowerCase();
  }

  /* ---------- expose ---------- */
  FXE.GENERIC_TEAM_TOKENS = GENERIC_TEAM_TOKENS;
  FXE.QUALIFIER_CANON = QUALIFIER_CANON;
  FXE.canonToken = canonToken;
  FXE.isQualifier = isQualifier;
  FXE.foldText = foldText;
  FXE.teamKey = teamKey;
  FXE.qualifierKey = qualifierKey;
  FXE.levSim = levSim;
  FXE.tokenEq = tokenEq;
  FXE.coreTokens = coreTokens;
  FXE.teamRelation = teamRelation;
  FXE.timeKey = timeKey;
  FXE.eventIdKey = eventIdKey;

  /* ---------- broad-region fallback helpers (pure) ---------- */
  var REGION_FAMILY = {"world":"world","international":"world","europe":"europe","asia":"asia","africa":"africa","oceania":"oceania",
    "america":"america","americas":"america","north america":"america","south america":"america","central america":"america","latin america":"america"};
  var BROAD_REGIONS = new Set(Object.keys(REGION_FAMILY));
  function isBroadRegion(key){return BROAD_REGIONS.has(key);}
  function regionFamily(key){return REGION_FAMILY[key]||"";}

  /* ---------- priority league matcher (dependencies explicit) ----------
     makeMatcher(sport, mappings) reproduces MSFM's matcher verbatim, except the
     mappings dataset is passed in explicitly instead of read from a module
     global. It snapshots the supplied mappings at creation time (same as MSFM),
     so callers that need current mappings must create a fresh matcher after a
     mappings change - exactly MSFM's existing contract. Returns the same
     matchFixture(fixture) closure and the same {match, all?, reason} results. */
  function makeMatcher(sport, mappings){
    var mapList = Array.isArray(mappings) ? mappings : [];
    var sp=canonSport(sport);
    var sportMappings=mapList.filter(function(m){return canonSport(m.sport)===sp;});
    var usable=sportMappings.filter(function(m){return m.active!==false&&leagueKey(m.flashscoreLeague)!=="";});
    var byLeague=new Map();
    for(var i=0;i<usable.length;i++){var m=usable[i];var k=leagueKey(m.flashscoreLeague);if(!byLeague.has(k))byLeague.set(k,[]);byLeague.get(k).push(m);}
    return function matchFixture(fixture){
      var league=leagueKey(fixture.DetectedLeague),country=countryKey(fixture.Country);
      if(!league)return {match:null,reason:"Could not detect a league heading."};
      var candidates=byLeague.get(league)||[];
      if(!candidates.length){
        var inactive=sportMappings.some(function(m){return m.active===false&&leagueKey(m.flashscoreLeague)===league;});
        var blankForCountry=sportMappings.some(function(m){return countryKey(m.country)===country&&leagueKey(m.flashscoreLeague)==="";});
        return {match:null,reason:inactive?"Mapping exists but is disabled.":blankForCountry?"Mapping has a blank Flashscore League Name; no automatic match was attempted.":"No active mapping for this Flashscore league name."};
      }
      // 1) Exact (alias-aware) country + league name.
      var exact=candidates.filter(function(m){return countryKey(m.country)===country;});
      if(exact.length)return {match:exact[0],all:exact,reason:""};
      // 2) Controlled broad-region fallback within the same region family.
      if(isBroadRegion(country)){
        var fam=regionFamily(country);
        var broad=candidates.filter(function(m){var mk=countryKey(m.country);return isBroadRegion(mk)&&regionFamily(mk)===fam;});
        var regions=new Set(broad.map(function(m){return countryKey(m.country);}));
        if(broad.length&&regions.size===1)return {match:broad[0],all:broad,reason:""};
        if(broad.length>1)return {match:null,reason:"Several broad-region mappings share this league name; add a mapping for this exact region."};
        return {match:null,reason:"League name matches a mapping for another region/country ("+[...new Set(candidates.map(function(m){return m.country;}))].join(", ")+"), not "+fixture.Country+"."};
      }
      return {match:null,reason:"League name matches a mapping for another country/region ("+[...new Set(candidates.map(function(m){return m.country;}))].join(", ")+"), not "+(fixture.Country||"(no country)")+"."};
    };
  }

  FXE.REGION_FAMILY = REGION_FAMILY;
  FXE.BROAD_REGIONS = BROAD_REGIONS;
  FXE.isBroadRegion = isBroadRegion;
  FXE.regionFamily = regionFamily;
  FXE.makeMatcher = makeMatcher;
  FXE.SPORTS = SPORTS;
  FXE.sportKey = sportKey;
  FXE.canonSport = canonSport;
  FXE.sportIndex = sportIndex;
  FXE.leagueKey = leagueKey;
  FXE.COUNTRY_ALIASES = COUNTRY_ALIASES;
  FXE.countryKey = countryKey;
  FXE.parseISODate = parseISODate;
  FXE.formatDate = formatDate;
  FXE.isoFromParts = isoFromParts;
  FXE.MONTHS = MONTHS;
  FXE.monthNo = monthNo;
  FXE.fullYear = fullYear;
  FXE.dateKey = dateKey;
  FXE.addDaysISO = addDaysISO;

  /* ---------- worked-fixture comparison / duplicate classification ----------
     classifyFixtures(fixtures, worked) and its helpers, reproduced verbatim from
     MSFM. All inputs are explicit; nothing reads an MSFM global. Inputs are not
     mutated (prepFixture/prepWorked build new objects that only reference the
     original rows via .raw, and a fresh result object is returned). Return
     structure, statuses, ordering, reason strings and scoring are unchanged. */
  function minutesOf(t){var p=t.split(":").map(Number);return p[0]*60+p[1];}
  function describeShift(from,to){var d=minutesOf(to)-minutesOf(from);var a=Math.abs(d);var txt=(a>=60?Math.floor(a/60)+"h"+(a%60?String(a%60).padStart(2,"0"):""):a+"min");return txt+(d>0?" later":" earlier");}
  function prepWorked(r,i){
    return {raw:r,rowNo:r.rowNo||i+1,sportKey:sportKey(r.Sport),date:dateKey(r.Date),time:timeKey(r.Time),country:countryKey(r.Country),league:leagueKey(r.League),eid:eventIdKey(r["Event ID"])};
  }
  function prepFixture(f,i){
    var leagues2=String(f["Priority League"]==null?"":f["Priority League"]).split(" / ").map(leagueKey).filter(Boolean);
    return {raw:f,idx:i,sportKey:sportKey(f.Sport),date:dateKey(f.Date),time:timeKey(f.Time),country:countryKey(f.Country),league:leagueKey(f["Flashscore League Name"]||f.League),leagues2:leagues2,
      home:f.Home,away:f.Away,eid:eventIdKey(f["Event ID"]||f.EventID)};
  }
  function buildIdGroups(worked){
    var byId=new Map();
    for(var a=0;a<worked.length;a++){var w0=worked[a];if(!w0.eid)continue;if(!byId.has(w0.eid))byId.set(w0.eid,[]);byId.get(w0.eid).push(w0);}
    var groups=new Map();
    byId.forEach(function(rows,id){
      if(rows.length<2)return;
      var fields=[];
      var differs=function(label,fn){if(new Set(rows.map(fn)).size>1)fields.push(label);};
      differs("sport",function(w){return w.sportKey;});differs("date",function(w){return w.date||w.raw.Date;});differs("time",function(w){return w.time||w.raw.Time;});
      differs("country",function(w){return w.country;});differs("league",function(w){return w.league;});
      differs("home team",function(w){return teamKey(w.raw.Home).replace(/ /g,"");});differs("away team",function(w){return teamKey(w.raw.Away).replace(/ /g,"");});
      groups.set(id,{id:id,rows:rows,fields:fields,inconsistent:fields.length>0});
    });
    return groups;
  }
  function evaluateCandidate(fx,w,groups){
    var idSame=!!(fx.eid&&w.eid&&fx.eid===w.eid),idDiff=!!(fx.eid&&w.eid&&fx.eid!==w.eid);
    var sportSame=!!fx.sportKey&&fx.sportKey===w.sportKey,dateSame=!!(fx.date&&w.date&&fx.date===w.date);
    var adjacentDay=!!(fx.date&&w.date&&!dateSame&&(addDaysISO(fx.date,1)===w.date||addDaysISO(fx.date,-1)===w.date));
    var home=teamRelation(fx.home,w.raw.Home),away=teamRelation(fx.away,w.raw.Away);
    var aligned=home!=="none"&&away!=="none";
    var swapped=false;
    if(!aligned){swapped=teamRelation(fx.home,w.raw.Away)!=="none"&&teamRelation(fx.away,w.raw.Home)!=="none";}
    var countryEq=!!(fx.country&&w.country&&fx.country===w.country);
    var leagueEq=!!(w.league&&(w.league===fx.league||fx.leagues2.includes(w.league)));
    var timeBoth=!!(fx.time&&w.time),timeSame=timeBoth&&fx.time===w.time;
    var partial=!aligned&&!swapped&&timeSame&&leagueEq&&(home==="exact"||away==="exact");
    var sameSlot=sportSame&&dateSame&&(aligned||swapped||partial);
    var nearDay=sportSame&&adjacentDay&&!swapped&&home==="exact"&&away==="exact";
    if(!idSame&&!sameSlot&&!nearDay)return null;     // not a candidate at all
    var g=w.eid?groups.get(w.eid):null,groupBad=!!(g&&g.inconsistent);
    var q=function(s){return '"'+s+'"';},pre=idSame?"Same Event ID "+fx.eid+" but ":"";
    var reasons=[];
    if(idSame&&!sportSame)reasons.push("Event ID "+fx.eid+" is recorded in worked history under a different sport ("+q(w.raw.Sport)+" vs collected "+q(fx.raw.Sport)+"); not treated as the same fixture");
    if(idDiff)reasons.push("Matching fixture details but different Event IDs (collected "+fx.eid+" vs worked "+w.eid+")");
    if(swapped)reasons.push("Home and away teams appear swapped (collected "+q(fx.home)+" vs "+q(fx.away)+"; worked "+q(w.raw.Home)+" vs "+q(w.raw.Away)+")");
    else if(idSame){
      if(home!=="exact")reasons.push(pre+"the home-team name differs ("+q(fx.home)+" vs "+q(w.raw.Home)+(home==="similar"?", similar":", unrelated")+")");
      if(away!=="exact")reasons.push(pre+"the away-team name differs ("+q(fx.away)+" vs "+q(w.raw.Away)+(away==="similar"?", similar":", unrelated")+")");
    } else if(partial){
      reasons.push(home==="exact"
        ?"Same league, date and time and the same home team, but the away-team name differs ("+q(fx.away)+" vs "+q(w.raw.Away)+")"
        :"Same league, date and time and the same away team, but the home-team name differs ("+q(fx.home)+" vs "+q(w.raw.Home)+")");
    } else if(home==="similar"||away==="similar"){
      reasons.push("Similar team names and matching fixture details (home: "+q(fx.home)+" vs "+q(w.raw.Home)+" ["+home+"]; away: "+q(fx.away)+" vs "+q(w.raw.Away)+" ["+away+"])");
    }
    if(!dateSame){
      if(idSame)reasons.push(pre+"the date differs (collected "+fx.raw.Date+" vs worked "+(w.raw.Date||"blank")+")");
      else if(nearDay)reasons.push("Same sport and teams on the adjacent date (collected "+fx.raw.Date+" "+fx.raw.Time+" vs worked "+w.raw.Date+" "+w.raw.Time+"); possible midnight or time-zone shift");
    }
    if(!countryEq){reasons.push(fx.country&&w.country?"Matching teams but conflicting country details ("+q(fx.raw.Country)+" vs "+q(w.raw.Country)+")":"Country is missing on "+(w.country?"the collected fixture":"the worked-history row")+", so the match cannot be confirmed");}
    if(!leagueEq){reasons.push(fx.league&&w.league?"Matching teams but conflicting league details (collected "+q(fx.raw["Flashscore League Name"]||fx.raw.League)+" vs worked "+q(w.raw.League)+")":"League is missing on "+(w.league?"the collected fixture":"the worked-history row")+", so the match cannot be confirmed");}
    if(!timeBoth)reasons.push("Time is missing or unreadable (collected "+q(fx.raw.Time||"blank")+", worked "+q(w.raw.Time||"blank")+"); cannot confirm it is the same slot");
    if(groupBad)reasons.push("Multiple worked-history rows with the same Event ID: "+w.eid+" appears on "+g.rows.length+" rows with inconsistent details ("+g.fields.join(", ")+"; rows "+g.rows.map(function(x){return "#"+x.rowNo;}).join(", ")+")");
    var exactTeams=!swapped&&home==="exact"&&away==="exact";
    var cls="possible";
    if(sportSame&&dateSame&&exactTeams&&countryEq&&leagueEq&&!idDiff&&!groupBad&&timeBoth)cls=timeSame?"already":"time";
    var type="",timeDiff=null;
    if(cls==="already")type="Exact match: sport, date, country, league, home/away teams and time"+(idSame?" (Event ID "+fx.eid+" agrees)":w.eid?" (history Event ID "+w.eid+")":"");
    if(cls==="time"){timeDiff={from:w.raw.Time,to:fx.raw.Time,shift:describeShift(w.time,fx.time)};
      reasons.length=0;reasons.push("Same teams and fixture details"+(idSame?" and Event ID "+fx.eid:"")+"; current time "+fx.raw.Time+" differs from worked time "+w.raw.Time+" ("+timeDiff.shift+")");}
    if(cls==="possible"&&!reasons.length)reasons.push("Details match but the record could not be confirmed automatically; please review");
    var score=(idSame?30:0)+(sportSame?10:0)+(dateSame?10:adjacentDay?4:0)+(home==="exact"?10:home==="similar"?5:0)+(away==="exact"?10:away==="similar"?5:0)+(countryEq?5:0)+(leagueEq?5:0)+(timeSame?3:0)-(groupBad?2:0)-(idDiff?20:0);
    return {w:w,cls:cls,reasons:reasons,type:type,timeDiff:timeDiff,score:score,idSame:idSame};
  }
  var CLS_RANK={already:0,time:1,possible:2};
  function classifyFixtures(fixtures,workedRows){
    var worked=(workedRows||[]).map(prepWorked);
    var groups=buildIdGroups(worked);
    var byId=new Map(),bySD=new Map();
    var push=function(m,k,v){if(!m.has(k))m.set(k,[]);m.get(k).push(v);};
    for(var a=0;a<worked.length;a++){var w=worked[a];if(w.eid)push(byId,w.eid,w);if(w.date)push(bySD,w.sportKey+"|"+w.date,w);}
    var seen=new Set(),fxs=[],duplicatesIgnored=0;
    (fixtures||[]).forEach(function(f,i){var p=prepFixture(f,i);
      var k=[p.sportKey,p.date||String(f.Date),p.time||String(f.Time),p.country,p.league,teamKey(f.Home).replace(/ /g,""),teamKey(f.Away).replace(/ /g,""),p.eid].join("|");
      if(seen.has(k)){duplicatesIgnored++;return;}seen.add(k);fxs.push(p);});
    var evals=fxs.map(function(fx){
      var set=new Set();
      if(fx.eid&&byId.has(fx.eid))byId.get(fx.eid).forEach(function(w){set.add(w);});
      if(fx.date){[fx.date,addDaysISO(fx.date,-1),addDaysISO(fx.date,1)].forEach(function(dk){var k=fx.sportKey+"|"+dk;if(bySD.has(k))bySD.get(k).forEach(function(w){set.add(w);});});}
      var cands=[];set.forEach(function(w){var e=evaluateCandidate(fx,w,groups);if(e)cands.push(e);});
      cands.sort(function(x,y){return CLS_RANK[x.cls]-CLS_RANK[y.cls]||y.score-x.score||x.w.rowNo-y.w.rowNo;});
      return {fx:fx,cands:cands,result:null};
    });
    var claimed=new Map();   // worked rowNo -> collected fixture index
    ["already","time"].forEach(function(pass){
      for(var i=0;i<evals.length;i++){
        var ev=evals[i];
        if(ev.result)continue;
        var c=ev.cands.find(function(x){return x.cls===pass&&!claimed.has(x.w.rowNo);});
        if(c){claimed.set(c.w.rowNo,ev.fx.idx);ev.result={kind:pass,c:c};}
      }
    });
    var out={newMatches:[],alreadyWorked:[],possible:[],timeChanged:[],conflicts:[],duplicatesIgnored:duplicatesIgnored,totalCompared:fxs.length,workedRows:worked.length,invalidWorkedDates:worked.filter(function(w){return !w.date;}).length};
    for(var i=0;i<evals.length;i++){
      var ev=evals[i];
      var f=ev.fx.raw;
      if(!ev.result){
        if(!ev.cands.length){out.newMatches.push(f);continue;}
        var top=ev.cands[0];var reasons=top.reasons.slice();
        if(top.cls!=="possible"){
          var other=fxs.find(function(x){return x.idx===claimed.get(top.w.rowNo);});
          reasons.unshift("Worked row #"+top.w.rowNo+" would also match this fixture, but it is already matched to another collected fixture"+(other?" ("+other.raw.Home+" vs "+other.raw.Away+" "+other.raw.Time+")":""));
        }
        out.possible.push({fixture:f,worked:top.w.raw,rowNo:top.w.rowNo,reason:reasons.join("; "),reasons:reasons,otherRows:ev.cands.slice(1,4).map(function(x){return x.w.rowNo;})});
        continue;
      }
      var c=ev.result.c;
      if(ev.result.kind==="already")out.alreadyWorked.push({fixture:f,worked:c.w.raw,rowNo:c.w.rowNo,type:c.type});
      else out.timeChanged.push({fixture:f,worked:c.w.raw,rowNo:c.w.rowNo,reason:c.reasons[0],timeDiff:c.timeDiff});
    }
    groups.forEach(function(g){if(g.inconsistent)out.conflicts.push({id:g.id,eventId:g.rows[0].raw["Event ID"],fields:g.fields,rows:g.rows.map(function(w){return Object.assign({rowNo:w.rowNo},w.raw);})});});
    return out;
  }

  FXE.minutesOf = minutesOf;
  FXE.describeShift = describeShift;
  FXE.prepWorked = prepWorked;
  FXE.prepFixture = prepFixture;
  FXE.buildIdGroups = buildIdGroups;
  FXE.evaluateCandidate = evaluateCandidate;
  FXE.CLS_RANK = CLS_RANK;
  FXE.classifyFixtures = classifyFixtures;

  /* ---------- CSV formatting (pure) ----------
     escapeCSV/buildCSV reproduced verbatim from MSFM. Pure string formatting:
     same formula-injection neutralisation, same quoting (wrap every field in
     double quotes, double embedded quotes), comma field separator, CRLF row
     separator, header row first, then one row per input in order, reading each
     header key off the row object (missing -> ""). No DOM, no encoding/Blob
     concerns - the UTF-8 BOM and download belong to the browser adapter in MSFM. */
  function escapeCSV(value){
    var s=String(value==null?"":value);
    // Neutralise spreadsheet formula injection, but leave plain numbers/times/dates alone.
    if(/^[=+\-@\t\r]/.test(s)&&!/^[-+]?[\d.,:\/\- ]+$/.test(s))s="'"+s;
    return '"'+s.replace(/"/g,'""')+'"';
  }
  function buildCSV(headers,rows){return [headers.map(escapeCSV).join(",")].concat(rows.map(function(row){return headers.map(function(h){return escapeCSV(row[h]);}).join(",");})).join("\r\n");}

  FXE.escapeCSV = escapeCSV;
  FXE.buildCSV = buildCSV;

  window.FXE = FXE;
})();
