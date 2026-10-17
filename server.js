const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const yc = require('./services/yahooCache');
const { handleStockAnalysis } = require('./routes/stockAnalysisApi');
const news = require('./routes/newsApi');
const API_KEY = process.env.ANTHROPIC_API_KEY;

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  };
  return map[ext] || 'application/octet-stream';
}

function proxyAnthropic(body, res) {
  const req = https.request({
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    }
  }, apiRes => {
    let data = '';
    apiRes.on('data', c => data += c);
    apiRes.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(data);
    });
  });
  req.on('error', err => { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); });
  req.write(body);
  req.end();
}

function proxyYahoo(ticker, res, interval, range) {
  interval = interval || '1d';
  range = range || '3mo';
  const reqOptions = {
    hostname: 'query1.finance.yahoo.com',
    path: '/v8/finance/chart/' + ticker + '?interval=' + interval + '&range=' + range + '&includePrePost=false',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'identity',
      'Referer': 'https://finance.yahoo.com/',
      'Origin': 'https://finance.yahoo.com',
      'Connection': 'keep-alive'
    }
  };

  const req = https.request(reqOptions, apiRes => {
    let data = '';
    apiRes.on('data', c => data += c);
    apiRes.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(data);
    });
  });
  req.on('error', err => { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); });
  req.end();
}

let YAHOO_COOKIE = null;
let YAHOO_CRUMB = null;
let crumbFetchInProgress = false;

function fetchYahooCrumb(callback) {
  if (crumbFetchInProgress) { setTimeout(() => callback(YAHOO_CRUMB), 1000); return; }
  crumbFetchInProgress = true;

  const homeReq = https.request({
    hostname: 'fc.yahoo.com',
    path: '/',
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  }, homeRes => {
    const setCookie = homeRes.headers['set-cookie'];
    if (setCookie) YAHOO_COOKIE = setCookie.map(c => c.split(';')[0]).join('; ');
    homeRes.resume();
    homeRes.on('end', () => {
      const crumbReq = https.request({
        hostname: 'query2.finance.yahoo.com',
        path: '/v1/test/getcrumb',
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Cookie': YAHOO_COOKIE || ''
        }
      }, crumbRes => {
        let data = '';
        crumbRes.on('data', c => data += c);
        crumbRes.on('end', () => {
          YAHOO_CRUMB = data.trim();
          crumbFetchInProgress = false;
          callback(YAHOO_CRUMB);
        });
      });
      crumbReq.on('error', () => { crumbFetchInProgress = false; callback(null); });
      crumbReq.end();
    });
  });
  homeReq.on('error', () => { crumbFetchInProgress = false; callback(null); });
  homeReq.end();
}

function proxyYahooQuote(ticker, res) {
  function doRequest(crumb) {
    let path = '/v7/finance/quote?symbols=' + ticker;
    if (crumb) path += '&crumb=' + encodeURIComponent(crumb);
    const reqOptions = {
      hostname: 'query1.finance.yahoo.com',
      path: path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Referer': 'https://finance.yahoo.com/',
        'Origin': 'https://finance.yahoo.com',
        'Connection': 'keep-alive',
        'Cookie': YAHOO_COOKIE || ''
      }
    };
    const req = https.request(reqOptions, apiRes => {
      let data = '';
      apiRes.on('data', c => data += c);
      apiRes.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(data);
      });
    });
    req.on('error', err => { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); });
    req.end();
  }

  if (YAHOO_CRUMB) {
    doRequest(YAHOO_CRUMB);
  } else {
    fetchYahooCrumb(crumb => doRequest(crumb));
  }
}

function proxyTaseNews(res) {
  const reqOptions = {
    hostname: 'apicontent.tase.co.il',
    path: '/api/Cms?Route=/content/news-lobby&culture=he-IL',
    method: 'GET',
    headers: {
      'accept': 'application/json, */*',
      'accept-language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
      'content-type': 'application/json',
      'origin': 'https://www.tase.co.il',
      'referer': 'https://www.tase.co.il/',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  };
  const req = https.request(reqOptions, apiRes => {
    let data = '';
    apiRes.on('data', c => data += c);
    apiRes.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(data);
    });
  });
  req.on('error', err => { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); });
  req.end();
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    yc.send(req, res, 200, html, 'text/html; charset=utf-8');
    return;
  }

  // חדשות הבורסה: כותרות מהירות + ניתוח AI עם מטמון
  if (req.method === 'GET' && req.url.startsWith('/api/news-headlines')) { news.handleHeadlines(req, res); return; }
  if (req.method === 'GET' && req.url.startsWith('/api/news-analysis')) { news.handleAnalysis(req, res); return; }

  // ניתוח טכני מלא למניה (מודול חדש)
  if (req.method === 'GET' && req.url.startsWith('/api/stock-analysis')) {
    handleStockAnalysis(req, res);
    return;
  }

  if (req.method === 'POST' && req.url === '/api/analyze') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => proxyAnthropic(body, res));
    return;
  }

  // חשוב: הבדיקות הספציפיות (yahoo-quote, yahoo-news) חייבות לבוא
  // *לפני* הבדיקה הכללית של /api/yahoo, אחרת הן ייתפסו בטעות שם.

  if (req.method === 'GET' && req.url.startsWith('/api/yahoo-quote')) {
    const parsed = new url.URL('http://x' + req.url);
    const ticker = parsed.searchParams.get('ticker');
    if (!ticker) { res.writeHead(400); res.end('Missing ticker'); return; }
    yc.getQuote(ticker)
      .then(r => yc.send(req, res, 200, r.body))
      .catch(err => yc.send(req, res, 500, JSON.stringify({ error: err.message })));
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/tase-news')) {
    proxyTaseNews(res);
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/yahoo-news')) {
    const parsed = new url.URL('http://x' + req.url);
    const category = parsed.searchParams.get('category') || '';
    let newsPath = '/rss/topfinstories';
    if (category === 'market') newsPath = '/rss/topfinstories';
    else if (category === 'stocks') newsPath = '/rss/headline?s=^GSPC,^IXIC,^DJI';
    else if (category === 'crypto') newsPath = '/rss/headline?s=BTC-USD';

    const newsReq = https.request({
      hostname: 'finance.yahoo.com',
      path: newsPath,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    }, newsRes => {
      let data = '';
      newsRes.on('data', c => data += c);
      newsRes.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/xml', 'Access-Control-Allow-Origin': '*' });
        res.end(data);
      });
    });
    newsReq.on('error', err => { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); });
    newsReq.end();
    return;
  }

  // הבדיקה הכללית של /api/yahoo (לצ'ארטים) - אחרי הבדיקות הספציפיות
  if (req.method === 'GET' && req.url.startsWith('/api/yahoo')) {
    const parsed = new url.URL('http://x' + req.url);
    const ticker = parsed.searchParams.get('ticker');
    if (!ticker) { res.writeHead(400); res.end('Missing ticker'); return; }
    const interval = parsed.searchParams.get('interval') || '1d';
    const range = parsed.searchParams.get('range') || '3mo';
    // מטמון + חיבור קבוע: סריקה חוזרת כמעט מיידית
    yc.getChart(ticker, interval, range)
      .then(r => yc.send(req, res, 200, r.body))
      .catch(err => yc.send(req, res, 500, JSON.stringify({ error: err.message })));
    return;
  }

  // route גנרי לכל קובץ אחר בתוך public (css/js/watcher.html/תמונות וכו')
  if (req.method === 'GET' && !req.url.startsWith('/api/')) {
    const parsed = new url.URL('http://x' + req.url);
    const safePath = path.normalize(decodeURIComponent(parsed.pathname)).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(__dirname, 'public', safePath);

    if (filePath.startsWith(path.join(__dirname, 'public'))) {
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': getContentType(filePath) });
        res.end(data);
      });
      return;
    }
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log('TradeVision running on http://localhost:' + PORT);
});
