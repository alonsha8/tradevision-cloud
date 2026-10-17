// analysis-engine.js — מנוע ניתוח טכני דטרמיניסטי (ללא AI): כל מספר מחושב ישירות מנתוני המחיר.
'use strict';

// ---------- אינדיקטורים ----------
function sma(src, n) {
  const out = new Array(src.length).fill(null);
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    sum += src[i];
    if (i >= n) sum -= src[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function ema(src, n) {
  const out = new Array(src.length).fill(null);
  const k = 2 / (n + 1);
  let start = src.findIndex(v => v != null);
  if (start < 0 || src.length - start < n) return out;
  let seed = 0;
  for (let i = start; i < start + n; i++) seed += src[i];
  let prev = seed / n;
  out[start + n - 1] = prev;
  for (let i = start + n; i < src.length; i++) {
    prev = src[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function stdev(src, n, means) {
  const out = new Array(src.length).fill(null);
  for (let i = n - 1; i < src.length; i++) {
    const m = means[i];
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (src[j] - m) ** 2;
    out[i] = Math.sqrt(s / n);
  }
  return out;
}

function bollinger(close, n = 20, mult = 2) {
  const mid = sma(close, n);
  const sd = stdev(close, n, mid);
  return {
    mid,
    upper: mid.map((m, i) => (m == null ? null : m + mult * sd[i])),
    lower: mid.map((m, i) => (m == null ? null : m - mult * sd[i])),
  };
}

function trueRange(h, l, c) {
  return h.map((hi, i) => (i === 0 ? hi - l[i] : Math.max(hi - l[i], Math.abs(hi - c[i - 1]), Math.abs(l[i] - c[i - 1]))));
}

// ATR בשיטת Wilder (RMA)
function atr(h, l, c, n = 14) {
  const tr = trueRange(h, l, c);
  const out = new Array(tr.length).fill(null);
  if (tr.length < n) return out;
  let prev = 0;
  for (let i = 0; i < n; i++) prev += tr[i];
  prev /= n;
  out[n - 1] = prev;
  for (let i = n; i < tr.length; i++) {
    prev = (prev * (n - 1) + tr[i]) / n;
    out[i] = prev;
  }
  return out;
}

// SuperTrend(10,3) — כמו ב-TradingView
function supertrend(h, l, c, n = 10, mult = 3) {
  const a = atr(h, l, c, n);
  const line = new Array(c.length).fill(null);
  const dir = new Array(c.length).fill(null); // 1 = עולה, -1 = יורד
  let fu = null, fl = null, d = 1;
  for (let i = 0; i < c.length; i++) {
    if (a[i] == null) continue;
    const hl2 = (h[i] + l[i]) / 2;
    const bu = hl2 + mult * a[i];
    const bl = hl2 - mult * a[i];
    if (fu == null) { fu = bu; fl = bl; }
    else {
      fu = bu < fu || c[i - 1] > fu ? bu : fu;
      fl = bl > fl || c[i - 1] < fl ? bl : fl;
    }
    if (dir[i - 1] == null) d = c[i] > fu ? 1 : -1;
    else if (d === -1 && c[i] > fu) d = 1;
    else if (d === 1 && c[i] < fl) d = -1;
    dir[i] = d;
    line[i] = d === 1 ? fl : fu;
  }
  return { line, dir };
}

function macd(close, fast = 12, slow = 26, sig = 9) {
  const ef = ema(close, fast), es = ema(close, slow);
  const m = close.map((_, i) => (ef[i] == null || es[i] == null ? null : ef[i] - es[i]));
  const s = ema(m, sig);
  return { macd: m, signal: s, hist: m.map((v, i) => (v == null || s[i] == null ? null : v - s[i])) };
}

function rsi(close, n = 14) {
  const out = new Array(close.length).fill(null);
  if (close.length <= n) return out;
  let g = 0, lo = 0;
  for (let i = 1; i <= n; i++) {
    const d = close[i] - close[i - 1];
    if (d > 0) g += d; else lo -= d;
  }
  g /= n; lo /= n;
  out[n] = lo === 0 ? 100 : 100 - 100 / (1 + g / lo);
  for (let i = n + 1; i < close.length; i++) {
    const d = close[i] - close[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    lo = (lo * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = lo === 0 ? 100 : 100 - 100 / (1 + g / lo);
  }
  return out;
}

// ---------- תמיכות והתנגדויות ----------
// מאתר נקודות מפנה (swing) ומקבץ אותן לאזורים לפי ATR. ציון = מספר נגיעות + משקל לטריות.
function findLevels(h, l, atrNow, lookback = 260, k = 5) {
  const n = h.length;
  const start = Math.max(k, n - lookback);
  const piv = [];
  for (let i = start; i < n - k; i++) {
    let isH = true, isL = true;
    for (let j = i - k; j <= i + k; j++) {
      if (h[j] > h[i]) isH = false;
      if (l[j] < l[i]) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) piv.push({ p: h[i], i });
    if (isL) piv.push({ p: l[i], i });
  }
  piv.sort((a, b) => a.p - b.p);
  const tol = atrNow * 0.6;
  const clusters = [];
  for (const pt of piv) {
    const last = clusters[clusters.length - 1];
    if (last && pt.p - last.max <= tol) {
      last.pts.push(pt); last.max = pt.p;
    } else clusters.push({ pts: [pt], max: pt.p });
  }
  return clusters.map(cl => {
    const price = cl.pts.reduce((s, x) => s + x.p, 0) / cl.pts.length;
    const lastIdx = Math.max(...cl.pts.map(x => x.i));
    const recency = 1 - (n - 1 - lastIdx) / lookback; // 0..1
    return { price, touches: cl.pts.length, lastIdx, score: cl.pts.length + recency * 1.5 };
  });
}

// ---------- עיצוב מספרים ----------
function decimalsFor(p) { return p >= 1000 ? 0 : p >= 100 ? 1 : p >= 1 ? 2 : 4; }
function roundP(p) { const d = decimalsFor(Math.abs(p)); const f = 10 ** d; return Math.round(p * f) / f; }

function makeFmt(currency) {
  return p => {
    const v = roundP(p).toLocaleString('en-US', { maximumFractionDigits: decimalsFor(Math.abs(p)) });
    if (currency === 'ILA') return `${v} אג׳`;
    if (currency === 'ILS') return `₪${v}`;
    if (currency === 'USD') return `$${v}`;
    return `${v} ${currency || ''}`.trim();
  };
}

const last = arr => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; };
const pct = (a, b) => ((a - b) / b) * 100;

// ---------- הניתוח המלא ----------
// ---------- אימות איכות נתונים ----------
// blocking = הנתונים לא אמינים, אין החלטת מסחר. warnings = מוצג למשתמש, הניתוח נשאר תקף.
function checkData(rawBars, meta, nowSec) {
  const blocking = [], warnings = [];
  let bars = rawBars.filter(b => [b.o, b.h, b.l, b.c].every(v => Number.isFinite(v) && v > 0));
  const dropped = rawBars.length - bars.length;
  // תיקון נרות לא עקביים (גבוה נמוך מהסגירה וכו')
  let fixed = 0;
  bars = bars.map(b => {
    const hi = Math.max(b.h, b.o, b.c), lo = Math.min(b.l, b.o, b.c);
    if (hi !== b.h || lo !== b.l) { fixed++; return { ...b, h: hi, l: lo }; }
    return b;
  });
  // נר "קוצני" בודד: קפיצה של 25%+ שחוזרת למחרת — תקלה בנתונים, לא תנועה אמיתית
  let spikes = 0;
  for (let k = 1; k < bars.length - 1; k++) {
    const p = bars[k - 1].c, x = bars[k].c, nx = bars[k + 1].c;
    if (Math.abs(x / p - 1) > 0.25 && Math.abs(nx / p - 1) < 0.08 && Math.sign(x - p) !== Math.sign(nx - x)) {
      bars.splice(k, 1); spikes++; k--;
    }
  }
  if (dropped + fixed + spikes > 0) warnings.push(`תוקנו ${dropped + fixed + spikes} נרות פגומים בנתוני המקור`);
  // חשד לפיצול מניה שעדיין לא תוקן בנתונים
  const SPLIT = [2, 3, 4, 5, 10, 20, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 10, 1 / 20, 1.5, 2 / 3];
  for (let k = Math.max(1, bars.length - 260); k < bars.length; k++) {
    const r = bars[k].c / bars[k - 1].c;
    if ((r > 1.4 || r < 0.6) && SPLIT.some(f => Math.abs(r / f - 1) < 0.03)) {
      blocking.push(`קפיצה חדה של פי ${r.toFixed(2)} ב-${new Date(bars[k].t * 1000).toLocaleDateString('he-IL')} — חשד לפיצול מניה שלא תוקן בנתונים`);
      break;
    }
  }
  if (bars.length < 60) { blocking.push(`רק ${bars.length} ימי מסחר תקינים — נדרשים לפחות 60`); return { bars, blocking, warnings }; }
  // טריות הנתונים
  const last = bars[bars.length - 1];
  const ageDays = (nowSec - last.t) / 86400;
  if (ageDays > 6) blocking.push(`הנר האחרון מ-${new Date(last.t * 1000).toLocaleDateString('he-IL')} (לפני ${Math.floor(ageDays)} ימים) — הנתונים לא עדכניים`);
  else if (ageDays > 4) warnings.push(`הנר האחרון מלפני ${Math.floor(ageDays)} ימים (חג / סוף שבוע ארוך?)`);
  // התאמה בין מחיר חי לסגירה האחרונה בגרף
  if (meta.livePrice && meta.rawLastClose) {
    const d = Math.abs(meta.livePrice / meta.rawLastClose - 1);
    if (d > 0.15) blocking.push(`פער של ${(d * 100).toFixed(1)}% בין המחיר החי לסגירה בגרף — נתונים סותרים`);
    else if (d > 0.08) warnings.push(`פער של ${(d * 100).toFixed(1)}% בין המחיר החי לסגירה האחרונה בגרף`);
  }
  if (bars.length < 200) warnings.push(`רק ${bars.length} ימי מסחר — SMA(200) לא זמין, והניתוח פחות מבוסס`);
  if (bars.slice(-20).every(b => !b.v)) warnings.push('אין נתוני מחזור — לא ניתן לאשר פריצות לפי מחזור');
  return { bars, blocking, warnings };
}

function analyze(rawBars, meta = {}) {
  const dq = checkData(rawBars, meta, meta.nowSec || Date.now() / 1000);
  let bars = dq.bars;
  if (bars.length < 60) throw new Error(dq.blocking.join(' · ') || 'אין מספיק היסטוריית מחירים לניתוח (נדרשים לפחות 60 ימי מסחר)');
  const o = bars.map(b => b.o), h = bars.map(b => b.h), l = bars.map(b => b.l), c = bars.map(b => b.c), v = bars.map(b => b.v || 0);
  const n = c.length, i = n - 1;
  const fmt = makeFmt(meta.currency);

  const s20 = sma(c, 20), s50 = sma(c, 50), s200 = sma(c, 200);
  const bb = bollinger(c, 20, 2);
  const st = supertrend(h, l, c, 10, 3);
  const md = macd(c);
  const r = rsi(c, 14);
  const a14 = atr(h, l, c, 14);
  const vAvg = sma(v, 20);

  const close = c[i], atrNow = a14[i];
  const ind = {
    close, prevClose: c[i - 1], changePct: pct(close, c[i - 1]),
    sma20: s20[i], sma50: s50[i], sma200: s200[i],
    bbUpper: bb.upper[i], bbMid: bb.mid[i], bbLower: bb.lower[i],
    st: st.line[i], stDir: st.dir[i],
    macd: md.macd[i], signal: md.signal[i], hist: md.hist[i], histPrev: md.hist[i - 1],
    rsi: r[i], atr: atrNow, volume: v[i], volAvg20: vAvg[i],
    high52: Math.max(...h.slice(-252)), low52: Math.min(...l.slice(-252)),
  };

  // --- רמות ---
  const tol = atrNow * 0.6;
  let levels = findLevels(h, l, atrNow);
  const dyn = [
    { key: 'SMA(200)', val: ind.sma200 }, { key: 'SMA(50)', val: ind.sma50 },
    { key: 'SuperTrend', val: ind.st }, { key: 'בולינגר תחתון', val: ind.bbLower }, { key: 'בולינגר עליון', val: ind.bbUpper },
  ].filter(d => d.val != null);
  const confl = p => dyn.filter(d => Math.abs(d.val - p) <= tol).map(d => d.key);

  const minGap = atrNow * 0.8;
  const pick = (arr, max) => {
    const out = [];
    for (const x of arr) { if (out.every(y => Math.abs(y.price - x.price) >= minGap)) out.push(x); if (out.length >= max) break; }
    return out;
  };
  const above = levels.filter(x => x.price > close + atrNow * 0.15 && x.touches >= 1).sort((a, b) => a.price - b.price);
  const below = levels.filter(x => x.price < close - atrNow * 0.15).sort((a, b) => b.price - a.price);

  let resist = pick(above.filter(x => x.touches >= 2 || x.score >= 1.8), 3);
  if (resist.length < 2) resist = pick(above, 3);
  // מחיר בשיא — אין התנגדות היסטורית: יעדים מבוססי תנודתיות
  while (resist.length < 2) {
    const base = resist.length ? resist[resist.length - 1].price : Math.max(close, ind.high52);
    resist.push({ price: base + atrNow * 2, touches: 0, projected: true });
  }
  let support = pick(below.filter(x => x.touches >= 2 || x.score >= 1.8), 3);
  if (support.length < 3) support = pick(below, 3);
  // הוספת תמיכה דינמית חזקה (SMA200 / SuperTrend) אם היא מתחת למחיר ואינה מכוסה
  for (const d of dyn.filter(d => (d.key === 'SMA(200)' || d.key === 'SuperTrend') && d.val < close - atrNow * 0.15)) {
    if (support.every(s => Math.abs(s.price - d.val) > tol)) support.push({ price: d.val, touches: 0, dynamic: d.key });
  }
  support = support.sort((a, b) => b.price - a.price).slice(0, 3);
  // המחיר מתחת לכל התמיכות ההיסטוריות (שפל חדש / ירידה חדה): רמות מבוססות תנודתיות
  while (support.length < 3) {
    const base = support.length ? support[support.length - 1].price : close;
    const p = base - atrNow * 2;
    if (p <= 0) break;
    support.push({ price: p, touches: 0, projected: true });
  }
  if (!support.length) support.push({ price: close * 0.9, touches: 0, projected: true });

  const fmtLevel = x => ({ price: roundP(x.price), label: fmt(x.price), touches: x.touches, confluence: confl(x.price), projected: !!x.projected });
  const R = resist.map(fmtLevel), S = support.map(fmtLevel);

  // סיווג התמיכות: ראשונה / קריטית (עם התכנסות ממוצעים) / עמוקה
  const critIdx = S.findIndex((s, k) => k > 0 && s.confluence.some(cf => cf === 'SMA(200)' || cf === 'SuperTrend'));
  const sRoles = S.map((_, k) => (k === 0 ? 'ראשונה' : k === critIdx || (critIdx < 0 && k === 1) ? 'קריטית' : 'עמוקה'));

  // --- מגמה ומומנטום (ציון) ---
  const sig = [];
  const add = (cond, w, pos, neg) => { if (cond == null) return 0; sig.push(cond ? pos : neg); return cond ? w : -w; };
  let score = 0;
  score += add(ind.sma20 != null ? close > ind.sma20 : null, 1, 'מעל SMA(20)', 'מתחת ל-SMA(20)');
  score += add(ind.sma50 != null ? close > ind.sma50 : null, 1, 'מעל SMA(50)', 'מתחת ל-SMA(50)');
  score += add(ind.sma200 != null ? close > ind.sma200 : null, 1.5, 'מעל SMA(200)', 'מתחת ל-SMA(200)');
  score += add(ind.sma50 != null && ind.sma200 != null ? ind.sma50 > ind.sma200 : null, 1, 'SMA(50) מעל SMA(200)', 'SMA(50) מתחת ל-SMA(200)');
  score += add(ind.stDir === 1, 1.5, 'SuperTrend חיובי', 'SuperTrend שלילי');
  score += add(ind.macd > ind.signal, 1, 'MACD מעל קו האיתות', 'MACD מתחת לקו האיתות');
  score += add(ind.macd > 0, 0.5, 'MACD מעל אפס', 'MACD מתחת לאפס');
  score += add(ind.hist > ind.histPrev, 0.5, 'היסטוגרמה מתחזקת', 'היסטוגרמה נחלשת');
  const maxScore = 8;
  const bias = score >= 3 ? 'חיובית' : score <= -3 ? 'שלילית' : 'ניטרלית';

  // פריצה: סגירה מעל השיא של 60 הימים (ללא 3 הימים האחרונים) עם מחזור גבוה
  const prevHigh = Math.max(...h.slice(Math.max(0, n - 63), n - 3));
  const prevLow = Math.min(...l.slice(Math.max(0, n - 63), n - 3));
  const volRatio = ind.volAvg20 ? ind.volume / ind.volAvg20 : null;
  const breakout = close > prevHigh ? (volRatio && volRatio >= 1.3 ? 'confirmed' : 'unconfirmed') : null;
  const breakdown = close < prevLow;

  // --- טקסט ---
  const R1 = R[0], R2 = R[1], R3 = R[2];
  const S1 = S[0], S2 = S[1] || S[0], S3 = S[2] || S2;
  const sections = [];

  sections.push({
    title: 'תמונת מצב',
    body: [
      `המחיר האחרון: <b>${fmt(close)}</b> (${ind.changePct >= 0 ? '+' : ''}${ind.changePct.toFixed(2)}% ביום האחרון). ` +
      `הטיה טכנית: <b>${bias}</b> (ציון ${score.toFixed(1)} מתוך ±${maxScore}).`,
      `טווח 52 שבועות: ${fmt(ind.low52)}–${fmt(ind.high52)}; ${close >= ind.high52 ? 'המחיר בשיא שנתי.' : `המחיר נמצא ${Math.abs(pct(close, ind.high52)).toFixed(1)}% מתחת לשיא.`}`,
      breakout === 'confirmed' ? `פריצה מאושרת: סגירה מעל השיא של 3 החודשים האחרונים (${fmt(prevHigh)}) במחזור גבוה פי ${volRatio.toFixed(1)} מהממוצע.`
        : breakout === 'unconfirmed' ? `סגירה מעל השיא של 3 החודשים (${fmt(prevHigh)}), אך המחזור לא חריג (פי ${volRatio ? volRatio.toFixed(1) : '—'} מהממוצע), ולכן הפריצה עדיין לא מאושרת.`
        : breakdown ? `שבירה כלפי מטה: סגירה מתחת לשפל של 3 החודשים (${fmt(prevLow)}).`
        : `המחיר נע בתוך טווח 3 החודשים האחרונים (${fmt(prevLow)}–${fmt(prevHigh)}), ללא פריצה מאושרת.`,
    ],
  });

  const rLines = R.map((x, k) => `• ${k === 0 ? 'התנגדות קרובה' : k === 1 ? 'התנגדות מרכזית' : 'יעד המשך'}: <b>${x.label}</b>` +
    (x.projected ? ' (יעד מבוסס תנודתיות, אין התנגדות היסטורית)' : x.touches >= 2 ? ` (${x.touches} נגיעות)` : '') +
    (x.confluence.length ? ` — חפיפה עם ${x.confluence.join(', ')}` : ''));
  sections.push({
    title: 'התנגדויות',
    body: [...rLines,
      `סגירה יומית מעל ${R2 ? R2.label : R1.label}${volRatio != null ? ', עדיף עם מחזור גבוה,' : ''} תשפר משמעותית את התמונה` + (R3 ? ` ותאפשר המשך ל-${R3.label}.` : '.')],
  });

  const nearZero = Math.abs(ind.macd) < atrNow * 0.3;
  const histTxt = ind.hist > 0 ? (ind.hist > ind.histPrev ? 'חיובית ומתחזקת' : 'חיובית אך נחלשת') : (ind.hist > ind.histPrev ? 'שלילית אך מצטמצמת' : 'שלילית ומתרחבת');
  const rsiTxt = ind.rsi >= 70 ? 'קנוי-יתר — סיכון לתיקון' : ind.rsi <= 30 ? 'מכור-יתר — פוטנציאל לריבאונד' : ind.rsi >= 55 ? 'מומנטום חיובי' : ind.rsi <= 45 ? 'מומנטום חלש' : 'ניטרלי';
  sections.push({
    title: ind.macd > ind.signal ? 'המומנטום מתאושש' : 'המומנטום נחלש',
    body: [
      `MACD(12,26,9): הקו ב-<b>${ind.macd.toFixed(2)}</b>, ${ind.macd > ind.signal ? 'מעל קו האיתות' : 'מתחת לקו האיתות'} (${ind.signal.toFixed(2)}); ההיסטוגרמה ${histTxt}.`,
      nearZero ? `ה-MACD עדיין קרוב לאזור האפס, ולכן זהו ${ind.macd > ind.signal ? 'שיפור במומנטום ולא הוכחה לגל עליות חדש' : 'היחלשות שעדיין אינה מגמת ירידה מובהקת'}.`
        : ind.macd > 0 ? 'ה-MACD מעל האפס: המגמה בינונית-הטווח חיובית.' : 'ה-MACD מתחת לאפס: המגמה בינונית-הטווח שלילית.',
      `RSI(14): <b>${ind.rsi.toFixed(1)}</b> — ${rsiTxt}.`,
    ],
  });

  sections.push({
    title: 'רמות הגנה',
    body: S.map((x, k) => `• תמיכה ${sRoles[k]}: <b>${x.label}</b>` + (x.projected ? ' (רמה מבוססת תנודתיות, אין תמיכה היסטורית)' : '') +
      (x.confluence.length ? ` — יחד עם ${x.confluence.join(', ')}` : x.touches >= 2 ? ` (${x.touches} נגיעות)` : '') +
      (sRoles[k] === 'קריטית' ? '. שבירה וסגירה מתחת לאזור זה תחליש את המבנה העולה.' : sRoles[k] === 'עמוקה' ? '. איבוד שלה יבטל חלק גדול מתרחיש ההתאוששות.' : '.')),
  });

  // --- תרחישים (לונג) ---
  const buf = atrNow * 0.3;
  const rr = (e, s, t) => (t - e) / (e - s);
  const scen = [];
  const pushS = (type, desc, entry, stop, stopDesc, target) => {
    if (!(stop < entry && target > entry)) return;
    const o = { type, desc, entry: fmt(entry), stop: `${fmt(stop)} — ${stopDesc}`, target: fmt(target), rr: rr(entry, stop, target).toFixed(1),
      raw: { entry: roundP(entry), stop: roundP(stop), target: roundP(target) } };
    scen.push(o);
    return o;
  };
  // יעד: ההתנגדות הראשונה שנותנת יחס סיכוי/סיכון של 1.2 לפחות; אחרת — מהלך מדוד
  const tgt = (entry, stop) => {
    const risk = entry - stop;
    const ok = R.find(x => x.price > entry + atrNow * 0.3 && (x.price - entry) / risk >= 1.2);
    return ok ? ok.price : entry + risk * 2;
  };
  const sNow = pushS('אגרסיבי', 'כניסה במחיר הנוכחי', close, S1.price - buf, `מתחת ל-${S1.label}`, tgt(close, S1.price - buf));
  const sBrk = pushS('אגרסיבי', `כניסה בסגירה מעל ${R1.label}`, R1.price + buf, S1.price - buf, `מתחת ל-${S1.label}`, tgt(R1.price + buf, S1.price - buf));
  const sPull = pushS('שמרני', `כניסה בתיקון ל-${S1.label}`, S1.price, S2.price - buf, `מתחת ל-${S2.label}`, tgt(S1.price, S2.price - buf));
  if (ind.st != null && ind.stDir === 1 && S2 !== S1) {
    const st2 = Math.min(S3.price, ind.st) - buf;
    pushS('שמרני', 'כניסה בתיקון לתמיכה הקריטית', S2.price, st2, 'מתחת לתמיכה ול-SuperTrend', tgt(S2.price, st2));
  }
  sections.push({ title: 'תרחישים מותנים', table: scen });

  // --- שורה תחתונה ---
  const bl = [];
  if (bias === 'חיובית') {
    bl.push(`<b>הטיה חיובית${breakout === 'confirmed' ? ' עם פריצה מאושרת' : ', אך לא פריצה מאושרת'}.</b> כל עוד המחיר מעל ${S1.label}, לקונים יש יתרון טכני. סגירה מעל ${R1.label} תפתח יעד אפשרי באזור ${(R2 || R1).label}.`);
    bl.push(`מנגד, דחייה ב-${R1.label} עלולה להחזיר את המחיר ל-${S1.label}. סגירה מתחת ל-${S2.label} תאותת שההתאוששות מאבדת כוח.`);
  } else if (bias === 'שלילית') {
    bl.push(`<b>הטיה שלילית.</b> המוכרים שולטים כל עוד המחיר מתחת ל-${R1.label}. שבירת ${S1.label} עלולה להוביל ל-${S2.label}${S3 !== S2 ? ` ואף ל-${S3.label}` : ''}.`);
    bl.push(`שינוי תמונה יחייב סגירה מעל ${R1.label}${ind.sma50 ? ` וחזרה מעל SMA(50) (${fmt(ind.sma50)})` : ''}. עד אז, תרחישי הקנייה בטבלה הם ספקולטיביים.`);
  } else {
    bl.push(`<b>תמונה מעורבת.</b> המחיר נע בין התמיכה ב-${S1.label} להתנגדות ב-${R1.label}. כיוון ברור יתקבל בסגירה מחוץ לטווח הזה.`);
    bl.push(`פריצה מעל ${R1.label} תפתח יעד ב-${(R2 || R1).label}; שבירה מתחת ל-${S1.label} תפנה את המחיר ל-${S2.label}.`);
  }
  if (ind.rsi >= 70) bl.push('שימו לב: RSI בקנוי-יתר. כניסה במחיר הנוכחי מגדילה את הסיכון לתיקון קצר.');
  sections.push({ title: 'השורה התחתונה', body: bl });

  // --- ההחלטה: נכנס / ממתין / לא נכנס (כללים קבועים) ---
  // כניסה רק כשהמגמה חיובית, יחס סיכוי/סיכון 1.5 ומעלה, ו-RSI לא בקנוי-יתר
  const good = x => x && +x.rr >= 1.5;
  const nearSup = close - S1.price <= atrNow * 1.2;
  const why = [];
  let decision, plan = null, trigger = null;
  if (bias === 'חיובית') {
    if (breakout === 'confirmed' && ind.rsi < 75 && good(sNow)) {
      decision = 'enter'; plan = sNow; why.push('פריצה מאושרת במחזור גבוה', `הטיה חיובית (ציון ${score.toFixed(1)})`);
    } else if (ind.rsi < 70 && nearSup && good(sNow)) {
      decision = 'enter'; plan = sNow; why.push(`הטיה חיובית (ציון ${score.toFixed(1)})`, `המחיר קרוב לתמיכה ב-${S1.label}, כך שהסטופ צמוד`, `יחס סיכוי/סיכון 1:${sNow.rr}`);
    } else {
      decision = 'wait';
      plan = good(sPull) ? sPull : good(sBrk) ? sBrk : (sPull || sBrk);
      if (ind.rsi >= 70) why.push(`RSI ${ind.rsi.toFixed(0)} — קנוי-יתר`);
      if (!nearSup) why.push(`המחיר רחוק מהתמיכה (${S1.label}), כך שהסטופ רחב מדי`);
      if (sNow && !good(sNow)) why.push(`יחס סיכוי/סיכון בכניסה עכשיו רק 1:${sNow.rr}`);
      why.push('המגמה חיובית, ולכן כדאי להמתין לנקודת כניסה טובה יותר');
    }
  } else if (bias === 'ניטרלית') {
    decision = 'wait';
    plan = sBrk || sPull;
    why.push(`תמונה מעורבת (ציון ${score.toFixed(1)})`, `אין כיוון ברור עד סגירה מחוץ לטווח ${S1.label}–${R1.label}`);
  } else {
    decision = 'no';
    why.push(`הטיה שלילית (ציון ${score.toFixed(1)})`, ...sig.filter(x => /מתחת|שלילי|נחלש/.test(x)).slice(0, 3));
    trigger = `לבחון מחדש רק אחרי סגירה מעל ${R1.label}${ind.stDir === -1 && ind.st ? ` והיפוך SuperTrend לחיובי (מעל ${fmt(ind.st)})` : ''}`;
  }
  // פילטר מצב שוק: כשהמדד הרחב מתחת ל-SMA(200) לא נכנסים מיד — רק פקודה ממתינה
  const toWait = reason => {
    decision = 'wait';
    plan = good(sPull) ? sPull : good(sBrk) ? sBrk : (sPull || sBrk);
    why.unshift(reason);
  };
  if (decision === 'enter' && meta.regime && meta.regime.ok === false) {
    toWait(`השוק הרחב (${meta.regime.label}) מתחת לממוצע 200 יום — לא נכנסים מיד לעסקאות חדשות`);
  }
  // דוח רבעוני קרוב: סיכון לפער מחיר שעוקף את הסטופ
  if (meta.earningsDays != null && meta.earningsDays >= 0 && meta.earningsDays <= 10) {
    dq.warnings.push(`דוח רבעוני בעוד ${meta.earningsDays} ימים — המחיר עלול לקפוץ מעבר לסטופ`);
    if (decision === 'enter' && meta.earningsDays <= 5) toWait(`דוח רבעוני בעוד ${meta.earningsDays} ימים — עדיף להמתין לאחר הפרסום`);
  }
  if (plan && plan.raw.entry > 0) {
    const r = plan.raw;
    plan = { ...plan, riskPct: ((r.entry - r.stop) / r.entry * 100).toFixed(1), rewardPct: ((r.target - r.entry) / r.entry * 100).toFixed(1) };
  }
  // נתונים לא אמינים: אין החלטת מסחר בכלל
  if (dq.blocking.length) {
    decision = 'nodata'; plan = null; trigger = 'לנסות שוב מאוחר יותר או לבדוק את המחיר במקור נוסף (אתר הבורסה / ברוקר)';
    why.length = 0; why.push(...dq.blocking);
  }
  const verdict = {
    decision,
    title: decision === 'enter' ? 'כן, הייתי נכנס' : decision === 'wait' ? 'לא עכשיו, ממתין לכניסה' : decision === 'nodata' ? 'אין החלטה — בעיית נתונים' : 'לא הייתי נכנס',
    how: plan ? plan.desc : null,
    entry: plan ? plan.entry : null, stop: plan ? plan.stop.split(' — ')[0] : null, target: plan ? plan.target : null,
    rr: plan ? plan.rr : null, riskPct: plan ? plan.riskPct : null, rewardPct: plan ? plan.rewardPct : null,
    reasons: why, trigger, raw: plan ? plan.raw : null, planType: plan ? (sNow && plan.desc === sNow.desc ? "market" : plan.raw.entry < close ? "limit" : "stop") : null,
  };

  // --- סדרות לגרף ---
  const series = bars.map((b, k) => ({
    t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v,
    s20: s20[k], s50: s50[k], s200: s200[k], bu: bb.upper[k], bm: bb.mid[k], bl: bb.lower[k],
    st: st.line[k], sd: st.dir[k], m: md.macd[k], ms: md.signal[k], mh: md.hist[k],
  }));

  return {
    meta, dataQuality: { ok: !dq.blocking.length, blocking: dq.blocking, warnings: dq.warnings }, bias, score: +score.toFixed(1), maxScore, signals: sig,
    indicators: Object.fromEntries(Object.entries(ind).map(([kk, vv]) => [kk, typeof vv === 'number' ? +vv.toFixed(4) : vv])),
    resistances: R, supports: S.map((s, k) => ({ ...s, role: sRoles[k] })), scenarios: scen, verdict,
    sections, series, asOf: bars[i].t,
  };
}

module.exports = { analyze, checkData, sma, ema, bollinger, atr, supertrend, macd, rsi, findLevels, roundP };
