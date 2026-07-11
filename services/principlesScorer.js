// principlesScorer.js
//
// Takes the raw technical signals for a sector and scores them against
// Alon's standing investment principles:
//   1. Buy on weakness, not momentum - avoid entries after major rallies
//   2. Prefer phased entries over lump-sum, no chasing
//   3. Positive early signal (RS strengthening / 52w-low drying up) is good,
//      but ONLY if it hasn't already turned into a big run-up
//   4. Flag existing large rallies (defense, banks, renewables historically)
//      as "already priced in" candidates for weakening, not buying
//
// This produces a verdict Alon can act on immediately: "candidate",
// "too early", "too late / chase risk", or "watch only".

const RUN_UP_CHASE_THRESHOLD = 40; // % - beyond this, treat as "already rallied"
const RUN_UP_CAUTION_THRESHOLD = 20; // % - between caution and chase thresholds

// Raw internal score roughly ranges [-70, +65] given the weights below.
// We normalize it to 0-100 for display: 50 = neutral, 100 = strongest
// candidate, 0 = strongest weakening/chase-risk signal.
const SCORE_NORMALIZATION_RANGE = 70;
function normalizeScore(rawScore) {
  const normalized = 50 + (rawScore / SCORE_NORMALIZATION_RANGE) * 50;
  return Math.round(Math.max(0, Math.min(100, normalized)));
}

function scoreOpportunity(signals) {
  const { rsTrend, relativeVolume, lowBehavior, runUp } = signals;

  const flags = [];
  let verdict = "watch_only";
  let rawScore = 0; // internal signed scale, converted to 0-100 before returning

  // --- Positive early-trend signals ---
  if (rsTrend.direction === "strengthening" && rsTrend.weeksConsistent >= 3) {
    rawScore += 30;
    flags.push("rs_strengthening_multiweek");
  } else if (rsTrend.direction === "strengthening") {
    rawScore += 10;
    flags.push("rs_strengthening_early");
  }

  if (relativeVolume.sufficientData && relativeVolume.relativeVolumePct > 25) {
    rawScore += 15;
    flags.push("volume_anomaly_accumulation");
  }

  if (lowBehavior.hasEnoughHistory && lowBehavior.isDryingUp) {
    rawScore += 20;
    flags.push("52w_low_drying_up");
  }

  // --- Negative / weakening signals ---
  if (rsTrend.direction === "weakening" && rsTrend.weeksConsistent >= 3) {
    rawScore -= 30;
    flags.push("rs_weakening_multiweek");
  } else if (rsTrend.direction === "weakening") {
    rawScore -= 10;
    flags.push("rs_weakening_early");
  }

  // --- Run-up / chase-risk check (core principle: don't buy after rallies) ---
  if (runUp.sufficientData) {
    if (runUp.runUpPct >= RUN_UP_CHASE_THRESHOLD) {
      rawScore -= 40;
      flags.push("chase_risk_major_rally");
    } else if (runUp.runUpPct >= RUN_UP_CAUTION_THRESHOLD) {
      rawScore -= 15;
      flags.push("caution_moderate_rally");
    }
  }

  // --- Verdict ---
  if (rawScore >= 40 && !flags.includes("chase_risk_major_rally")) {
    verdict = "candidate"; // early positive signal, not yet chased
  } else if (rawScore >= 15 && flags.includes("chase_risk_major_rally")) {
    verdict = "too_late"; // strong signal but already rallied hard - chase risk
  } else if (rawScore >= 15) {
    verdict = "early_candidate"; // positive but not yet confirmed multi-week
  } else if (rawScore <= -30) {
    verdict = "weakening"; // sector losing steam - relevant for existing holdings
  } else {
    verdict = "watch_only";
  }

  return { score: normalizeScore(rawScore), rawScore, verdict, flags };
}

module.exports = { scoreOpportunity, RUN_UP_CHASE_THRESHOLD, RUN_UP_CAUTION_THRESHOLD };
