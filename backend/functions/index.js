/* ============================================================================
   Treasury yields + term premia -> Firestore   (Firebase Cloud Functions, 2nd gen)

   Deploy:   firebase deploy --only functions   (run from the backend/ folder)

   Writes the dashboard's `portfolio/rates` doc with BOTH:
     - Treasury yields      DGS1 / DGS5 / DGS10        (FRED, daily constant maturity)
     - Kim-Wright term premia  TP1 / TP5 / TP10         (FRED THREEFYTP{N}, monthly)
   server-side so the FRED API key stays private.

   Yields used to be fetched client-side from Twelve Data, but those Treasury
   symbols (US1Y/US5Y/US10Y) require a paid Twelve Data plan, so they came back
   empty. Sourcing them from FRED here makes both boxes work off one free key.

   Exports:
     scheduledRates  - runs on a schedule (Firebase auto-provisions Cloud Scheduler)
     updateRatesNow  - HTTPS endpoint you open once to test / backfill / diagnose
   ============================================================================ */
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest }  = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

// Set once with:  firebase functions:secrets:set FRED_KEY   (get a free key at fred.stlouisfed.org)
const FRED_KEY = defineSecret('FRED_KEY');

// Set once with:  firebase functions:secrets:set FINNHUB_KEY   (same key the dashboard used client-side is fine)
const FINNHUB_KEY = defineSecret('FINNHUB_KEY');

// Set once with:  firebase functions:secrets:set TWELVE_KEY   (Twelve Data free key, for std-dev / moving averages)
const TWELVE_KEY = defineSecret('TWELVE_KEY');

// FRED series. DGS* = Treasury yields (daily). THREEFYTP* = Kim-Wright term premia (monthly).
const SERIES = {
  DGS1: 'DGS1',  DGS5: 'DGS5',  DGS10: 'DGS10',
  TP1:  'THREEFYTP1', TP5: 'THREEFYTP5', TP10: 'THREEFYTP10',
};

async function latest(sid, key){
  const url = `https://api.stlouisfed.org/fred/series/observations`
    + `?series_id=${sid}&api_key=${key}&file_type=json&sort_order=desc&limit=8`;
  const r = await fetch(url);                        // Node 20+ has global fetch
  if(!r.ok){
    let detail = '';
    try { const b = await r.json(); detail = b.error_message || ''; } catch(_) {}
    throw new Error(`FRED ${sid} -> ${r.status}${detail ? ' ('+detail+')' : ''}`);
  }
  const j = await r.json();
  const obs = (j.observations || []).find(o => o.value && o.value !== '.');  // skip holiday gaps
  return obs ? parseFloat(obs.value) : null;
}

async function updateRates(rawKey){
  const key = (rawKey || '').trim();               // guard against a whitespace/newline secret
  const out = {}, errors = {};
  for(const [field, sid] of Object.entries(SERIES)){
    try { out[field] = await latest(sid, key); }
    catch(e){ console.error(e.message); out[field] = null; errors[field] = e.message; }
  }
  await db.collection('portfolio').doc('rates').set(
    { data: JSON.stringify(out), updatedAt: Date.now() },
    { merge: true }
  );
  console.log('rates written:', out);
  if(Object.keys(errors).length) console.error('rate errors:', errors);
  return { out, errors, keyLength: key.length };
}

/* ============================================================================
   STOCK PRICES -> Firestore   (portfolio/prices)

   Polls Finnhub server-side every 5 min while the US market is open and writes
   a single `portfolio/prices` doc the dashboard reads (cache-first, re-checked
   client-side every minute). Mirrors the rates design so the Finnhub key can
   live in a secret instead of the client.

   Doc shape:  { data: JSON.stringify({ quotes:{TICKER:{price,prev}}, indices:[{k,name,c,pc}] }), updatedAt }

   Exports:
     scheduledPrices  - every 5 min, 9:00–16:55 ET Mon–Fri (gated to 09:30–16:00 inside)
     updatePricesNow  - HTTPS endpoint to test / backfill / diagnose
   ============================================================================ */
const INDEX_SYMS   = [['DIA','Dow'], ['SPY','S&P 500'], ['QQQ','NASDAQ']];
const CASH_TICKERS = new Set(['CASH', 'RCASH', 'JPMPD']);   // never sent to Finnhub

// SEED/fallback list of US equity full-day closures (NYSE/NASDAQ). The
// scheduledHolidays function computes each year's schedule and writes it to
// `portfolio/holidays`; this seed only covers the gap before that doc exists.
// Early-close half-days are intentionally omitted (market is open until 1pm ET).
const MARKET_HOLIDAYS = new Set([
  '2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25','2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25',
  '2027-01-01','2027-01-18','2027-02-15','2027-03-26','2027-05-31','2027-06-18','2027-07-05','2027-09-06','2027-11-25','2027-12-24'
]);
function isMarketOpenET(d = new Date(), holidays = MARKET_HOLIDAYS){
  const p = new Intl.DateTimeFormat('en-US', { timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit', weekday:'short', hour:'2-digit', minute:'2-digit', hour12:false })
    .formatToParts(d).reduce((a,x)=>(a[x.type]=x.value,a),{});
  if(p.weekday==='Sat' || p.weekday==='Sun') return false;
  if(holidays.has(`${p.year}-${p.month}-${p.day}`)) return false;
  const mins = (+p.hour)*60 + (+p.minute);
  return mins >= 570 && mins < 960;   // 09:30 (570) .. 16:00 (960)
}

/* ============================================================================
   MARKET HOLIDAYS -> Firestore   (portfolio/holidays)

   The 10 standard NYSE/NASDAQ full-day closures are rule-based, so the server
   computes them rather than depending on a third-party holiday API: fixed-date
   holidays (New Year, Juneteenth, Independence Day, Christmas) with the NYSE
   observed-date shift (Sat -> preceding Fri, Sun -> following Mon; New Year's on
   a Sat is the lone exception — no Friday closure), the floating Monday/Thursday
   holidays, and Good Friday (2 days before Easter, via the Computus algorithm).
   Note: ad-hoc closures (e.g. national days of mourning) are not rule-based and
   would still need a manual add to the seed list.

   scheduledHolidays runs at the start of each year and writes a rolling window
   [thisYear-1 .. thisYear+1]; both this function (price gating) and the client
   read the doc, falling back to the seed list above.

   Exports:
     scheduledHolidays  - 06:00 ET on Jan 1, writes next year's schedule
     updateHolidaysNow  - HTTPS endpoint to backfill / test immediately
   ============================================================================ */
function nthWeekdayOfMonth(year, month, weekday, n){           // month 1-12, weekday 0=Sun..6=Sat
  const firstDow = new Date(Date.UTC(year, month-1, 1)).getUTCDay();
  const day = 1 + ((weekday - firstDow + 7) % 7) + (n-1)*7;
  return new Date(Date.UTC(year, month-1, day));
}
function lastWeekdayOfMonth(year, month, weekday){
  const last = new Date(Date.UTC(year, month, 0));            // day 0 of next month = last day of this one
  const day  = last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7);
  return new Date(Date.UTC(year, month-1, day));
}
function easterSunday(year){                                   // Anonymous Gregorian (Meeus/Jones/Butcher)
  const a=year%19, b=Math.floor(year/100), c=year%100, d=Math.floor(b/4), e=b%4,
        f=Math.floor((b+8)/25), g=Math.floor((b-f+1)/3), h=(19*a+b-d-g+15)%30,
        i=Math.floor(c/4), k=c%4, l=(32+2*e+2*i-h-k)%7, m=Math.floor((a+11*h+22*l)/451),
        month=Math.floor((h+l-7*m+114)/31), day=((h+l-7*m+114)%31)+1;
  return new Date(Date.UTC(year, month-1, day));
}
const isoUTC = dt => dt.toISOString().slice(0,10);
function observedFixed(year, month, day, isNewYear){
  const dow = new Date(Date.UTC(year, month-1, day)).getUTCDay();
  if(dow===6) return isNewYear ? null : isoUTC(new Date(Date.UTC(year, month-1, day-1)));   // Sat -> Fri (none for New Year)
  if(dow===0) return isoUTC(new Date(Date.UTC(year, month-1, day+1)));                       // Sun -> Mon
  return isoUTC(new Date(Date.UTC(year, month-1, day)));
}
function computeMarketHolidays(year){
  const out = [], push = v => { if(v) out.push(v); };
  push(observedFixed(year, 1, 1, true));                       // New Year's Day
  push(isoUTC(nthWeekdayOfMonth(year, 1, 1, 3)));             // MLK — 3rd Monday Jan
  push(isoUTC(nthWeekdayOfMonth(year, 2, 1, 3)));             // Washington's Birthday — 3rd Monday Feb
  push(isoUTC(new Date(easterSunday(year).getTime() - 2*86400000)));   // Good Friday
  push(isoUTC(lastWeekdayOfMonth(year, 5, 1)));              // Memorial Day — last Monday May
  push(observedFixed(year, 6, 19, false));                    // Juneteenth
  push(observedFixed(year, 7, 4, false));                     // Independence Day
  push(isoUTC(nthWeekdayOfMonth(year, 9, 1, 1)));            // Labor Day — 1st Monday Sep
  push(isoUTC(nthWeekdayOfMonth(year, 11, 4, 4)));           // Thanksgiving — 4th Thursday Nov
  push(observedFixed(year, 12, 25, false));                   // Christmas
  return out;
}
function computeHolidayWindow(){
  const y = new Date().getFullYear();
  const set = new Set(MARKET_HOLIDAYS);                        // keep the seed too, harmless duplicates collapse
  for(const yy of [y-1, y, y+1]) for(const d of computeMarketHolidays(yy)) set.add(d);
  return set;
}
async function writeHolidays(){
  const list = [...computeHolidayWindow()].sort();
  await db.collection('portfolio').doc('holidays').set(
    { data: JSON.stringify(list), updatedAt: Date.now() }, { merge: true }
  );
  console.log('[holidays] wrote', list.length, 'dates through', list[list.length-1]);
  return list;
}
/* Per-instance cache: keeps the price gate's holiday set fresh and writes the
   client doc when it's missing or doesn't yet cover next year (≈ once a year). */
let _holidaySet = new Set(MARKET_HOLIDAYS), _holidayYear = 0;
async function syncHolidays(){
  const y = new Date().getFullYear();
  if(_holidayYear === y) return _holidaySet;                  // already synced this instance, this year
  const computed = computeHolidayWindow();
  try{
    const s = await db.collection('portfolio').doc('holidays').get();
    const stored = s.exists ? JSON.parse(s.data().data) : null;
    const coversNext = Array.isArray(stored) && stored.some(d => d.startsWith((y+1) + '-'));
    if(!coversNext) await writeHolidays();                    // self-heal: keep the client's doc current
  }catch(e){ console.warn('[holidays] sync check failed:', e.message); }
  _holidaySet = computed; _holidayYear = y;
  return _holidaySet;
}

async function quote(sym, key){
  const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${key}`);
  if(!r.ok) throw new Error(`Finnhub ${sym} -> ${r.status}`);
  const j = await r.json();
  return (j && typeof j.c === 'number' && j.c) ? { c:j.c, pc:(typeof j.pc==='number' ? j.pc : j.c) } : null;
}

async function holdingTickers(){
  const s = await db.collection('portfolio').doc('holdings').get();
  if(!s.exists) return [];
  let arr; try { arr = JSON.parse(s.data().data); } catch(_) { return []; }
  const ts = (arr || []).map(h => h.t).filter(Boolean).filter(t => !CASH_TICKERS.has(t));
  return [...new Set(ts)];
}

async function updatePrices(rawKey){
  const key = (rawKey || '').trim();               // guard against a whitespace/newline secret
  const quotes = {}, errors = {};
  for(const t of await holdingTickers()){
    try { const q = await quote(t, key); if(q) quotes[t] = { price:q.c, prev:q.pc }; }
    catch(e){ console.error(e.message); errors[t] = e.message; }
  }
  const indices = [];
  for(const [k, name] of INDEX_SYMS){
    try { const q = await quote(k, key); if(q) indices.push({ k, name, c:q.c, pc:q.pc }); }
    catch(e){ console.error(e.message); errors[k] = e.message; }
  }
  await db.collection('portfolio').doc('prices').set(
    { data: JSON.stringify({ quotes, indices }), updatedAt: Date.now() },
    { merge: true }
  );
  console.log('prices written:', Object.keys(quotes).length, 'tickers,', indices.length, 'indices');
  if(Object.keys(errors).length) console.error('price errors:', errors);
  return { tickers: Object.keys(quotes).length, indices: indices.length, errors, keyLength: key.length };
}

exports.scheduledPrices = onSchedule(
  { schedule: '*/5 9-16 * * 1-5', timeZone: 'America/New_York', secrets: [FINNHUB_KEY], region: 'us-central1' },
  async () => {
    const holidays = await syncHolidays();
    if(isMarketOpenET(new Date(), holidays)) await updatePrices(FINNHUB_KEY.value());
    else console.log('market closed — skipping price fetch');
  }
);

exports.updatePricesNow = onRequest(
  { cors: true, secrets: [FINNHUB_KEY], region: 'us-central1' },
  async (req, res) => {
    try {
      const holidays = await syncHolidays();
      const { tickers, indices, errors, keyLength } = await updatePrices(FINNHUB_KEY.value());
      res.json({
        ok: true,
        marketOpen: isMarketOpenET(new Date(), holidays),
        keyConfigured: keyLength > 0,   // false => the FINNHUB_KEY secret is empty
        keyLength,                      // never returns the key itself
        tickers, indices, errors,
      });
    } catch(e){ console.error(e); res.status(500).json({ ok:false, error:e.message }); }
  }
);

/* ============================================================================
   BETA + P/E -> Firestore   (portfolio/metrics)

   Daily Finnhub `stock/metric` pull (once is plenty — these barely move) for the
   held tickers, written to the `portfolio/metrics` doc the dashboard reads.
   Doc shape matches the old client writes:  { data: JSON.stringify({T:{beta,pe}}), updatedAt }
   ============================================================================ */
async function updateMetrics(rawKey){
  const key = (rawKey || '').trim();
  const map = {}, errors = {};
  for(const t of await holdingTickers()){
    try{
      const r = await fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(t)}&metric=all&token=${key}`);
      if(!r.ok) throw new Error(`Finnhub ${t} -> ${r.status}`);
      const j = await r.json(); const m = (j && j.metric) || {};
      map[t] = { beta: m.beta || 0, pe: m.peNormalizedAnnual || m.peTTM || 0 };
    }catch(e){ console.error(e.message); errors[t] = e.message; }
  }
  await db.collection('portfolio').doc('metrics').set(
    { data: JSON.stringify(map), updatedAt: Date.now() }, { merge: true }
  );
  console.log('metrics written:', Object.keys(map).length, 'tickers');
  if(Object.keys(errors).length) console.error('metric errors:', errors);
  return { tickers: Object.keys(map).length, errors, keyLength: key.length };
}

exports.scheduledMetrics = onSchedule(
  { schedule: '30 17 * * 1-5', timeZone: 'America/New_York', secrets: [FINNHUB_KEY], region: 'us-central1' },   // 17:30 ET, after close
  async () => { await updateMetrics(FINNHUB_KEY.value()); }
);

exports.updateMetricsNow = onRequest(
  { cors: true, secrets: [FINNHUB_KEY], region: 'us-central1' },
  async (req, res) => {
    try { const o = await updateMetrics(FINNHUB_KEY.value()); res.json({ ok:true, keyConfigured:o.keyLength>0, ...o }); }
    catch(e){ console.error(e); res.status(500).json({ ok:false, error:e.message }); }
  }
);

/* ============================================================================
   STD-DEV + MOVING AVERAGES -> Firestore   (portfolio/stdev_7d / 30d / 252d)

   Mirrors the old client logic exactly, on the same cadence (per-period
   staleness: 7d daily, 30d weekly, 252d monthly — a daily weekday run refreshes
   each window only when its period key rolls over). Per stale ticker: one Twelve
   Data daily time_series (outputsize scaled to the widest stale window), sample
   std-dev of log returns + mean of closes per window, 8s spacing for the free
   tier (8/min). Doc shape matches the old client writes:
     portfolio/stdev_{p} = { data: JSON.stringify({ data:{T:{s,ma}}, updatedAt:{T:key} }), updatedAt }
   ============================================================================ */
const delay = ms => new Promise(r => setTimeout(r, ms));
const STDEV_PERIODS = [
  { p:'7d',   sf:'s7',   mf:'ma7',   win:7,   out:10  },
  { p:'30d',  sf:'s30',  mf:'ma30',  win:30,  out:35  },
  { p:'252d', sf:'s252', mf:'ma252', win:252, out:260 },
];
function stddev(arr){ if(!arr || arr.length<2) return null; const m=arr.reduce((a,b)=>a+b,0)/arr.length; const v=arr.reduce((s,x)=>s+(x-m)**2,0)/(arr.length-1); return Math.sqrt(v); }
function mean(a){ return a.length ? a.reduce((x,y)=>x+y,0)/a.length : null; }
function stdevPeriodKeys(){
  const today    = new Date().toISOString().slice(0,10);
  const weekKey  = (()=>{ const d=new Date(); d.setUTCDate(d.getUTCDate()-d.getUTCDay()); return d.toISOString().slice(0,10); })();
  const monthKey = new Date().toISOString().slice(0,7);
  return { '7d':today, '30d':weekKey, '252d':monthKey };
}
async function updateStdev(rawKey){
  const key = (rawKey || '').trim();
  const tickers = await holdingTickers();
  const periodKey = stdevPeriodKeys();
  const docs = {};
  for(const { p } of STDEV_PERIODS){
    try{ const s = await db.collection('portfolio').doc(`stdev_${p}`).get(); docs[p] = s.exists ? JSON.parse(s.data().data) : null; }
    catch(_){ docs[p] = null; }
    docs[p] = docs[p] || {}; docs[p].data = docs[p].data || {}; docs[p].updatedAt = docs[p].updatedAt || {};
  }
  const staleByPeriod = {}, staleAll = new Set();
  for(const { p } of STDEV_PERIODS){
    staleByPeriod[p] = tickers.filter(t => docs[p].updatedAt[t] !== periodKey[p]);
    staleByPeriod[p].forEach(t => staleAll.add(t));
  }
  const errors = {}; let fetched = 0;
  for(const t of staleAll){
    const need = STDEV_PERIODS.filter(({ p }) => staleByPeriod[p].includes(t));
    const outputsize = Math.max(...need.map(n => n.out));
    let ok = false;
    for(let attempt=0; attempt<=2 && !ok; attempt++){
      try{
        if(attempt>0) await delay(8000);
        const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(t)}&interval=1day&outputsize=${outputsize}&apikey=${key}`;
        const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
        const d = await r.json();
        if(!d || d.status==='error' || !d.values || d.values.length < 8) continue;
        const closes = [...d.values].reverse().map(v => parseFloat(v.close));
        const rets = []; for(let i=1;i<closes.length;i++) rets.push(Math.log(closes[i]/closes[i-1]));
        for(const { p, sf, mf, win } of need){
          const s = stddev(rets.slice(-win)), m = mean(closes.slice(-win));
          docs[p].data[t] = docs[p].data[t] || {};
          if(s!=null) docs[p].data[t][sf] = s;
          if(m!=null) docs[p].data[t][mf] = m;
          docs[p].updatedAt[t] = periodKey[p];
        }
        ok = true; fetched++;
      }catch(e){ /* retry up to 3x */ }
    }
    if(!ok) errors[t] = 'fetch failed';
    await delay(8000);   // Twelve Data free tier: 8 calls/min
  }
  // drop tickers no longer held, then persist each period doc
  const active = new Set(tickers);
  for(const { p } of STDEV_PERIODS){
    for(const t of Object.keys(docs[p].data)){ if(!active.has(t)){ delete docs[p].data[t]; delete docs[p].updatedAt[t]; } }
    await db.collection('portfolio').doc(`stdev_${p}`).set({ data: JSON.stringify(docs[p]), updatedAt: Date.now() }, { merge: true });
  }
  console.log('stdev written: fetched', fetched, 'of', staleAll.size, 'stale tickers');
  if(Object.keys(errors).length) console.error('stdev errors:', errors);
  return { stale: staleAll.size, fetched, errors, keyLength: key.length };
}

exports.scheduledStdev = onSchedule(
  { schedule: '45 17 * * 1-5', timeZone: 'America/New_York', timeoutSeconds: 540, secrets: [TWELVE_KEY], region: 'us-central1' },   // 17:45 ET, after close
  async () => { await updateStdev(TWELVE_KEY.value()); }
);

exports.updateStdevNow = onRequest(
  { cors: true, timeoutSeconds: 540, secrets: [TWELVE_KEY], region: 'us-central1' },
  async (req, res) => {
    try { const o = await updateStdev(TWELVE_KEY.value()); res.json({ ok:true, keyConfigured:o.keyLength>0, ...o }); }
    catch(e){ console.error(e); res.status(500).json({ ok:false, error:e.message }); }
  }
);

exports.scheduledHolidays = onSchedule(
  { schedule: '0 6 1 1 *', timeZone: 'America/New_York', region: 'us-central1' },   // 06:00 ET, Jan 1
  async () => { _holidayYear = 0; await writeHolidays(); }
);

exports.updateHolidaysNow = onRequest(
  { region: 'us-central1' },
  async (req, res) => {
    try { const list = await writeHolidays(); res.json({ ok:true, count:list.length, holidays:list }); }
    catch(e){ console.error(e); res.status(500).json({ ok:false, error:e.message }); }
  }
);

exports.scheduledRates = onSchedule(
  { schedule: '0 18 * * 1-5', timeZone: 'America/Chicago', secrets: [FRED_KEY], region: 'us-central1' },
  async () => { await updateRates(FRED_KEY.value()); }
);

exports.updateRatesNow = onRequest(
  { secrets: [FRED_KEY], region: 'us-central1' },
  async (req, res) => {
    try {
      const { out, errors, keyLength } = await updateRates(FRED_KEY.value());
      res.json({
        ok: true,
        keyConfigured: keyLength > 0,   // false => the FRED_KEY secret is empty
        keyLength,                      // expect ~32; never returns the key itself
        rates: out,
        errors,                         // per-series FRED error messages, if any
      });
    } catch(e){ console.error(e); res.status(500).json({ ok:false, error:e.message }); }
  }
);
