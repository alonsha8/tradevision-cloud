// routes/portfolioApi.js
//
// מנתח תיק השקעות:
// 1. מקבל רשימת אחזקות [{ticker, shares, avgCost, name}]
// 2. שולף נתוני Yahoo Finance לכל מניה
// 3. מחשב RSI, מגמה, תמיכות, ציון טכני (0-100)
// 4. קורא ל-Claude AI לניתוח כולל + המלצות
//
// שימוש ב-server.js:
//   const createPortfolioApi = require('./routes/portfolioApi');
//   app.use('/api/portfolio', createPortfolioApi(API_KEY));

const https = require('https');
const express = require('express');

// ══ חישובי אינדיקטורים טכניים ══

function avgArr(arr) { return arr.reduce((a,b)=>a+b,0)/arr.length; }

function calcRSI(closes, period) {
  if (closes.length < period+1) return 50;
  let gains=0, losses=0;
  for (let i=closes.length-period; i<closes.length; i++) {
    const diff = closes[i]-closes[i-1];
    if (diff>0) gains+=diff; else losses+=Math.abs(diff);
  }
  gains/=period; losses/=period;
  if (losses===0) return 100;
  return Math.round(100-(100/(1+gains/losses)));
}

function calcATR(highs, lows, closes, period) {
  if (highs.length<2) return 0;
  const trs=[];
  for (let i=1; i<highs.length; i++) {
    trs.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
  }
  return avgArr(trs.slice(-period));
}

// ══ שליפת נתוני Yahoo Finance ══

function fetchYahooAsync(ticker, interval, range) {
  return new Promise((resolve, reject) => {
    const path = `/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}&includePrePost=false`;
    const req = https.request({
      hostname: 'query1.finance.yahoo.com',
      path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Encoding': 'identity',
        'Referer': 'https://finance.yahoo.com/',
        'Origin': 'https://finance.yahoo.com',
        'Connection': 'keep-alive'
      }
    }, apiRes => {
      let data='';
      apiRes.on('data', c => data+=c);
      apiRes.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function parseYahooData(data) {
  const chart = data?.chart?.result?.[0];
  if (!chart) return null;
  const q = chart.indicators?.quote?.[0];
  if (!q) return null;
  const closes=[], highs=[], lows=[];
  (q.close||[]).forEach((c,i) => {
    if (c!=null && q.high[i]!=null && q.low[i]!=null) {
      closes.push(c); highs.push(q.high[i]); lows.push(q.low[i]);
    }
  });
  if (closes.length<5) return null;
  const price = chart.meta?.regularMarketPrice || closes[closes.length-1];
  const rsi = calcRSI(closes, 14);
  const sma20 = closes.length>=20 ? avgArr(closes.slice(-20)) : null;
  const sma50 = closes.length>=50 ? avgArr(closes.slice(-50)) : null;
  const atr = calcATR(highs, lows, closes, 14);
  const support = Math.min(...lows.slice(-20));
  const resistance = Math.max(...highs.slice(-20));
  const trendScore = (sma20?(price>sma20?1:-1)*0.5:0) + (sma20&&sma50?(sma20>sma50?1:-1)*0.5:0);
  return { price, rsi, sma20, sma50, atr, support, resistance, trendScore };
}

// ══ ניתוח מניה בודדת ══

async function analyzeStock(ticker, shares, avgCost, name) {
  try {
    const [daily, weekly] = await Promise.all([
      fetchYahooAsync(ticker, '1d', '3mo'),
      fetchYahooAsync(ticker, '1wk', '1y')
    ]);

    const d = parseYahooData(daily);
    const w = parseYahooData(weekly);
    if (!d) return { ticker, name: name||ticker, shares, avgCost, error: 'לא נמצאו נתונים — בדוק את הסימול' };

    const price = d.price;
    const value = price * (parseFloat(shares)||0);
    const pnl = avgCost && parseFloat(avgCost)>0 ? +((price - parseFloat(avgCost)) / parseFloat(avgCost) * 100).toFixed(1) : null;

    // ציון טכני (0-100)
    let techScore = 50;
    // RSI
    if (d.rsi<30) techScore+=15;
    else if (d.rsi>70) techScore-=15;
    else if (d.rsi>55) techScore+=7;
    else if (d.rsi<45) techScore-=7;
    // מגמה יומית
    techScore += d.trendScore * 20;
    // מגמה שבועית
    if (w) techScore += w.trendScore * 10;
    // קרבה לתמיכה
    const distFromSupport = ((price-d.support)/d.support*100);
    if (distFromSupport<3) techScore+=10;
    else if (distFromSupport>25) techScore-=5;
    // P&L (אם יש)
    if (pnl!==null) {
      if (pnl < -15) techScore -= 5;
      else if (pnl > 20) techScore += 3;
    }

    techScore = Math.max(0, Math.min(100, Math.round(techScore)));

    return {
      ticker, name: name||ticker,
      shares: parseFloat(shares)||0,
      avgCost: avgCost ? parseFloat(avgCost) : null,
      price: +price.toFixed(2),
      value: +value.toFixed(2),
      pnl,
      rsi: d.rsi,
      sma20: d.sma20 ? +d.sma20.toFixed(2) : null,
      sma50: d.sma50 ? +d.sma50.toFixed(2) : null,
      atr: +d.atr.toFixed(2),
      support: +d.support.toFixed(2),
      resistance: +d.resistance.toFixed(2),
      trend: d.trendScore>0.2?'עולה':d.trendScore<-0.2?'יורד':'מעורב',
      weeklyTrend: w?(w.trendScore>0.2?'עולה':w.trendScore<-0.2?'יורד':'מעורב'):null,
      techScore
    };
  } catch(err) {
    return { ticker, name: name||ticker, shares: parseFloat(shares)||0, avgCost, error: err.message };
  }
}

// ══ ניתוח AI עם Claude ══

function callClaudeForPortfolio(stocks, API_KEY) {
  const valid = stocks.filter(s=>!s.error);
  const totalValue = valid.reduce((sum,s)=>sum+(s.value||0), 0);

  const stocksSummary = valid.map(s =>
    `• ${s.name} (${s.ticker}): מחיר ${s.price}, RSI ${s.rsi}, מגמה יומית ${s.trend}${s.weeklyTrend?'/שבועית '+s.weeklyTrend:''}, ציון טכני ${s.techScore}/100, שווי ${s.value?.toFixed(0)}${s.pnl!=null?`, רווח/הפסד ${s.pnl}%`:''}`
  ).join('\n');

  const prompt = `אתה יועץ השקעות מנוסה ומדויק. נתח את תיק ההשקעות הבא:

${stocksSummary}

שווי תיק כולל: ${totalValue.toFixed(0)}
מספר אחזקות: ${stocks.length}

בצע ניתוח מעמיק. ענה ב-JSON בלבד (ללא תגי קוד):
{
  "portfolio_score": מספר שלם 0-100,
  "portfolio_summary": "3-4 משפטים על מצב התיק הכולל, פיזור, חשיפות עיקריות",
  "top_strengths": ["חוזק ספציפי 1", "חוזק ספציפי 2"],
  "main_risks": ["סיכון ספציפי 1", "סיכון ספציפי 2"],
  "recommendations": ["המלצה פעולה 1", "המלצה פעולה 2", "המלצה פעולה 3"],
  "stocks": [
    {
      "ticker": "סימול בדיוק כפי שנשלח",
      "score": מספר שלם 0-100,
      "signal": "BUY" או "HOLD" או "SELL",
      "comment": "משפט אחד ספציפי ותמציתי על האחזקה"
    }
  ]
}`;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    }, apiRes => {
      let data='';
      apiRes.on('data', c => data+=c);
      apiRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = (parsed.content||[]).map(b=>b.text||'').join('').trim();
          resolve(JSON.parse(text.replace(/```json|```/g,'').trim()));
        } catch(e) { reject(new Error('שגיאה בפרסור תשובת AI: '+e.message)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ══ Express Router ══

function createPortfolioApi(API_KEY) {
  const router = express.Router();

  router.post('/analyze', async (req, res) => {
    const { holdings } = req.body;
    if (!holdings || !Array.isArray(holdings) || holdings.length===0)
      return res.status(400).json({ error: 'נא לשלוח רשימת אחזקות' });
    if (holdings.length>25)
      return res.status(400).json({ error: 'מקסימום 25 אחזקות לניתוח' });

    try {
      console.log(`📊 מנתח תיק עם ${holdings.length} אחזקות...`);
      const stocks = [];
      for (const h of holdings) {
        const result = await analyzeStock(h.ticker?.trim(), h.shares, h.avgCost, h.name);
        stocks.push(result);
        await new Promise(r=>setTimeout(r,350)); // מניעת חסימת Yahoo
      }

      let aiAnalysis = null;
      if (API_KEY) {
        try {
          console.log('🤖 קורא ל-Claude לניתוח תיק...');
          aiAnalysis = await callClaudeForPortfolio(stocks, API_KEY);
          console.log(`✅ ניתוח AI הושלם (ציון תיק: ${aiAnalysis.portfolio_score})`);
        } catch(err) {
          console.error('שגיאה בניתוח AI:', err.message);
        }
      }

      res.json({ stocks, aiAnalysis });
    } catch(err) {
      console.error('שגיאה בניתוח תיק:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createPortfolioApi;
