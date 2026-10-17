// services/secFacts.js — נתוני דוחות כספיים רשמיים מ-SEC EDGAR (XBRL "companyfacts")
//
// מקור: data.sec.gov — הדוחות השנתיים שהחברות עצמן מגישות (10-K / 20-F / 40-F). ללא AI, ללא הערכות.
// • ארה"ב: כל חברה שמגישה ל-SEC.
// • ישראל: חברות דואליות שמגישות ל-SEC (טבע, נייס, אלביט, טאואר...) — דרך הסימול האמריקאי.
// • SEC דורש User-Agent עם כתובת קשר: משתנה סביבה SEC_CONTACT_EMAIL ב-Render.

const https = require('https');
const zlib = require('zlib');

const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });
const CONTACT = process.env.SEC_CONTACT_EMAIL || '';

// מניות ת"א שנסחרות גם בארה"ב ומגישות דוחות ל-SEC
const TA_TO_US = {
  'TEVA.TA': 'TEVA', 'NICE.TA': 'NICE', 'ESLT.TA': 'ESLT', 'TSEM.TA': 'TSEM', 'NVMI.TA': 'NVMI', 'CAMT.TA': 'CAMT',
  'ICL.TA': 'ICL', 'ORA.TA': 'ORA', 'SPNS.TA': 'SPNS', 'AUDC.TA': 'AUDC', 'ENLT.TA': 'ENLT', 'PERI.TA': 'PERI',
  'KMDA.TA': 'KMDA', 'MGIC.TA': 'MGIC', 'FORTY.TA': 'FORTY',
};

let fetcher = null; // לבדיקות בלבד
function get(url) {
  if (fetcher) return fetcher(url);
  return new Promise((resolve, reject) => {
    if (!CONTACT) return reject(new Error('חסר SEC_CONTACT_EMAIL בהגדרות השרת (Render → Environment) — SEC דורש כתובת קשר'));
    const req = https.get(url, { agent, headers: { 'User-Agent': `TradeVision Cloud ${CONTACT}`, 'Accept-Encoding': 'gzip', Accept: 'application/json' } }, res => {
      const stream = res.headers['content-encoding'] === 'gzip' ? res.pipe(zlib.createGunzip()) : res;
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        if (res.statusCode === 404) return reject(Object.assign(new Error('לא נמצאו דוחות ב-SEC'), { code: 404 }));
        if (res.statusCode !== 200) return reject(new Error(`SEC החזיר קוד ${res.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new Error('תשובה לא תקינה מ-SEC')); }
      });
      stream.on('error', reject);
    });
    req.setTimeout(20000, () => req.destroy(new Error('SEC לא הגיב בזמן')));
    req.on('error', reject);
  });
}

// ---------- סימול → CIK ----------
let tickerMap = null, tickerMapT = 0;
async function cikFor(ticker) {
  if (!tickerMap || Date.now() - tickerMapT > 24 * 3600 * 1000) {
    const j = await get('https://www.sec.gov/files/company_tickers.json');
    tickerMap = {};
    for (const k of Object.keys(j)) tickerMap[String(j[k].ticker).toUpperCase()] = { cik: j[k].cik_str, title: j[k].title };
    tickerMapT = Date.now();
  }
  return tickerMap[ticker.toUpperCase().replace('-', '.')] || tickerMap[ticker.toUpperCase()] || null;
}

// ---------- חילוץ סדרות שנתיות ----------
const ANNUAL_FORMS = new Set(['10-K', '10-K/A', '20-F', '20-F/A', '40-F', '40-F/A', '10-KT']);
const DAY = 86400000;

// מושגים לפי עדיפות. כל מושג: [namespace, name]
const C = {
  revenue: [['us-gaap', 'RevenueFromContractWithCustomerExcludingAssessedTax'], ['us-gaap', 'Revenues'], ['us-gaap', 'SalesRevenueNet'],
    ['us-gaap', 'RevenueFromContractWithCustomerIncludingAssessedTax'], ['us-gaap', 'RevenuesNetOfInterestExpense'], ['ifrs-full', 'Revenue']],
  netIncome: [['us-gaap', 'NetIncomeLoss'], ['us-gaap', 'NetIncomeLossAvailableToCommonStockholdersBasic'], ['ifrs-full', 'ProfitLossAttributableToOwnersOfParent'], ['ifrs-full', 'ProfitLoss']],
  opIncome: [['us-gaap', 'OperatingIncomeLoss'], ['ifrs-full', 'ProfitLossFromOperatingActivities']],
  ocf: [['us-gaap', 'NetCashProvidedByUsedInOperatingActivities'], ['us-gaap', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'], ['ifrs-full', 'CashFlowsFromUsedInOperatingActivities']],
  capex: [['us-gaap', 'PaymentsToAcquirePropertyPlantAndEquipment'], ['us-gaap', 'PaymentsToAcquireProductiveAssets'], ['ifrs-full', 'PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities'], ['ifrs-full', 'PurchaseOfPropertyPlantAndEquipment']],
  epsDiluted: [['us-gaap', 'EarningsPerShareDiluted'], ['us-gaap', 'EarningsPerShareBasicAndDiluted'], ['us-gaap', 'EarningsPerShareBasic'], ['ifrs-full', 'DilutedEarningsLossPerShare'], ['ifrs-full', 'BasicEarningsLossPerShare']],
  equity: [['us-gaap', 'StockholdersEquity'], ['us-gaap', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'], ['ifrs-full', 'EquityAttributableToOwnersOfParent'], ['ifrs-full', 'Equity']],
  cash: [['us-gaap', 'CashAndCashEquivalentsAtCarryingValue'], ['us-gaap', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'], ['ifrs-full', 'CashAndCashEquivalents']],
  debtLT: [['us-gaap', 'LongTermDebtNoncurrent'], ['us-gaap', 'LongTermDebt'], ['us-gaap', 'LongTermDebtAndCapitalLeaseObligations'], ['ifrs-full', 'NoncurrentPortionOfNoncurrentBorrowings'], ['ifrs-full', 'NoncurrentBorrowings'], ['ifrs-full', 'Borrowings']],
  debtST: [['us-gaap', 'LongTermDebtCurrent'], ['us-gaap', 'DebtCurrent'], ['us-gaap', 'ShortTermBorrowings'], ['ifrs-full', 'CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings'], ['ifrs-full', 'CurrentBorrowings']],
  dilutedShares: [['us-gaap', 'WeightedAverageNumberOfDilutedSharesOutstanding'], ['ifrs-full', 'WeightedAverageNumberOfSharesOutstandingBasicAndDiluted'], ['ifrs-full', 'AdjustedWeightedAverageShares']],
  dividendsPS: [['us-gaap', 'CommonStockDividendsPerShareDeclared'], ['us-gaap', 'CommonStockDividendsPerShareCashPaid']],
};
const FLOW = new Set(['revenue', 'netIncome', 'opIncome', 'ocf', 'capex', 'epsDiluted', 'dilutedShares', 'dividendsPS']);

function pickUnit(units, kind) {
  const keys = Object.keys(units || {});
  if (kind === 'perShare') return keys.find(k => /\/shares$/i.test(k) && k.startsWith('USD')) || keys.find(k => /\/shares$/i.test(k));
  if (kind === 'shares') return keys.find(k => k === 'shares');
  return keys.includes('USD') ? 'USD' : keys.find(k => /^[A-Z]{3}$/.test(k));
}

// מחזיר { [endDate]: { val, filed, unit } } לשנים מלאות בלבד
function annualSeries(facts, key) {
  const kind = ['epsDiluted', 'dividendsPS'].includes(key) ? 'perShare' : key === 'dilutedShares' ? 'shares' : 'money';
  const out = {};
  for (const [ns, name] of C[key]) {
    const f = facts[ns] && facts[ns][name];
    if (!f) continue;
    const unit = pickUnit(f.units, kind);
    if (!unit) continue;
    for (const it of f.units[unit]) {
      if (!ANNUAL_FORMS.has(it.form) || !it.end || it.val == null) continue;
      if (FLOW.has(key)) {
        if (!it.start) continue;
        const days = (new Date(it.end) - new Date(it.start)) / DAY;
        if (days < 340 || days > 390) continue; // שנה מלאה בלבד
      } else if (it.start) continue;
      const prev = out[it.end];
      // מושג בעדיפות גבוהה גובר; באותו מושג — הדיווח המאוחר (כולל תיקונים)
      if (!prev || (prev.name === name && it.filed > prev.filed)) out[it.end] = { val: it.val, filed: it.filed, unit, name };
    }
  }
  return out;
}

function lastYears(series, n = 6) {
  return Object.keys(series).sort().slice(-n).map(end => ({ end, ...series[end] }));
}

// ---------- ממשק ראשי ----------
const cache = new Map();
async function getFundamentals(symbol) {
  const usTicker = symbol.endsWith('.TA') ? TA_TO_US[symbol] : symbol.replace(/\.[A-Z]+$/, '');
  if (!usTicker) return { available: false, reason: 'אין דוחות זמינים ב-SEC למניה הזו (נסחרת רק בתל אביב)' };
  const hit = cache.get(usTicker);
  if (hit && Date.now() - hit.t < 12 * 3600 * 1000) return hit.v;
  const map = await cikFor(usTicker);
  if (!map) return { available: false, reason: `הסימול ${usTicker} לא נמצא ברשימת החברות של SEC` };
  const cik = String(map.cik).padStart(10, '0');
  const j = await get(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
  const facts = j.facts || {};
  const years = {};
  for (const key of Object.keys(C)) years[key] = lastYears(annualSeries(facts, key), key === 'revenue' ? 7 : 6);
  // מניות במחזור: מעמוד השער של הדוח האחרון (dei)
  let sharesOut = null;
  const dei = facts.dei && facts.dei.EntityCommonStockSharesOutstanding;
  if (dei && dei.units && dei.units.shares) {
    const latest = dei.units.shares.filter(x => x.val > 0).sort((a, b) => (a.filed < b.filed ? 1 : -1));
    if (latest.length) {
      // חברות עם כמה סוגי מניות מדווחות כמה שורות באותו תאריך — מסכמים אותן
      const f0 = latest[0].filed, end0 = latest[0].end;
      sharesOut = { val: latest.filter(x => x.filed === f0 && x.end === end0).reduce((s, x) => s + x.val, 0), asOf: end0 };
    }
  }
  const currencies = new Set(['revenue', 'netIncome', 'ocf'].flatMap(k => years[k].map(y => y.unit)));
  const v = {
    available: true, source: 'SEC EDGAR', usTicker, cik, name: j.entityName || map.title,
    currency: currencies.size === 1 ? [...currencies][0] : [...currencies].join('/'),
    years, sharesOut,
    lastFiled: Object.values(years).flat().reduce((m, y) => (y.filed > m ? y.filed : m), ''),
  };
  cache.set(usTicker, { t: Date.now(), v });
  if (cache.size > 80) cache.delete(cache.keys().next().value);
  return v;
}

module.exports = { getFundamentals, TA_TO_US, annualSeries, C, _setFetcher: f => { fetcher = f; } };
