// technicalSignals.js
//
// Pure functions that turn raw OHLCV price series into the early-trend
// signals discussed with Alon: Relative Strength trend, relative volume,
// and 52-week-low "drying up" behavior.
//
// Input format for a price series (matches what Yahoo Finance chart API
// returns, and what TradeVision's existing multi-timeframe analyzer already
// parses):
//   [{ date: '2026-06-01', close: 123.4, volume: 98765, high, low }, ...]
//
// All functions are deterministic and side-effect free so they're easy to
// unit test with synthetic data (see demo.js).

/**
 * Relative Strength line: sectorClose / benchmarkClose, then normalized to
 * start at 100 so we can read the trend visually / numerically regardless
 * of the two instruments' absolute price levels.
 */
function computeRSLine(sectorSeries, benchmarkSeries) {
  const benchByDate = new Map(benchmarkSeries.map((d) => [d.date, d.close]));
  const aligned = sectorSeries
    .filter((d) => benchByDate.has(d.date))
    .map((d) => ({ date: d.date, ratio: d.close / benchByDate.get(d.date) }));

  if (aligned.length === 0) return [];

  const base = aligned[0].ratio;
  return aligned.map((d) => ({ date: d.date, rs: (d.ratio / base) * 100 }));
}

/**
 * Classifies the RS line trend over the trailing `lookbackDays` window using
 * simple linear regression slope, normalized as %/week so it's comparable
 * across sectors regardless of price scale.
 *
 * Returns: { slopePerWeek, weeksConsistent, direction }
 * direction: 'strengthening' | 'weakening' | 'flat'
 */
function classifyRSTrend(rsLine, lookbackDays = 90) {
  const window = rsLine.slice(-lookbackDays);
  if (window.length < 10) {
    return { slopePerWeek: 0, weeksConsistent: 0, direction: "insufficient_data" };
  }

  const n = window.length;
  const xs = window.map((_, i) => i);
  const ys = window.map((d) => d.rs);
  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xMean) * (ys[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  const slopePerDay = den === 0 ? 0 : num / den;
  const slopePerWeek = (slopePerDay / yMean) * 100 * 7; // % of RS level per week

  // Count consecutive weeks (trailing) where the weekly RS change had the
  // same sign as the overall slope - a crude "consistency" measure so a
  // single spike doesn't get flagged as a multi-week trend.
  const weeklyPoints = [];
  for (let i = window.length - 1; i >= 6; i -= 7) {
    weeklyPoints.push(window[i].rs - window[i - 6].rs);
  }
  const sign = Math.sign(slopePerWeek);
  let weeksConsistent = 0;
  for (const wp of weeklyPoints) {
    if (Math.sign(wp) === sign && sign !== 0) weeksConsistent++;
    else break;
  }

  let direction = "flat";
  if (Math.abs(slopePerWeek) > 0.3) {
    direction = slopePerWeek > 0 ? "strengthening" : "weakening";
  }

  return { slopePerWeek: Number(slopePerWeek.toFixed(2)), weeksConsistent, direction };
}

/**
 * Relative volume: average volume over `recentDays` vs average volume over
 * the prior `baselineDays`, expressed as a percentage change.
 */
function computeRelativeVolume(series, recentDays = 10, baselineDays = 60) {
  if (series.length < recentDays + baselineDays) {
    return { relativeVolumePct: 0, sufficientData: false };
  }
  const recent = series.slice(-recentDays);
  const baseline = series.slice(-(recentDays + baselineDays), -recentDays);

  const avg = (arr) => arr.reduce((a, b) => a + b.volume, 0) / arr.length;
  const recentAvg = avg(recent);
  const baselineAvg = avg(baseline);

  if (baselineAvg === 0) return { relativeVolumePct: 0, sufficientData: false };

  const relativeVolumePct = ((recentAvg - baselineAvg) / baselineAvg) * 100;
  return { relativeVolumePct: Number(relativeVolumePct.toFixed(1)), sufficientData: true };
}

/**
 * 52-week-low "drying up" detector: finds the most recent date the series
 * made a new 52w-low, and checks whether it has since stopped making new
 * lows even though price is flat/down - a classic sign that sellers are
 * exhausted before a turn.
 */
function detect52WeekLowBehavior(series) {
  // 240 instead of a strict 252 - small safety margin for tickers with
  // slightly fewer trading days in the fetched range (holidays, partial
  // data), now that we fetch 2y of history as the primary safeguard.
  if (series.length < 240) {
    return { hasEnoughHistory: false };
  }

  let lastNewLowIndex = -1;
  let runningMin = Infinity;
  const dailyMins = series.map((d) => d.low ?? d.close);

  for (let i = 0; i < series.length; i++) {
    const windowStart = Math.max(0, i - 251);
    const window = dailyMins.slice(windowStart, i + 1);
    const min52w = Math.min(...window);
    if (dailyMins[i] <= min52w) {
      lastNewLowIndex = i;
    }
  }

  const daysSinceLastNewLow = series.length - 1 - lastNewLowIndex;
  const priceChangeSinceLastLow =
    lastNewLowIndex >= 0
      ? ((series[series.length - 1].close - series[lastNewLowIndex].close) /
          series[lastNewLowIndex].close) *
        100
      : null;

  return {
    hasEnoughHistory: true,
    lastNewLowDate: lastNewLowIndex >= 0 ? series[lastNewLowIndex].date : null,
    daysSinceLastNewLow,
    priceChangeSinceLastLow:
      priceChangeSinceLastLow !== null ? Number(priceChangeSinceLastLow.toFixed(1)) : null,
    // "drying up" = hasn't made a new low in 10+ trading days AND price is
    // roughly flat-to-down since then (i.e. not just a normal rally already
    // well underway - that's a different, later-stage signal)
    isDryingUp:
      daysSinceLastNewLow >= 10 &&
      priceChangeSinceLastLow !== null &&
      priceChangeSinceLastLow < 8,
  };
}

/**
 * Distance from current price to the 52-week high, as a sanity check for
 * "already rallied too much" - directly maps to Alon's principle of
 * avoiding entries after major rallies.
 */
function computeRunUpFromLow(series, windowDays = 252) {
  const window = series.slice(-windowDays);
  if (window.length < 20) return { runUpPct: null, sufficientData: false };

  const low = Math.min(...window.map((d) => d.low ?? d.close));
  const current = window[window.length - 1].close;
  const runUpPct = ((current - low) / low) * 100;
  return { runUpPct: Number(runUpPct.toFixed(1)), sufficientData: true };
}

module.exports = {
  computeRSLine,
  classifyRSTrend,
  computeRelativeVolume,
  detect52WeekLowBehavior,
  computeRunUpFromLow,
};
