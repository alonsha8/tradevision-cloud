// services/longTerm.js — ניתוח מניה להחזקה של 1–5 שנים
//
// כל המספרים מחושבים מדוחות רשמיים (SEC) ומנתוני מחיר — ללא AI.
// ציון שקוף בכללים קבועים: איכות (50) + איתנות (15) + שווי (25) + מגמה ארוכה (10) = 100.

const { getFundamentals } = require('./secFacts');
const { analyze } = require('./analysisEngine');
const yc = require('./yahooCache');

const getBars = (...a) => require('../routes/stockAnalysisApi').getBars(...a);
const resolveSymbol = (...a) => require('../routes/stockAnalysisApi').resolveSymbol(...a);

const cagr = (a, b, years) => (a > 0 && b > 0 && years > 0 ? Math.pow(b / a, 1 / years) - 1 : null);
const pct = x => (x == null ? null : +(x * 100).toFixed(1));
const last = arr => arr[arr.length - 1];
const byEnd = arr => Object.fromEntries(arr.map(y => [y.end, y.val]));

// DCF פשוט ושמרני: 5 שנות צמיחה + ערך שארית, הוון לפי שיעור היוון
function dcfPerShare(fcf, growth, discount, terminal, shares, netCash) {
  if (!(fcf > 0) || !(shares > 0)) return null;
  let pv = 0, f = fcf;
  for (let y = 1; y <= 5; y++) { f *= 1 + growth; pv += f / Math.pow(1 + discount, y); }
  const tv = (f * (1 + terminal)) / (discount - terminal);
  pv += tv / Math.pow(1 + discount, 5);
  return (pv + (netCash || 0)) / shares;
}

async function monthlyHistory(symbol) {
  try {
    const r = await yc.getChart(symbol, '1mo', '10y');
    const j = JSON.parse(r.body), res = j.chart.result[0];
    const q = res.indicators.quote[0];
    const adj = res.indicators.adjclose && res.indicators.adjclose[0] && res.indicators.adjclose[0].adjclose;
    return res.timestamp.map((t, i) => ({ t, c: (adj && adj[i]) || q.close[i] })).filter(x => x.c > 0);
  } catch (e) { return []; }
}

async function analyzeLongTerm(query) {
  const symbol = await resolveSymbol(query);
  const [{ bars, meta }, fund, monthly] = await Promise.all([
    getBars(symbol),
    getFundamentals(symbol).catch(e => ({ available: false, reason: e.message })),
    monthlyHistory(symbol),
  ]);
  const tech = analyze(bars, { ...meta });
  const price = tech.indicators.close;
  const out = { symbol, name: meta.name, currency: meta.currency, price, asOf: tech.asOf, fundamentals: null, missing: [], warnings: [...tech.dataQuality.warnings] };
  if (!tech.dataQuality.ok) out.warnings.unshift(...tech.dataQuality.blocking);

  // ---------- מגמה ארוכה (מחירים מותאמים לדיבידנדים ופיצולים) ----------
  const lt = {};
  if (monthly.length >= 13) {
    const lastM = last(monthly);
    const back = yrs => monthly.find(m => m.t >= lastM.t - yrs * 365.25 * 86400);
    const m5 = back(5), m3 = back(3), m1 = back(1);
    const span = m => (lastM.t - m.t) / (365.25 * 86400);
    if (m1) lt.ret1y = pct(lastM.c / m1.c - 1);
    if (m3 && span(m3) > 2.5) lt.cagr3y = pct(cagr(m3.c, lastM.c, span(m3)));
    if (m5 && span(m5) > 4.5) lt.cagr5y = pct(cagr(m5.c, lastM.c, span(m5)));
    let peak = 0, mdd = 0;
    for (const m of monthly.filter(m => m.t >= lastM.t - 5 * 365.25 * 86400)) { peak = Math.max(peak, m.c); mdd = Math.max(mdd, 1 - m.c / peak); }
    lt.maxDrawdown5y = pct(mdd);
  }
  lt.aboveSma200 = tech.indicators.sma200 != null ? price > tech.indicators.sma200 : null;
  lt.fromHigh52 = pct(price / tech.indicators.high52 - 1);
  out.longTrend = lt;

  // ---------- דוחות ----------
  let q = null, bal = null, val = null;
  const F = fund && fund.available ? fund : null;
  if (!F) out.missing.push(fund && fund.reason ? fund.reason : 'אין נתוני דוחות');
  if (F) {
    const Y = F.years;
    const rev = Y.revenue, ni = byEnd(Y.netIncome), op = byEnd(Y.opIncome), ocf = byEnd(Y.ocf), capex = byEnd(Y.capex), eq = byEnd(Y.equity);
    const ends = rev.map(r => r.end);
    const n = rev.length;
    if (n < 3) out.missing.push(`רק ${n} שנות דוחות — נדרשות לפחות 3`);
    const yrs = n >= 2 ? (new Date(rev[n - 1].end) - new Date(rev[0].end)) / (365.25 * 86400000) : 0;
    const revCagr = n >= 3 ? cagr(rev[0].val, rev[n - 1].val, yrs) : null;
    const eps = Y.epsDiluted;
    const epsCagr = eps.length >= 3 ? cagr(eps[0].val, last(eps).val, (new Date(last(eps).end) - new Date(eps[0].end)) / (365.25 * 86400000)) : null;
    const lastEnd = ends[n - 1];
    const fcfBy = Object.fromEntries(ends.filter(e => ocf[e] != null).map(e => [e, ocf[e] - (capex[e] || 0)]));
    const fcfVals = Object.values(fcfBy);
    const opMargin = lastEnd && op[lastEnd] != null ? op[lastEnd] / rev[n - 1].val : null;
    const netMargin = lastEnd && ni[lastEnd] != null ? ni[lastEnd] / rev[n - 1].val : null;
    const eqEnds = Object.keys(eq).sort();
    const roe = lastEnd && ni[lastEnd] != null && eqEnds.length >= 2
      ? ni[lastEnd] / ((eq[eqEnds[eqEnds.length - 1]] + eq[eqEnds[eqEnds.length - 2]]) / 2) : null;
    const revUpYears = rev.slice(1).filter((r, k) => r.val > rev[k].val).length;
    if (Y.capex.length === 0) out.missing.push('אין נתון השקעות הוניות — התזרים החופשי שווה לתזרים מפעילות');

    q = {
      years: n, revenueCagr: pct(revCagr), revenueUpYears: `${revUpYears}/${Math.max(n - 1, 0)}`, epsCagr: pct(epsCagr),
      opMargin: pct(opMargin), netMargin: pct(netMargin), roe: pct(roe),
      fcfLast: fcfBy[lastEnd] ?? null, fcfPositiveYears: `${fcfVals.filter(x => x > 0).length}/${fcfVals.length}`,
      fcfMargin: fcfBy[lastEnd] != null ? pct(fcfBy[lastEnd] / rev[n - 1].val) : null,
    };

    const lastOf = arr => (arr.length ? last(arr) : null);
    const debt = (lastOf(Y.debtLT) ? lastOf(Y.debtLT).val : 0) + (lastOf(Y.debtST) ? lastOf(Y.debtST).val : 0);
    const cash = lastOf(Y.cash) ? lastOf(Y.cash).val : null;
    const equity = lastOf(Y.equity) ? lastOf(Y.equity).val : null;
    const sh = Y.dilutedShares;
    const dilution = sh.length >= 3 ? cagr(sh[0].val, last(sh).val, (new Date(last(sh).end) - new Date(sh[0].end)) / (365.25 * 86400000)) : null;
    bal = {
      debt, cash, netCash: cash != null ? cash - debt : null,
      debtToEquity: equity > 0 ? +(debt / equity).toFixed(2) : null, negativeEquity: equity != null && equity <= 0,
      shareChangePerYear: pct(dilution), debtKnown: Y.debtLT.length + Y.debtST.length > 0,
    };
    if (!bal.debtKnown) out.missing.push('לא נמצא נתון חוב בדוחות — ייתכן שאין לחברה חוב, או שהוא מדווח בשם אחר');

    // ---------- שווי ----------
    const shares = (F.sharesOut && F.sharesOut.val) || (sh.length ? last(sh).val : null);
    // מחיר בדולר: מניה אמריקאית — המחיר שלה; מניה דואלית בת"א — המחיר של המסחר בארה"ב (הדוחות בדולר)
    let usdPrice = !symbol.endsWith('.TA') && meta.currency === 'USD' ? price : null;
    if (symbol.endsWith('.TA') && F.usTicker) {
      try { const b2 = await getBars(F.usTicker); usdPrice = last(b2.bars).c; out.usTicker = F.usTicker; } catch (e) { /* */ }
    }
    if (F.currency !== 'USD') out.missing.push(`הדוחות במטבע ${F.currency} — חישובי השווי מושבתים כדי למנוע טעות המרה`);
    if (usdPrice && shares && F.currency === 'USD') {
      const mcap = usdPrice * shares;
      const fcfAvg3 = fcfVals.slice(-3).reduce((s, x) => s + x, 0) / Math.min(3, fcfVals.length || 1);
      const baseFcf = Math.min(q.fcfLast ?? fcfAvg3, fcfAvg3 > 0 ? fcfAvg3 * 1.25 : Infinity); // לא מסתמכים על שנה חריגה אחת
      const g = Math.max(0, Math.min(revCagr ?? 0, 0.15));
      const netCash = bal.netCash ?? 0;
      const scen = {
        conservative: dcfPerShare(baseFcf, g * 0.5, 0.10, 0.02, shares, netCash),
        base: dcfPerShare(baseFcf, g, 0.09, 0.025, shares, netCash),
        optimistic: dcfPerShare(baseFcf, Math.min(g * 1.3, 0.2), 0.085, 0.03, shares, netCash),
      };
      val = {
        price: usdPrice, shares, marketCap: mcap,
        pe: ni[lastEnd] > 0 ? +(mcap / ni[lastEnd]).toFixed(1) : null,
        pFcf: q.fcfLast > 0 ? +(mcap / q.fcfLast).toFixed(1) : null,
        fcfYield: q.fcfLast != null ? pct(q.fcfLast / mcap) : null,
        dcf: scen.base ? Object.fromEntries(Object.entries(scen).map(([k, v]) => [k, v == null ? null : +v.toFixed(2)])) : null,
        marginOfSafety: scen.base ? pct(scen.base / usdPrice - 1) : null,
        assumptions: { baseFcf, growth: pct(g), discount: 9, terminal: 2.5 },
      };
      if (!scen.base) out.missing.push('תזרים חופשי שלילי — אין הערכת שווי DCF');
      // הצלבה עם מקור שני (Yahoo): שווי שוק
      try {
        const qr = JSON.parse((await yc.getQuote(F.usTicker)).body).quoteResponse.result[0];
        if (qr && qr.marketCap) {
          const diff = Math.abs(mcap / qr.marketCap - 1);
          val.crossCheck = { yahooMarketCap: qr.marketCap, diffPct: pct(diff) };
          if (diff > 0.25) out.warnings.push(`שווי השוק לפי הדוחות שונה ב-${pct(diff)}% מ-Yahoo — ייתכן שינוי במספר המניות (פיצול / רכישה עצמית / כמה סוגי מניות)`);
        }
      } catch (e) { /* הצלבה היא תוספת בלבד */ }
    }
    out.fundamentals = { source: F.source, name: F.name, currency: F.currency, lastFiled: F.lastFiled, revenue: rev, quality: q, balance: bal, valuation: val };
  }

  // ---------- ציון ----------
  const s = { quality: null, balance: null, valuation: null, trend: 0 };
  const band = (x, steps) => { if (x == null) return 0; for (const [min, pts] of steps) if (x >= min) return pts; return 0; };
  if (q && q.years >= 3) {
    s.quality = band(q.revenueCagr, [[10, 10], [5, 7], [0, 3]]) + band(q.epsCagr, [[10, 10], [5, 7], [0, 3]])
      + band(q.opMargin, [[20, 10], [10, 7], [5, 4]]) + band(q.roe, [[20, 10], [12, 7], [8, 4]])
      + (q.fcfPositiveYears && q.fcfPositiveYears.split('/')[0] === q.fcfPositiveYears.split('/')[1] ? 5 : 0) + band(q.fcfMargin, [[10, 5], [5, 3]]);
  }
  if (bal) {
    s.balance = bal.negativeEquity ? 0 : (bal.debtToEquity == null ? 5 : band(-bal.debtToEquity, [[-0.5, 10], [-1, 6], [-2, 3]]))
      + (bal.netCash > 0 ? 3 : 0) + (bal.shareChangePerYear != null && bal.shareChangePerYear <= 1 ? 2 : 0);
  }
  if (val && val.marginOfSafety != null) s.valuation = band(val.marginOfSafety, [[20, 25], [0, 16], [-20, 8]]);
  s.trend = (lt.aboveSma200 ? 5 : 0) + (lt.cagr5y > 0 ? 5 : lt.cagr3y > 0 ? 3 : 0);
  const total = (s.quality ?? 0) + (s.balance ?? 0) + (s.valuation ?? 0) + s.trend;
  out.score = { ...s, total, max: 100 };

  // ---------- החלטה ----------
  const why = [];
  let verdict;
  if (!q || q.years < 3 || s.quality == null) {
    verdict = { code: 'nodata', title: 'אין מספיק נתוני דוחות להחלטה לטווח ארוך' };
    why.push(...out.missing);
  } else if (s.quality >= 30 && (s.balance ?? 0) >= 6 && (s.valuation ?? 0) >= 16) {
    verdict = { code: 'buy', title: 'מתאים לתיק לטווח ארוך' };
    why.push('חברה איכותית: צמיחה, רווחיות ותזרים', 'מאזן סביר', `מחיר מתחת להערכת השווי הבסיסית (מרווח ביטחון ${val.marginOfSafety}%)`);
  } else if (s.quality >= 30 && (s.balance ?? 0) >= 6) {
    verdict = { code: 'watch', title: 'חברה טובה — אבל המחיר יקר כרגע' };
    why.push('איכות ומאזן עומדים בקריטריונים', val && val.marginOfSafety != null ? `המחיר גבוה ב-${Math.abs(val.marginOfSafety)}% מהערכת השווי הבסיסית` : 'אין הערכת שווי אמינה', 'להוסיף לרשימת מעקב ולקנות בתיקון');
  } else {
    verdict = { code: 'no', title: 'לא עומד בקריטריונים לטווח ארוך' };
    if (s.quality < 30) why.push(`איכות נמוכה (${s.quality}/50): צמיחה, רווחיות או תזרים חלשים`);
    if ((s.balance ?? 0) < 6) why.push(`מאזן חלש (${s.balance ?? 0}/15): חוב גבוה, הון שלילי או דילול`);
  }
  // תזמון כניסה מהמנוע הטכני: צבירה בשלוש מנות
  const sup = tech.supports || [];
  let plan = [];
  if (verdict.code === 'buy') {
    plan = [
      lt.aboveSma200 ? { part: '⅓', when: 'עכשיו', price } : { part: '⅓', when: 'כשהמחיר יחזור מעל ממוצע 200 יום', price: tech.indicators.sma200 },
      sup[0] && { part: '⅓', when: 'בתיקון לתמיכה', price: sup[0].price },
      sup[1] && { part: '⅓', when: 'בתיקון עמוק', price: sup[1].price },
    ].filter(Boolean);
  } else if (verdict.code === 'watch') {
    // מחיר יקר: צוברים רק ככל שהמחיר מתקרב להערכת השווי
    const fair = val && val.dcf && val.dcf.base;
    plan = [
      sup[0] && { part: '⅓', when: 'בתיקון לתמיכה', price: sup[0].price },
      sup[1] && { part: '⅓', when: 'בתיקון עמוק', price: sup[1].price },
      fair && fair < price && { part: '⅓', when: 'בהערכת השווי הבסיסית (DCF)', price: fair },
    ].filter(Boolean).sort((x, y) => y.price - x.price);
  }
  if (verdict.code === 'buy' && !lt.aboveSma200) why.push('המחיר מתחת לממוצע 200 יום — עדיף לצבור בהדרגה');
  if (lt.maxDrawdown5y > 40) out.warnings.push(`במהלך 5 השנים האחרונות המניה ירדה עד ${lt.maxDrawdown5y}% מהשיא — צפו לתנודתיות`);
  out.verdict = { ...verdict, reasons: why, plan };
  out.technical = { bias: tech.bias, verdict: tech.verdict.title, supports: sup.map(x => x.price), resistances: (tech.resistances || []).map(x => x.price) };
  return out;
}

module.exports = { analyzeLongTerm, dcfPerShare };
