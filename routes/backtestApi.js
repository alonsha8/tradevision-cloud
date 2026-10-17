// routes/backtestApi.js — הרצת בדיקה היסטורית ברקע + תוצאות
//   POST /api/backtest/start   { universe: 'us'|'ta'|'all', years: 2|5, includeWait: true }
//   GET  /api/backtest/status  → התקדמות / תוצאה
const express = require('express');
const yc = require('../services/yahooCache');
const { simulateTicker, stats, byYear } = require('../services/backtest');
const { US, TA } = require('../services/universe');
const { sma } = require('../services/analysisEngine');

// מצב שוק היסטורי: בכל יום — האם המדד מעל ממוצע 200 יום (לפי נתונים עד אותו יום בלבד)
async function regimeSeries(symbol, range) {
  try {
    const { bars } = await loadBars(symbol, range);
    const s200 = sma(bars.map(b => b.c), 200);
    const days = bars.map((b, k) => ({ d: Math.floor(b.t / 86400), ok: s200[k] == null ? null : b.c > s200[k] }));
    return t => {
      const d = Math.floor(t / 86400);
      let lo = 0, hi = days.length - 1, ans = null;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (days[m].d <= d) { ans = days[m].ok; lo = m + 1; } else hi = m - 1; }
      return ans;
    };
  } catch (e) { return null; }
}

let job = { state: 'idle' };

async function loadBars(ticker, range) {
  const r = await yc.getChart(ticker, '1d', range);
  const j = JSON.parse(r.body);
  const res = j.chart && j.chart.result && j.chart.result[0];
  if (!res || !res.timestamp) throw new Error('אין נתונים');
  const q = res.indicators.quote[0];
  const bars = res.timestamp.map((t, i) => ({ t, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] }))
    .filter(b => [b.o, b.h, b.l, b.c].every(x => x != null && x > 0));
  return { bars, currency: res.meta.currency };
}

async function run(params, pool) {
  const { universe, years, includeWait } = params;
  const tickers = universe === 'us' ? US : universe === 'ta' ? TA : US.concat(TA);
  const range = years <= 2 ? '5y' : '10y';
  const fromSec = Date.now() / 1000 - years * 365.25 * 86400;
  job = { state: 'running', params, startedAt: Date.now(), progress: { done: 0, total: tickers.length, current: '' } };

  const regimes = params.regimeFilter
    ? { US: await regimeSeries('^GSPC', range), TA: await regimeSeries('^TA125.TA', range) }
    : { US: null, TA: null };
  const all = [], perTicker = [], failed = [];
  const bh = [];
  for (const ticker of tickers) {
    job.progress.current = ticker;
    try {
      const { bars, currency } = await loadBars(ticker, range);
      let start = bars.findIndex(b => b.t >= fromSec);
      if (start < 0 || bars.length - start < 60) throw new Error('היסטוריה קצרה מדי');
      start = Math.max(start, 250);
      const isTA = ticker.endsWith('.TA');
      const trades = simulateTicker(bars, { currency, includeWait, startIndex: start, costPct: isTA ? 0.2 : 0.1,
        regimeAt: regimes[isTA ? 'TA' : 'US'], regimeLabel: isTA ? 'ת"א 125' : 'S&P 500' })
        .map(t => ({ ...t, ticker, market: isTA ? 'TA' : 'US' }));
      all.push(...trades);
      bh.push((bars[bars.length - 1].c / bars[start].o - 1) * 100);
      if (trades.length) {
        const s = stats(trades);
        perTicker.push({ ticker, trades: s.trades, winRate: s.winRate, expectancyR: s.expectancyR });
      }
    } catch (e) {
      failed.push({ ticker, error: e.message });
    }
    job.progress.done++;
    await new Promise(r => setImmediate(r)); // לא לחסום את השרת
  }

  const overall = stats(all);
  const result = {
    params, finishedAt: Date.now(), seconds: Math.round((Date.now() - job.startedAt) / 1000),
    tickersTested: tickers.length - failed.length, failed,
    overall,
    byKind: { enter: stats(all.filter(t => t.kind === 'enter')), wait: stats(all.filter(t => t.kind === 'wait')) },
    byMarket: { US: stats(all.filter(t => t.market === 'US')), TA: stats(all.filter(t => t.market === 'TA')) },
    byYear: byYear(all),
    best: perTicker.filter(p => p.trades >= 3).sort((a, b) => b.expectancyR - a.expectancyR).slice(0, 10),
    worst: perTicker.filter(p => p.trades >= 3).sort((a, b) => a.expectancyR - b.expectancyR).slice(0, 10),
    buyHoldAvgPct: bh.length ? +(bh.reduce((s, x) => s + x, 0) / bh.length).toFixed(1) : null,
    recentTrades: all.sort((a, b) => b.exitDate - a.exitDate).slice(0, 50),
  };
  for (const k of ['byKind', 'byMarket']) for (const s of Object.values(result[k])) delete s.curve;
  job = { state: 'done', params, result };

  if (pool) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS backtest_runs (id SERIAL PRIMARY KEY, created_at TIMESTAMP DEFAULT NOW(), params JSONB, result JSONB)`);
      await pool.query('INSERT INTO backtest_runs (params, result) VALUES ($1, $2)', [params, result]);
    } catch (e) { console.error('backtest save:', e.message); }
  }
}

function createBacktestApi(pool) {
  const router = express.Router();

  router.post('/start', express.json(), (req, res) => {
    if (job.state === 'running') return res.json(job);
    const b = req.body || {};
    const params = {
      universe: ['us', 'ta', 'all'].includes(b.universe) ? b.universe : 'all',
      years: [2, 5].includes(+b.years) ? +b.years : 2,
      includeWait: b.includeWait !== false,
      regimeFilter: b.regimeFilter !== false,
    };
    run(params, pool).catch(e => { job = { state: 'error', params, error: e.message }; });
    res.json({ state: 'running', params });
  });

  router.get('/status', async (req, res) => {
    if (job.state === 'idle' && pool) {
      try {
        const r = await pool.query('SELECT result FROM backtest_runs ORDER BY id DESC LIMIT 1');
        if (r.rows.length) return res.json({ state: 'done', result: r.rows[0].result, fromDb: true });
      } catch (e) { /* אין טבלה עדיין */ }
    }
    res.json(job);
  });

  return router;
}

module.exports = createBacktestApi;
