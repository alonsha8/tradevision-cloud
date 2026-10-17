// services/scanner.js — סריקה בשרת על מנוע הניתוח (מקור אחד לכל האפליקציה)
//
// • analyzeTicker: ניתוח מלא למניה אחת + מצב שוק + מועד דוח → שורה בפורמט שהאפליקציה מכירה
// • scanMarket: כל מניות הסורק בבורסה אחת
// • regime: האם המדד הרחב (S&P 500 / ת"א 125) מעל ממוצע 200 יום

const { analyze, sma } = require('./analysisEngine');
const yc = require('./yahooCache');
const { US, TA } = require('./universe');

const INDEX = { US: { symbol: '^GSPC', label: 'S&P 500' }, TA: { symbol: '^TA125.TA', label: 'ת"א 125' } };
const marketOf = t => (t.endsWith('.TA') ? 'TA' : 'US');

function lazyGetBars() { return require('../routes/stockAnalysisApi').getBars; }

// ---------- מצב שוק ----------
const regimeCache = {};
async function regime(market) {
  const c = regimeCache[market];
  if (c && Date.now() - c.t < 30 * 60 * 1000) return c.v;
  try {
    const { bars } = await lazyGetBars()(INDEX[market].symbol);
    const closes = bars.map(b => b.c);
    const s200 = sma(closes, 200);
    const last = closes[closes.length - 1], m = s200[s200.length - 1];
    const v = m ? { ok: last > m, label: INDEX[market].label, close: last, sma200: m } : null;
    regimeCache[market] = { t: Date.now(), v };
    return v;
  } catch (e) {
    return c ? c.v : null; // אין נתון → לא מפעילים את הפילטר
  }
}

// ---------- מועד דוח (best effort; בעיקר ארה"ב) ----------
function earningsDaysFromQuote(q) {
  if (!q) return null;
  const ts = [q.earningsTimestampStart, q.earningsTimestamp].filter(x => x && x * 1000 > Date.now() - 86400000);
  if (!ts.length) return null;
  return Math.max(0, Math.round((Math.min(...ts) * 1000 - Date.now()) / 86400000));
}

async function context(symbol, quote) {
  const market = marketOf(symbol);
  const [rg, q] = await Promise.all([
    regime(market),
    quote !== undefined ? quote : yc.getQuote(symbol).then(r => { const j = JSON.parse(r.body); return j.quoteResponse && j.quoteResponse.result && j.quoteResponse.result[0]; }).catch(() => null),
  ]);
  return { regime: rg, earningsDays: earningsDaysFromQuote(q) };
}

// ---------- שורה בפורמט הסורק ----------
const SIGNAL = { enter: 'BUY', wait: 'WAIT', no: 'SELL', nodata: 'SELL' };

function toRow(ticker, a) {
  const I = a.indicators, v = a.verdict;
  const s = a.series.slice(-21);
  // לחץ קונים/מוכרים (OBV) על 10 ימים, באותה נורמליזציה כמו בסורק הישן
  let obv = 0; const o = [0];
  for (let k = 1; k < s.length; k++) o.push(o[k - 1] + (s[k].c > s[k - 1].c ? (s[k].v || 0) : s[k].c < s[k - 1].c ? -(s[k].v || 0) : 0));
  const rec = o.slice(-10), vols = s.slice(-10).map(x => x.v || 0);
  const avgV = vols.reduce((x, y) => x + y, 0) / (vols.length || 1) || 1;
  obv = (rec[rec.length - 1] - rec[0]) / (avgV * 10);
  return {
    ticker,
    price: I.close, pct: I.changePct, rsi: Math.round(I.rsi),
    score: Math.round((a.score + a.maxScore) / (2 * a.maxScore) * 100),
    signal: SIGNAL[v.decision] || 'WAIT', decision: v.decision, verdictTitle: v.title,
    entry: v.raw ? v.raw.entry : null, target: v.raw ? v.raw.target : null, stopLoss: v.raw ? v.raw.stop : null,
    rr: v.rr ? '1:' + v.rr : '—', planType: v.planType || null, how: v.how || null,
    reasons: (v.reasons || []).slice(0, 3),
    pctFrom52High: (I.close - I.high52) / I.high52 * 100, pctFrom52Low: (I.close - I.low52) / I.low52 * 100,
    obvSignal: obv, volRatio: I.volAvg20 ? I.volume / I.volAvg20 : null,
    pe: null, marketCap: null, divYield: null,
    currency: a.meta.currency, bias: a.bias,
    dataOk: a.dataQuality.ok, dataWarnings: a.dataQuality.warnings.length,
    regimeOk: a.meta.regime ? a.meta.regime.ok : null, earningsDays: a.meta.earningsDays,
  };
}

async function analyzeTicker(ticker, quote) {
  const { bars, meta } = await lazyGetBars()(ticker);
  const ctx = await context(ticker, quote);
  const a = analyze(bars, { ...meta, ...ctx });
  return toRow(ticker, a);
}

const scanCache = {};
async function scanMarket(market, force) {
  const c = scanCache[market];
  if (!force && c && Date.now() - c.t < 5 * 60 * 1000) return c.v;
  const list = market === 'TA' ? TA : US;
  const quotes = await yc.getQuotes(list);
  const rows = [], failed = [];
  await Promise.all(list.map(t => analyzeTicker(t, quotes[t] || null).then(r => rows.push(r)).catch(e => failed.push({ ticker: t, error: e.message }))));
  rows.sort((x, y) => y.score - x.score);
  const v = { market, generatedAt: new Date().toISOString(), regime: await regime(market), rows, failed };
  scanCache[market] = { t: Date.now(), v };
  return v;
}

module.exports = { analyzeTicker, scanMarket, regime, context, toRow, INDEX };
