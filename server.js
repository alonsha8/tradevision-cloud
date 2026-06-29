const express = require('express');
const https = require('https');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// ══ Configuration via environment variables (set in Render dashboard) ══
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';

if (!API_KEY) {
  console.warn('⚠️  WARNING: ANTHROPIC_API_KEY environment variable is not set. AI features will not work.');
}
if (!DATABASE_URL) {
  console.warn('⚠️  WARNING: DATABASE_URL environment variable is not set. Trading desk / portfolio sync will not work.');
}

const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
}) : null;
const startDailyWatcher = require('./watchers/dailyCheck');
   const createWatcherApi = require('./routes/watcherApi');

   if (pool) {
     startDailyWatcher(pool);
     app.use('/api/watcher', createWatcherApi(pool));
   }

// ══ Database setup: single-row tables keyed by a fixed account id ══
// Since this is a personal single-user app, we use a fixed accountId ('default')
// rather than building a full multi-user auth system.
async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trading_account (
      account_id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saved_portfolios (
      account_id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ Database tables ready');
}

initDb().catch(err => console.error('DB init error:', err.message));

// ══ Middleware ══
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ══ Serve static frontend ══
app.use(express.static(path.join(__dirname, 'public')));

// ══ Anthropic API proxy ══
app.post('/api/analyze', (req, res) => {
  const body = JSON.stringify(req.body);
  const apiReq = https.request({
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
      res.status(200).json(JSON.parse(data));
    });
  });
  apiReq.on('error', err => res.status(500).json({ error: err.message }));
  apiReq.write(body);
  apiReq.end();
});

// ══ Yahoo Finance chart proxy ══
function proxyYahooChart(ticker, res) {
  const reqOptions = {
       hostname: 'query1.finance.yahoo.com',
    path: '/v8/finance/chart/' + encodeURIComponent(ticker) + '?interval=' + encodeURIComponent(interval) + '&range=' + encodeURIComponent(range) + '&includePrePost=false',
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
      res.status(200).send(data);
    });
  });
  req.on('error', err => res.status(500).json({ error: err.message }));
  req.end();
}

app.get('/api/yahoo', (req, res) => {
  const ticker = req.query.ticker;
  if (!ticker) return res.status(400).send('Missing ticker');
  const interval = req.query.interval || '1d';
  const range = req.query.range || '3mo';
  proxyYahooChart(ticker, interval, range, res);
});

// ══ Yahoo Finance quote proxy (P/E, market cap - best effort with crumb) ══
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
    let qpath = '/v7/finance/quote?symbols=' + encodeURIComponent(ticker);
    if (crumb) qpath += '&crumb=' + encodeURIComponent(crumb);
    const reqOptions = {
      hostname: 'query1.finance.yahoo.com',
      path: qpath,
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
      apiRes.on('end', () => res.status(200).send(data));
    });
    req.on('error', err => res.status(500).json({ error: err.message }));
    req.end();
  }

  if (YAHOO_CRUMB) doRequest(YAHOO_CRUMB);
  else fetchYahooCrumb(crumb => doRequest(crumb));
}

app.get('/api/yahoo-quote', (req, res) => {
  const ticker = req.query.ticker;
  if (!ticker) return res.status(400).send('Missing ticker');
  proxyYahooQuote(ticker, res);
});

// ══ Trading Account persistence (synced across all devices) ══
const ACCOUNT_ID = 'default'; // single-user app

app.get('/api/trading-account', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    const result = await pool.query('SELECT data FROM trading_account WHERE account_id = $1', [ACCOUNT_ID]);
    if (result.rows.length === 0) return res.json(null);
    res.json(result.rows[0].data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/trading-account', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    const data = req.body;
    await pool.query(
      `INSERT INTO trading_account (account_id, data, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (account_id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [ACCOUNT_ID, JSON.stringify(data)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/trading-account', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    await pool.query('DELETE FROM trading_account WHERE account_id = $1', [ACCOUNT_ID]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══ Saved Portfolios persistence (synced across all devices) ══
app.get('/api/saved-portfolios', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    const result = await pool.query('SELECT data FROM saved_portfolios WHERE account_id = $1', [ACCOUNT_ID]);
    if (result.rows.length === 0) return res.json([]);
    res.json(result.rows[0].data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/saved-portfolios', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    const data = req.body;
    await pool.query(
      `INSERT INTO saved_portfolios (account_id, data, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (account_id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [ACCOUNT_ID, JSON.stringify(data)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══ Health check (useful for uptime monitoring) ══
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', database: !!pool, timestamp: new Date().toISOString() });
});

// ══ Fallback to index.html for any other route (SPA-style) ══
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('TradeVision Cloud running on port ' + PORT);
});
