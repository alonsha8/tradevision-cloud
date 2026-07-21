// watchers/positionWatcher.js
//
// מעקב אוטומטי אחרי מניות (בניגוד למעקב הפורום ב-dailyCheck.js שנעצר ב-16:00,
// זה רץ 9:00-23:00 שעון ישראל כדי לכסות גם את מסחר ת"א וגם את נאסד"ק/NYSE).
//
// שולח דרך אותו emailAlert.js הקיים (EmailJS REST API משרת - לא תלות חדשה).
//
// ‼️ הערה חשובה: זה רק *מתריע* במייל. זה לא סוגר פוזיציות אוטומטית ולא נוגע
// בנתוני המסחר שלך. הסגירה האוטומטית בפועל של Stop Loss / Take Profit עדיין
// קורית רק בצד לקוח, כשאתה בפועל בטאב "דסק מסחר" (קוד קיים, לא שונה כאן).
//
// רשימות הטיקרים (NASDAQ_TICKERS / TA_TICKERS) משוכפלות מ-index.html.
// אם מוסיפים/מסירים מניה בסורק בצד לקוח, יש לעדכן גם כאן כדי שההתראות יישארו מסונכרנות.

const cron = require('node-cron');
const https = require('https');
const { sendAlertEmail } = require('./emailAlert');

const NASDAQ_TICKERS = ['AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','AVGO','JPM','LLY','UNH','V','XOM','MA','JNJ','PG','HD','COST','MRK','ABBV','CVX','CRM','BAC','NFLX','AMD','KO','PEP','TMO','ORCL','ACN','MCD','CSCO','ABT','INTC','DIS','WMT','GE','CAT','GS','BA','AXP','HON','AMGN','GILD','ISRG','BKNG','SBUX','TXN','QCOM','LOW','SPGI','BLK','SYK','ADI','VRTX','REGN','PLD','CI','ETN','ZTS','LRCX','KLAC','AMAT','MU','SNPS','CDNS','PANW','FTNT','CRWD','NOW','ADBE','INTU','PYPL','UBER','ABNB','DDOG','NET','MDB','MRVL','TEAM','WDAY','ON','WFC','MS','C','SCHW','PGR','MMC','AON','CB','TRV','ALL','MET','AIG','PNC','USB','TFC','COF','BK','AMP','DFS','FITB','PFE','BMY','MDT','DHR','BSX','EW','ELV','HUM','CNC','MCK','HCA','CVS','ZBH','BDX','IDXX','IQV','A','MTD','WAT','RMD','PM','MO','CL','KMB','GIS','HSY','STZ','MNST','KDP','EL','CLX','SYY','KHC','HRL','TAP','CHD','K','CAG','LIN','APD','SHW','ECL','PPG','NUE','DOW','LYB','VMC','MLM','IFF','ALB','FMC','CTVA','EMN','CE','PKG','AVY','UPS','FDX','LMT','RTX','NOC','GD','UNP','CSX','NSC','EMR','ITW','PH','ROK','AME','CMI','XYL','DOV','PCAR','PWR','FAST','WM','RSG','VRSK','NEE','DUK','SO','D','AEP','EXC','SRE','XEL','ED','PEG','WEC','ES','AWK','ATO','SPG','PSA','EQIX','DLR','O'];
const TA_TICKERS = ['TEVA.TA','ICL.TA','NICE.TA','POLI.TA','LUMI.TA','HARL.TA','MZTF.TA','ESLT.TA','DSCT.TA','FIBI.TA','BEZQ.TA','PHOE.TA','MGDL.TA','ALHE.TA','OPCE.TA','PTNR.TA','CEL.TA','DLEKG.TA','TASE.TA','SPNS.TA','MLTM.TA','AZRG.TA','SAE.TA','ARYT.TA','ENRG.TA','ELAL.TA','RTEK.TA','CAST.TA','ORA.TA','SHLD.TA','KEN.TA','ILCO.TA','BIG.TA','AMOT.TA','GZT.TA','MISH.TA','SLAR.TA','NXTL.TA','MTRX.TA','ENLV.TA','SKBN.TA','VTLZ.TA','WIZ.TA','APOL.TA','EQTL.TA','MAXO.TA','PRTC.TA','GAON.TA','SNFL.TA','NWMD.TA','ENOG.TA','DRAL.TA','ASHO.TA','BLSR.TA','CMTR.TA','ALMS.TA','UNCT.TA','ELTR.TA','EPSL.TA','PRGR.TA','OBAS.TA','GADM.TA','PLAZ.TA','MTRN.TA','DANE.TA','MMHD.TA','EQTC.TA','RIT1.TA','SCOP.TA','PARZ.TA','GIBN.TA','TIMI.TA','LAPD.TA','ROBO.TA','ADGR.TA','ZNV.TA','SVDA.TA','KFSA.TA','ASTM.TA','IDIN.TA','TLSY.TA','MNRT.TA','TGAS.TA','NFTA.TA','MGRT.TA','MMI.TA','RLCO.TA','ORMT.TA','SVTL.TA','TRDY.TA','SHGR.TA','VRDS.TA','CRGS.TA','EFRT.TA','SRDR.TA','SNS.TA','MLSR.TA','ICCM.TA','ONE.TA','BONS.TA','LDER.TA','PCBT.TA','EVGN.TA','GVUR.TA','RMNF.TA','SKLN.TA','MVNE.TA','HOGN.TA','KMDA.TA','BOND.TA','TGEU.TA','AURA.TA','ELCRE.TA','PERI.TA','UNCM.TA','GLRS.TA','LRHO.TA'];
const SCORE_THRESHOLD = 80;
const ACCOUNT_ID = 'default'; // אותו מזהה חשבון יחיד שמשמש בכל שאר server.js

// ── שליפת נתוני גרף מ-Yahoo (עומד בפני עצמו, כדי לא לתלות ב-Express req/res) ──
function fetchYahooChart(ticker) {
  return new Promise((resolve) => {
    const reqOptions = {
      hostname: 'query1.finance.yahoo.com',
      path: '/v8/finance/chart/' + encodeURIComponent(ticker) + '?interval=1d&range=3mo&includePrePost=false',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Encoding': 'identity',
        'Referer': 'https://finance.yahoo.com/'
      }
    };
    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// ── פונקציות חישוב טכניות - שוכפלו בזהירות מ-index.html (calcRSI/calcScore/וכו') ──
function avgArr(a) { return a.reduce((x, y) => x + y, 0) / a.length; }

function calcRSI(c, p) {
  if (c.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = c.length - p; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    if (d > 0) g += d; else l += Math.abs(d);
  }
  const rs = (g / p) / ((l / p) || 0.001);
  return Math.round(100 - (100 / (1 + rs)));
}

function calcOBVTrend(closes, volumes) {
  if (closes.length < 10) return 0;
  const obv = [0];
  for (let i = 1; i < closes.length; i++) {
    const prevObv = obv[i - 1];
    if (closes[i] > closes[i - 1]) obv.push(prevObv + volumes[i]);
    else if (closes[i] < closes[i - 1]) obv.push(prevObv - volumes[i]);
    else obv.push(prevObv);
  }
  const recent = obv.slice(-10);
  const trend = recent[recent.length - 1] - recent[0];
  const avgVol = avgArr(volumes.slice(-10)) || 1;
  return trend / (avgVol * 10);
}

function calcVolRatio(volumes) {
  if (volumes.length < 10) return 1;
  const recent = volumes[volumes.length - 1];
  const avg = avgArr(volumes.slice(-20, -1));
  return avg > 0 ? recent / avg : 1;
}

function calcScore(rsi, pct, price, sma20, sma50, closes, pctFrom52High, pctFrom52Low, obvSignal, volRatio) {
  let s = 50;
  if (rsi < 30) s += 25; else if (rsi < 40) s += 15; else if (rsi < 50) s += 5; else if (rsi > 70) s -= 20; else if (rsi > 60) s -= 10;
  if (pct < -3) s += 10; else if (pct < -1.5) s += 5; else if (pct > 3) s -= 10;
  if (sma20 && price < sma20 * 1.02 && price > sma20 * 0.95) s += 10;
  if (sma50 && price > sma50) s += 5; else if (sma50) s -= 5;
  const rec = closes.slice(-5); if (rec[rec.length - 1] - rec[0] < 0 && rsi < 45) s += 8;
  if (pctFrom52Low != null && pctFrom52Low < 15 && rsi < 55) s += 8;
  if (pctFrom52High != null && pctFrom52High > -3) s -= 8;
  if (obvSignal != null) {
    if (obvSignal > 0.3) s += 10; else if (obvSignal > 0.1) s += 5;
    else if (obvSignal < -0.3) s -= 10; else if (obvSignal < -0.1) s -= 5;
  }
  if (volRatio != null && volRatio > 1.8) s += 5;
  return Math.min(100, Math.max(0, Math.round(s)));
}

// Same fix applied here as in index.html fetchQuote: prefer the fresh historical
// closes array over meta.chartPreviousClose, which was observed returning stale values.
async function getQuoteData(ticker) {
  const data = await fetchYahooChart(ticker);
  const chart = data && data.chart && data.chart.result && data.chart.result[0];
  if (!chart) return null;
  const q = chart.indicators && chart.indicators.quote && chart.indicators.quote[0];
  if (!q) return null;
  const rawClose = q.close || [], rawHigh = q.high || [], rawLow = q.low || [], rawVolume = q.volume || [];
  const closes = [], volumes = [];
  for (let i = 0; i < rawClose.length; i++) {
    if (rawClose[i] != null && rawHigh[i] != null && rawLow[i] != null) {
      closes.push(rawClose[i]);
      volumes.push(rawVolume[i] != null ? rawVolume[i] : 0);
    }
  }
  const meta = chart.meta || {};
  if (closes.length < 15) return null;
  const price = meta.regularMarketPrice || closes[closes.length - 1];
  const prevClose = closes.length >= 2 ? closes[closes.length - 2] : price;
  const pct = prevClose ? ((price - prevClose) / prevClose * 100) : 0;
  const rsi = calcRSI(closes, 14);
  const sma20 = avgArr(closes.slice(-20));
  const sma50 = closes.length >= 50 ? avgArr(closes.slice(-50)) : null;
  const w52High = meta.fiftyTwoWeekHigh || null;
  const w52Low = meta.fiftyTwoWeekLow || null;
  const pctFrom52High = w52High ? ((price - w52High) / w52High * 100) : null;
  const pctFrom52Low = w52Low ? ((price - w52Low) / w52Low * 100) : null;
  const obvSignal = calcOBVTrend(closes, volumes);
  const volRatio = calcVolRatio(volumes);
  const score = calcScore(rsi, pct, price, sma20, sma50, closes, pctFrom52High, pctFrom52Low, obvSignal, volRatio);
  return { ticker, price, pct, score };
}

// ── דה-דופ: כל התראה נשלחת פעם אחת בלבד ליום קלנדרי (טבלת alert_log) ──
async function alreadySentToday(pool, alertKey) {
  const r = await pool.query('SELECT 1 FROM alert_log WHERE alert_key = $1 AND sent_date = CURRENT_DATE', [alertKey]);
  return r.rows.length > 0;
}
async function markSent(pool, alertKey) {
  await pool.query(
    'INSERT INTO alert_log (alert_key, sent_date) VALUES ($1, CURRENT_DATE) ON CONFLICT (alert_key, sent_date) DO NOTHING',
    [alertKey]
  );
}

// ── 1) Stop Loss / Take Profit על פוזיציות פתוחות בדסק המסחר (רק התראה, לא סגירה) ──
async function checkStopLossAlerts(pool) {
  const r = await pool.query('SELECT data FROM trading_account WHERE account_id = $1', [ACCOUNT_ID]);
  if (r.rows.length === 0) return;
  const acc = r.rows[0].data;
  if (!acc || !acc.positions || !acc.positions.length) return;

  for (const p of acc.positions) {
    const q = await getQuoteData(p.ticker);
    if (!q) continue;
    const current = q.price;

    let hit = null;
    if (p.stopLoss && ((p.direction === 'BUY' && current <= p.stopLoss) || (p.direction === 'SELL' && current >= p.stopLoss))) hit = 'stop';
    else if (p.takeProfit && ((p.direction === 'BUY' && current >= p.takeProfit) || (p.direction === 'SELL' && current <= p.takeProfit))) hit = 'target';
    if (!hit) continue;

    const alertKey = 'stoploss:' + p.id + ':' + hit;
    if (await alreadySentToday(pool, alertKey)) continue;

    try {
      await sendAlertEmail({
        subject: (hit === 'stop' ? '🔻 Stop Loss נפגע' : '🎯 יעד רווח הושג') + ' | ' + p.ticker,
        message: p.ticker + ' (' + (p.direction === 'BUY' ? 'LONG' : 'SHORT') + ') הגיע למחיר ' + current.toFixed(2) + '. ' +
          (hit === 'stop' ? 'Stop Loss שהוגדר: ' + p.stopLoss : 'יעד רווח שהוגדר: ' + p.takeProfit) +
          '. שים לב: הפוזיציה עדיין פתוחה בפועל - זו התראה בלבד, כנס לדסק המסחר כדי לסגור אותה.',
        link: 'https://finance.yahoo.com/chart/' + p.ticker
      });
      await markSent(pool, alertKey);
    } catch (err) {
      console.error('❌ שגיאת מייל Stop Loss (' + p.ticker + '):', err.message);
    }
  }
}

// ── 2) התראות ציון סריקה (עובר סף) על כל היקום - נאסד"ק + ת"א ──
async function checkScoreAlerts(pool) {
  const allTickers = NASDAQ_TICKERS.concat(TA_TICKERS);
  let i = 0;
  while (i < allTickers.length) {
    const batch = allTickers.slice(i, i + 5);
    i += 5;
    await Promise.all(batch.map(async (ticker) => {
      const q = await getQuoteData(ticker);
      if (!q || q.score < SCORE_THRESHOLD) return;

      const alertKey = 'score:' + ticker;
      if (await alreadySentToday(pool, alertKey)) return;

      try {
        await sendAlertEmail({
          subject: '🔔 ציון סריקה גבוה | ' + ticker + ' (' + q.score + ')',
          message: ticker + ' עבר ציון ' + SCORE_THRESHOLD + ' (ציון נוכחי: ' + q.score + ', מחיר: ' + q.price.toFixed(2) + ', שינוי יומי: ' + q.pct.toFixed(2) + '%).',
          link: 'https://finance.yahoo.com/chart/' + ticker
        });
        await markSent(pool, alertKey);
      } catch (err) {
        console.error('❌ שגיאת מייל ציון סריקה (' + ticker + '):', err.message);
      }
    }));
    await new Promise((res) => setTimeout(res, 300)); // לא להציף את Yahoo
  }
}

function startPositionWatcher(pool) {
  // Stop Loss / Take Profit: כל 30 דקות, 9:00-23:30, כל יום (שעון ישראל)
  cron.schedule('*/30 9-23 * * *', async () => {
    try { await checkStopLossAlerts(pool); }
    catch (err) { console.error('❌ שגיאה בבדיקת Stop Loss:', err.message); }
  }, { timezone: 'Asia/Jerusalem' });

  // התראות ציון סריקה: כל שעה עגולה, 9:00-23:00, כל יום (שעון ישראל)
  cron.schedule('0 9-23 * * *', async () => {
    try { await checkScoreAlerts(pool); }
    catch (err) { console.error('❌ שגיאה בבדיקת ציוני סריקה:', err.message); }
  }, { timezone: 'Asia/Jerusalem' });

  console.log('⏰ Position watcher מתוזמן: Stop Loss כל 30 דק׳, ציוני סריקה כל שעה, 9:00-23:00 (שעון ישראל, מכסה גם ת"א וגם נאסד"ק/NYSE)');
}

module.exports = startPositionWatcher;
module.exports.checkStopLossAlerts = checkStopLossAlerts;
module.exports.checkScoreAlerts = checkScoreAlerts;
