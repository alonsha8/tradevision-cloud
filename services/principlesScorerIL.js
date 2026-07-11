// principlesScorerIL.js
//
// Scores Israeli sector snapshots from indx.co.il against Alon's principles.
// Important difference from the US scorer (principlesScorer.js): indx.co.il
// gives a DAILY SNAPSHOT (today's change%, P/E, P/B, dividend yield), not
// years of price history. So this scorer works in two modes:
//
//   1. COLD START (history.length < 5 accumulated scans): score is based
//      only on today's move + valuation percentile vs peers today. Verdict
//      is deliberately capped - never "candidate" - because one day of data
//      cannot confirm a multi-week trend the way the US engine requires.
//   2. WARM (history.length >= 5): once enough daily snapshots have been
//      stored (via the scan route's DB write), a real multi-day trend
//      signal becomes available and is weighted much more heavily than the
//      single-day move.
//
// This means the Israeli side gets MORE accurate over time automatically,
// simply by running the scan regularly (same cron cadence as the rest of
// TradeVision) - no manual work needed.

const SCORE_NORMALIZATION_RANGE = 70;
function normalizeScore(rawScore) {
  const normalized = 50 + (rawScore / SCORE_NORMALIZATION_RANGE) * 50;
  return Math.round(Math.max(0, Math.min(100, normalized)));
}

function computeHistoryTrend(history) {
  // history: array of { dailyChangePct, fetchedAt }, oldest -> newest
  if (!history || history.length < 5) return { sufficientData: false };

  const recent = history.slice(-10); // up to last 10 trading-day snapshots
  const avgDailyChange = recent.reduce((sum, h) => sum + (h.dailyChangePct || 0), 0) / recent.length;

  // consecutive-day streak in the same direction, most recent first
  let streak = 0;
  const sign = Math.sign(avgDailyChange);
  for (let i = recent.length - 1; i >= 0; i--) {
    if (Math.sign(recent[i].dailyChangePct) === sign && sign !== 0) streak++;
    else break;
  }

  return {
    sufficientData: true,
    avgDailyChangePct: Number(avgDailyChange.toFixed(2)),
    streak,
    daysTracked: history.length,
  };
}

function scoreILOpportunity(signals) {
  const { dailyChangePct, peRankPercentile, history } = signals;
  const flags = [];
  let rawScore = 0;

  const trend = computeHistoryTrend(history);

  if (trend.sufficientData) {
    // Warm mode - multi-day accumulated trend carries most of the weight
    if (trend.avgDailyChangePct > 0.15 && trend.streak >= 3) {
      rawScore += 35;
      flags.push("il_trend_positive_multiday");
    } else if (trend.avgDailyChangePct > 0.05) {
      rawScore += 12;
      flags.push("il_trend_positive_early");
    } else if (trend.avgDailyChangePct < -0.15 && trend.streak >= 3) {
      rawScore -= 35;
      flags.push("il_trend_negative_multiday");
    } else if (trend.avgDailyChangePct < -0.05) {
      rawScore -= 12;
      flags.push("il_trend_negative_early");
    }
  } else {
    flags.push("il_limited_history");
    // Cold start - only today's move, weighted lightly on purpose
    if (dailyChangePct > 1) {
      rawScore += 8;
      flags.push("il_daily_move_positive");
    } else if (dailyChangePct < -1) {
      rawScore -= 8;
      flags.push("il_daily_move_negative");
    }
  }

  // Valuation vs peers today (proxy for "avoid buying at highs" when we
  // don't have historical run-up data available yet for Israeli sectors)
  if (peRankPercentile !== null) {
    if (peRankPercentile >= 80) {
      rawScore -= 20;
      flags.push("il_valuation_expensive_percentile");
    } else if (peRankPercentile <= 20) {
      rawScore += 15;
      flags.push("il_valuation_cheap_percentile");
    }
  }

  // --- Verdict - capped conservatively while history is thin ---
  let verdict = "watch_only";
  if (trend.sufficientData) {
    if (rawScore >= 40 && !flags.includes("il_valuation_expensive_percentile")) {
      verdict = "candidate";
    } else if (rawScore >= 40) {
      verdict = "too_late"; // positive trend but already expensive vs peers
    } else if (rawScore >= 15) {
      verdict = "early_candidate";
    } else if (rawScore <= -25) {
      verdict = "weakening";
    }
  } else {
    // Cold start - never "candidate", cap at early_candidate at most
    if (rawScore >= 15) {
      verdict = "early_candidate";
    } else if (rawScore <= -20) {
      verdict = "weakening";
    }
  }

  return { score: normalizeScore(rawScore), rawScore, verdict, flags, trend };
}

module.exports = { scoreILOpportunity, computeHistoryTrend };
