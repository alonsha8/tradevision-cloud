// services/indxScraper.js
//
// Scrapes sector index tables from indx.co.il category pages. Confirmed via
// manual DevTools inspection (2026-07-11) that the data is plain
// server-rendered HTML - each row is a <tr onclick="window.location='...'">
// with <td data-sort="-0.77"> for numeric columns. No JavaScript rendering,
// no hidden API - a simple GET + HTML parse is enough (same pattern as the
// existing sponser.co.il forum watcher).
//
// Column headers are read dynamically from the table's <thead> rather than
// hardcoded by position, so if indx.co.il reorders columns this keeps working.

const https = require('https');
const cheerio = require('cheerio');

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'he-IL,he;q=0.9',
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve(data));
        }
      )
      .on('error', reject);
  });
}

/**
 * Scrapes ONE category page (e.g. "מדדי מניות ענפיים בישראל") and returns
 * every index row in that table, with columns keyed by their actual Hebrew
 * header text (read live from <thead>, not hardcoded).
 *
 * Numeric columns (identified by having a data-sort attribute) are parsed
 * as numbers; everything else stays as trimmed text.
 */
async function scrapeIndxCategory(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const table = $('table').first();
  if (table.length === 0) {
    throw new Error('No <table> found on page - indx.co.il page structure may have changed: ' + url);
  }

  const headers = [];
  table
    .find('thead th')
    .each((i, el) => headers.push($(el).text().trim() || `col${i}`));

  const rows = [];
  table.find('tbody tr').each((i, tr) => {
    const $row = $(tr);
    const record = {};
    $row.find('td').each((ci, td) => {
      const $cell = $(td);
      const header = headers[ci] || `col${ci}`;
      const dataSort = $cell.attr('data-sort');
      record[header] = dataSort !== undefined && dataSort !== '' ? parseFloat(dataSort) : $cell.text().trim();
    });

    // The row's onclick carries the link to the index's own detail page,
    // which also contains the index ID (useful for later drill-down).
    const onclick = $row.attr('onclick') || '';
    const urlMatch = onclick.match(/window\.location='([^']+)'/);
    record._indexUrl = urlMatch ? urlMatch[1] : null;
    const idMatch = record._indexUrl && record._indexUrl.match(/\/index\/(\d+)-index/);
    record._indexId = idMatch ? idMatch[1] : null;

    // Skip empty/header-repeat rows
    const firstCol = record[headers[0]];
    if (firstCol && String(firstCol).trim()) rows.push(record);
  });

  return { headers, rows, sourceUrl: url, fetchedAt: new Date().toISOString() };
}

module.exports = { scrapeIndxCategory, fetchHtml };
