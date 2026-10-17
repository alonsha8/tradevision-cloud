// server.js — TradeVision Cloud
//
// משתני סביבה (Render → Environment):
//   ANTHROPIC_API_KEY  — מפתח Claude (חובה לפיצ'רים של AI)
//   APP_PASSWORD       — סיסמת כניסה לאפליקציה (מומלץ מאוד; בלעדיה האפליקציה פתוחה לכל העולם)
//   DATABASE_URL       — PostgreSQL (יומן עסקאות, התראות, היסטוריית סקטורים). בלעדיו החלקים האלה מושבתים.

const express = require('express');
const compression = require('compression');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const yc = require('./services/yahooCache');
const { handleStockAnalysis } = require('./routes/stockAnalysisApi');
const news = require('./routes/newsApi');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const DATABASE_URL = process.env.DATABASE_URL || '';

if (!API_KEY) console.warn('⚠️  ANTHROPIC_API_KEY לא מוגדר — פיצ\'רי AI לא יעבדו');
if (!APP_PASSWORD) console.warn('⚠️  APP_PASSWORD לא מוגדר — האפליקציה פתוחה לכל מי שיודע את הכתובת');
if (!DATABASE_URL) console.warn('⚠️  DATABASE_URL לא מוגדר — יומן עסקאות והתראות מושבתים');

const localDb = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: localDb ? false : { rejectUnauthorized: false }, max: 5 }) : null;
if (pool) pool.on('error', err => console.error('PostgreSQL error:', err.message));
app.locals.pool = pool;

app.set('trust proxy', 1); // Render יושב מאחורי proxy — כדי לקבל IP אמיתי
app.use(compression());

// ══════════════ הגבלת קצב פשוטה (בזיכרון) ══════════════
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start > windowMs) { b = { start: now, n: 0 }; buckets.set(key, b); }
  b.n++;
  if (buckets.size > 10000) buckets.clear();
  return b.n <= max;
}

// ══════════════ סיסמה ══════════════
const AUTH_COOKIE = 'tv_auth';
const authToken = APP_PASSWORD ? crypto.createHmac('sha256', APP_PASSWORD).update('tradevision-v1').digest('hex') : '';

function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
function isAuthed(req) {
  if (!APP_PASSWORD) return true;
  const c = getCookie(req, AUTH_COOKIE);
  return !!c && c.length === authToken.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(authToken));
}

const LOGIN_PAGE = (err) => `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TradeVision — כניסה</title><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f7fb;font-family:Heebo,system-ui,sans-serif;color:#18202f}
form{background:#fff;border:1px solid #e2e6ee;border-radius:16px;padding:28px;width:min(340px,92vw);box-shadow:0 4px 20px rgba(16,24,40,.06)}
h1{font-size:20px;margin:0 0 16px}input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #e2e6ee;border-radius:10px;font:inherit;margin-bottom:12px}
button{width:100%;padding:12px;border:0;border-radius:10px;background:#0a9b80;color:#fff;font:inherit;font-weight:700;cursor:pointer}
.e{color:#b91c1c;font-size:14px;margin-bottom:10px}</style></head><body>
<form method="post" action="/login"><h1>TradeVision AI</h1>${err ? `<div class="e">${err}</div>` : ''}
<input type="password" name="password" placeholder="סיסמה" autofocus autocomplete="current-password"><button>כניסה</button></form></body></html>`;

app.get('/login', (req, res) => res.type('html').send(LOGIN_PAGE('')));
app.post('/login', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
  if (!APP_PASSWORD) return res.redirect('/');
  if (!rateLimit('login:' + req.ip, 10, 15 * 60 * 1000)) return res.status(429).type('html').send(LOGIN_PAGE('יותר מדי ניסיונות. נסו שוב בעוד 15 דקות.'));
  const ok = typeof req.body.password === 'string' &&
    crypto.timingSafeEqual(crypto.createHash('sha256').update(req.body.password).digest(), crypto.createHash('sha256').update(APP_PASSWORD).digest());
  if (!ok) return res.status(401).type('html').send(LOGIN_PAGE('סיסמה שגויה'));
  const secure = req.secure ? ' Secure;' : '';
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${authToken}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${60 * 60 * 24 * 60}`);
  res.redirect('/');
});
app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.redirect('/login');
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', database: !!pool, auth: !!APP_PASSWORD, ai: !!API_KEY, time: new Date().toISOString() }));

// כל השאר — רק אחרי כניסה
app.use((req, res, next) => {
  if (isAuthed(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'נדרשת כניסה מחדש — רעננו את הדף' });
  res.redirect('/login');
});

// ══════════════ Claude — מוגן ══════════════
// מודלים מותרים בלבד, תקרת טוקנים והגבלת קצב: גם אם מישהו עוקף את הסיסמה, הנזק מוגבל.
const ALLOWED_MODELS = ['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001'];
app.post('/api/analyze', express.json({ limit: '12mb' }), (req, res) => {
  if (!API_KEY) return res.status(503).json({ error: { message: 'ANTHROPIC_API_KEY לא מוגדר בשרת' } });
  if (!rateLimit('ai:' + req.ip, 120, 60 * 60 * 1000)) return res.status(429).json({ error: { message: 'יותר מדי בקשות AI בשעה האחרונה. נסו שוב מאוחר יותר.' } });
  const b = req.body || {};
  if (!Array.isArray(b.messages) || !b.messages.length) return res.status(400).json({ error: { message: 'בקשה לא תקינה' } });
  const safe = {
    model: ALLOWED_MODELS.includes(b.model) ? b.model : 'claude-sonnet-4-6',
    max_tokens: Math.min(Math.max(parseInt(b.max_tokens, 10) || 1000, 1), 4000),
    messages: b.messages,
  };
  if (typeof b.system === 'string') safe.system = b.system;
  if (typeof b.temperature === 'number') safe.temperature = b.temperature;
  const body = JSON.stringify(safe);
  const apiReq = https.request({
    hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) }
  }, apiRes => {
    let data = '';
    apiRes.on('data', c => data += c);
    apiRes.on('end', () => res.status(200).type('json').send(data));
  });
  apiReq.setTimeout(90000, () => apiReq.destroy(new Error('timeout')));
  apiReq.on('error', err => { if (!res.headersSent) res.status(502).json({ error: { message: err.message } }); });
  apiReq.write(body);
  apiReq.end();
});

// ══════════════ Yahoo (עם מטמון) ══════════════
app.get('/api/yahoo-quote', (req, res) => {
  const ticker = req.query.ticker;
  if (!ticker) return res.status(400).send('Missing ticker');
  yc.getQuote(String(ticker)).then(r => res.type('json').send(r.body)).catch(err => res.status(500).json({ error: err.message }));
});

app.get('/api/yahoo', (req, res) => {
  const ticker = req.query.ticker;
  if (!ticker) return res.status(400).send('Missing ticker');
  yc.getChart(String(ticker), String(req.query.interval || '1d'), String(req.query.range || '3mo'))
    .then(r => res.type('json').send(r.body))
    .catch(err => res.status(500).json({ error: err.message }));
});

app.get('/api/yahoo-news', (req, res) => {
  const category = req.query.category || '';
  let newsPath = '/rss/topfinstories';
  if (category === 'stocks') newsPath = '/rss/headline?s=^GSPC,^IXIC,^DJI';
  else if (category === 'crypto') newsPath = '/rss/headline?s=BTC-USD';
  yc.rawGet('finance.yahoo.com', newsPath, { Accept: 'application/rss+xml, application/xml, text/xml, */*' })
    .then(r => res.type('text/xml').send(r.body))
    .catch(err => res.status(500).json({ error: err.message }));
});

// ══════════════ חדשות + ניתוח מניה ══════════════
app.get('/api/news-headlines', news.handleHeadlines);
app.get('/api/news-analysis', news.handleAnalysis);
app.get('/api/stock-analysis', handleStockAnalysis);

// ══════════════ סורק על המנוע (מקור אחד לכל האפליקציה) ══════════════
const scanner = require('./services/scanner');
app.get('/api/scan', (req, res) => {
  const market = String(req.query.market || 'us').toUpperCase() === 'TA' ? 'TA' : 'US';
  scanner.scanMarket(market, req.query.force === '1').then(v => res.json(v)).catch(err => res.status(502).json({ error: err.message }));
});
app.get('/api/quick', (req, res) => {
  const t = String(req.query.ticker || '').trim().toUpperCase();
  if (!t || !/^[A-Z0-9.\-^=]{1,15}$/.test(t)) return res.status(400).json({ error: 'סימול לא תקין' });
  scanner.analyzeTicker(t).then(r => res.json(r)).catch(err => res.status(502).json({ error: err.message }));
});
app.get('/api/regime', (req, res) => {
  Promise.all([scanner.regime('US'), scanner.regime('TA')]).then(([us, ta]) => res.json({ US: us, TA: ta })).catch(err => res.status(502).json({ error: err.message }));
});

// ══════════════ מודולים שהיו מנותקים מאז יולי ══════════════
const createSectorScannerApi = require('./routes/sectorScannerApi');
app.use('/api/sector-scanner', createSectorScannerApi(pool));
const createBacktestApi = require('./routes/backtestApi');
app.use('/api/backtest', createBacktestApi(pool));
const createPortfolioApi = require('./routes/portfolioApi');
app.use('/api/portfolio', createPortfolioApi(API_KEY));

// ══════════════ יומן עסקאות + סריקות מתוזמנות ══════════════
const journal = require('./services/journal');
if (pool) {
  journal.initTables(pool).then(() => console.log('✅ טבלאות היומן מוכנות')).catch(e => console.error('journal init:', e.message));
  app.get('/api/journal', (req, res) => journal.journalStats(pool).then(d => res.json(d)).catch(e => res.status(500).json({ error: e.message })));
  app.post('/api/journal', express.json(), async (req, res) => {
    const b = req.body || {};
    const n = x => (typeof x === 'number' && isFinite(x) && x > 0 ? x : null);
    const entry = n(b.entry), stop = n(b.stop), target = n(b.target);
    if (!b.ticker || !entry || !stop || !target || !(stop < entry && entry < target)) return res.status(400).json({ error: 'נתוני התוכנית לא תקינים (נדרש סטופ < כניסה < יעד)' });
    if (!['market', 'limit', 'stop'].includes(b.planType)) return res.status(400).json({ error: 'סוג פקודה לא תקין' });
    try {
      const r = await pool.query(`INSERT INTO trade_journal (ticker, currency, decision, plan_type, entry, stop, target, shares, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [String(b.ticker).toUpperCase().slice(0, 20), String(b.currency || '').slice(0, 5), String(b.decision || '').slice(0, 10), b.planType, entry, stop, target, Number.isInteger(b.shares) ? b.shares : null, String(b.notes || '').slice(0, 500)]);
      res.json({ id: r.rows[0].id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/journal/:id/cancel', (req, res) => pool.query(`UPDATE trade_journal SET status='cancelled' WHERE id=$1 AND status IN ('pending','open')`, [+req.params.id]).then(() => res.json({ ok: true })).catch(e => res.status(500).json({ error: e.message })));
  app.delete('/api/journal/:id', (req, res) => pool.query('DELETE FROM trade_journal WHERE id=$1', [+req.params.id]).then(() => res.json({ ok: true })).catch(e => res.status(500).json({ error: e.message })));
  app.post('/api/journal/refresh', (req, res) => journal.trackAll(pool).then(() => res.json({ ok: true })).catch(e => res.status(500).json({ error: e.message })));
} else {
  app.use('/api/journal', (req, res) => res.status(503).json({ error: 'יומן העסקאות דורש מסד נתונים (DATABASE_URL ב-Render)' }));
}
if (require.main === module) journal.startSchedules(pool);

if (pool) {
  const createWatcherApi = require('./routes/watcherApi');
  app.use('/api/watcher', createWatcherApi(pool));
  if (require.main === module) require('./watchers/dailyCheck')(pool); // פורום ספונסר: 10:15, 14:00, 16:00
} else {
  app.use('/api/watcher', (req, res) => res.status(503).json({ error: 'מסד הנתונים לא מוגדר (DATABASE_URL)' }));
}

// ══════════════ קבצים סטטיים ══════════════
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((req, res) => res.status(404).send('Not found'));

if (require.main === module) app.listen(PORT, () => console.log('TradeVision running on port ' + PORT));

module.exports = app;
