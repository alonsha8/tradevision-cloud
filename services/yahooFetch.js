// services/yahooFetch.js
//
// Fetches and parses Yahoo Finance chart data for the sector scanner.
// Uses the exact same request pattern as server.js's proxyYahooChart (same
// headers), so it behaves consistently with what already works in
// TradeVision Cloud - just returns parsed data instead of piping the raw
// response to an HTTP client.

const https = require('https');

function fetchYahooChartRaw(ticker, interval, range) {
  return new Promise((resolve, reject) => {
    const reqOptions = {
      hostname: 'query1.finance.yahoo.com',
      path: '/v8/finance/chart/' + encodeURIComponent(ticker) +
        '?interval=' + encodeURIComponent(interval) +
        '&range=' + encodeURIComponent(range) +
        '&includePrePost=false',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Referer': 'https://finance.yahoo.com/',
        'Origin': 'https://finance.yahoo.com',
        'Connection': 'keep-alive'
      }
    };
    const req = https.request(reqOptions, apiRes => {
      let data = '';
      apiRes.on('data', c => data += c);
      apiRes.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error('Failed to parse Yahoo response for ' + ticker + ': ' + err.message));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Parses raw Yahoo chart JSON into a clean array of
 * { date, close, high, low, volume } sorted ascending by date.
 * Filters out null/incomplete bars (Yahoo sometimes returns nulls for
 * holidays/gaps).
 */
function parseYahooChart(raw) {
  const result = raw && raw.chart && raw.chart.result && raw.chart.result[0];
  if (!result) {
    throw new Error('Unexpected Yahoo chart response shape (no result[0])');
  }
  const timestamps = result.timestamp || [];
  const quote = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const { close = [], high = [], low = [], volume = [] } = quote;

  const series = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (close[i] == null) continue; // skip incomplete bars
    const date = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
    series.push({
      date,
      close: close[i],
      high: high[i] != null ? high[i] : close[i],
      low: low[i] != null ? low[i] : close[i],
      volume: volume[i] != null ? volume[i] : 0,
    });
  }
  return series;
}

/**
 * Fetches and parses in one call. range='1y' interval='1d' gives ~252
 * trading days, which is what technicalSignals.js needs for 52w-low and
 * run-up calculations.
 */
async function fetchDailySeries(ticker, range = '1y') {
  const raw = await fetchYahooChartRaw(ticker, '1d', range);
  return parseYahooChart(raw);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { fetchYahooChartRaw, parseYahooChart, fetchDailySeries, sleep };
