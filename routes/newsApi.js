// routes/newsApi.js
// חדשות הבורסה + ניתוח AI — מהיר:
//  • החדשות הגולמיות נשמרות במטמון 3 דקות (הכותרות מוצגות מיד)
//  • ניתוח ה-AI נשמר לפי תוכן הכותרות: כל עוד לא הגיעו ידיעות חדשות, התשובה מיידית
//  • מודל מהיר (Haiku) עם גיבוי אוטומטי ל-Sonnet אם נכשל
//  • בקשות זהות במקביל מאוחדות לקריאה אחת

const https = require('https');
const crypto = require('crypto');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODELS = [process.env.NEWS_MODEL || 'claude-haiku-4-5', 'claude-sonnet-4-6'];

function httpsJSON(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(data) }); }
        catch (e) { reject(new Error('תשובה לא תקינה (' + res.statusCode + ')')); }
      });
    });
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------- חדשות גולמיות מהבורסה ----------
let newsCache = null; // { t, items }
let newsInflight = null;

function fetchTaseNewsRaw() {
  return httpsJSON({
    hostname: 'apicontent.tase.co.il',
    path: '/api/Cms?Route=/content/news-lobby&culture=he-IL',
    method: 'GET',
    headers: {
      'accept': 'application/json, */*',
      'accept-language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
      'content-type': 'application/json',
      'origin': 'https://www.tase.co.il',
      'referer': 'https://www.tase.co.il/',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    }
  });
}

async function getNews() {
  if (newsCache && Date.now() - newsCache.t < 3 * 60 * 1000) return newsCache.items;
  if (newsInflight) return newsInflight;
  newsInflight = fetchTaseNewsRaw()
    .then(r => {
      const items = ((r.json && r.json.items) || []).slice(0, 8).map(it => ({
        title: it.newsTitle || '',
        description: (it.newsDescription || '').replace(/\n+/g, ' ').trim().substring(0, 400),
        link: (it.link && it.link.url) ? it.link.url : '',
        date: it.date || ''
      })).filter(n => n.title);
      newsCache = { t: Date.now(), items };
      return items;
    })
    .catch(err => { if (newsCache) return newsCache.items; throw err; })
    .finally(() => { newsInflight = null; });
  return newsInflight;
}

// ---------- ניתוח AI ----------
const analysisCache = new Map(); // hash -> parsed
const analysisInflight = new Map();

function buildPrompt(news) {
  const newsText = news.map((n, i) => (i + 1) + '. ' + n.title + '\n   ' + n.description).join('\n\n');
  return 'אתה אנליסט שוק הון שמסביר לאדם פשוט, לא מקצועי, האם כדאי לו להתעניין במניה מסוימת. לפניך ' + news.length + ' ידיעות אחרונות מאתר הבורסה בתל אביב (TASE):\n\n' + newsText + '\n\n' +
    'עבור כל ידיעה, ענה בקצרה וברור, באותו סדר:\n' +
    '1. שם החברה - תמיד תן שם, גם אם זו רק ההשערה הכי סבירה שלך על סמך הידיעה. אם באמת אין שום חברה ספציפית, כתוב "שוק כללי".\n' +
    '2. הסקטור שמושפע (למשל: בנקים, נדל"ן, טכנולוגיה, ביטחון, אנרגיה, קמעונאות וכו׳).\n' +
    '3. ניתוח קצר - משפט אחד בלבד, בשפה פשוטה, בלי ז׳רגון.\n' +
    '4. ציון השפעה מיידית (ימים-שבועות) בין 1 ל-10: 1-3=חלשה, 4-6=בינונית, 7-10=חזקה.\n' +
    '5. כיוון ההשפעה (חיובי/שלילי/ניטרלי) לטווח קצר ולטווח ארוך, עם עוצמה 1-3 לכל אחד.\n\n' +
    'החזר JSON בלבד ללא backticks:\n' +
    '{"news":[{"title_he":"כותרת קצרה (עד 12 מילים)","entity":"שם החברה או שוק כללי","sector":"סקטור","short_analysis":"משפט אחד","immediate_score":1,"short_term":{"direction":"חיובי/שלילי/ניטרלי","strength":1},"long_term":{"direction":"חיובי/שלילי/ניטרלי","strength":1},"importance":"גבוהה/בינונית/נמוכה"}],' +
    '"market_mood":"סנטימנט כללי (משפט אחד)","market_mood_score":5}';
}

function parseJSON(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e < s) throw new Error('לא התקבל JSON מהמודל');
  return JSON.parse(text.slice(s, e + 1));
}

async function callClaude(prompt) {
  if (!API_KEY) throw new Error('חסר ANTHROPIC_API_KEY בהגדרות השרת');
  let lastErr;
  for (const model of MODELS) {
    try {
      const body = JSON.stringify({ model, max_tokens: 3000, messages: [{ role: 'user', content: prompt }] });
      const r = await httpsJSON({
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) }
      }, body);
      if (r.json.error) throw new Error(r.json.error.message || 'שגיאת API');
      const text = (r.json.content || []).map(b => b.text || '').join('');
      const parsed = parseJSON(text);
      if (!Array.isArray(parsed.news)) throw new Error('מבנה תשובה לא תקין');
      parsed.model = model;
      return parsed;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function getAnalysis(news) {
  const key = crypto.createHash('sha1').update(news.map(n => n.title).join('|')).digest('hex');
  if (analysisCache.has(key)) return analysisCache.get(key);
  if (analysisInflight.has(key)) return analysisInflight.get(key);
  const p = callClaude(buildPrompt(news))
    .then(parsed => {
      analysisCache.set(key, parsed);
      if (analysisCache.size > 50) analysisCache.delete(analysisCache.keys().next().value);
      return parsed;
    })
    .finally(() => analysisInflight.delete(key));
  analysisInflight.set(key, p);
  return p;
}

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

// GET /api/news-headlines — מהיר, בלי AI
async function handleHeadlines(req, res) {
  try { sendJSON(res, 200, { news: await getNews() }); }
  catch (e) { sendJSON(res, 502, { error: 'לא ניתן לטעון חדשות מהבורסה: ' + e.message }); }
}

// GET /api/news-analysis — חדשות + ניתוח AI (מהמטמון אם הכותרות לא השתנו)
async function handleAnalysis(req, res) {
  try {
    const news = await getNews();
    if (!news.length) return sendJSON(res, 200, { news, analysis: null });
    const analysis = await getAnalysis(news);
    sendJSON(res, 200, { news, analysis });
  } catch (e) {
    sendJSON(res, 502, { error: 'ניתוח החדשות נכשל: ' + e.message });
  }
}

module.exports = { handleHeadlines, handleAnalysis };
