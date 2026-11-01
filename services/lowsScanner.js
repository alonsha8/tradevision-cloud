// services/lowsScanner.js — סורק "קרוב לשפל 52 שבועות" עם ציון השקעה לטווח קצר ולטווח ארוך
//
// שלב 1: מכל מניות הסורק — רק מניות שהמחיר שלהן עד X% מעל השפל של 52 השבועות.
// שלב 2: לכל מועמדת שני ציונים (0–100), מחושבים בקוד מנתונים בלבד:
//   • טווח קצר — "ציון היפוך": האם הירידה נעצרת ומתחילה התאוששות (מכירת-יתר שמתהפכת,
//     מומנטום שמשתפר, השפל מחזיק, מחזורים, יחס סיכוי/סיכון).
//   • טווח ארוך — הציון של "טווח ארוך" (איכות + איתנות + שווי + מגמה) מדוחות SEC.
// שלב 3: מוצגות מניות שלפחות אחד הציונים עובר את הסף (ברירת מחדל 85).

const { analyze, rsi: rsiCalc, macd: macdCalc, sma } = require('./analysisEngine');
const { US, TA } = require('./universe');
const scanner = require('./scanner');
const { analyzeLongTerm } = require('./longTerm');

const getBars = (...a) => require('../routes/stockAnalysisApi').getBars(...a);

// ---------- ציון היפוך לטווח קצר ----------
function reversalScore(bars, tech) {
  const c = bars.map(b => b.c), v = bars.map(b => b.v || 0), n = c.length, i = n - 1;
  const R = rsiCalc(c, 14), M = macdCalc(c), s20 = sma(c, 20), vAvg = sma(v, 20);
  const parts = {}, notes = [];

  // 1. מכירת-יתר שמתהפכת (25)
  const rsiMin10 = Math.min(...R.slice(-10).filter(x => x != null));
  const rsiNow = R[i];
  if (rsiMin10 < 35 && rsiNow - rsiMin10 >= 5) { parts.oversoldTurn = 25; notes.push(`RSI ירד ל-${rsiMin10.toFixed(0)} ועלה ל-${rsiNow.toFixed(0)} — מכירת-יתר שמתהפכת`); }
  else if (rsiMin10 < 40 && rsiNow > rsiMin10) { parts.oversoldTurn = 15; notes.push(`RSI עולה מ-${rsiMin10.toFixed(0)}`); }
  else parts.oversoldTurn = rsiNow < 30 ? 5 : 0;

  // 2. מומנטום מתהפך (20)
  const h = M.hist;
  let mom = 0;
  if (h[i] > h[i - 1] && h[i - 1] > h[i - 2] && h[i - 2] > h[i - 3]) { mom += 10; notes.push('היסטוגרמת MACD עולה 3 ימים ברציפות'); }
  const crossed = [0, 1, 2, 3, 4].some(k => M.macd[i - k] > M.signal[i - k] && M.macd[i - k - 1] <= M.signal[i - k - 1]);
  if (crossed) { mom += 10; notes.push('MACD חצה מעל קו האיתות ב-5 הימים האחרונים'); }
  parts.momentum = mom;

  // 3. השפל מחזיק (20)
  const lows = bars.slice(-252).map(b => b.l);
  const lowIdxFromEnd = lows.length - 1 - lows.lastIndexOf(Math.min(...lows));
  let hold = 0;
  if (lowIdxFromEnd >= 10) { hold += 10; notes.push(`לא נקבע שפל חדש כבר ${lowIdxFromEnd} ימי מסחר`); }
  if (c[i] > s20[i]) { hold += 10; notes.push('המחיר חזר מעל ממוצע 20 יום'); }
  parts.lowHolding = hold;

  // 4. מחזורים (15)
  let vol = 0;
  const spike = bars.slice(-30).some((b, k) => { const idx = n - 30 + k; return vAvg[idx] && b.v > 2 * vAvg[idx] && b.c < c[idx - 1]; });
  if (spike) { vol += 8; notes.push('יום ירידה במחזור כפול מהממוצע — סימן אפשרי לכניעת מוכרים'); }
  let upV = 0, dnV = 0;
  for (let k = n - 10; k < n; k++) { if (c[k] > c[k - 1]) upV += v[k]; else if (c[k] < c[k - 1]) dnV += v[k]; }
  if (upV > dnV && upV > 0) { vol += 7; notes.push('מחזור בימי עלייה גבוה ממחזור בימי ירידה (10 ימים)'); }
  parts.volume = vol;

  // 5. סיכוי/סיכון (20): סטופ מתחת לשפל, יעד בהתנגדות הקרובה
  const atr = tech.indicators.atr, low52 = tech.indicators.low52;
  const stop = Math.min(low52, c[i]) - 0.5 * atr;
  const R1 = (tech.resistances || [])[0];
  let rr = null, rrPts = 0;
  if (R1 && R1.price > c[i] && c[i] > stop) {
    rr = (R1.price - c[i]) / (c[i] - stop);
    rrPts = rr >= 3 ? 20 : rr >= 2 ? 14 : rr >= 1.5 ? 8 : 0;
    notes.push(`יחס סיכוי/סיכון 1:${rr.toFixed(1)} (סטופ מתחת לשפל השנתי, יעד בהתנגדות הקרובה)`);
  }
  parts.riskReward = rrPts;

  let total = parts.oversoldTurn + parts.momentum + parts.lowHolding + parts.volume + parts.riskReward;
  if (tech.meta.regime && tech.meta.regime.ok === false) { total = Math.max(0, total - 10); notes.push(`קנס 10: השוק הרחב (${tech.meta.regime.label}) מתחת לממוצע 200`); }
  return {
    total, parts, notes,
    plan: R1 && rr ? { entry: c[i], stop: +stop.toFixed(4), target: R1.price, rr: +rr.toFixed(1) } : null,
  };
}

// ---------- ריצה ברקע ----------
let job = { state: 'idle' };
let last = null;

async function run(params) {
  const { market, nearPct, threshold } = params;
  const markets = market === 'all' ? ['US', 'TA'] : [market === 'ta' ? 'TA' : 'US'];
  job = { state: 'running', params, startedAt: Date.now(), progress: { stage: 'סורק מחירים', done: 0, total: 0 } };

  const scans = [];
  for (const m of markets) scans.push(await scanner.scanMarket(m));
  const all = scans.flatMap(s => s.rows);
  const near = all.filter(r => r.dataOk !== false && r.pctFrom52Low != null && r.pctFrom52Low <= nearPct);
  job.progress = { stage: 'מנתח מועמדות', done: 0, total: near.length };

  const rows = [], failed = [];
  for (const r of near) {
    job.progress.current = r.ticker;
    try {
      const { bars, meta } = await getBars(r.ticker);
      const ctx = await scanner.context(r.ticker);
      const tech = analyze(bars, { ...meta, ...ctx });
      if (!tech.dataQuality.ok) { failed.push({ ticker: r.ticker, error: 'נתונים לא תקינים: ' + tech.dataQuality.blocking[0] }); continue; }
      const st = reversalScore(bars, tech);
      let lt = null;
      try {
        const L = await analyzeLongTerm(r.ticker);
        lt = L.fundamentals ? { total: L.score.total, parts: { quality: L.score.quality, balance: L.score.balance, valuation: L.score.valuation, trend: L.score.trend }, verdict: L.verdict.title, code: L.verdict.code,
          marginOfSafety: L.fundamentals.valuation ? L.fundamentals.valuation.marginOfSafety : null, plan: L.verdict.plan } : { total: null, reason: (L.missing || [])[0] || 'אין דוחות' };
      } catch (e) { lt = { total: null, reason: e.message }; }
      rows.push({
        ticker: r.ticker, name: meta.name, currency: meta.currency, price: tech.indicators.close,
        low52: tech.indicators.low52, high52: tech.indicators.high52, pctFrom52Low: +r.pctFrom52Low.toFixed(1), pctFrom52High: +r.pctFrom52High.toFixed(1),
        short: st, long: lt, engineVerdict: tech.verdict.title, warnings: tech.dataQuality.warnings,
        passShort: st.total >= threshold, passLong: lt.total != null && lt.total >= threshold,
      });
    } catch (e) { failed.push({ ticker: r.ticker, error: e.message }); }
    job.progress.done++;
    await new Promise(res => setImmediate(res));
  }
  const best = x => Math.max(x.short.total, x.long.total ?? 0);
  rows.sort((a, b) => best(b) - best(a));
  last = {
    params, finishedAt: Date.now(), seconds: Math.round((Date.now() - job.startedAt) / 1000),
    scanned: all.length, nearCount: near.length, regime: Object.fromEntries(scans.map(s => [s.market, s.regime])),
    passed: rows.filter(x => x.passShort || x.passLong), close: rows.filter(x => !(x.passShort || x.passLong) && best(x) >= threshold - 15),
    all: rows, failed,
  };
  job = { state: 'done', params };
}

function start(body) {
  if (job.state === 'running') return job;
  const params = {
    market: ['us', 'ta', 'all'].includes(body.market) ? body.market : 'all',
    nearPct: Math.min(Math.max(+body.nearPct || 15, 3), 40),
    threshold: Math.min(Math.max(+body.threshold || 85, 50), 100),
  };
  run(params).catch(e => { job = { state: 'error', params, error: e.message }; });
  return { state: 'running', params };
}

function status() {
  return { ...job, result: job.state === 'done' || job.state === 'idle' ? last : null };
}

module.exports = { start, status, reversalScore, _last: () => last };
