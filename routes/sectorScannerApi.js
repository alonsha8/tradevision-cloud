// routes/sectorScannerApi.js
//
// Follows the same factory pattern as routes/portfolioApi.js and
// routes/watcherApi.js - exported function returns an Express router.
//
// Usage in server.js:
//   const createSectorScannerApi = require('./routes/sectorScannerApi');
//   app.use('/api/sector-scanner', createSectorScannerApi(pool));
//
// IMPORTANT: pool is now REQUIRED as an argument (can be null if
// DATABASE_URL isn't configured - the IL scanner degrades gracefully to
// single-day-only scoring without it, just like before, it just won't
// accumulate history for better IL trend accuracy over time).
//
// Endpoints:
//   GET /api/sector-scanner/scan          -> US sectors only (cached 4h)
//   GET /api/sector-scanner/scan-il       -> Israeli sectors only (cached 1h - cheap to refresh, and daily-snapshot based so more frequent refreshes build history faster)
//   GET /api/sector-scanner/scan-all      -> BOTH combined into one ranked list, tagged with `market: 'US'|'IL'` per row
//   Add ?force=1 to any of the above to bypass cache.

const express = require('express');
const { US_SECTORS } = require('../services/sectorUniverse');
const { scanSector } = require('../services/scanSector');
const { fetchDailySeries, sleep } = require('../services/yahooFetch');
const { scanILSectors } = require('../services/ilScanner');

const US_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const IL_CACHE_TTL_MS = 1 * 60 * 60 * 1000; // 1 hour - cheap HTML scrape, refresh more often to build history faster
let usCache = { timestamp: 0, data: null };
let ilCache = { timestamp: 0, data: null };

async function scanAllUSSectors() {
  const RANGE = '2y';
  const benchmarkSeries = await fetchDailySeries('^GSPC', RANGE);
  await sleep(300);

  const results = [];
  for (const [sectorKey, sector] of Object.entries(US_SECTORS)) {
    const primary = sector.instruments.find((i) => i.type === 'broad') || sector.instruments[0];
    try {
      const sectorSeries = await fetchDailySeries(primary.ticker, RANGE);
      const result = scanSector({
        sectorKey,
        sectorLabel: sector.label,
        instruments: sector.instruments,
        sectorSeries,
        benchmarkSeries,
      });
      results.push({ ...result, market: 'US' });
    } catch (err) {
      results.push({ sectorKey, sectorLabel: sector.label, market: 'US', instruments: sector.instruments, error: err.message });
    }
    await sleep(300);
  }

  return sortResults(results);
}

function sortResults(results) {
  const verdictOrder = { candidate: 0, early_candidate: 1, too_late: 2, weakening: 3, watch_only: 4 };
  return results.slice().sort((a, b) => {
    const av = a.scoring ? verdictOrder[a.scoring.verdict] ?? 5 : 5;
    const bv = b.scoring ? verdictOrder[b.scoring.verdict] ?? 5 : 5;
    if (av !== bv) return av - bv;
    const as = a.scoring ? a.scoring.score : -999;
    const bs = b.scoring ? b.scoring.score : -999;
    return bs - as;
  });
}

async function getUSResults(force) {
  const isFresh = usCache.data && Date.now() - usCache.timestamp < US_CACHE_TTL_MS;
  if (isFresh && !force) return { cached: true, generatedAt: new Date(usCache.timestamp).toISOString(), results: usCache.data };
  try {
    const results = await scanAllUSSectors();
    usCache = { timestamp: Date.now(), data: results };
    return { cached: false, generatedAt: new Date(usCache.timestamp).toISOString(), results };
  } catch (err) {
    if (usCache.data) return { cached: true, stale: true, error: err.message, generatedAt: new Date(usCache.timestamp).toISOString(), results: usCache.data };
    throw err;
  }
}

async function getILResults(pool, force) {
  const isFresh = ilCache.data && Date.now() - ilCache.timestamp < IL_CACHE_TTL_MS;
  if (isFresh && !force) return { cached: true, generatedAt: new Date(ilCache.timestamp).toISOString(), results: ilCache.data };
  try {
    const results = await scanILSectors(pool);
    ilCache = { timestamp: Date.now(), data: results };
    return { cached: false, generatedAt: new Date(ilCache.timestamp).toISOString(), results };
  } catch (err) {
    if (ilCache.data) return { cached: true, stale: true, error: err.message, generatedAt: new Date(ilCache.timestamp).toISOString(), results: ilCache.data };
    throw err;
  }
}

function createSectorScannerApi(pool) {
  const router = express.Router();

  router.get('/scan', async (req, res) => {
    try {
      const payload = await getUSResults(req.query.force === '1');
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/scan-il', async (req, res) => {
    try {
      const payload = await getILResults(pool, req.query.force === '1');
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/scan-all', async (req, res) => {
    const force = req.query.force === '1';
    try {
      const [us, il] = await Promise.all([getUSResults(force), getILResults(pool, force)]);
      const combined = sortResults([...(us.results || []), ...(il.results || [])]);
      res.json({
        us: { cached: us.cached, stale: !!us.stale, generatedAt: us.generatedAt },
        il: { cached: il.cached, stale: !!il.stale, generatedAt: il.generatedAt },
        results: combined,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createSectorScannerApi;
