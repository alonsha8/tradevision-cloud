// routes/portfolioApi.js
const https = require('https');
const express = require('express');

function httpsGetSafe(hostname, path, ms) {
  return new Promise((resolve) => {
    let done = false;
    function fin(v) { if (!done) { done=true; resolve(v); } }
    try {
      const req = https.request({
        hostname, path, method:'GET',
        headers:{
          'User-Agent':'Mozilla/5.0',
          'Accept':'application/json',
          'Accept-Encoding':'identity',
          'Referer':'https://finance.yahoo.com/',
          'Origin':'https://finance.yahoo.com'
        }
      }, r => {
        let d='';
        r.on('data', c=>d+=c);
        r.on('end', ()=>{ try{fin(JSON.parse(d));}catch(e){fin(null);} });
        r.on('error', ()=>fin(null));
      });
      req.setTimeout(ms||6000, ()=>{ fin(null); req.destroy(); });
      req.on('error', ()=>fin(null));
      req.end();
    } catch(e) { fin(null); }
  });
}

function avgArr(a){return a.reduce((x,y)=>x+y,0)/a.length;}
function calcRSI(c,p){
  if(c.length<p+1)return 50;
  let g=0,l=0;
  for(let i=c.length-p;i<c.length;i++){const d=c[i]-c[i-1];if(d>0)g+=d;else l+=Math.abs(d);}
  g/=p;l/=p;if(l===0)return 100;
  return Math.round(100-(100/(1+g/l)));
}
function calcATR(h,l,c,p){
  if(h.length<2)return 0;
  const t=[];
  for(let i=1;i<h.length;i++)t.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));
  return avgArr(t.slice(-p));
}
function parseY(data){
  const ch=data?.chart?.result?.[0];if(!ch)return null;
  const q=ch.indicators?.quote?.[0];if(!q)return null;
  const cl=[],hi=[],lo=[];
  (q.close||[]).forEach((c,i)=>{if(c!=null&&q.high[i]!=null&&q.low[i]!=null){cl.push(c);hi.push(q.high[i]);lo.push(q.low[i]);}});
  if(cl.length<5)return null;
  const price=ch.meta?.regularMarketPrice||cl[cl.length-1];
  const rsi=calcRSI(cl,14);
  const s20=cl.length>=20?avgArr(cl.slice(-20)):null;
  const s50=cl.length>=50?avgArr(cl.slice(-50)):null;
  const atr=calcATR(hi,lo,cl,14);
  const sup=Math.min(...lo.slice(-20));
  const res=Math.max(...hi.slice(-20));
  const tr=(s20?(price>s20?1:-1)*0.5:0)+(s20&&s50?(s20>s50?1:-1)*0.5:0);
  return {price,rsi,s20,s50,atr,sup,res,tr};
}

async function analyzeStock(ticker,shares,avgCost,name){
  try{
    const t=encodeURIComponent(ticker);
    const[d,w]=await Promise.all([
      httpsGetSafe('query1.finance.yahoo.com',`/v8/finance/chart/${t}?interval=1d&range=3mo&includePrePost=false`,6000),
      httpsGetSafe('query1.finance.yahoo.com',`/v8/finance/chart/${t}?interval=1wk&range=1y&includePrePost=false`,6000)
    ]);
    const D=parseY(d),W=parseY(w);
    if(!D)return{ticker,name:name||ticker,shares:parseFloat(shares)||0,avgCost,error:'לא נמצאו נתונים'};
    const price=D.price,sh=parseFloat(shares)||0,val=price*sh;
    const ac=avgCost?parseFloat(avgCost):null;
    const pnl=ac&&ac>0?+((price-ac)/ac*100).toFixed(1):null;
    let sc=50;
    if(D.rsi<30)sc+=15;else if(D.rsi>70)sc-=15;else if(D.rsi>55)sc+=7;else if(D.rsi<45)sc-=7;
    sc+=D.tr*20;if(W)sc+=W.tr*10;
    const dist=D.sup>0?((price-D.sup)/D.sup*100):0;
    if(dist<3)sc+=10;else if(dist>25)sc-=5;
    if(pnl!=null){if(pnl<-15)sc-=5;else if(pnl>20)sc+=3;}
    sc=Math.max(0,Math.min(100,Math.round(sc)));
    return{ticker,name:name||ticker,shares:sh,avgCost:ac,
      price:+price.toFixed(2),value:+val.toFixed(2),pnl,rsi:D.rsi,
      sma20:D.s20?+D.s20.toFixed(2):null,sma50:D.s50?+D.s50.toFixed(2):null,
      atr:+D.atr.toFixed(2),support:+D.sup.toFixed(2),resistance:+D.res.toFixed(2),
      trend:D.tr>0.2?'עולה':D.tr<-0.2?'יורד':'מעורב',
      weeklyTrend:W?(W.tr>0.2?'עולה':W.tr<-0.2?'יורד':'מעורב'):null,
      techScore:sc};
  }catch(e){return{ticker,name:name||ticker,shares:parseFloat(shares)||0,avgCost,error:e.message};}
}

function callClaude(stocks,API_KEY){
  const v=stocks.filter(s=>!s.error);
  if(!v.length||!API_KEY)return Promise.resolve(null);
  const tot=v.reduce((s,x)=>s+(x.value||0),0);
  const sum=v.map(s=>`• ${s.name}(${s.ticker}): ₪${s.price} RSI:${s.rsi} ${s.trend} ציון:${s.techScore}${s.pnl!=null?' P&L:'+s.pnl+'%':''}`).join('\n');
  const prompt=`יועץ השקעות — נתח תיק:\n${sum}\nשווי כולל:${tot.toFixed(0)}\nענה JSON בלבד:\n{"portfolio_score":75,"portfolio_summary":"סיכום 2 משפטים","top_strengths":["א","ב"],"main_risks":["א","ב"],"recommendations":["א","ב","ג"],"stocks":[{"ticker":"X","score":70,"signal":"BUY","comment":"הערה"}]}`;
  return new Promise((resolve)=>{
    let done=false;
    function fin(v){if(!done){done=true;resolve(v);}}
    setTimeout(()=>{console.log('Claude timeout');fin(null);},20000);
    try{
      const body=JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:1000,messages:[{role:'user',content:prompt}]});
      const req=https.request({hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',
        headers:{'Content-Type':'application/json','x-api-key':API_KEY,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(body)}
      },r=>{
        let d='';r.on('data',c=>d+=c);
        r.on('end',()=>{try{const p=JSON.parse(d);const t=(p.content||[]).map(b=>b.text||'').join('').trim();fin(JSON.parse(t.replace(/```json|```/g,'').trim()));}catch(e){fin(null);}});
        r.on('error',()=>fin(null));
      });
      req.on('error',()=>fin(null));
      req.write(body);req.end();
    }catch(e){fin(null);}
  });
}

function isHebrew(t){return /[\u0590-\u05FF]/.test(t);}
async function searchTicker(name,israeli){
  const data=await httpsGetSafe('query1.finance.yahoo.com',`/v1/finance/search?q=${encodeURIComponent(name)}&quotesCount=10&newsCount=0`,5000);
  if(!data)return{ticker:null,exchange:'?',confidence:'low'};
  const q=data.quotes||[];
  if(israeli){const ta=q.filter(x=>x.symbol?.endsWith('.TA')&&['EQUITY','ETF','MUTUALFUND'].includes(x.quoteType));if(ta.length)return{ticker:ta[0].symbol,exchange:'TASE',confidence:'high'};}
  else{const us=q.filter(x=>!x.symbol?.includes('.')&&['EQUITY','ETF'].includes(x.quoteType));if(us.length)return{ticker:us[0].symbol,exchange:us[0].exchange||'US',confidence:'high'};const any=q.find(x=>['EQUITY','ETF'].includes(x.quoteType));if(any)return{ticker:any.symbol,exchange:any.exchange||'?',confidence:'medium'};}
  return{ticker:null,exchange:'?',confidence:'low'};
}

function createPortfolioApi(API_KEY){
  const router=express.Router();

  // ⚠️ express.json() מוסף ישירות על ה-route כי הוא נרשם לפני middleware הגלובלי
  router.post('/analyze', express.json({limit:'2mb'}), (req,res)=>{
    const body=req.body||{};
    const holdings=body.holdings;
    if(!holdings||!Array.isArray(holdings)||!holdings.length)
      return res.json({stocks:[],aiAnalysis:null,error:'נא לשלוח רשימת אחזקות'});
    if(holdings.length>25)
      return res.json({stocks:[],aiAnalysis:null,error:'מקסימום 25 אחזקות'});

    console.log(`📊 מנתח ${holdings.length} אחזקות...`);
    let sent=false;
    function send(data){if(!sent){sent=true;try{res.json(data);}catch(e){console.error('send err:',e.message);}}}

    // Hard timeout — תמיד שולח תשובה תוך 25 שניות
    const t=setTimeout(()=>{console.log('hard timeout');send({stocks:[],aiAnalysis:null,error:'Timeout — נסה עם פחות ניירות ערך'});},25000);

    Promise.all(holdings.map(h=>analyzeStock(h.ticker?.trim(),h.shares,h.avgCost,h.name)))
      .then(stocks=>{
        console.log(`✅ Yahoo: ${stocks.filter(s=>!s.error).length}/${stocks.length}`);
        return callClaude(stocks,API_KEY).then(ai=>{clearTimeout(t);send({stocks,aiAnalysis:ai});});
      })
      .catch(e=>{clearTimeout(t);send({stocks:[],aiAnalysis:null,error:e.message});});
  });

  router.get('/search-ticker',(req,res)=>{
    const name=(req.query.name||'').trim();
    if(!name)return res.json({ticker:null,exchange:'?',confidence:'low'});
    searchTicker(name,isHebrew(name))
      .then(r=>res.json(r))
      .catch(()=>res.json({ticker:null,exchange:'?',confidence:'low'}));
  });

  return router;
}

module.exports=createPortfolioApi;
