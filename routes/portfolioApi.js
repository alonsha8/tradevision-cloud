// routes/portfolioApi.js
const https = require('https');
const express = require('express');

// ══ עזר: בקשת HTTPS עם timeout ══
function httpsGet(hostname, path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Accept-Encoding': 'identity',
        'Referer': 'https://finance.yahoo.com/',
        'Origin': 'https://finance.yahoo.com'
      }
    }, apiRes => {
      let data = '';
      apiRes.on('data', c => data += c);
      apiRes.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Invalid JSON from Yahoo')); }
      });
    });
    req.setTimeout(timeoutMs || 8000, () => {
      req.destroy();
      reject(new Error('Yahoo Finance timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

// ══ חישובי אינדיקטורים ══
function avgArr(arr) { return arr.reduce((a,b)=>a+b,0)/arr.length; }

function calcRSI(closes, period) {
  if (closes.length < period+1) return 50;
  let gains=0, losses=0;
  for (let i=closes.length-period; i<closes.length; i++) {
    const diff=closes[i]-closes[i-1];
    if (diff>0) gains+=diff; else losses+=Math.abs(diff);
  }
  gains/=period; losses/=period;
  if (losses===0) return 100;
  return Math.round(100-(100/(1+gains/losses)));
}

function calcATR(highs, lows, closes, period) {
  if (highs.length<2) return 0;
  const trs=[];
  for (let i=1; i<highs.length; i++)
    trs.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
  return avgArr(trs.slice(-period));
}

function parseYahooData(data) {
  const chart=data?.chart?.result?.[0];
  if (!chart) return null;
  const q=chart.indicators?.quote?.[0];
  if (!q) return null;
  const closes=[], highs=[], lows=[];
  (q.close||[]).forEach((c,i) => {
    if (c!=null && q.high[i]!=null && q.low[i]!=null) {
      closes.push(c); highs.push(q.high[i]); lows.push(q.low[i]);
    }
  });
  if (closes.length<5) return null;
  const price=chart.meta?.regularMarketPrice||closes[closes.length-1];
  const rsi=calcRSI(closes, 14);
  const sma20=closes.length>=20?avgArr(closes.slice(-20)):null;
  const sma50=closes.length>=50?avgArr(closes.slice(-50)):null;
  const atr=calcATR(highs, lows, closes, 14);
  const support=Math.min(...lows.slice(-20));
  const resistance=Math.max(...highs.slice(-20));
  const trendScore=(sma20?(price>sma20?1:-1)*0.5:0)+(sma20&&sma50?(sma20>sma50?1:-1)*0.5:0);
  return {price, rsi, sma20, sma50, atr, support, resistance, trendScore};
}

// ══ ניתוח מניה בודדת ══
async function analyzeStock(ticker, shares, avgCost, name) {
  try {
    const [daily, weekly] = await Promise.all([
      httpsGet('query1.finance.yahoo.com', `/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=3mo&includePrePost=false`, 8000),
      httpsGet('query1.finance.yahoo.com', `/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1wk&range=1y&includePrePost=false`, 8000)
    ]);

    const d=parseYahooData(daily);
    const w=parseYahooData(weekly);
    if (!d) return {ticker, name:name||ticker, shares, avgCost, error:'לא נמצאו נתונים'};

    const price=d.price;
    const sharesNum=parseFloat(shares)||0;
    const value=price*sharesNum;
    const avgCostNum=avgCost?parseFloat(avgCost):null;
    const pnl=avgCostNum&&avgCostNum>0?+((price-avgCostNum)/avgCostNum*100).toFixed(1):null;

    let techScore=50;
    if (d.rsi<30) techScore+=15; else if (d.rsi>70) techScore-=15;
    else if (d.rsi>55) techScore+=7; else if (d.rsi<45) techScore-=7;
    techScore+=d.trendScore*20;
    if (w) techScore+=w.trendScore*10;
    const dist=((price-d.support)/d.support*100);
    if (dist<3) techScore+=10; else if (dist>25) techScore-=5;
    if (pnl!=null) { if (pnl<-15) techScore-=5; else if (pnl>20) techScore+=3; }
    techScore=Math.max(0,Math.min(100,Math.round(techScore)));

    return {
      ticker, name:name||ticker,
      shares:sharesNum, avgCost:avgCostNum,
      price:+price.toFixed(2), value:+value.toFixed(2), pnl,
      rsi:d.rsi,
      sma20:d.sma20?+d.sma20.toFixed(2):null,
      sma50:d.sma50?+d.sma50.toFixed(2):null,
      atr:+d.atr.toFixed(2),
      support:+d.support.toFixed(2),
      resistance:+d.resistance.toFixed(2),
      trend:d.trendScore>0.2?'עולה':d.trendScore<-0.2?'יורד':'מעורב',
      weeklyTrend:w?(w.trendScore>0.2?'עולה':w.trendScore<-0.2?'יורד':'מעורב'):null,
      techScore
    };
  } catch(err) {
    return {ticker, name:name||ticker, shares:parseFloat(shares)||0, avgCost, error:err.message};
  }
}

// ══ ניתוח AI עם Claude ══
function callClaudeForPortfolio(stocks, API_KEY) {
  const valid=stocks.filter(s=>!s.error);
  if (!valid.length) return Promise.resolve(null);
  const totalValue=valid.reduce((sum,s)=>sum+(s.value||0),0);
  const summary=valid.map(s=>`• ${s.name} (${s.ticker}): מחיר ${s.price}, RSI ${s.rsi}, מגמה ${s.trend}, ציון ${s.techScore}/100, שווי ${(s.value||0).toFixed(0)}${s.pnl!=null?`, P&L ${s.pnl}%`:''}`).join('\n');
  const prompt=`אתה יועץ השקעות. נתח תיק זה:\n\n${summary}\n\nשווי כולל: ${totalValue.toFixed(0)} | ${stocks.length} אחזקות\n\nענה ב-JSON בלבד:\n{"portfolio_score":0-100,"portfolio_summary":"3 משפטים","top_strengths":["א","ב"],"main_risks":["א","ב"],"recommendations":["א","ב","ג"],"stocks":[{"ticker":"סימול","score":0-100,"signal":"BUY"/"HOLD"/"SELL","comment":"משפט"}]}`;

  return new Promise((resolve, reject) => {
    const body=JSON.stringify({model:'claude-sonnet-4-6',max_tokens:1500,messages:[{role:'user',content:prompt}]});
    const req=https.request({
      hostname:'api.anthropic.com', path:'/v1/messages', method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':API_KEY,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(body)}
    }, apiRes => {
      let data='';
      apiRes.on('data', c=>data+=c);
      apiRes.on('end', () => {
        try {
          const parsed=JSON.parse(data);
          const text=(parsed.content||[]).map(b=>b.text||'').join('').trim();
          resolve(JSON.parse(text.replace(/```json|```/g,'').trim()));
        } catch(e) { reject(e); }
      });
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Claude API timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ══ חיפוש טיקר לפי שם ══
function isHebrew(text) { return /[\u0590-\u05FF]/.test(text); }

async function searchYahooTicker(name, isIsraeli) {
  try {
    const data=await httpsGet('query1.finance.yahoo.com',
      `/v1/finance/search?q=${encodeURIComponent(name)}&quotesCount=10&newsCount=0`, 6000);
    const quotes=data?.quotes||[];
    if (isIsraeli) {
      const ta=quotes.filter(q=>q.symbol?.endsWith('.TA')&&['EQUITY','ETF','MUTUALFUND'].includes(q.quoteType));
      if (ta.length>0) return {ticker:ta[0].symbol, exchange:'TASE', confidence:'high'};
    } else {
      const us=quotes.filter(q=>!q.symbol?.includes('.')&&['EQUITY','ETF'].includes(q.quoteType));
      if (us.length>0) return {ticker:us[0].symbol, exchange:us[0].exchange||'US', confidence:'high'};
      const any=quotes.find(q=>['EQUITY','ETF'].includes(q.quoteType));
      if (any) return {ticker:any.symbol, exchange:any.exchange||'?', confidence:'medium'};
    }
  } catch(err) {
    console.error('Yahoo search error:', err.message);
  }
  return {ticker:null, exchange:'?', confidence:'low'};
}

// ══ Express Router ══
function createPortfolioApi(API_KEY) {
  const router=express.Router();

  // POST /api/portfolio/analyze
  router.post('/analyze', async (req, res) => {
    const {holdings}=req.body;
    if (!holdings||!Array.isArray(holdings)||holdings.length===0)
      return res.status(400).json({error:'נא לשלוח רשימת אחזקות'});
    if (holdings.length>25)
      return res.status(400).json({error:'מקסימום 25 אחזקות'});

    try {
      console.log(`📊 מנתח ${holdings.length} אחזקות...`);
      const stocks=[];
      for (const h of holdings) {
        const result=await analyzeStock(h.ticker?.trim(), h.shares, h.avgCost, h.name);
        stocks.push(result);
        await new Promise(r=>setTimeout(r,400));
      }

      let aiAnalysis=null;
      if (API_KEY) {
        try {
          aiAnalysis=await callClaudeForPortfolio(stocks, API_KEY);
          console.log(`✅ ניתוח AI הושלם (ציון: ${aiAnalysis?.portfolio_score})`);
        } catch(err) {
          console.error('AI error:', err.message);
        }
      }

      res.json({stocks, aiAnalysis});
    } catch(err) {
      console.error('Portfolio analyze error:', err.message);
      res.status(500).json({error:err.message});
    }
  });

  // GET /api/portfolio/search-ticker?name=...
  router.get('/search-ticker', async (req, res) => {
    const name=req.query.name?.trim();
    if (!name) return res.status(400).json({error:'חסר שם'});
    try {
      const result=await searchYahooTicker(name, isHebrew(name));
      res.json(result);
    } catch(err) {
      res.json({ticker:null, exchange:'?', confidence:'low'});
    }
  });

  return router;
}

module.exports = createPortfolioApi;
