// routes/lowsApi.js — סורק "קרוב לשפל 52 שבועות"
//   POST /api/lows/start    { market, nearPct, threshold }
//   GET  /api/lows/status
//   GET  /api/lows/explain?ticker=   הסבר AI — רק על בסיס המספרים שחושבו, עם בדיקה שלא הומצאו מספרים
const express = require('express');
const https = require('https');
const lows = require('../services/lowsScanner');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODELS = [process.env.NEWS_MODEL || 'claude-haiku-4-5', 'claude-sonnet-4-6'];
const explainCache = new Map();

function callClaude(prompt, model) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, max_tokens: 700, messages: [{ role: 'user', content: prompt }] });
    const req = https.request({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { const j = JSON.parse(d); if (j.error) return reject(new Error(j.error.message)); resolve((j.content || []).map(b => b.text || '').join('').trim()); } catch (e) { reject(e); } });
    });
    req.setTimeout(45000, () => req.destroy(new Error('timeout')));
    req.on('error', reject); req.write(body); req.end();
  });
}

// כל מספר בטקסט חייב להופיע בנתונים (בעיגול סביר) — אחרת ההסבר נפסל
function numbersAreGrounded(text, facts) {
  const allowed = [];
  JSON.stringify(facts).replace(/-?\d+(\.\d+)?/g, m => { allowed.push(Math.abs(parseFloat(m))); return m; });
  const used = (text.match(/\d[\d,]*(\.\d+)?/g) || []).map(s => parseFloat(s.replace(/,/g, '')));
  const bad = used.filter(x => x > 10 && !allowed.some(a => Math.abs(a - x) <= Math.max(0.6, Math.abs(a) * 0.01)) && ![14, 20, 50, 52, 200].includes(x));
  return { ok: bad.length === 0, bad };
}

function createLowsApi() {
  const router = express.Router();
  router.post('/start', express.json(), (req, res) => res.json(lows.start(req.body || {})));
  router.get('/status', (req, res) => res.json(lows.status()));

  router.get('/explain', async (req, res) => {
    const t = String(req.query.ticker || '').toUpperCase();
    const last = lows._last();
    const row = last && last.all.find(r => r.ticker === t);
    if (!row) return res.status(404).json({ error: 'המניה לא נמצאת בסריקה האחרונה — הריצו סריקה מחדש' });
    if (!API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY לא מוגדר' });
    const key = t + '|' + last.finishedAt;
    if (explainCache.has(key)) return res.json(explainCache.get(key));
    const facts = {
      ticker: row.ticker, name: row.name, currency: row.currency, price: +row.price.toFixed(2),
      low52: +row.low52.toFixed(2), high52: +row.high52.toFixed(2), pctAbove52wLow: row.pctFrom52Low, pctFrom52High: row.pctFrom52High,
      shortTermScore: row.short.total, shortTermParts: row.short.parts, shortTermSignals: row.short.notes, shortPlan: row.short.plan,
      longTermScore: row.long.total, longTermParts: row.long.parts || null, longTermVerdict: row.long.verdict || row.long.reason, marginOfSafetyPct: row.long.marginOfSafety ?? null,
      technicalVerdict: row.engineVerdict, dataWarnings: row.warnings,
    };
    const prompt = `אתה אנליסט שמסביר למשקיע פרטי, בעברית פשוטה וקצרה, מניה שנמצאת קרוב לשפל השנתי שלה.
מותר לך להשתמש **רק** במספרים ובעובדות שבנתונים הבאים. אסור להוסיף מספרים, תחזיות מחיר, חדשות או מידע על החברה שלא מופיע כאן.
כתוב 4–6 משפטים: (1) למה היא בשפל ומה הציונים אומרים, (2) מה מחזק ומה מחליש לטווח קצר, (3) מה אומר הציון לטווח ארוך (אם יש), (4) מה הסיכון העיקרי ומה צריך לקרות כדי שהתזה תיפול.
בלי כותרות, בלי רשימות, בלי המלצה חד-משמעית לקנות או למכור.

נתונים (JSON):
${JSON.stringify(facts)}`;
    for (const model of MODELS) {
      try {
        const text = await callClaude(prompt, model);
        const g = numbersAreGrounded(text, facts);
        if (!g.ok) { console.warn('explain rejected (ungrounded numbers)', t, g.bad); continue; }
        const out = { ticker: t, text, model };
        explainCache.set(key, out);
        return res.json(out);
      } catch (e) { /* ננסה את המודל הבא */ }
    }
    res.status(502).json({ error: 'לא ניתן היה לייצר הסבר אמין כרגע (ההסבר נפסל או שה-AI לא זמין)' });
  });
  return router;
}

module.exports = createLowsApi;
module.exports.numbersAreGrounded = numbersAreGrounded;
