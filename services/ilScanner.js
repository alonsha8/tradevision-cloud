// ilScanner.js
//
// Full pipeline for the Israeli side: scrape indx.co.il's 4 sector
// categories, store a daily snapshot per index in Postgres (if pool is
// available) so trend accuracy improves automatically over time, score
// against Alon's principles, and produce Hebrew explanations - same output
// shape as the US scanSector() pipeline so the frontend can merge both.

const { scrapeIndxCategory } = require('./indxScraper');
const { IL_SECTORS, IL_CATEGORY_URLS } = require('./sectorUniverse');
const { scoreILOpportunity } = require('./principlesScorerIL');
const { explainILSignal } = require('./explainIL');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS il_sector_snapshots (
      id SERIAL PRIMARY KEY,
      index_id TEXT NOT NULL,
      sector_label TEXT NOT NULL,
      daily_change_pct NUMERIC,
      pe_ratio NUMERIC,
      pb_ratio NUMERIC,
      dividend_yield_pct NUMERIC,
      fetched_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_il_snapshots_index_id ON il_sector_snapshots(index_id, fetched_at);
  `);
}

async function saveSnapshot(pool, row) {
  await pool.query(
    `INSERT INTO il_sector_snapshots (index_id, sector_label, daily_change_pct, pe_ratio, pb_ratio, dividend_yield_pct)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [row.indexId, row.sectorLabel, row.dailyChangePct, row.peRatio, row.pbRatio, row.dividendYieldPct]
  );
}

async function getHistory(pool, indexId, limit = 30) {
  const result = await pool.query(
    `SELECT daily_change_pct, fetched_at FROM il_sector_snapshots
     WHERE index_id = $1 ORDER BY fetched_at DESC LIMIT $2`,
    [indexId, limit]
  );
  // return oldest -> newest
  return result.rows.reverse().map((r) => ({
    dailyChangePct: Number(r.daily_change_pct),
    fetchedAt: r.fetched_at,
  }));
}

function computePERankPercentile(peRatio, allPEValues) {
  if (typeof peRatio !== 'number' || !isFinite(peRatio)) return null;
  const valid = allPEValues.filter((v) => typeof v === 'number' && isFinite(v) && v > 0 && v < 500);
  if (valid.length < 3) return null;
  const sorted = [...valid].sort((a, b) => a - b);
  const belowCount = sorted.filter((v) => v <= peRatio).length;
  return Math.round((belowCount / sorted.length) * 100);
}

async function scanILSectors(pool) {
  // 1. Scrape all 4 categories (sequential, gentle delay - same courtesy as Yahoo calls)
  const categoryRows = [];
  for (const url of Object.values(IL_CATEGORY_URLS)) {
    try {
      const result = await scrapeIndxCategory(url);
      categoryRows.push(...result.rows);
    } catch (err) {
      // one category failing shouldn't kill the whole scan
      console.error('indx.co.il category scrape failed:', url, err.message);
    }
    await sleep(500);
  }

  // 2. Compute P/E percentile ranks across everything scraped this run
  const allPEValues = categoryRows.map((r) => r['מכפיל רווח']);

  // 3. Ensure DB table exists (no-op if pool is null - DATABASE_URL not configured)
  if (pool) {
    try {
      await ensureTable(pool);
    } catch (err) {
      console.error('il_sector_snapshots table setup failed:', err.message);
    }
  }

  // 4. Score each mapped sector
  const results = [];
  for (const row of categoryRows) {
    const indexId = row._indexId;
    const meta = IL_SECTORS[indexId];
    if (!meta) continue; // unmapped/new index - skip defensively rather than guess

    const dailyChangePct = row['שינוי יומי'];
    const peRatio = row['מכפיל רווח'];
    const pbRatio = row['מכפיל הון'];
    const dividendYieldPct = row["תשואת דיב'"];
    const peRankPercentile = computePERankPercentile(peRatio, allPEValues);

    let history = [];
    if (pool) {
      try {
        await saveSnapshot(pool, { indexId, sectorLabel: meta.label, dailyChangePct, peRatio, pbRatio, dividendYieldPct });
        history = await getHistory(pool, indexId, 30);
      } catch (err) {
        console.error('IL snapshot save/read failed for', indexId, err.message);
      }
    }

    const signals = { dailyChangePct, peRatio, pbRatio, dividendYieldPct, peRankPercentile, history };
    const scoring = scoreILOpportunity(signals);
    signals.trend = scoring.trend; // explainIL.js reads signals.trend
    const explanation = explainILSignal(meta.label, signals, scoring, meta.knownInstruments);

    results.push({
      sectorKey: indexId,
      sectorLabel: meta.label,
      market: 'IL',
      instruments: meta.knownInstruments,
      indexUrl: row._indexUrl,
      signals,
      scoring,
      explanation: explanation.explanation,
      verdictLabel: explanation.verdictLabel,
    });
  }

  const verdictOrder = { candidate: 0, early_candidate: 1, too_late: 2, weakening: 3, watch_only: 4 };
  results.sort((a, b) => {
    const av = verdictOrder[a.scoring.verdict] ?? 5;
    const bv = verdictOrder[b.scoring.verdict] ?? 5;
    if (av !== bv) return av - bv;
    return b.scoring.score - a.scoring.score;
  });

  return results;
}

module.exports = { scanILSectors };
