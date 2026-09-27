/* =====================================================================
   Basketball BR/BG Shift Automation — V1
   Pipeline: upload BR/BG/Euro Desk → date filter → Euro Desk league filter →
   separate eligible BR and BG lists. Basketball only. No BCM, no matching
   between BR and BG, no fuzzy, no mappings, no auto-creation.
   ===================================================================== */

/* ---------------- shared helpers ---------------- */
function esc(s){ const d=document.createElement('div'); d.textContent=(s==null?'':s); return d.innerHTML; }
function toast(msg,isErr){ const w=document.getElementById('toast-wrap'); const e=document.createElement('div'); e.className='toast'+(isErr?' err':''); e.textContent=msg; w.appendChild(e); setTimeout(()=>{e.style.opacity='0';e.style.transition='opacity .3s';setTimeout(()=>e.remove(),300);},3200); }
function csvSafe(v){ const s=String(v==null?'':v); return /^[=+\-@\t\r]/.test(s) ? "'"+s : s; }
function pad2(n){ n=String(n); return n.length<2?('0'+n):n; }

// Safe normalization for league comparison. Lowercase, trim, collapse spaces,
// normalize dashes/punctuation — but PRESERVE meaningful qualifiers (Women/U23/
// Cup/3x3/Division ...). Never used for fuzzy; only exact-normalized equality.
function normLeague(s){
  let t = String(s==null?'':s);
  t = t.normalize ? t.normalize('NFD').replace(/[\u0300-\u036f]/g,'') : t; // fold accents for compare only
  t = t.toLowerCase();
  t = t.replace(/[\u2013\u2014]/g,'-');            // en/em dash → hyphen
  t = t.replace(/[\u2018\u2019\u02bc`]/g,"'");
  t = t.replace(/\s*-\s*/g,' ');                   // hyphen (with/without spaces) → space (safe: "Chile-LNB"=="Chile LNB")
  t = t.replace(/[.,()]/g,' ');                    // light punctuation → space
  t = t.replace(/[^a-z0-9' ]/g,' ');
  t = t.replace(/\s+/g,' ').replace(/^\s+|\s+$/g,'');
  return t;
}

/* =====================================================================
   BR PARSER — Excel-XML / xls / xlsx (Betradar dump)
   Header rows look like: "Basketball.Denmark.Basketligaen, week 38" and appear
   in a merged cell; fixture rows have Date, KO, Home, Away, Neutral, Match Id.
   We do NOT rely on cell colour — pure structure.
   ===================================================================== */
const BRParser = {
  // Build a case-insensitive header prefix regex from a sport name. Any run of
  // whitespace in the name becomes optional whitespace so "Water Polo" also
  // matches "Waterpolo", and the whole thing is escaped for regex safety.
  _sportPrefix(sport){
    const name = String(sport||'Basketball').trim();
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');   // escape regex metachars
    const flexible = esc.replace(/\s+/g,'\\s*');              // spaces → optional
    return new RegExp('^\\s*'+flexible+'\\s*\\.', 'i');
  },
  // Phase 14 (H1): non-blocking check that the BR column header row names the
  // expected columns at the expected positions used by the positional parser:
  //   0=Date, 2=Home Team, 3=Away Team, 5=Match Id. Returns a warning string if
  // any of those is clearly at a DIFFERENT index, else ''. Only warns when the
  // header actually names the column somewhere (enough info to be sure).
  _checkHeaderOrder(cells){
    const lc = cells.map(c => String(c==null?'':c).toLowerCase().trim());
    const idxOf = (pred) => { for (let i=0;i<lc.length;i++){ if (pred(lc[i])) return i; } return -1; };
    const expected = [
      { name:'Date',      pos:0, i: idxOf(h => h==='date') },
      { name:'Home Team', pos:2, i: idxOf(h => h==='home team' || h==='hometeam') },
      { name:'Away Team', pos:3, i: idxOf(h => h==='away team' || h==='awayteam') },
      { name:'Match Id',  pos:5, i: idxOf(h => h==='match id' || h==='matchid') }
    ];
    const off = expected.filter(e => e.i !== -1 && e.i !== e.pos);
    if (!off.length) return '';
    return 'BR column order differs from expected (Date,KO,Home,Away,Neutral,Match Id): '
      + off.map(e => `"${e.name}" at column ${e.i+1}, expected ${e.pos+1}`).join('; ')
      + '. The parser reads columns by position — verify the file layout before trusting BR results.';
  },

  parse(rows, dateCtx, sport){
    // rows = array of arrays (sheet_to_json header:1)
    // dateCtx = selected date window { start, end, yearHint } (or a legacy year Number).
    sport = sport || 'Basketball';
    // Header rows look like "<Sport>.Country.League, week NN". Build a flexible
    // prefix from the sport name so ANY sport works (Basketball, Ice Hockey,
    // Bandy, Curling, Floorball, Hockey, Rink Hockey, Water Polo ...). Spaces in
    // the sport name are made optional (e.g. "Water Polo." or "Waterpolo.",
    // "Ice Hockey." or "Icehockey.").
    const sportPrefix = this._sportPrefix(sport);
    const out = { matches: [], malformed: [], totalRows: 0 };
    let curComp='', curCountry='', curLeague='', curWeek='';
    // find header row index (row containing "Home Team" & "Match Id")
    let started = false;
    for (let i=0;i<rows.length;i++){
      const row = rows[i] || [];
      const cells = row.map(c => String(c==null?'':c).trim());
      const joined = cells.join(' ').trim();
      out.totalRows++;
      const lower = joined.toLowerCase();

      // Column header row — skip it, mark started.
      if (!started && lower.indexOf('home team')!==-1 && lower.indexOf('match id')!==-1){
        started=true;
        // Phase 14 (H1): non-blocking column-order sanity check. The positional
        // parser expects Date,KO,Home,Away,Neutral,Match Id at indices 0..5.
        // If the header row names those columns at DIFFERENT positions, warn.
        out.headerOrderWarning = this._checkHeaderOrder(cells);
        continue;
      }

      if (joined==='') continue;

      // Competition header: a single meaningful cell like "Basketball.Country.League, week NN"
      // Heuristic: contains "basketball." and no separate KO/MatchId columns filled.
      const nonEmpty = cells.filter(c=>c!=='');
      const looksHeader = sportPrefix.test(joined) && nonEmpty.length <= 2;
      if (looksHeader){
        const h = this.parseHeader(joined);
        curComp=h.raw; curCountry=h.country; curLeague=h.league; curWeek=h.week;
        continue;
      }

      // Otherwise treat as a fixture row (needs at least Home/Away).
      // Column order from spec: Date, KO, Home, Away, Neutral, Match Id
      const date=cells[0]||'', ko=cells[1]||'', home=cells[2]||'', away=cells[3]||'', neutral=cells[4]||'', matchId=cells[5]||'';
      // K1: the ORIGINAL (pre-stringify) Date cell, so a genuine Excel serial can
      // be detected. Only the Date column's raw value is needed.
      const rawDate = row[0];
      if (!home && !away && !matchId) continue; // blank/decorative row

      const rec = {
        source:'BR', sport:sport,
        competitionRaw:curComp, competitionName:curLeague, country:curCountry, week:curWeek,
        dateRaw:date, koRaw:ko, eventDate:'', eventTime:ko,
        homeTeam:home, awayTeam:away, neutralGround:neutral, brMatchId:matchId,
        sourceRowNumber:i+1, parseStatus:'Parsed', parseWarning:''
      };
      if (!curLeague){ rec.parseStatus='Malformed'; rec.parseWarning='Fixture before any competition header'; out.malformed.push(rec); continue; }
      if (!home || !away){ rec.parseStatus='Malformed'; rec.parseWarning='Missing home/away team'; out.malformed.push(rec); continue; }
      const d = this.parseDate(date, dateCtx, rawDate);
      // Phase 14 (F1): impossible calendar date → malformed (never reaches lookup).
      if (d && typeof d === 'object' && d.invalid){
        rec.parseStatus='Malformed'; rec.parseWarning='Invalid calendar date: '+(date||String(rawDate)); out.malformed.push(rec); continue;
      }
      // A year-less dd/mm that couldn't be safely placed in the window returns
      // an { ambiguous:true, reason } sentinel — surface it as a parsing issue
      // rather than inventing a year.
      if (d && typeof d === 'object' && d.ambiguous){
        rec.parseStatus='Malformed'; rec.parseWarning='Ambiguous date "'+date+'": '+d.reason; out.malformed.push(rec); continue;
      }
      if (!d){ rec.parseStatus='Malformed'; rec.parseWarning='Unparseable date: '+date; out.malformed.push(rec); continue; }
      rec.eventDate = d;
      out.matches.push(rec);
    }
    if (!started) out.headerMissing = true;
    return out;
  },
  // "Basketball.Denmark.Basketligaen, week 38" → {country, league, week, raw}
  parseHeader(text){
    const raw = text.replace(/\s+/g,' ').trim();
    let week=''; const wm = raw.match(/week\s+(\d+)/i); if (wm) week=wm[1];
    let core = raw.replace(/,?\s*week\s+\d+.*$/i,'').trim();
    const parts = core.split('.').map(s=>s.trim()).filter(Boolean);
    // parts[0]=Basketball, parts[1]=Country, parts[2..]=League (league may contain dots rarely)
    let country='', league='';
    if (parts.length>=3){ country=parts[1]; league=parts.slice(2).join('.'); }
    else if (parts.length===2){ country=parts[1]; league=parts[1]; }
    else { league=core; }
    return { raw:core, country, league, week };
  },
  // BR date parser.
  // `ctx` may be either:
  //   • a number  → legacy single-year hint (kept for backward compatibility), or
  //   • an object { start:'YYYY-MM-DD', end:'YYYY-MM-DD', yearHint:Number }
  //     → the selected date window, used to resolve year-less dd/mm dates.
  //
  // Return value is normally 'YYYY-MM-DD'. For a dd/mm value that has NO explicit
  // year AND cannot be placed inside (or adjacent to) the selected window with a
  // single unambiguous year, we return the sentinel object
  //   { ambiguous:true, reason:'...' }
  // so the caller can mark the fixture as a parsing issue instead of silently
  // inventing a year. Dates WITH an explicit year are never treated as ambiguous.
  // Phase 14 (F1): real calendar validation. Returns true only if (y,mo,d) is a
  // genuine calendar date (correct days-in-month incl. Gregorian leap years).
  // Does NOT use JS Date normalization (which would silently roll Feb 31 → Mar).
  _isRealDate(y, mo, d){
    if (!(y>=1 && mo>=1 && mo<=12 && d>=1)) return false;
    const leap = (y%4===0 && y%100!==0) || (y%400===0);
    const dim = [31, leap?29:28, 31,30,31,30,31,31,30,31,30,31];
    return d <= dim[mo-1];
  },
  // Phase 14 (K1): Excel 1900 serial → {y,mo,d} using the SAME epoch as BGParser
  // (1899-12-30, UTC parts, rounded to whole days for the date). Date-only here
  // (BR uses a separate KO column). No timezone shift.
  _excelSerialToYMD(serial){
    if (!isFinite(serial)) return null;
    const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
    const dt = new Date(EXCEL_EPOCH + Math.round(serial) * 24*60*60*1000);
    if (isNaN(dt)) return null;
    return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth()+1, d: dt.getUTCDate() };
  },

  // BR date parser.
  // `ctx` may be either:
  //   • a number  → legacy single-year hint (kept for backward compatibility), or
  //   • an object { start:'YYYY-MM-DD', end:'YYYY-MM-DD', yearHint:Number }
  //     → the selected date window, used to resolve year-less dd/mm dates.
  //
  // `raw` (optional) is the ORIGINAL Date cell value before stringification, used
  // to detect a genuine Excel numeric date serial (K1).
  //
  // Return: 'YYYY-MM-DD' on success; { ambiguous:true } for an unresolvable
  // year-less date; { invalid:true } for an impossible calendar date (F1);
  // '' when the value is unparseable. Explicit years are never "ambiguous".
  parseDate(dateStr, ctx, raw){
    // K1: genuine Excel serial number in the Date cell (only when the raw cell
    // is actually a number in a plausible Excel-serial window — never treat an
    // arbitrary numeric string like "38" as a date).
    if (typeof raw === 'number' && isFinite(raw) && raw > 20000 && raw < 80000){
      const p = this._excelSerialToYMD(raw);
      if (!p || !this._isRealDate(p.y, p.mo, p.d)) return { invalid:true };
      return `${p.y}-${pad2(String(p.mo))}-${pad2(String(p.d))}`;
    }

    const s=String(dateStr||'').trim();

    // Explicit years always win (dd/mm yy and dd/mm/yyyy) — now calendar-validated.
    let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})\s+(\d{2,4})$/);   // dd/mm yy
    if (m){ let y=parseInt(m[3],10); if(y<100)y+=2000; const d=+m[1],mo=+m[2];
      if (!this._isRealDate(y,mo,d)) return { invalid:true };
      return `${y}-${pad2(m[2])}-${pad2(m[1])}`; }
    m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);    // dd/mm/yyyy
    if (m){ let y=parseInt(m[3],10); if(y<100)y+=2000; const d=+m[1],mo=+m[2];
      if (!this._isRealDate(y,mo,d)) return { invalid:true };
      return `${y}-${pad2(m[2])}-${pad2(m[1])}`; }

    // Year-less dd/mm — resolve the year from the window, then calendar-validate.
    m = s.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
    if (m){
      const dd = pad2(m[1]), mm = pad2(m[2]);
      return this._resolveYearlessDate(dd, mm, ctx);
    }
    return '';
  },

  // Resolve a dd/mm (no year) against the selected window.
  // Strategy (window-driven, NOT month hard-coding):
  //   Consider candidate full dates using the window's start year and the year
  //   after it (covers a Dec→Jan window that spans two calendar years). Pick the
  //   candidate that lies INSIDE [window.start, window.end] inclusive. If none is
  //   inside the window, fall back to the candidate CLOSEST to the window (so a
  //   normal "outside date range" fixture still parses and is bucketed as
  //   Outside, exactly as before) — UNLESS both candidate years are equally far
  //   and genuinely ambiguous, in which case we surface it as a parsing issue.
  _resolveYearlessDate(dd, mm, ctx){
    // Backward-compatible: a bare number hint behaves like the old code path.
    if (typeof ctx === 'number' && isFinite(ctx)){
      return `${ctx}-${mm}-${dd}`;
    }
    if (!ctx || !ctx.start || !ctx.end){
      // No window available — cannot safely resolve. Surface as ambiguous.
      return { ambiguous:true, reason:'No date window available to resolve year for '+dd+'/'+mm };
    }
    const startYear = parseInt(String(ctx.start).slice(0,4),10);
    // Phase 14 (F1): if the day/month is impossible for BOTH candidate years,
    // it's an impossible calendar date regardless of window → malformed.
    // (Feb 29 is validated per-year below so a valid leap-year candidate survives.)
    const dNum = parseInt(dd,10), moNum = parseInt(mm,10);
    if (!this._isRealDate(startYear, moNum, dNum) && !this._isRealDate(startYear+1, moNum, dNum)){
      return { invalid:true };
    }
    // Candidate years: window start year and the next year (handles Dec→Jan spans).
    // Only keep years where the date is a real calendar date (drops non-leap Feb 29).
    const candidates = [startYear, startYear+1]
      .filter(y => this._isRealDate(y, moNum, dNum))
      .map(y => `${y}-${mm}-${dd}`);
    if (!candidates.length) return { invalid:true };
    // 1) Prefer a candidate that falls inside the window (inclusive).
    const inside = candidates.filter(c => c >= ctx.start && c <= ctx.end);
    if (inside.length === 1) return inside[0];
    if (inside.length > 1){
      // Two candidates inside the same window would require a >365-day window,
      // which these checks never produce; treat as ambiguous defensively.
      return { ambiguous:true, reason:'dd/mm '+dd+'/'+mm+' matches multiple years in the window' };
    }
    // 2) None inside the window — choose the candidate closest to the window so
    //    the fixture still parses and is correctly bucketed as "Outside Date".
    const dist = (c) => {
      if (c < ctx.start) return this._dayDiff(c, ctx.start);
      return this._dayDiff(ctx.end, c);
    };
    // If only one candidate survived calendar filtering (e.g. Feb 29 valid in
    // exactly one of the two years), return it directly.
    if (candidates.length === 1) return candidates[0];
    const d0 = dist(candidates[0]), d1 = dist(candidates[1]);
    if (d0 === d1){
      // Genuinely equidistant → do not invent a year.
      return { ambiguous:true, reason:'dd/mm '+dd+'/'+mm+' is equally distant from both candidate years' };
    }
    return d0 < d1 ? candidates[0] : candidates[1];
  },
  // Whole-day difference between two 'YYYY-MM-DD' strings (absolute).
  _dayDiff(a, b){
    const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
    const da = Date.UTC(pa[0], pa[1]-1, pa[2]), db = Date.UTC(pb[0], pb[1]-1, pb[2]);
    return Math.abs(Math.round((db-da)/86400000));
  }
};

/* =====================================================================
   BG PARSER — CSV / xlsx (Betgenius dump)
   Columns: Competition, EventId, Event ("Home v Away"), Start (UTC+2), Feed,
   Booking Status, OST
   ===================================================================== */
const BGParser = {
  parse(objRows){
    const out = { matches: [], malformed: [], totalRows: 0 };
    objRows.forEach((row,i)=>{
      out.totalRows++;
      const comp = String(row['Competition']||row['competition']||'').trim();
      const eventId = String(row['EventId']||row['Event Id']||row['eventid']||'').trim();
      const ev = String(row['Event']||row['event']||'').trim();
      // Capture the RAW Start value BEFORE stringifying — it may be an Excel
      // serial NUMBER (xlsx) or a JS Date, not just a string (csv).
      const startRawVal = (row['Start (UTC+2)'] !== undefined && row['Start (UTC+2)'] !== '') ? row['Start (UTC+2)']
        : (row['Start (UTC)'] !== undefined && row['Start (UTC)'] !== '') ? row['Start (UTC)']
        : (row['Start'] !== undefined && row['Start'] !== '') ? row['Start']
        : (row['start (utc+2)'] !== undefined ? row['start (utc+2)'] : '');
      const feed = String(row['Feed']||row['feed']||'').trim();
      const booking = String(row['Booking Status']||row['booking status']||'').trim();
      const ost = String(row['OST']||row['ost']||row['Column1']||'').trim();

      const rec = {
        source:'BG', sport:'Basketball',
        competitionRaw:comp, eventId, eventRaw:ev, homeTeam:'', awayTeam:'',
        startRaw:startRawVal, startDisplay:'', startType:'', eventDate:'', eventTime:'',
        feed, bookingStatus:booking, ost,
        sourceRowNumber:i+2, parseStatus:'Parsed', parseWarning:''  // +2: header + 1-based
      };
      if (!comp){ rec.parseStatus='Malformed'; rec.parseWarning='Missing competition'; out.malformed.push(rec); return; }
      if (!eventId){ rec.parseStatus='Malformed'; rec.parseWarning='Missing EventId'; out.malformed.push(rec); return; }
      // Split "Home v Away" (space-v-space). Guard names containing " v ".
      const parts = ev.split(/\s+v\s+/i);
      if (parts.length!==2 || !parts[0].trim() || !parts[1].trim()){
        rec.parseStatus='Malformed'; rec.parseWarning='Cannot split event into two teams: '+ev; out.malformed.push(rec); return;
      }
      rec.homeTeam=parts[0].trim(); rec.awayTeam=parts[1].trim();
      const d = this.parseStart(startRawVal);
      rec.startType = d ? d.type : 'Invalid';
      if (!d){ rec.parseStatus='Malformed'; rec.parseWarning='Unparseable start: '+String(startRawVal); out.malformed.push(rec); return; }
      rec.eventDate = d.date; rec.eventTime = d.time; rec.startDisplay = d.display;
      out.matches.push(rec);
    });
    return out;
  },

  // Excel 1900 date system: serial 1 = 1900-01-01 (with the 1900 leap bug), so
  // the epoch anchor is 1899-12-30. Reading UTC parts keeps the wall-clock value
  // exactly as authored (the BG column is UTC+2; we do NOT re-shift it).
  excelSerialToDate(serial){
    if (!isFinite(serial)) return null;
    const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
    return new Date(EXCEL_EPOCH + Math.round(serial * 24 * 60 * 60 * 1000)); // round to whole ms → avoids 01:59:59
  },

  // Accepts: Excel serial number | JS Date | date string (ISO / DD-MM-YYYY /
  // DD/MM/YYYY). Returns {date:'YYYY-MM-DD', time:'HH:MM', display, type} or null.
  parseStart(val){
    // 1) JS Date object (SheetJS with cellDates:true, or already a Date).
    if (val instanceof Date && !isNaN(val)){
      return this._fromDate(val, 'JavaScript Date');
    }
    // 2) Excel serial NUMBER (or a numeric string that is clearly a serial).
    let num = null;
    if (typeof val === 'number' && isFinite(val)) num = val;
    else if (typeof val === 'string' && /^\d+(\.\d+)?$/.test(val.trim())) num = parseFloat(val.trim());
    // Plausible Excel serial window (~1970..2100) so we never misread a year like "2026".
    if (num !== null && num > 20000 && num < 80000){
      const dt = this.excelSerialToDate(num);
      if (dt && !isNaN(dt)) return this._fromDate(dt, 'Excel Serial');
    }
    // 3) Date string.
    const s = String(val==null?'':val).trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T]+(\d{1,2}):(\d{2})/);   // ISO
    if (m) return this._pack(m[1], m[2], m[3], m[4], m[5], 'Date String');
    m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})[ T]+(\d{1,2}):(\d{2})/);       // DD-MM-YYYY
    if (m) return this._pack(m[3], m[2], m[1], m[4], m[5], 'Date String');
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T]+(\d{1,2}):(\d{2})/);     // DD/MM/YYYY
    if (m) return this._pack(m[3], m[2], m[1], m[4], m[5], 'Date String');
    return null;
  },
  _fromDate(dt, type){
    // Read UTC parts (we built the Date from a UTC epoch; no local shift).
    const y=dt.getUTCFullYear(), mo=dt.getUTCMonth()+1, d=dt.getUTCDate(), h=dt.getUTCHours(), mi=dt.getUTCMinutes();
    return this._pack(y, mo, d, h, mi, type);
  },
  _pack(y, mo, d, h, mi, type){
    const date = `${y}-${pad2(mo)}-${pad2(d)}`;
    const time = `${pad2(h)}:${pad2(mi)}`;
    const display = `${pad2(d)}-${pad2(mo)}-${y} ${time}`;   // DD-MM-YYYY HH:MM (UTC+2 wall clock)
    return { date, time, display, type };
  }
};

/* =====================================================================
   EURO DESK PARSER — Basketball sheet only. Reads League + Betradar columns.
   Red-highlighted rows → disregarded (best-effort colour read + explicit list).
   ===================================================================== */
const EuroDeskParser = {
  // sheetMatch: optional RegExp to pick the sport's sheet (defaults to Basketball).
  parse(workbook, sheetMatch){
    const out = { leagues: [], colourReadable:false, warning:'' };
    const matcher = sheetMatch || /basket/i;
    let sheetName = workbook.SheetNames.find(n=>matcher.test(n)) || workbook.SheetNames[0];
    const ws = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header:1, defval:'' });
    if (!rows.length){ out.warning='Euro Desk sheet is empty'; return out; }
    let hIdx = rows.findIndex(r => r.map(c=>String(c).toLowerCase().trim()).includes('league'));
    if (hIdx===-1) hIdx = 0;
    const header = rows[hIdx].map(c=>String(c).trim());
    const col = (name)=> header.findIndex(h=>h.toLowerCase().trim()===name.toLowerCase());
    const leagueCol = col('League');
    const betradarCol = col('Betradar');
    const regionCol = col('Region');
    const sportCol = col('Sport');
    if (leagueCol===-1){ out.warning='Euro Desk sheet is missing a "League" column'; return out; }

    for (let i=hIdx+1;i<rows.length;i++){
      const r = rows[i]||[];
      const league = String(r[leagueCol]||'').trim();
      if (!league) continue;
      const betradar = betradarCol>=0 ? String(r[betradarCol]||'').trim() : '';
      const region = regionCol>=0 ? String(r[regionCol]||'').trim() : '';
      const sport = sportCol>=0 ? String(r[sportCol]||'').trim() : '';
      // Best-effort red-fill detection on the League cell (needs a workbook read
      // with cellStyles; falls back to false when colour isn't available).
      const disregarded = this._isRed(ws, i, leagueCol);
      if (disregarded) out.colourReadable = true;
      out.leagues.push({ league, betradar, region, sport, row:i+1, disregarded,
        keyLeague:normLeague(league), keyBetradar:betradar?normLeague(betradar):'', keySport:sport?normLeague(sport):'' });
    }
    out.sheetName = sheetName;
    return out;
  },
  // Build the same {leagues,...} output from an in-memory 4-column grid
  // (Sport, Region, League, Provider Name) instead of a workbook. Used by the
  // "Use Saved Data" option. providerRole decides whether the Provider Name maps
  // to the Betradar alias ('br') or is just the BG competition name ('bg') — in
  // both cases we index it as keyBetradar so the existing _edLookup matches it.
  fromRows(rows){
    const out = { leagues: [], colourReadable:false, warning:'', sheetName:'(saved data)' };
    if (!rows || !rows.length){ out.warning='Saved Euro Desk list is empty'; return out; }
    for (let i=0;i<rows.length;i++){
      const r = rows[i] || {};
      const league = String(r.league||'').trim();
      if (!league) continue;                       // skip blank rows
      const region = String(r.region||'').trim();
      const sport = String(r.sport||'').trim();
      const provider = String(r.providerName||'').trim();
      out.leagues.push({ league, betradar:provider, region, sport, row:i+1, disregarded:false,
        keyLeague:normLeague(league), keyBetradar:provider?normLeague(provider):'', keySport:sport?normLeague(sport):'' });
    }
    if (!out.leagues.length) out.warning='Saved Euro Desk list has no rows with a League value';
    return out;
  },

  // Detect duplicate normalized keys in a parsed Euro Desk list. This does NOT
  // change or dedupe records — matching stays first-row-wins. It only reports
  // groups so the user can review them. Returns an array of duplicate groups:
  //   { keyType:'League'|'Betradar', key, count, rows:[...],
  //     leagues:[...], providers:[...], sportDiffers, regionDiffers, disregardedDiffers }
  findDuplicates(leagues){
    const groups = [];
    if (!leagues || !leagues.length) return groups;
    const collect = (keyType, keyField) => {
      const byKey = {};
      for (let i=0;i<leagues.length;i++){
        const L = leagues[i];
        const k = L[keyField];
        if (!k) continue;                 // skip empty keys (e.g. blank provider)
        (byKey[k] = byKey[k] || []).push(L);
      }
      for (const k in byKey){
        const arr = byKey[k];
        if (arr.length < 2) continue;     // only duplicates
        const uniq = a => { const s={}; const o=[]; a.forEach(v=>{ const t=String(v==null?'':v); if(!s[t.toLowerCase()]){s[t.toLowerCase()]=1;o.push(t);} }); return o; };
        const sports = uniq(arr.map(x=>x.sport));
        const regions = uniq(arr.map(x=>x.region));
        const disr = uniq(arr.map(x=>x.disregarded?'yes':'no'));
        groups.push({
          keyType, key:k, count:arr.length,
          rows: arr.map(x=>x.row),
          leagues: uniq(arr.map(x=>x.league)),
          providers: uniq(arr.map(x=>x.betradar)),
          sportDiffers: sports.length>1,
          regionDiffers: regions.length>1,
          disregardedDiffers: disr.length>1
        });
      }
    };
    collect('League','keyLeague');
    collect('Betradar','keyBetradar');   // keyBetradar is '' when provider blank → skipped above
    return groups;
  },

  // Detect rows whose non-blank Sport differs from the context sport (normalized
  // with the SAME normLeague used everywhere). DETECTION ONLY — never mutates a
  // record, never changes matching/filtering. Blank Sport is NOT a mismatch.
  // Returns [{ row, sport, league, provider }] for each mismatched row.
  findSportMismatches(leagues, contextSport){
    const out = [];
    if (!leagues || !leagues.length) return out;
    const ctxKey = normLeague(contextSport||'');
    for (let i=0;i<leagues.length;i++){
      const L = leagues[i];
      if (!L.keySport) continue;              // blank Sport → not a mismatch
      if (L.keySport !== ctxKey){
        out.push({ row:L.row, sport:L.sport, league:L.league, provider:L.betradar||'' });
      }
    }
    return out;
  },

  // Read the fill colour of a cell (SheetJS style info, when present). Returns
  // true only when the fill is clearly a red shade. Best-effort — many exports
  // don't carry style info, in which case nothing is auto-excluded.
  _isRed(ws, r, c){
    try {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (!cell || !cell.s || !cell.s.fgColor) return false;
      const rgb = (cell.s.fgColor.rgb || '').toUpperCase();
      if (!rgb || rgb.length < 6) return false;
      const R = parseInt(rgb.slice(-6,-4),16), G = parseInt(rgb.slice(-4,-2),16), B = parseInt(rgb.slice(-2),16);
      return R >= 150 && G <= 110 && B <= 110;   // clearly red-dominant fill
    } catch(e){ return false; }
  }
};

/* =====================================================================
   V1 CONTROLLER
   ===================================================================== */
const V1 = {
  sport: 'Basketball',
  minorSport: 'Bandy',
  checkType: '3day',
  files: { br:null, bg:null, edbr:null, edbg:null, ihbr:null, ihed:null, msbr:null, msed:null },
  parsed: { br:null, bg:null, edbr:null, edbg:null, ihbr:null, ihed:null, msbr:null, msed:null },
  // Per-Euro-Desk-sheet input source: 'file' (upload) or 'grid' (saved data).
  edSource: { edbr:'file', edbg:'file', ihed:'file', msed:'file' },
  // In-memory grid rows for each Euro Desk key: [{sport,region,league,providerName}].
  edGrid: { edbr:[], edbg:[], ihed:[], msed:[] },
  edLoaded: {},   // which grids have been loaded from Supabase this session
  _edBusy: {},    // in-flight guard per grid key+action to block overlapping load/save
  // Phase 4 data-integrity state, per grid key:
  edBaseline: {}, // serialized snapshot of the last loaded/saved clean grid state
  edVersion: {},  // persisted row version (updated_at) captured at load/save, or null
  range: null,        // { start:'YYYY-MM-DD', end:'YYYY-MM-DD', label:'' }
  results: null,
  resultTab: 'br',

  init(){
    const d = new Date();
    document.getElementById('ref-today').value = `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
    this.recalcRange();
  },

  // Phase 12: single, consistent way to invalidate a previous run so stale
  // results can never be viewed or exported after inputs change. This ONLY
  // touches result presentation state — it does NOT modify uploaded files,
  // parsed data, Euro Desk saved data, matching logic, or export scope.
  _invalidateResults(){
    this.results = null;                 // export guards key off this
    const res = document.getElementById('results'); if (res) res.style.display='none';
    const rt = document.getElementById('result-tabs'); if (rt) rt.innerHTML='';
    const rb = document.getElementById('result-body'); if (rb) rb.innerHTML='';
    const btn = document.getElementById('btn-run'); if (btn) btn.disabled = true;   // require Validate again
  },

  setSport(sp){
    this.sport = sp;
    document.getElementById('sp-bk').classList.toggle('active', sp==='Basketball');
    document.getElementById('sp-ih').classList.toggle('active', sp==='Ice Hockey');
    document.getElementById('sp-ms').classList.toggle('active', sp==='Minor Sports');
    const isBk = sp==='Basketball', isIh = sp==='Ice Hockey', isMs = sp==='Minor Sports';
    document.getElementById('uploads-basketball').style.display = isBk ? '' : 'none';
    document.getElementById('uploads-icehockey').style.display = isIh ? '' : 'none';
    document.getElementById('uploads-minor').style.display = isMs ? '' : 'none';
    // Minor Sports: show the minor-sport picker; 3-Day only (hide 10th-Day).
    document.getElementById('minor-sport-wrap').style.display = isMs ? '' : 'none';
    document.getElementById('ct-10th').style.display = isMs ? 'none' : '';
    document.getElementById('ms-check-note').style.display = isMs ? '' : 'none';
    if (isMs && this.checkType!=='3day') this.setCheck('3day');
    // Reset results + run gate when switching sport so counts never mix.
    this._invalidateResults();
    document.getElementById('validation-msg').innerHTML='';   // prior validation no longer current
  },
  setMinorSport(ms){
    const prevMinor = this.minorSport;   // captured for dirty-guard revert below
    this.minorSport = ms;
    [['ms-bandy','Bandy'],['ms-curling','Curling'],['ms-floorball','Floorball'],['ms-hockey','Hockey'],['ms-rinkhockey','Rink Hockey'],['ms-waterpolo','Water Polo']]
      .forEach(([id,name])=>{ const b=document.getElementById(id); if(b) b.classList.toggle('active', name===ms); });
    // Changing the minor sport invalidates the last run (different sport filter).
    this._invalidateResults();
    // If the Minor Sports Euro Desk grid is open, reload it for the new sport.
    // Guard: switching minor sport replaces the grid, so confirm before
    // discarding unsaved edits. If the user cancels, keep the current grid AND
    // revert the sport selection so the grid still matches the active sport.
    if (this.edSource.msed === 'grid'){
      if (!this._confirmDiscardIfDirty('msed')){
        // Revert the sport toggle + selection to the previous value.
        this.minorSport = prevMinor;
        [['ms-bandy','Bandy'],['ms-curling','Curling'],['ms-floorball','Floorball'],['ms-hockey','Hockey'],['ms-rinkhockey','Rink Hockey'],['ms-waterpolo','Water Polo']]
          .forEach(([id,name])=>{ const b=document.getElementById(id); if(b) b.classList.toggle('active', name===prevMinor); });
        return;
      }
      this.edLoaded.msed = false; this.parsed.msed = null; this.loadEdGrid('msed');
    }
  },
  setCheck(t){
    this.checkType=t;
    document.getElementById('ct-3day').classList.toggle('active', t==='3day');
    document.getElementById('ct-10th').classList.toggle('active', t==='10th');
    this.recalcRange();
  },
  _fmt(d){ return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; },
  _human(d){ return d.toLocaleDateString(undefined,{day:'2-digit',month:'short',year:'numeric'}); },
  recalcRange(){
    const base = document.getElementById('ref-today').value;
    if (!base){ return; }
    const [y,m,dd] = base.split('-').map(Number);
    const today = new Date(y, m-1, dd);
    let start, end, label;
    if (this.checkType==='3day'){
      start = new Date(today); start.setDate(start.getDate()+1);
      end   = new Date(today); end.setDate(end.getDate()+3);
      label = `3-Day Check: ${this._human(start)} to ${this._human(end)} (inclusive)`;
    } else {
      start = new Date(today); start.setDate(start.getDate()+10);
      end   = new Date(start);
      label = `10th-Day Check: ${this._human(start)} only`;
    }
    this.range = { start:this._fmt(start), end:this._fmt(end), label };
    document.getElementById('daterange').innerHTML =
      `Today: <b>${this._human(today)}</b> &nbsp;·&nbsp; ${label} &nbsp; <span style="color:var(--text-faint);font-family:var(--font-mono);">[${this.range.start} … ${this.range.end}]</span>`;
    this._yearHint = start.getFullYear();
    // Window context passed to BRParser.parseDate so year-less dd/mm BR dates are
    // resolved against the actual selected window (fixes the Dec→Jan boundary bug).
    this._dateCtx = { start:this.range.start, end:this.range.end, yearHint:this._yearHint };
    // Phase 12: a changed date window invalidates any previous run and requires
    // Validate again before Run (eliminates the year-less BR date ambiguity).
    // The BR date algorithm itself is unchanged — this only gates the workflow.
    this._invalidateResults();
  },

  async onFile(kind, input){
    const f = input.files[0];
    const el = document.getElementById('fstat-'+kind);
    if (!f){ this.files[kind]=null; el.className='fstat pending'; el.textContent='No file selected.'; return; }
    this.files[kind]=f; this.parsed[kind]=null;
    el.className='fstat pending'; el.textContent='Loaded: '+f.name+' (validate to parse)';
    // Phase 12: a new file invalidates the previous run (keeps the file itself).
    this._invalidateResults();
  },

  /* ---------------- Euro Desk saved-data grid ---------------- */
  // Resolve the (sport, sheetType, providerLabel) config for a grid key from the
  // data-* attributes on its wrapper. Sport can be dynamic for Minor Sports.
  _edCfg(key){
    const wrap = document.getElementById('edwrap-'+key+'-grid');
    if (!wrap) return null;
    let sport = wrap.getAttribute('data-ed-sport') || '';
    if (wrap.getAttribute('data-ed-sport-dynamic') === 'minor') sport = this.minorSport;
    return { sport, sheet: wrap.getAttribute('data-ed-sheet') || 'br', provLabel: wrap.getAttribute('data-ed-provlabel') || 'Provider Name' };
  },

  setEdSource(key, mode){
    this.edSource[key] = mode;
    document.getElementById('edsrc-'+key+'-file').classList.toggle('active', mode==='file');
    document.getElementById('edsrc-'+key+'-grid').classList.toggle('active', mode==='grid');
    document.getElementById('edwrap-'+key+'-file').style.display = mode==='file' ? '' : 'none';
    document.getElementById('edwrap-'+key+'-grid').style.display = mode==='grid' ? '' : 'none';
    this.parsed[key] = null;                       // switching source invalidates prior parse
    this._invalidateResults();                     // Phase 12: prior run no longer current
    if (mode==='grid'){
      this._renderEdGrid(key);                         // also refreshes the indicator
      if (!this.edLoaded[key]) this.loadEdGrid(key);   // auto-load saved data on first open
    } else {
      this._refreshUnsavedIndicator(key);              // source=file → hide indicator
    }
  },

  /* ---------------- Phase 4: dirty-state + concurrency helpers ---------------- */
  // Stable serialized representation of a grid's rows for baseline comparison.
  // Uses the SAME trimming the save path uses (via _collectEdGrid) and preserves
  // row order + all four fields, so whitespace-only differences are NOT dirty.
  // Blank-league rows are dropped to mirror what actually gets saved.
  _serializeGrid(rows){
    const clean = (rows||[])
      .map(r=>({sport:String(r.sport||'').trim(), region:String(r.region||'').trim(), league:String(r.league||'').trim(), providerName:String(r.providerName||'').trim()}))
      .filter(r=>r.league);   // save path only persists rows with a League
    // Manual serializer (avoids relying on JSON key order); order-preserving.
    let out = '';
    for (let i=0;i<clean.length;i++){
      const r = clean[i];
      out += (i?'\u0001':'') + r.sport + '\u0002' + r.region + '\u0002' + r.league + '\u0002' + r.providerName;
    }
    return out;
  },
  // Capture the current grid (from live DOM) as the clean baseline + version.
  _setEdBaseline(key, version){
    this.edBaseline[key] = this._serializeGrid(this._collectEdGrid(key));
    if (version !== undefined) this.edVersion[key] = version;
  },
  // True when the current DOM grid differs from the captured baseline. Collects
  // live DOM values first (typing lives in inputs until collected).
  _isEdDirty(key){
    if (this.edBaseline[key] === undefined) return false;   // never established a baseline
    return this._serializeGrid(this._collectEdGrid(key)) !== this.edBaseline[key];
  },
  // Guard used before any action that would REPLACE the grid from Supabase.
  // Returns true if it's safe to proceed (clean, or user confirmed discarding).
  _confirmDiscardIfDirty(key){
    if (!this._isEdDirty(key)) return true;
    return confirm('You have unsaved changes in this Euro Desk grid. Reloading will discard them. Continue?');
  },
  // Phase 16 (item 3/4): non-blocking "unsaved changes" indicator. Reuses the
  // EXISTING dirty-state machine (_isEdDirty + edBaseline) — no second tracker.
  // Shows only when this grid's source is 'grid' AND it is dirty (which itself
  // requires an established baseline). Never shows for source='file', never when
  // no baseline exists. Purely informational — does NOT block Validate/Run.
  _refreshUnsavedIndicator(key){
    const el = document.getElementById('edunsaved-'+key);
    if (!el) return;                                   // indicator not rendered yet
    const show = (this.edSource[key] === 'grid') && this._isEdDirty(key);
    el.style.display = show ? '' : 'none';
  },

  // Toggle the busy state for a (key, action) pair. While busy, its button is
  // disabled to prevent overlapping load/save operations. Restored in finally.
  _setEdBusy(key, action, busy){
    this._edBusy[key+'|'+action] = busy;
    const btn = document.getElementById((action==='load'?'edreload-':'edsave-')+key);
    if (btn) btn.disabled = busy;
  },
  _isEdBusy(key, action){ return !!this._edBusy[key+'|'+action]; },

  // Load the saved grid. opts.guard=true means this load was user/UI-initiated
  // in a way that REPLACES current edits (Reload button, sport switch) → confirm
  // first if the grid is dirty. On success, capture the clean baseline + the
  // persisted version (updated_at) for optimistic concurrency.
  async loadEdGrid(key, opts){
    const cfg = this._edCfg(key); if (!cfg) return;
    if (this._isEdBusy(key,'load')) return;           // block overlapping reloads
    // Dirty-guard: never silently discard unsaved edits on a replacing load.
    if (opts && opts.guard && !this._confirmDiscardIfDirty(key)) return;   // user cancelled
    this._setEdBusy(key,'load',true);
    const bar = document.getElementById('edstatus-'+key);
    if (bar){ bar.textContent = 'Loading saved data…'; }
    try {
      const res = await EDStore.load(cfg.sport, cfg.sheet);   // { rows, skipped, version }
      const rows = res.rows;
      const skipped = res.skipped || 0;               // Phase 16: corrupted rows dropped by EDStore
      // Valid rows keep their persisted order and values (map is 1:1, no sort/dedup).
      this.edGrid[key] = (rows && rows.length) ? rows.map(r=>({sport:r.sport||cfg.sport, region:r.region||'', league:r.league||'', providerName:r.providerName||''})) : [];
      if (!this.edGrid[key].length) this.edGrid[key] = [{sport:cfg.sport, region:'', league:'', providerName:''}];
      this.edLoaded[key] = true;
      this._renderEdGrid(key);
      // Loaded data is now the clean baseline; capture the concurrency version.
      this._setEdBaseline(key, res.version);
      const bar2 = document.getElementById('edstatus-'+key);  // re-render replaced the node
      if (bar2){
        // Base status: how many valid rows loaded (order/values preserved).
        let msg = (rows && rows.length) ? (rows.length+' saved row(s) loaded.') : 'No saved data yet — add rows and Save.';
        // Phase 16: non-blocking notice when EDStore skipped corrupted rows.
        // Informational only — never a validation-blocking error.
        if (skipped > 0){ msg += ' ' + skipped + ' invalid row(s) skipped.'; }
        bar2.textContent = msg;
      }
      // Clean, server-synced baseline just established → hide the indicator.
      this._refreshUnsavedIndicator(key);
    } catch(e){
      // Load FAILED: do NOT silently wipe the grid to empty. Only seed a blank
      // row if there is genuinely nothing displayed yet.
      if (!this.edGrid[key] || !this.edGrid[key].length){ this.edGrid[key] = [{sport:cfg.sport, region:'', league:'', providerName:''}]; this._renderEdGrid(key); }
      // Phase 16 (BASELINE RULE): a failed load is NOT a server-synced empty
      // baseline. If NO baseline has ever been established, seed one from the
      // CURRENT on-screen grid so subsequent edits are still tracked as dirty —
      // WITHOUT inventing a server version (leave edVersion untouched, so a later
      // Save uses the INSERT path). Never overwrite an existing baseline, and
      // never claim synchronization.
      if (this.edBaseline[key] === undefined){
        this.edBaseline[key] = this._serializeGrid(this._collectEdGrid(key));
        // edVersion[key] intentionally left as-is (undefined/null) — no fake version.
      }
      const bar2 = document.getElementById('edstatus-'+key);
      if (bar2){ bar2.textContent = 'Load error: '+e.message; }
      this._refreshUnsavedIndicator(key);
    } finally {
      // Restore in both success and error paths (button lives in the re-rendered grid).
      this._setEdBusy(key,'load',false);
    }
  },

  async saveEdGrid(key){
    const cfg = this._edCfg(key); if (!cfg) return;
    if (this._isEdBusy(key,'save')) return;           // block overlapping saves
    this._setEdBusy(key,'save',true);
    const rows = this._collectEdGrid(key).filter(r=>String(r.league||'').trim());
    const bar = document.getElementById('edstatus-'+key);
    if (bar){ bar.textContent = 'Saving…'; }
    try {
      // Optimistic concurrency: pass the version captured at load. EDStore.save
      // confirms the persisted rows and throws ConflictError on a stale save.
      const result = await EDStore.save(cfg.sport, cfg.sheet, rows, this.edVersion[key]);
      this.edGrid[key] = rows.length ? rows : [{sport:cfg.sport, region:'', league:'', providerName:''}];
      this._renderEdGrid(key);
      // Saved state becomes the new clean baseline; capture the new version.
      this._setEdBaseline(key, result.version);
      const bar2 = document.getElementById('edstatus-'+key);
      if (bar2){ bar2.textContent = 'Saved & confirmed '+result.count+' row(s) for '+cfg.sport+' ('+cfg.sheet.toUpperCase()+').'; }
      // Clean baseline after a confirmed save → hide the unsaved indicator.
      this._refreshUnsavedIndicator(key);
      toast('Euro Desk data saved & confirmed ('+result.count+' rows)');
    } catch(e){
      // On ANY failure (including a concurrency conflict) the user's edits are
      // left intact and the baseline is NOT updated, so the grid stays dirty.
      const bar2 = document.getElementById('edstatus-'+key) || bar;
      if (e && e.isConflict){
        if (bar2){ bar2.textContent = 'Conflict: '+e.message; }
        toast('Save conflict — '+e.message, true);
      } else {
        if (bar2){ bar2.textContent = 'Save error: '+e.message; }
        toast('Save failed: '+e.message, true);
      }
      // Baseline unchanged on failure/conflict/timeout → grid stays dirty →
      // the unsaved indicator remains visible.
      this._refreshUnsavedIndicator(key);
    } finally {
      this._setEdBusy(key,'save',false);
    }
  },

  // Read the current grid values from the DOM inputs into an array.
  _collectEdGrid(key){
    const cfg = this._edCfg(key);
    const tbody = document.getElementById('edgrid-'+key+'-body');
    const out = [];
    if (!tbody) return this.edGrid[key] || [];
    const trs = tbody.querySelectorAll('tr');
    for (let i=0;i<trs.length;i++){
      const ins = trs[i].querySelectorAll('input');
      out.push({
        sport: (ins[0]?ins[0].value:'').trim() || (cfg?cfg.sport:''),
        region:(ins[1]?ins[1].value:'').trim(),
        league:(ins[2]?ins[2].value:'').trim(),
        providerName:(ins[3]?ins[3].value:'').trim()
      });
    }
    return out;
  },

  // Phase 12: any grid content change (cell edit, add, delete, paste) invalidates
  // the previous run for THIS grid's sport/source and requires Validate again.
  // It does NOT auto-validate, auto-save, or touch matching/parsing.
  _onEdGridEdit(key){
    // Only gate when this grid's source is the active one feeding a run. Guarding
    // unconditionally is safe (worst case: Run disabled until re-Validate).
    this._invalidateResults();
    // Phase 16: reflect unsaved-changes state after every edit (cell edit, add,
    // delete, paste all funnel through here). Direct cell edits do NOT re-render,
    // so this call is what keeps the indicator live during typing.
    this._refreshUnsavedIndicator(key);
  },

  edGridAdd(key){
    const cfg = this._edCfg(key);
    this.edGrid[key] = this._collectEdGrid(key);
    this.edGrid[key].push({sport:cfg?cfg.sport:'', region:'', league:'', providerName:''});
    this._renderEdGrid(key);
    this._onEdGridEdit(key);
  },
  edGridDel(key, idx){
    this.edGrid[key] = this._collectEdGrid(key);
    this.edGrid[key].splice(idx,1);
    if (!this.edGrid[key].length){ const cfg=this._edCfg(key); this.edGrid[key]=[{sport:cfg?cfg.sport:'', region:'', league:'', providerName:''}]; }
    this._renderEdGrid(key);
    this._onEdGridEdit(key);
  },

  // Paste handler: if a user pastes multi-line TSV/CSV into any cell, expand it
  // into rows (Sport, Region, League, Provider Name). Keeps single-value pastes normal.
  edGridPaste(key, ev){
    const text = (ev.clipboardData || window.clipboardData).getData('text');
    if (!text || text.indexOf('\n')===-1 && text.indexOf('\t')===-1) return; // normal single-cell paste
    ev.preventDefault();
    const cfg = this._edCfg(key);
    const cur = this._collectEdGrid(key).filter(r=>r.league||r.region||r.providerName);
    const lines = text.replace(/\r/g,'').split('\n').filter(l=>l.trim().length);
    for (let i=0;i<lines.length;i++){
      const c = lines[i].split('\t');
      if (c.length < 2) continue;                  // need at least a couple columns
      // Accept either 4-col (Sport,Region,League,Provider) or 3-col (Region,League,Provider)
      let sport, region, league, prov;
      if (c.length >= 4){ sport=c[0]; region=c[1]; league=c[2]; prov=c[3]; }
      else { sport=cfg?cfg.sport:''; region=c[0]; league=c[1]; prov=c[2]||''; }
      const low = String(sport||'').toLowerCase();
      if (low==='sport') continue;                 // skip a pasted header row
      cur.push({sport:(sport||'').trim()||(cfg?cfg.sport:''), region:(region||'').trim(), league:(league||'').trim(), providerName:(prov||'').trim()});
    }
    this.edGrid[key] = cur.length ? cur : [{sport:cfg?cfg.sport:'', region:'', league:'', providerName:''}];
    this._renderEdGrid(key);
    this._onEdGridEdit(key);
    toast('Pasted '+lines.length+' row(s) into the grid');
  },

  _renderEdGrid(key){
    const wrap = document.getElementById('edwrap-'+key+'-grid');
    const cfg = this._edCfg(key);
    if (!wrap || !cfg) return;
    const rows = (this.edGrid[key] && this.edGrid[key].length) ? this.edGrid[key] : [{sport:cfg.sport, region:'', league:'', providerName:''}];
    const esc2 = s => esc(s);
    const body = rows.map((r,i)=>`<tr>
      <td class="rn">${i+1}</td>
      <td><input value="${esc2(r.sport||cfg.sport)}" oninput="V1._onEdGridEdit('${key}')" onpaste="V1.edGridPaste('${key}',event)"></td>
      <td><input value="${esc2(r.region||'')}" oninput="V1._onEdGridEdit('${key}')" onpaste="V1.edGridPaste('${key}',event)"></td>
      <td><input value="${esc2(r.league||'')}" oninput="V1._onEdGridEdit('${key}')" onpaste="V1.edGridPaste('${key}',event)"></td>
      <td><input value="${esc2(r.providerName||'')}" oninput="V1._onEdGridEdit('${key}')" onpaste="V1.edGridPaste('${key}',event)"></td>
      <td><button class="btn btn-ghost" style="padding:4px 8px;font-size:12px;" onclick="V1.edGridDel('${key}',${i})" title="Delete row">✕</button></td>
    </tr>`).join('');
    wrap.innerHTML =
      `<div class="ed-grid-wrap"><table class="ed-grid">
        <thead><tr><th>#</th><th>Sport</th><th>Region</th><th>League</th><th>${esc2(cfg.provLabel)}</th><th></th></tr></thead>
        <tbody id="edgrid-${key}-body">${body}</tbody>
      </table></div>
      <div class="ed-grid-bar">
        <button class="btn btn-secondary" onclick="V1.edGridAdd('${key}')">+ Add Row</button>
        <button class="btn btn-secondary" id="edreload-${key}" onclick="V1.loadEdGrid('${key}',{guard:true})">↺ Reload Saved</button>
        <button class="btn btn-primary" id="edsave-${key}" onclick="V1.saveEdGrid('${key}')">💾 Save Data</button>
        <span class="ed-status" id="edstatus-${key}"></span>
        <span class="ed-unsaved" id="edunsaved-${key}" style="display:none;color:var(--warn);font-size:12px;font-weight:600;">⚠ Using unsaved Euro Desk changes</span>
      </div>
      <small style="display:block;margin-top:6px;color:var(--text-faint);">Columns: Sport · Region · League · ${esc2(cfg.provLabel)}. You can paste a block straight from Excel (tab-separated). Saved per sport, shared across agents.</small>`;
    // Phase 16: re-evaluate the unsaved indicator every time the grid re-renders.
    this._refreshUnsavedIndicator(key);
  },

  async _readWorkbook(file){
    const buf = await file.arrayBuffer();
    // cellStyles:true lets us best-effort read red fills in the Euro Desk sheet.
    return XLSX.read(new Uint8Array(buf), { type:'array', cellStyles:true });
  },

  // Is a Euro Desk sheet ready to validate? For 'file' source, a file must be
  // chosen; for 'grid' source, at least one row with a League must exist.
  _edReady(key){
    if (this.edSource[key] === 'grid'){
      const rows = this._collectEdGrid(key);
      return rows.some(r => String(r.league||'').trim());
    }
    return !!this.files[key];
  },

  // Parse a Euro Desk sheet from whichever source is active (file upload or the
  // saved-data grid). sheetMatch is only used for the file path.
  async _parseEuroDesk(key, sheetMatch){
    if (this.edSource[key] === 'grid'){
      return EuroDeskParser.fromRows(this._collectEdGrid(key));
    }
    const f = this.files[key];
    let wb;
    if (/\.csv$/i.test(f.name)){ const t = await f.text(); wb = XLSX.read(t, { type:'string' }); }
    else wb = await this._readWorkbook(f);
    const parsed = EuroDeskParser.parse(wb, sheetMatch);
    // Prefix sheetName with the quoted source for the OK message continuity.
    if (parsed.sheetName) parsed.sheetName = 'sheet "'+parsed.sheetName+'"';
    return parsed;
  },

  async validate(){
    const msg = document.getElementById('validation-msg');
    msg.innerHTML='';
    const problems=[]; const oks=[];
    this._dupWarnings = [];   // reset duplicate-key warnings for this validation run
    this._sportWarnings = []; // reset sport-mismatch warnings for this validation run
    this._headerWarnings = []; // reset BR column-order warnings (Phase 14 H1)
    if (!this.range) problems.push('Date range not set.');

    // -------- ICE HOCKEY validation (BR dump + one Euro Desk sheet, no BG) --------
    if (this.sport === 'Ice Hockey'){
      if (!this.files.ihbr) problems.push('Ice Hockey BR dump not uploaded.');
      if (!this._edReady('ihed')) problems.push('Ice Hockey Euro Desk sheet not provided (upload a file or add saved data).');
      if (problems.length){ this._showValidation(problems, []); return; }
      try {
        const brWb = await this._readWorkbook(this.files.ihbr);
        const brRows = XLSX.utils.sheet_to_json(brWb.Sheets[brWb.SheetNames[0]], { header:1, defval:'' });
        this.parsed.ihbr = BRParser.parse(brRows, this._dateCtx, 'Ice Hockey');
        if (this.parsed.ihbr.headerOrderWarning) this._headerWarnings.push('Ice Hockey '+this.parsed.ihbr.headerOrderWarning);
        if (this.parsed.ihbr.headerMissing) problems.push('Ice Hockey BR: could not find the "Home Team / Match Id" column header row.');
        else oks.push(`Ice Hockey BR: parsed ${this.parsed.ihbr.matches.length} matches, ${this.parsed.ihbr.malformed.length} malformed.`);
        document.getElementById('fstat-ihbr').className='fstat ok';
        document.getElementById('fstat-ihbr').textContent=`Ice Hockey BR ok — ${this.parsed.ihbr.matches.length} matches`;

        this.parsed.ihed = await this._parseEuroDesk('ihed', /ice|hockey/i);
        this._collectDupWarnings('Ice Hockey Euro Desk', this.parsed.ihed);
        this._collectSportWarnings('Ice Hockey', this.parsed.ihed, false);  // informational
        if (this.parsed.ihed.warning) problems.push('Ice Hockey Euro Desk: '+this.parsed.ihed.warning);
        else oks.push(`Ice Hockey Euro Desk: ${this.parsed.ihed.leagues.length} leagues loaded (${this.parsed.ihed.sheetName}).`);
        document.getElementById('fstat-ihed').className = this.parsed.ihed.warning?'fstat err':'fstat ok';
        document.getElementById('fstat-ihed').textContent = this.parsed.ihed.warning?('IH sheet: '+this.parsed.ihed.warning):`IH sheet ok — ${this.parsed.ihed.leagues.length} leagues`;
      } catch(e){ problems.push('Read error: '+e.message); }
      this._showValidation(problems, oks);
      document.getElementById('btn-run').disabled = problems.length>0;
      return;
    }

    // -------- MINOR SPORTS validation (BR dump + one Euro Desk sheet, no BG) --------
    // V1 uses Sport, Region and League columns only. 3-Day check only. BR-only.
    if (this.sport === 'Minor Sports'){
      if (!this.files.msbr) problems.push('Minor Sports BR dump not uploaded.');
      if (!this._edReady('msed')) problems.push('Minor Sports Euro Desk sheet not provided (upload a file or add saved data).');
      if (problems.length){ this._showValidation(problems, []); return; }
      try {
        const brWb = await this._readWorkbook(this.files.msbr);
        const brRows = XLSX.utils.sheet_to_json(brWb.Sheets[brWb.SheetNames[0]], { header:1, defval:'' });
        this.parsed.msbr = BRParser.parse(brRows, this._dateCtx, this.minorSport);
        if (this.parsed.msbr.headerOrderWarning) this._headerWarnings.push('Minor Sports '+this.parsed.msbr.headerOrderWarning);
        if (this.parsed.msbr.headerMissing) problems.push('Minor Sports BR: could not find the "Home Team / Match Id" column header row.');
        else oks.push(`Minor Sports BR (${this.minorSport}): parsed ${this.parsed.msbr.matches.length} matches, ${this.parsed.msbr.malformed.length} malformed.`);
        document.getElementById('fstat-msbr').className='fstat ok';
        document.getElementById('fstat-msbr').textContent=`Minor Sports BR ok — ${this.parsed.msbr.matches.length} matches`;

        // Minor Sports master config: file sheet matcher is minor/euro/desk; grid comes from saved data.
        this.parsed.msed = await this._parseEuroDesk('msed', /minor|euro|desk/i);
        this._collectDupWarnings('Minor Sports Euro Desk', this.parsed.msed);
        this._collectSportWarnings(this.minorSport, this.parsed.msed, true);  // affects matching (sport filter)
        if (this.parsed.msed.warning) problems.push('Minor Sports Euro Desk: '+this.parsed.msed.warning);
        else {
          // Report how many rows match the selected minor sport (Sport column filter).
          const spKey = normLeague(this.minorSport);
          const forSport = this.parsed.msed.leagues.filter(L=>!L.keySport || L.keySport===spKey);
          oks.push(`Minor Sports Euro Desk: ${this.parsed.msed.leagues.length} leagues loaded (sheet "${this.parsed.msed.sheetName}"), ${forSport.length} for ${this.minorSport}.`);
        }
        document.getElementById('fstat-msed').className = this.parsed.msed.warning?'fstat err':'fstat ok';
        document.getElementById('fstat-msed').textContent = this.parsed.msed.warning?('MS sheet: '+this.parsed.msed.warning):`MS sheet ok — ${this.parsed.msed.leagues.length} leagues`;
      } catch(e){ problems.push('Read error: '+e.message); }
      this._showValidation(problems, oks);
      document.getElementById('btn-run').disabled = problems.length>0;
      return;
    }

    // -------- BASKETBALL validation (BR + BG + two Euro Desk sheets) --------
    if (!this.files.br) problems.push('BR dump not uploaded.');
    if (!this.files.bg) problems.push('BG dump not uploaded.');
    if (!this._edReady('edbr')) problems.push('Basketball Euro Desk BR sheet not provided (upload a file or add saved data).');
    if (!this._edReady('edbg')) problems.push('Basketball BG Euro Desk sheet not provided (upload a file or add saved data).');
    if (problems.length){ this._showValidation(problems, []); return; }

    try {
      // BR
      const brWb = await this._readWorkbook(this.files.br);
      const brSheet = brWb.Sheets[brWb.SheetNames[0]];
      const brRows = XLSX.utils.sheet_to_json(brSheet, { header:1, defval:'' });
      this.parsed.br = BRParser.parse(brRows, this._dateCtx);
      if (this.parsed.br.headerOrderWarning) this._headerWarnings.push('BR '+this.parsed.br.headerOrderWarning);
      if (this.parsed.br.headerMissing) problems.push('BR: could not find the "Home Team / Match Id" column header row.');
      else oks.push(`BR: parsed ${this.parsed.br.matches.length} matches, ${this.parsed.br.malformed.length} malformed.`);
      document.getElementById('fstat-br').className='fstat ok';
      document.getElementById('fstat-br').textContent=`BR ok — ${this.parsed.br.matches.length} matches`;

      // BG (csv or xlsx)
      let bgObj;
      if (/\.csv$/i.test(this.files.bg.name)){
        const text = await this.files.bg.text();
        const wb = XLSX.read(text, { type:'string' });
        bgObj = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval:'' });
      } else {
        const wb = await this._readWorkbook(this.files.bg);
        bgObj = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval:'' });
      }
      // header check
      const bgHeaderOk = bgObj.length && ('Competition' in bgObj[0]) && ('EventId' in bgObj[0] || 'Event Id' in bgObj[0]) && ('Event' in bgObj[0]);
      if (!bgHeaderOk) problems.push('BG: missing required columns (Competition / EventId / Event).');
      this.parsed.bg = BGParser.parse(bgObj);
      oks.push(`BG: parsed ${this.parsed.bg.matches.length} matches, ${this.parsed.bg.malformed.length} malformed.`);
      document.getElementById('fstat-bg').className='fstat ok';
      document.getElementById('fstat-bg').textContent=`BG ok — ${this.parsed.bg.matches.length} matches`;

      // Euro Desk BR sheet (used ONLY to validate Betradar competitions)
      this.parsed.edbr = await this._parseEuroDesk('edbr');
      this._collectDupWarnings('Euro Desk BR', this.parsed.edbr);
      this._collectSportWarnings('Basketball', this.parsed.edbr, false);  // informational
      if (this.parsed.edbr.warning) problems.push('Euro Desk BR: '+this.parsed.edbr.warning);
      else oks.push(`Euro Desk BR: ${this.parsed.edbr.leagues.length} leagues loaded (${this.parsed.edbr.sheetName}).`);
      document.getElementById('fstat-edbr').className = this.parsed.edbr.warning?'fstat err':'fstat ok';
      document.getElementById('fstat-edbr').textContent = this.parsed.edbr.warning?('BR sheet: '+this.parsed.edbr.warning):`BR sheet ok — ${this.parsed.edbr.leagues.length} leagues`;

      // Euro Desk BG sheet (used ONLY to validate Betgenius competitions)
      this.parsed.edbg = await this._parseEuroDesk('edbg');
      this._collectDupWarnings('Euro Desk BG', this.parsed.edbg);
      this._collectSportWarnings('Basketball', this.parsed.edbg, false);  // informational
      if (this.parsed.edbg.warning) problems.push('Euro Desk BG: '+this.parsed.edbg.warning);
      else oks.push(`Euro Desk BG: ${this.parsed.edbg.leagues.length} leagues loaded (${this.parsed.edbg.sheetName}).`);
      document.getElementById('fstat-edbg').className = this.parsed.edbg.warning?'fstat err':'fstat ok';
      document.getElementById('fstat-edbg').textContent = this.parsed.edbg.warning?('BG sheet: '+this.parsed.edbg.warning):`BG sheet ok — ${this.parsed.edbg.leagues.length} leagues`;
    } catch(e){
      problems.push('Read error: '+e.message);
    }
    this._showValidation(problems, oks);
    document.getElementById('btn-run').disabled = problems.length>0;
  },
  _showValidation(problems, oks){
    const msg = document.getElementById('validation-msg');
    let html='';
    if (problems.length) html += `<div class="errbox">✗ ${problems.map(esc).join('<br>✗ ')}</div>`;
    if (oks.length) html += `<div class="warnbox" style="background:var(--success-soft);color:var(--success);border-color:var(--success);">✓ ${oks.map(esc).join('<br>✓ ')}</div>`;
    // Duplicate Euro Desk key warning (non-blocking). Matching stays first-row-wins.
    const dups = this._dupWarnings || [];
    if (dups.length){
      html += `<div class="warnbox"><b>⚠ Duplicate Euro Desk keys detected.</b> Matching remains first-row-wins; review these rows before running.<br>`
        + dups.map(esc).join('<br>') + `</div>`;
    }
    // BR column-order warnings (non-blocking; parsing is positional and unchanged).
    const hdrW = this._headerWarnings || [];
    if (hdrW.length){
      html += `<div class="warnbox"><b>⚠ BR column order check.</b><br>` + hdrW.map(esc).join('<br>') + `</div>`;
    }
    // Sport-mismatch warnings (non-blocking, separate from duplicate detection).
    // Informational for Basketball/Ice Hockey; matching-impact for Minor Sports.
    const sportW = this._sportWarnings || [];
    for (let i=0;i<sportW.length;i++){
      const g = sportW[i];
      const heading = g.affectsMatching ? 'SPORT MISMATCH — AFFECTS MATCHING' : 'SPORT MISMATCH — INFORMATIONAL';
      const note = g.affectsMatching
        ? 'These rows are currently excluded by the Minor Sports sport filter.'
        : 'These rows still participate in '+esc(g.context)+' matching (Sport is informational here).';
      html += `<div class="warnbox"><b>⚠ ${esc(heading)}</b><br>Context: ${esc(g.context)}<br>Rows:<br>`
        + g.lines.map(esc).join('<br>') + `<br><span style="opacity:.85;">${note}</span></div>`;
    }
    // Colour-read caveat for Euro Desk red rows:
    html += `<div class="note" style="margin-top:8px;">Note: red "disregarded" leagues are detected from the Euro Desk sheet where the browser can read cell colour. If colour can't be read, no league is auto-excluded — confirm exclusions manually.</div>`;
    msg.innerHTML = html;
  },

  // Append human-readable duplicate warnings for one parsed Euro Desk list.
  // Does not modify records. `label` identifies the sheet (e.g. "Euro Desk BR").
  _collectDupWarnings(label, parsed){
    if (!parsed || !parsed.leagues) return;
    const groups = EuroDeskParser.findDuplicates(parsed.leagues);
    for (let i=0;i<groups.length;i++){
      const g = groups[i];
      const flags = [];
      if (g.sportDiffers) flags.push('sport differs');
      if (g.regionDiffers) flags.push('region differs');
      if (g.disregardedDiffers) flags.push('disregarded differs');
      this._dupWarnings.push(
        `${label} — duplicate ${g.keyType} key "${g.key}" (${g.count} rows: #${g.rows.join(', #')})`
        + ` · leagues: ${g.leagues.join(' | ')}`
        + (g.providers.filter(Boolean).length ? ` · providers: ${g.providers.filter(Boolean).join(' | ')}` : '')
        + (flags.length ? ` · ${flags.join('; ')}` : '')
      );
    }
  },

  // Append Sport-mismatch warnings for one parsed Euro Desk list. Detection only
  // (uses EuroDeskParser.findSportMismatches); NEVER mutates records or matching.
  // affectsMatching=true only for Minor Sports (where _processMS filters by sport);
  // for Basketball/Ice Hockey the mismatch is informational (matching ignores it).
  _collectSportWarnings(contextSport, parsed, affectsMatching){
    if (!parsed || !parsed.leagues) return;
    const rows = EuroDeskParser.findSportMismatches(parsed.leagues, contextSport);
    if (!rows.length) return;
    const lines = rows.map(x =>
      `#${x.row} — Sport=${x.sport} — League=${x.league}` + (x.provider ? ` — Provider=${x.provider}` : ''));
    this._sportWarnings.push({
      affectsMatching: !!affectsMatching,
      context: contextSport,
      lines: lines
    });
  },

  /* -------- Euro Desk lookup: exact normalized only (no fuzzy) --------
     BR validates against the BR sheet; BG validates against the BG sheet.
     Never mix the two sheets. */
  // Returns { record, matchType } or null. matchType ∈ 'league' | 'alias' | 'country'.
  // The row-interleaved scan order and priority are PRESERVED EXACTLY as before:
  // for each Euro Desk row in order, test keyLeague, then keyBetradar, then the
  // country-prefixed keyLeague — first hit on the earliest row wins. Only the
  // return shape changed (record + matchType) so the UI/export can show evidence.
  _edLookup(leagues, compName, country){
    const key = normLeague(compName);
    if (!key || !leagues) return null;
    const withCountry = country ? normLeague(country+' '+compName) : '';
    for (const L of leagues){
      if (L.keyLeague === key) return { record:L, matchType:'league' };
      if (L.keyBetradar && L.keyBetradar === key) return { record:L, matchType:'alias' };
      if (withCountry && (L.keyLeague===withCountry)) return { record:L, matchType:'country' };
    }
    return null;
  },
  _edMatchBR(compName, country){ return this._edLookup(this.parsed.edbr ? this.parsed.edbr.leagues : null, compName, country); },
  _edMatchBG(compName){ return this._edLookup(this.parsed.edbg ? this.parsed.edbg.leagues : null, compName, ''); },

  // Human-readable label for a matchType (UI/export). Underlying value unchanged.
  matchTypeLabel(mt){
    return mt==='league' ? 'League' : mt==='alias' ? 'Provider Alias' : mt==='country' ? 'Country + League' : '—';
  },

  // Given the leagues list, the winning record and the matchType, return the
  // source rows of ALL records that share the SAME KEY that was actually used
  // for the match (league key when matched by league/country, betradar key when
  // matched by alias). Used to flag duplicateKey on results. Returns [] if the
  // used key is unique. Does NOT change matching or first-row-wins.
  _edDupRowsForKey(leagues, record, matchType){
    if (!leagues || !record) return [];
    const useBetradar = (matchType === 'alias');
    const usedKey = useBetradar ? record.keyBetradar : record.keyLeague;
    if (!usedKey) return [];
    const rows = [];
    for (const L of leagues){
      const k = useBetradar ? L.keyBetradar : L.keyLeague;
      if (k && k === usedKey) rows.push(L.row);
    }
    return rows.length > 1 ? rows : [];
  },

  // Build the review reason for an unmatched fixture (exact-normalized wording,
  // never implies fuzzy/close matching). For BR, notes the country attempt too.
  _reviewReason(providerLabel, hasCountry){
    let r = 'Not found in Euro Desk — no exact normalized League or Provider Alias match';
    if (hasCountry) r += '; Country + Competition exact match was also not found';
    return r;
  },
  _inRange(dateStr){
    if (!dateStr) return false;
    return dateStr >= this.range.start && dateStr <= this.range.end;
  },

  // A "BR-only" sport has no BG source or BG Euro Desk sheet (Ice Hockey,
  // Minor Sports). Basketball is the only dual-source sport.
  _brOnly(){ return this.sport !== 'Basketball'; },

  run(){
    if (this.sport === 'Ice Hockey'){
      if (!this.parsed.ihbr || !this.parsed.ihed){ toast('Validate files first', true); return; }
    } else if (this.sport === 'Minor Sports'){
      if (!this.parsed.msbr || !this.parsed.msed){ toast('Validate files first', true); return; }
    } else {
      if (!this.parsed.br || !this.parsed.bg || !this.parsed.edbr || !this.parsed.edbg){ toast('Validate files first', true); return; }
    }
    // Phase 12: clear any previous run BEFORE processing so a failed/interrupted
    // run can never leave the prior successful results viewable or exportable.
    // A successful _process*/_processIH/_processMS reassigns this.results at its end.
    this.results = null;
    const rt = document.getElementById('result-tabs'); if (rt) rt.innerHTML='';
    const rb = document.getElementById('result-body'); if (rb) rb.innerHTML='';
    document.getElementById('processing').style.display='block';
    document.getElementById('results').style.display='none';
    setTimeout(()=>{ try {
      if (this.sport==='Ice Hockey') this._processIH();
      else if (this.sport==='Minor Sports') this._processMS();
      else this._process();
    } catch(e){ this.results=null; toast('Processing failed: '+e.message,true); } finally { document.getElementById('processing').style.display='none'; } }, 30);
  },

  // Ice Hockey: BR-only pipeline (no BG). Reuses the same date + Euro Desk filters.
  _processIH(){
    const ihLeagues = this.parsed.ihed.leagues;
    const br = { eligible:[], outside:[], notFound:[], disregarded:[], review:[], malformed: this.parsed.ihbr.malformed.slice() };
    this.parsed.ihbr.matches.forEach(m=>{
      const hit = this._edLookup(ihLeagues, m.competitionName, m.country);
      this._clearEvidence(m);
      if (hit) this._applyEvidence(m, hit, ihLeagues);
      if (!this._inRange(m.eventDate)){ m.status='Outside Selected Date Range'; br.outside.push(m); return; }
      if (!hit){ m.status='League Not Found in Euro Desk'; m.reason=this._reviewReason('BR', !!m.country); br.notFound.push(m); return; }
      if (hit.record.disregarded){ m.status='Disregarded League'; m.reason='Matched in Euro Desk but marked as disregarded.'; br.disregarded.push(m); return; }
      m.status='Eligible'; m.reason=''; br.eligible.push(m);
    });
    // No BG for Ice Hockey — empty BG bucket keeps the shared renderers happy.
    const bg = { eligible:[], outside:[], notFound:[], disregarded:[], review:[], malformed:[] };
    this.results = { br, bg, sport:'Ice Hockey' };
    this._renderSummary();
    this._renderTabs();
    this.setResultTab('br');
    document.getElementById('results').style.display='block';
  },

  // Minor Sports: BR-only pipeline (no BG), 3-Day check only. Same date + Euro
  // Desk filters as Ice Hockey, PLUS a Sport-column filter so only Euro Desk
  // leagues that belong to the selected minor sport are considered a match.
  // V1 uses only Sport, Region and League columns from the master config.
  _processMS(){
    const spKey = normLeague(this.minorSport);
    // Restrict the master config to rows for the selected minor sport. Rows with
    // a blank Sport column are kept (config may omit it) so nothing valid is lost.
    const leagues = (this.parsed.msed.leagues||[]).filter(L=>!L.keySport || L.keySport===spKey);
    const br = { eligible:[], outside:[], notFound:[], disregarded:[], review:[], malformed: this.parsed.msbr.malformed.slice() };
    this.parsed.msbr.matches.forEach(m=>{
      const hit = this._edLookup(leagues, m.competitionName, m.country);
      this._clearEvidence(m);
      if (hit) this._applyEvidence(m, hit, leagues);
      if (!this._inRange(m.eventDate)){ m.status='Outside Selected Date Range'; br.outside.push(m); return; }
      if (!hit){ m.status='League Not Found in Euro Desk'; m.reason=this._reviewReason('BR', !!m.country); br.notFound.push(m); return; }
      if (hit.record.disregarded){ m.status='Disregarded League'; m.reason='Matched in Euro Desk but marked as disregarded.'; br.disregarded.push(m); return; }
      m.status='Eligible'; m.reason=''; br.eligible.push(m);
    });
    const bg = { eligible:[], outside:[], notFound:[], disregarded:[], review:[], malformed:[] };
    this.results = { br, bg, sport:'Minor Sports' };
    this._renderSummary();
    this._renderTabs();
    this.setResultTab('br');
    document.getElementById('results').style.display='block';
    toast(`Done — ${this.minorSport} eligible ${br.eligible.length}`);
  },

  // Attach empty evidence fields to a fixture (unmatched default).
  _clearEvidence(m){ m.edLeague=''; m.edProviderName=''; m.edSourceRow=''; m.matchType=''; m.duplicateKey=false; m.duplicateSourceRows=[]; },
  // Attach evidence from a winning { record, matchType } hit, plus duplicate linkage.
  _applyEvidence(m, hit, leagues){
    const L = hit.record;
    m.edLeague = L.league;
    m.edProviderName = L.betradar || '';
    m.edSourceRow = L.row;
    m.matchType = hit.matchType;
    const dupRows = this._edDupRowsForKey(leagues, L, hit.matchType);
    m.duplicateKey = dupRows.length > 1;
    m.duplicateSourceRows = dupRows;
  },

  _process(){
    // ---- BR (validated against the BR Euro Desk sheet only) ----
    const brLeagues = this.parsed.edbr ? this.parsed.edbr.leagues : null;
    const br = { eligible:[], outside:[], notFound:[], disregarded:[], review:[], malformed: this.parsed.br.malformed.slice() };
    this.parsed.br.matches.forEach(m=>{
      const hit = this._edMatchBR(m.competitionName, m.country);
      this._clearEvidence(m);
      if (hit) this._applyEvidence(m, hit, brLeagues);
      if (!this._inRange(m.eventDate)){ m.status='Outside Selected Date Range'; br.outside.push(m); return; }
      if (!hit){ m.status='League Not Found in Euro Desk'; m.reason=this._reviewReason('BR', !!m.country); br.notFound.push(m); return; }
      if (hit.record.disregarded){ m.status='Disregarded League'; m.reason='Matched in Euro Desk but marked as disregarded.'; br.disregarded.push(m); return; }
      m.status='Eligible'; m.reason=''; br.eligible.push(m);
    });
    // ---- BG (validated against the BG Euro Desk sheet only) ----
    const bgLeagues = this.parsed.edbg ? this.parsed.edbg.leagues : null;
    const bg = { eligible:[], outside:[], notFound:[], disregarded:[], review:[], malformed: this.parsed.bg.malformed.slice() };
    this.parsed.bg.matches.forEach(m=>{
      const hit = this._edMatchBG(m.competitionRaw);
      this._clearEvidence(m);
      if (hit) this._applyEvidence(m, hit, bgLeagues);
      if (!this._inRange(m.eventDate)){ m.status='Outside Selected Date Range'; bg.outside.push(m); return; }
      if (!hit){ m.status='Competition Not Found in Euro Desk'; m.reason=this._reviewReason('BG', false); bg.notFound.push(m); return; }
      if (hit.record.disregarded){ m.status='Disregarded Competition'; m.reason='Matched in Euro Desk but marked as disregarded.'; bg.disregarded.push(m); return; }
      m.status='Eligible'; m.reason=''; bg.eligible.push(m);
    });

    this.results = { br, bg };
    this._renderSummary();
    this._renderTabs();
    this.setResultTab('br');
    document.getElementById('results').style.display='block';
    toast(`Done — BR eligible ${br.eligible.length} · BG eligible ${bg.eligible.length}`);
  },

  // Display label for the current sport in BR-only mode (Ice Hockey / the
  // selected minor sport). Basketball keeps the plain "BR" labels.
  _sportLabel(){ return this.sport==='Minor Sports' ? this.minorSport : this.sport; },
  // The BR parse bucket for the current sport.
  _brParse(){ return this.sport==='Ice Hockey' ? this.parsed.ihbr : this.sport==='Minor Sports' ? this.parsed.msbr : this.parsed.br; },

  _renderSummary(){
    const r=this.results, P=this.parsed;
    const brOnly = this._brOnly();
    const lbl = this._sportLabel();
    document.getElementById('summary-head').innerHTML =
      `Selected Sport: <b>${esc(this._sportLabel())}</b> &nbsp;·&nbsp; Check: <b>${this.checkType==='3day'?'3-Day':'10th-Day'}</b> &nbsp;·&nbsp; ${esc(this.range.label)}`;
    const card=(n,l,cls)=>`<div class="stat-card ${cls||''}"><div class="num">${n}</div><div class="label">${esc(l)}</div></div>`;
    // BR block sources counts from the sport's BR parse (ihbr/msbr for BR-only sports).
    const brP = this._brParse();
    document.getElementById('br-summary-label').textContent = brOnly ? (lbl+' BR Summary') : 'BR Summary';
    document.getElementById('br-summary').innerHTML =
      card(brP.totalRows,brOnly?'Total '+lbl+' Rows':'Total BR Rows')+card(brP.matches.length,'Parsed Matches')+
      card(r.br.eligible.length,'Eligible','good')+card(r.br.outside.length,'Outside Date')+
      card(r.br.notFound.length,brOnly?'Not in Euro Desk':'Not in BR Euro Desk','warn')+card(r.br.disregarded.length,'Disregarded')+
      card(r.br.malformed.length,'Malformed','bad');
    // BG summary + BG export hidden entirely for BR-only sports; relabel BR export.
    document.getElementById('bg-summary-wrap').style.display = brOnly ? 'none' : '';
    const bgBtn = document.getElementById('btn-export-bg'); if (bgBtn) bgBtn.style.display = brOnly ? 'none' : '';
    const brBtn = document.getElementById('btn-export-br'); if (brBtn) brBtn.textContent = brOnly ? ('⬇ Export Eligible '+lbl) : '⬇ Export Eligible BR';
    if (!brOnly){
      document.getElementById('bg-summary').innerHTML =
        card(P.bg.totalRows,'Total BG Rows')+card(P.bg.matches.length,'Parsed Matches')+
        card(r.bg.eligible.length,'Eligible','good')+card(r.bg.outside.length,'Outside Date')+
        card(r.bg.notFound.length,'Not in BG Euro Desk','warn')+card(r.bg.disregarded.length,'Disregarded')+
        card(r.bg.malformed.length,'Malformed','bad');
    }
  },

  _renderTabs(){
    const r=this.results;
    const disCount = r.br.disregarded.length + r.bg.disregarded.length;
    const revBrCount = r.br.notFound.length;
    const revBgCount = r.bg.notFound.length;
    const malCount = r.br.malformed.length + r.bg.malformed.length;
    const brOnly = this._brOnly();
    const lbl = this._sportLabel();
    const tabs = brOnly ? [
      ['br',`Eligible ${lbl} (${r.br.eligible.length})`],
      ['revbr',`${lbl} League Review (${revBrCount})`],
      ['dis',`Disregarded (${disCount})`],
      ['mal',`Malformed (${malCount})`]
    ] : [
      ['br',`Eligible BR (${r.br.eligible.length})`],
      ['bg',`Eligible BG (${r.bg.eligible.length})`],
      ['revbr',`BR League Review (${revBrCount})`],
      ['revbg',`BG Competition Review (${revBgCount})`],
      ['dis',`Disregarded (${disCount})`],
      ['mal',`Malformed (${malCount})`]
    ];
    document.getElementById('result-tabs').innerHTML = tabs.map(([k,l])=>
      `<button class="rtab ${this.resultTab===k?'active':''}" onclick="V1.setResultTab('${k}')">${esc(l)}</button>`).join('');
  },
  setResultTab(k){ this.resultTab=k; this._renderTabs(); this._renderBody(); },

  // Small evidence-cell helpers (all values escaped via esc()).
  _dupBadge(m){
    return (m.duplicateKey && m.duplicateSourceRows && m.duplicateSourceRows.length)
      ? ` <span class="badge b-warn" title="Matched a duplicated Euro Desk key">⚠ Duplicate key (rows ${esc(m.duplicateSourceRows.join(', '))})</span>` : '';
  },
  _matchedByCell(m){ return esc(this.matchTypeLabel(m.matchType)); },

  _renderBody(){
    const r=this.results, body=document.getElementById('result-body');
    const empty=(msg)=>`<div class="empty-state"><div class="ic">📋</div>${esc(msg)}</div>`;
    const S = esc;
    if (this.resultTab==='br'){
      const rows=r.br.eligible;
      const noteLbl = this._brOnly() ? (this._sportLabel()+' matches (in date range and in the Euro Desk sheet)') : 'BR matches (in date range and in the Basketball Euro Desk)';
      body.innerHTML = rows.length ? `<div class="note">Eligible ${S(noteLbl)}.</div><div class="table-wrap"><table>
        <thead><tr><th>Competition</th><th>Country</th><th>Week</th><th>Date</th><th>KO</th><th>Home</th><th>Away</th><th>Neutral</th><th>BR Match ID</th><th>Euro Desk League</th><th>Matched Provider Name</th><th>Matched By</th><th>Euro Desk Row</th><th>Status</th><th>Row</th></tr></thead>
        <tbody>${rows.map(m=>`<tr><td>${S(m.competitionName)}</td><td>${S(m.country)}</td><td>${S(m.week)}</td><td>${S(m.eventDate)}</td><td>${S(m.koRaw)}</td><td>${S(m.homeTeam)}</td><td>${S(m.awayTeam)}</td><td>${S(m.neutralGround)}</td><td class="mono">${S(m.brMatchId)}</td><td>${S(m.edLeague)}</td><td>${S(m.edProviderName)||'<span class="badge b-dim">—</span>'}</td><td>${this._matchedByCell(m)}${this._dupBadge(m)}</td><td>${S(m.edSourceRow)}</td><td><span class="badge b-good">Eligible</span></td><td>${S(m.sourceRowNumber)}</td></tr>`).join('')}</tbody></table></div>` : empty('No eligible BR matches.');
    } else if (this.resultTab==='bg'){
      const rows=r.bg.eligible;
      body.innerHTML = rows.length ? `<div class="note">Eligible BG matches (in date range and in the Basketball Euro Desk).</div><div class="table-wrap"><table>
        <thead><tr><th>Competition</th><th>Event ID</th><th>Event</th><th>Start (UTC+2)</th><th>Home</th><th>Away</th><th>Feed</th><th>Booking</th><th>OST</th><th>Euro Desk League</th><th>Matched Provider Name</th><th>Matched By</th><th>Euro Desk Row</th><th>Status</th><th>Row</th></tr></thead>
        <tbody>${rows.map(m=>`<tr><td>${S(m.competitionRaw)}</td><td class="mono">${S(m.eventId)}</td><td>${S(m.eventRaw)}</td><td>${S(m.startDisplay||m.startRaw)}</td><td>${S(m.homeTeam)}</td><td>${S(m.awayTeam)}</td><td>${S(m.feed)}</td><td>${S(m.bookingStatus)}</td><td>${S(m.ost)}</td><td>${S(m.edLeague)}</td><td>${S(m.edProviderName)||'<span class="badge b-dim">—</span>'}</td><td>${this._matchedByCell(m)}${this._dupBadge(m)}</td><td>${S(m.edSourceRow)}</td><td><span class="badge b-good">Eligible</span></td><td>${S(m.sourceRowNumber)}</td></tr>`).join('')}</tbody></table></div>` : empty('No eligible BG matches.');
    } else if (this.resultTab==='revbr'){
      // EVERY BR fixture routed to Review is shown as its own row (no dedup).
      const rows = r.br.notFound;
      const status = 'League Not Found in Euro Desk';
      body.innerHTML = rows.length ? `<div class="note">BR/${S(this._sportLabel())} fixtures with no exact-normalized Euro Desk match. Every reviewed fixture is listed individually. Not included in eligible output — review manually.</div><div class="table-wrap"><table>
        <thead><tr><th>Source</th><th>Date</th><th>KO</th><th>Country</th><th>Competition</th><th>Home</th><th>Away</th><th>BR Match ID</th><th>Reason</th><th>Status</th><th>Source Row</th></tr></thead>
        <tbody>${rows.map(m=>`<tr><td>${S(m.source)}</td><td>${S(m.eventDate)}</td><td>${S(m.koRaw)}</td><td>${S(m.country)}</td><td>${S(m.competitionName)}</td><td>${S(m.homeTeam)}</td><td>${S(m.awayTeam)}</td><td class="mono">${S(m.brMatchId)}</td><td>${S(m.reason)}</td><td><span class="badge b-warn">${S(status)}</span></td><td>${S(m.sourceRowNumber)}</td></tr>`).join('')}</tbody></table></div>` : empty('No BR fixtures require review.');
    } else if (this.resultTab==='revbg'){
      const rows = r.bg.notFound;
      const status = 'Competition Not Found in Euro Desk';
      body.innerHTML = rows.length ? `<div class="note">BG fixtures with no exact-normalized Euro Desk match. Every reviewed fixture is listed individually. Not included in eligible output — review manually.</div><div class="table-wrap"><table>
        <thead><tr><th>Source</th><th>Start (UTC+2)</th><th>Competition</th><th>Home</th><th>Away</th><th>Event ID</th><th>Feed</th><th>Reason</th><th>Status</th><th>Source Row</th></tr></thead>
        <tbody>${rows.map(m=>`<tr><td>${S(m.source)}</td><td>${S(m.startDisplay||m.startRaw)}</td><td>${S(m.competitionRaw)}</td><td>${S(m.homeTeam)}</td><td>${S(m.awayTeam)}</td><td class="mono">${S(m.eventId)}</td><td>${S(m.feed)}</td><td>${S(m.reason)}</td><td><span class="badge b-warn">${S(status)}</span></td><td>${S(m.sourceRowNumber)}</td></tr>`).join('')}</tbody></table></div>` : empty('No BG fixtures require review.');
    } else if (this.resultTab==='dis'){
      const brRows = r.br.disregarded.map(m=>({source:m.source||'BR', date:m.eventDate, time:m.koRaw, comp:m.competitionName, home:m.homeTeam, away:m.awayTeam, id:m.brMatchId, edLeague:m.edLeague, edProv:m.edProviderName, edRow:m.edSourceRow, reason:m.reason||'Matched in Euro Desk but marked as disregarded.', status:m.status, row:m.sourceRowNumber}));
      const bgRows = r.bg.disregarded.map(m=>({source:'BG', date:(m.startDisplay||m.startRaw), time:'', comp:m.competitionRaw, home:m.homeTeam, away:m.awayTeam, id:m.eventId, edLeague:m.edLeague, edProv:m.edProviderName, edRow:m.edSourceRow, reason:m.reason||'Matched in Euro Desk but marked as disregarded.', status:m.status, row:m.sourceRowNumber}));
      const rows=[].concat(brRows,bgRows);
      body.innerHTML = rows.length ? `<div class="note">Fixtures whose competition matched a Euro Desk row that is marked disregarded (red). Not eligible.</div><div class="table-wrap"><table>
        <thead><tr><th>Source</th><th>Date</th><th>Time</th><th>Competition</th><th>Home</th><th>Away</th><th>Event ID / BR Match ID</th><th>Euro Desk League</th><th>Matched Provider Name</th><th>Euro Desk Row</th><th>Reason</th><th>Status</th><th>Source Row</th></tr></thead>
        <tbody>${rows.map(x=>`<tr><td>${S(x.source)}</td><td>${S(x.date)}</td><td>${S(x.time)}</td><td>${S(x.comp)}</td><td>${S(x.home)}</td><td>${S(x.away)}</td><td class="mono">${S(x.id)}</td><td>${S(x.edLeague)}</td><td>${S(x.edProv)||'<span class="badge b-dim">—</span>'}</td><td>${S(x.edRow)}</td><td>${S(x.reason)}</td><td><span class="badge b-warn">${S(x.status)}</span></td><td>${S(x.row)}</td></tr>`).join('')}</tbody></table></div>` : empty('No disregarded leagues (colour not read, or none flagged).');
    } else {
      const brRows = r.br.malformed.map(m=>({source:m.source||'BR', row:m.sourceRowNumber, date:m.dateRaw, data:`${m.dateRaw} ${m.koRaw} ${m.homeTeam} - ${m.awayTeam} (${m.competitionName})`, err:m.parseWarning, status:'Malformed'}));
      const bgRows = r.bg.malformed.map(m=>({source:'BG', row:m.sourceRowNumber, date:(m.startDisplay||m.startRaw||''), data:`${m.competitionRaw} | ${m.eventRaw} | ${m.startRaw}`, err:m.parseWarning, status:'Malformed'}));
      const rows=[].concat(brRows,bgRows);
      body.innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>Source</th><th>Source Row</th><th>Date</th><th>Original Data</th><th>Error</th><th>Status</th></tr></thead>
        <tbody>${rows.map(x=>`<tr><td>${S(x.source)}</td><td>${S(x.row)}</td><td>${S(x.date)}</td><td class="mono" style="font-size:11px;">${S(x.data)}</td><td>${S(x.err)}</td><td><span class="badge b-bad">${S(x.status)}</span></td></tr>`).join('')}</tbody></table></div>` : empty('No malformed rows.');
    }
  },

  /* -------- exports -------- */
  _sheetFromObjs(objs){ return XLSX.utils.json_to_sheet(objs.length?objs:[{Note:'(no records)'}]); },
  // Export cell for the duplicate-key flag (join affected Euro Desk source rows).
  _dupExport(m){ return (m.duplicateKey && m.duplicateSourceRows && m.duplicateSourceRows.length) ? ('Yes (rows '+m.duplicateSourceRows.join(', ')+')') : ''; },
  exportBR(){
    if (!this.results){ toast('Run first',true); return; }
    const S=csvSafe;
    const data=this.results.br.eligible.map(m=>({Competition:S(m.competitionName),Country:S(m.country),Week:S(m.week),Date:S(m.eventDate),KO:S(m.koRaw),'Home Team':S(m.homeTeam),'Away Team':S(m.awayTeam),'Neutral Ground':S(m.neutralGround),'BR Match ID':S(m.brMatchId),'Euro Desk League':S(m.edLeague),'Matched Provider Name':S(m.edProviderName),'Matched By':S(this.matchTypeLabel(m.matchType)),'Euro Desk Row':S(m.edSourceRow),'Duplicate Key':S(this._dupExport(m)),Status:S('Eligible'),'Source Row':m.sourceRowNumber}));
    const sheetName = (this._brOnly() ? ('Eligible '+this._sportLabel()) : 'Eligible BR').slice(0,31);
    const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,this._sheetFromObjs(data),sheetName);
    try { XLSX.writeFile(wb,this._fname('Eligible_BR')); } catch(e){ toast('Export failed: '+e.message,true); }
  },
  exportBG(){
    if (!this.results){ toast('Run first',true); return; }
    const S=csvSafe;
    const data=this.results.bg.eligible.map(m=>({Competition:S(m.competitionRaw),'Event ID':S(m.eventId),Event:S(m.eventRaw),'Start (UTC+2)':S(m.startDisplay||m.startRaw),'Home Team':S(m.homeTeam),'Away Team':S(m.awayTeam),Feed:S(m.feed),'Booking Status':S(m.bookingStatus),OST:S(m.ost),'Euro Desk League':S(m.edLeague),'Matched Provider Name':S(m.edProviderName),'Matched By':S(this.matchTypeLabel(m.matchType)),'Euro Desk Row':S(m.edSourceRow),'Duplicate Key':S(this._dupExport(m)),Status:S('Eligible'),'Source Row':m.sourceRowNumber}));
    const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,this._sheetFromObjs(data),'Eligible BG');
    try { XLSX.writeFile(wb,this._fname('Eligible_BG')); } catch(e){ toast('Export failed: '+e.message,true); }
  },
  exportAll(){
    if (!this.results){ toast('Run first',true); return; }
    const S=csvSafe, r=this.results, wb=XLSX.utils.book_new();
    const brOnly = this._brOnly();
    const lbl = this._sportLabel();
    const srcTag = brOnly ? lbl : 'BR';
    const brSheetName = brOnly ? ('Eligible '+lbl).slice(0,31) : 'Eligible BR';
    const edSheetLbl = this.sport==='Ice Hockey' ? 'Ice Hockey Euro Desk sheet'
      : this.sport==='Minor Sports' ? 'Minor Sports Euro Desk sheet'
      : 'Basketball Euro Desk BR sheet';
    XLSX.utils.book_append_sheet(wb,this._sheetFromObjs(r.br.eligible.map(m=>({Competition:S(m.competitionName),Country:S(m.country),Week:S(m.week),Date:S(m.eventDate),KO:S(m.koRaw),Home:S(m.homeTeam),Away:S(m.awayTeam),Neutral:S(m.neutralGround),'BR Match ID':S(m.brMatchId),'Euro Desk League':S(m.edLeague),'Matched Provider Name':S(m.edProviderName),'Matched By':S(this.matchTypeLabel(m.matchType)),'Euro Desk Row':S(m.edSourceRow),'Duplicate Key':S(this._dupExport(m)),'Source Row':m.sourceRowNumber}))),brSheetName);
    if (!brOnly){
      XLSX.utils.book_append_sheet(wb,this._sheetFromObjs(r.bg.eligible.map(m=>({Competition:S(m.competitionRaw),'Event ID':S(m.eventId),Event:S(m.eventRaw),'Start (UTC+2)':S(m.startDisplay||m.startRaw),Home:S(m.homeTeam),Away:S(m.awayTeam),Feed:S(m.feed),'Booking Status':S(m.bookingStatus),OST:S(m.ost),'Euro Desk League':S(m.edLeague),'Matched Provider Name':S(m.edProviderName),'Matched By':S(this.matchTypeLabel(m.matchType)),'Euro Desk Row':S(m.edSourceRow),'Duplicate Key':S(this._dupExport(m)),'Source Row':m.sourceRowNumber}))),'Eligible BG');
    }
    // Review — EVERY reviewed fixture, one-to-one with the UI Review tables. No dedup.
    const review=[].concat(
      r.br.notFound.map(m=>({Source:m.source||srcTag,Date:S(m.eventDate),'Time/KO':S(m.koRaw),Country:S(m.country),Competition:S(m.competitionName),Home:S(m.homeTeam),Away:S(m.awayTeam),'BR Match ID':S(m.brMatchId),Reason:S(m.reason||''),Status:'League Not Found in Euro Desk','Source Row':m.sourceRowNumber})),
      (brOnly?[]:r.bg.notFound.map(m=>({Source:'BG',Date:S(m.startDisplay||m.startRaw),'Time/KO':'',Country:'',Competition:S(m.competitionRaw),Home:S(m.homeTeam),Away:S(m.awayTeam),'BR Match ID':S(m.eventId),Reason:S(m.reason||''),Status:'Competition Not Found in Euro Desk','Source Row':m.sourceRowNumber}))));
    XLSX.utils.book_append_sheet(wb,this._sheetFromObjs(review),'Review');
    const dis=[].concat(
      r.br.disregarded.map(m=>({Source:m.source||srcTag,Date:S(m.eventDate),Time:S(m.koRaw),Competition:S(m.competitionName),Home:S(m.homeTeam),Away:S(m.awayTeam),'Event ID / BR Match ID':S(m.brMatchId),'Euro Desk League':S(m.edLeague),'Matched Provider Name':S(m.edProviderName),'Euro Desk Row':S(m.edSourceRow),Reason:S(m.reason||'Matched in Euro Desk but marked as disregarded.'),Status:S(m.status),'Source Row':m.sourceRowNumber})),
      (brOnly?[]:r.bg.disregarded.map(m=>({Source:'BG',Date:S(m.startDisplay||m.startRaw),Time:'',Competition:S(m.competitionRaw),Home:S(m.homeTeam),Away:S(m.awayTeam),'Event ID / BR Match ID':S(m.eventId),'Euro Desk League':S(m.edLeague),'Matched Provider Name':S(m.edProviderName),'Euro Desk Row':S(m.edSourceRow),Reason:S(m.reason||'Matched in Euro Desk but marked as disregarded.'),Status:S(m.status),'Source Row':m.sourceRowNumber}))));
    XLSX.utils.book_append_sheet(wb,this._sheetFromObjs(dis),'Disregarded');
    const mal=[].concat(
      r.br.malformed.map(m=>({Source:m.source||srcTag,'Source Row':m.sourceRowNumber,Date:S(m.dateRaw),Data:S(`${m.dateRaw} ${m.homeTeam} - ${m.awayTeam}`),Error:S(m.parseWarning),Status:'Malformed'})),
      (brOnly?[]:r.bg.malformed.map(m=>({Source:'BG','Source Row':m.sourceRowNumber,Date:S(m.startDisplay||m.startRaw||''),Data:S(`${m.competitionRaw} | ${m.eventRaw}`),Error:S(m.parseWarning),Status:'Malformed'}))));
    XLSX.utils.book_append_sheet(wb,this._sheetFromObjs(mal),'Malformed');
    const brP = this._brParse();
    const rowTag = brOnly ? lbl : 'BR';
    const summary=[
      {Field:'Sport',Value:this._sportLabel()},{Field:'Check',Value:this.checkType==='3day'?'3-Day':'10th-Day'},
      {Field:'Date Range',Value:`${this.range.start} to ${this.range.end}`},
      {Field:rowTag+' total rows',Value:brP.totalRows},{Field:rowTag+' parsed',Value:brP.matches.length},{Field:rowTag+' eligible',Value:r.br.eligible.length},
      {Field:rowTag+' outside date',Value:r.br.outside.length},{Field:rowTag+' not found',Value:r.br.notFound.length},{Field:rowTag+' malformed',Value:r.br.malformed.length}
    ];
    if (!brOnly){
      summary.push(
        {Field:'BG total rows',Value:this.parsed.bg.totalRows},{Field:'BG parsed',Value:this.parsed.bg.matches.length},{Field:'BG eligible',Value:r.bg.eligible.length},
        {Field:'BG outside date',Value:r.bg.outside.length},{Field:'BG not found',Value:r.bg.notFound.length},{Field:'BG malformed',Value:r.bg.malformed.length});
    }
    XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(summary),'Summary');
    try { XLSX.writeFile(wb,this._fname('All_Results')); } catch(e){ toast('Export failed: '+e.message,true); }
  },
  _fname(kind){ const sp = String(this._sportLabel()).replace(/[^A-Za-z0-9]+/g,'_'); return `${sp}_Shift_${kind}_${this.checkType==='3day'?'3Day':'10thDay'}_${this.range.start}.xlsx`; }
};

document.addEventListener('DOMContentLoaded',()=>V1.init());
