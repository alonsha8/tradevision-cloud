// routes/stockAnalysisApi.js
// GET /api/stock-analysis?q=<שם מניה בעברית/אנגלית או סימול>
// ניתוח טכני מלא: אינדיקטורים, תמיכות/התנגדויות, תרחישים והחלטת כניסה.
// כל המספרים מחושבים בקוד מנתוני המחיר (ללא AI) — מהיר ומדויק.

const url = require('url');
const { analyze } = require('../services/analysisEngine');
const yc = require('../services/yahooCache');

// שמות בעברית → סימול ביאהו (Yahoo לא מחפש בעברית)
const HEB = {
  'טבע': 'TEVA.TA', 'לאומי': 'LUMI.TA', 'בנק לאומי': 'LUMI.TA', 'הפועלים': 'POLI.TA', 'פועלים': 'POLI.TA', 'בנק הפועלים': 'POLI.TA',
  'דיסקונט': 'DSCT.TA', 'מזרחי': 'MZTF.TA', 'מזרחי טפחות': 'MZTF.TA', 'הבינלאומי': 'FIBI.TA', 'בינלאומי': 'FIBI.TA',
  'פיבי': 'FIBIH.TA', 'בנק ירושלים': 'JBNK.TA', 'אלביט': 'ESLT.TA', 'אלביט מערכות': 'ESLT.TA', 'נייס': 'NICE.TA',
  'כיל': 'ICL.TA', 'איי סי אל': 'ICL.TA', 'בזק': 'BEZQ.TA', 'עזריאלי': 'AZRG.TA', 'נובה': 'NVMI.TA', 'טאואר': 'TSEM.TA',
  'קמטק': 'CAMT.TA', 'הראל': 'HARL.TA', 'הפניקס': 'PHOE.TA', 'פניקס': 'PHOE.TA', 'מגדל': 'MGDL.TA', 'כלל': 'CLIS.TA',
  'כלל ביטוח': 'CLIS.TA', 'מנורה': 'MMHD.TA', 'מנורה מבטחים': 'MMHD.TA', 'שופרסל': 'SAE.TA', 'שטראוס': 'STRS.TA',
  'דלק': 'DLEKG.TA', 'קבוצת דלק': 'DLEKG.TA', 'ניו מד': 'NWMD.TA', 'ניומד': 'NWMD.TA', 'אנרגיאן': 'ENOG.TA', "אנרג'יאן": 'ENOG.TA',
  'ישראמקו': 'ISRA.TA', 'בזן': 'ORL.TA', 'פז': 'PZOL.TA', 'אלקטרה': 'ELTR.TA', 'אלוני חץ': 'ALHE.TA', 'מליסרון': 'MLSR.TA',
  'ביג': 'BIG.TA', 'אמות': 'AMOT.TA', 'גב ים': 'GVYM.TA', 'שיכון ובינוי': 'SKBN.TA', 'אשטרום': 'ASHG.TA', 'אנלייט': 'ENLT.TA',
  'אורמת': 'ORA.TA', 'אנרגיקס': 'ENRG.TA', "אנרג'יקס": 'ENRG.TA', 'דוראל': 'DORL.TA', 'או פי סי': 'OPCE.TA', 'אל על': 'ELAL.TA',
  'פרטנר': 'PTNR.TA', 'סלקום': 'CEL.TA', 'מטריקס': 'MTRX.TA', 'וואן': 'ONE.TA', 'חילן': 'HLAN.TA', 'ריט 1': 'RIT1.TA',
  'ישראכרט': 'ISCD.TA', 'אלקו': 'ELCO.TA', 'דלק רכב': 'DLEA.TA', 'פוקס': 'FOX.TA', 'רמי לוי': 'RMLI.TA', 'שפיר': 'SPEN.TA',
  'ישרס': 'ISRS.TA', 'איירפורט סיטי': 'ARPT.TA', 'סאפיינס': 'SPNS.TA', 'אודיוקודס': 'AUDC.TA', 'מיטב': 'MTAV.TA',
  'פתאל': 'FTAL.TA', 'מבטח שמיר': 'MISH.TA', 'נקסט ויזן': 'NXSN.TA', "נקסט ויז'ן": 'NXSN.TA',
};


const norm = s => s.trim().replace(/["״׳']/g, '').replace(/\s+/g, ' ');

async function resolveSymbol(q) {
  const raw = q.trim();
  if (!raw) throw new Error('יש להזין שם מניה או סימול');
  const nq = norm(raw);
  const keys = Object.keys(HEB);
  const exact = keys.find(k => norm(k) === nq);
  if (exact) return HEB[exact];
  if (/[֐-׿]/.test(raw)) {
    const part = keys.find(k => norm(k).includes(nq) || nq.includes(norm(k)));
    if (part) return HEB[part];
    throw new Error(`לא מצאתי את "${raw}". נסו את הסימול, למשל TEVA.TA`);
  }
  if (/^[A-Za-z0-9.\-^=]{1,12}$/.test(raw) && raw === raw.toUpperCase()) return raw;
  const r = await yc.search(raw);
  const j = JSON.parse(r.body);
  const qs = (j.quotes || []).filter(x => ['EQUITY', 'ETF', 'INDEX'].includes(x.quoteType));
  const best = qs.find(x => ['NMS', 'NYQ', 'NGM', 'NCM', 'ASE', 'PCX', 'BTS'].includes(x.exchange)) || qs.find(x => x.exchange === 'TLV') || qs[0];
  if (!best) throw new Error(`לא נמצאה מניה בשם "${raw}". נסו סימול (למשל AAPL או TEVA.TA).`);
  return best.symbol;
}

async function getBars(symbol) {
  const r = await yc.getChart(symbol, '1d', '2y');
  const j = JSON.parse(r.body);
  const res = j.chart && j.chart.result && j.chart.result[0];
  if (!res || !res.timestamp) throw new Error(`אין נתוני מחיר עבור ${symbol}`);
  const qd = res.indicators.quote[0];
  const bars = res.timestamp.map((t, i) => ({ t, o: qd.open[i], h: qd.high[i], l: qd.low[i], c: qd.close[i], v: qd.volume[i] }))
    .filter(b => b.c != null && b.o != null && b.h != null && b.l != null);
  const m = res.meta;
  if (m.regularMarketPrice && bars.length) {
    const lb = { ...bars[bars.length - 1] };
    lb.c = m.regularMarketPrice; lb.h = Math.max(lb.h, lb.c); lb.l = Math.min(lb.l, lb.c);
    bars[bars.length - 1] = lb;
  }
  return { bars, meta: { symbol: m.symbol, currency: m.currency, exchange: m.exchangeName, name: m.longName || m.shortName } };
}

async function handleStockAnalysis(req, res) {
  const t0 = Date.now();
  try {
    const q = new url.URL('http://x' + req.url).searchParams.get('q') || '';
    const symbol = await resolveSymbol(q);
    const { bars, meta } = await getBars(symbol);
    const out = analyze(bars, { ...meta, query: q });
    out.ms = Date.now() - t0;
    yc.send(req, res, 200, JSON.stringify(out));
  } catch (e) {
    yc.send(req, res, 400, JSON.stringify({ error: e.message === 'Yahoo timeout' ? 'שרת הנתונים לא הגיב בזמן. נסו שוב.' : e.message }));
  }
}

module.exports = { handleStockAnalysis };
