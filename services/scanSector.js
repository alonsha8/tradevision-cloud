// scanSector.js
//
// The main entry point: given a sector's price series and its benchmark's
// price series, runs all technical signals, scores them against Alon's
// principles, and produces one fully-explained result row.
//
// This is intentionally decoupled from HOW the price data is fetched
// (Yahoo Finance for US, TASE/indx.co.il for Israel) - scanSector() just
// takes arrays. The fetch layer gets wired in separately once server.js is
// available, matching TradeVision's existing multi-timeframe analyzer.

const {
  computeRSLine,
  classifyRSTrend,
  computeRelativeVolume,
  detect52WeekLowBehavior,
  computeRunUpFromLow,
} = require("./technicalSignals");
const { scoreOpportunity } = require("./principlesScorer");
const { explainSignal } = require("./explainSignal");

function scanSector({ sectorKey, sectorLabel, instruments, sectorSeries, benchmarkSeries }) {
  const rsLine = computeRSLine(sectorSeries, benchmarkSeries);
  const rsTrend = classifyRSTrend(rsLine);
  const relativeVolume = computeRelativeVolume(sectorSeries);
  const lowBehavior = detect52WeekLowBehavior(sectorSeries);
  const runUp = computeRunUpFromLow(sectorSeries);

  const signals = { rsTrend, relativeVolume, lowBehavior, runUp };
  const scoring = scoreOpportunity(signals);
  const explanation = explainSignal(sectorLabel, signals, scoring, instruments);

  return {
    sectorKey,
    sectorLabel,
    instruments,
    signals,
    scoring,
    explanation: explanation.explanation,
    verdictLabel: explanation.verdictLabel,
    rsLine, // kept for charting in the UI
  };
}

module.exports = { scanSector };
