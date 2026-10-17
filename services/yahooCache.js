// services/yahooCache.js
//
// שליפה מהירה מ-Yahoo עם:
//  1. חיבור קבוע (keep-alive) — חוסך לחיצת יד TLS בכל בקשה
//  2. דחיסת gzip — פחות נתונים בדרך
//  3. מטמון בזיכרון — סריקה חוזרת כמעט מיידית
//  4. איחוד בקשות זהות שרצות במקביל
//  5. הגבלת מקביליות — מונע חסימה (429) מ-Yahoo

const https = require('https');
const zlib = require('zlib');

const agent = new https.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 30000 });

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate',
  'Referer': 'https://finance.yahoo.com/',
  'Origin': 'https://finance.yahoo.com',
};

// --- הגבלת מקביליות ---
const MAX_CONCURRENT = 12;
let active = 0;
const queue = [];
function limit(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      active++;
      fn().then(resolve, reject).finally(() => { active--; if (queue.length) queue.shift()(); });
    };
    if (active < MAX_CONCURRENT) run(); else queue.push(run);
  });
}

function rawGet(hostname, path, extraHeaders) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', agent, headers: Object.assign({}, HEADERS, extraHeaders || {}) }, res => {
      let stream = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
      stream.on('error', reject);
    });
    req.setTimeout(10000, () => req.destroy(new Error('Yahoo timeout')));
    req.on('error', reject);
    req.end();
  });
}

// --- ניסיונות חוזרים: שגיאת רשת, חסימה זמנית (429) או תקלת שרת (5xx) ---
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn) {
  const waits = [400, 1200, 2500];
  for (let a = 0; ; a++) {
    try {
      const r = await fn();
      if ((r.status === 429 || r.status >= 500) && a < waits.length) { await sleep(waits[a]); continue; }
      return r;
    } catch (err) {
      if (a >= waits.length) throw err;
      await sleep(waits[a]);
    }
  }
}

// --- מטמון ---
const cache = new Map();      // key -> { t, ttl, status, body }
const inflight = new Map();   // key -> Promise
const MAX_ENTRIES = 3000;

function ttlForChart(interval, range) {
  if (/m$/.test(interval)) return 60 * 1000;            // תוך-יומי: דקה
  if (range === '1d' || range === '5d') return 60 * 1000;
  return 3 * 60 * 1000;                                   // יומי: 3 דקות
}

async function cachedGet(key, ttl, hostname, path, extraHeaders) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < hit.ttl) return hit;
  if (inflight.has(key)) return inflight.get(key);
  const p = limit(() => withRetry(() => rawGet(hostname, path, extraHeaders)))
    .then(r => {
      const entry = { t: Date.now(), ttl: r.status === 200 ? ttl : 15000, status: r.status, body: r.body };
      cache.set(key, entry);
      if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
      return entry;
    })
    .catch(err => {
      if (hit) return hit; // נתון ישן עדיף על שגיאה
      throw err;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function getChart(ticker, interval, range) {
  interval = interval || '1d';
  range = range || '3mo';
  const path = '/v8/finance/chart/' + encodeURIComponent(ticker) +
    '?interval=' + encodeURIComponent(interval) + '&range=' + encodeURIComponent(range) + '&includePrePost=false';
  return cachedGet('c|' + ticker + '|' + interval + '|' + range, ttlForChart(interval, range), 'query1.finance.yahoo.com', path);
}

// --- quote (P/E וכו') עם crumb ---
let COOKIE = null, CRUMB = null, crumbPromise = null;
function ensureCrumb() {
  if (CRUMB) return Promise.resolve(CRUMB);
  if (crumbPromise) return crumbPromise;
  crumbPromise = rawGet('fc.yahoo.com', '/')
    .then(r => {
      const sc = r.headers['set-cookie'];
      if (sc) COOKIE = sc.map(c => c.split(';')[0]).join('; ');
      return rawGet('query2.finance.yahoo.com', '/v1/test/getcrumb', { Cookie: COOKIE || '' });
    })
    .then(r => { CRUMB = r.status === 200 ? r.body.trim() : null; return CRUMB; })
    .catch(() => null)
    .finally(() => { crumbPromise = null; });
  return crumbPromise;
}

async function getQuote(ticker) {
  const crumb = await ensureCrumb();
  let path = '/v7/finance/quote?symbols=' + encodeURIComponent(ticker);
  if (crumb) path += '&crumb=' + encodeURIComponent(crumb);
  const r = await cachedGet('q|' + ticker, 10 * 60 * 1000, 'query1.finance.yahoo.com', path, { Cookie: COOKIE || '' });
  if (r.status === 401) { CRUMB = null; cache.delete('q|' + ticker); }
  return r;
}

// --- כתיבת תשובה ללקוח, עם gzip אם הדפדפן תומך ---
function send(req, res, status, body, contentType) {
  const headers = { 'Content-Type': contentType || 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' };
  const accepts = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (accepts && body.length > 1024) {
    zlib.gzip(body, (err, gz) => {
      if (err) { res.writeHead(status, headers); res.end(body); return; }
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
      res.writeHead(status, headers);
      res.end(gz);
    });
  } else {
    res.writeHead(status, headers);
    res.end(body);
  }
}

// כמה סימולים בבקשה אחת (לתאריכי דוחות)
async function getQuotes(tickers) {
  const out = {};
  for (let k = 0; k < tickers.length; k += 40) {
    const chunk = tickers.slice(k, k + 40);
    try {
      const r = await getQuote(chunk.join(','));
      const j = JSON.parse(r.body);
      for (const q of (j.quoteResponse && j.quoteResponse.result) || []) out[q.symbol] = q;
    } catch (e) { /* best effort */ }
  }
  return out;
}

function search(q) {
  const path = '/v1/finance/search?q=' + encodeURIComponent(q) + '&quotesCount=8&newsCount=0';
  return cachedGet('s|' + q.toLowerCase(), 24 * 3600 * 1000, 'query2.finance.yahoo.com', path);
}

module.exports = { getChart, getQuote, getQuotes, search, send, rawGet, cacheSize: () => cache.size };
