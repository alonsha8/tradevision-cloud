// sectorUniverse.js
//
// Maps broad economic sectors to their representative tradable instruments,
// separately for the US market (Yahoo Finance tickers) and the Israeli market
// (TASE-listed ETFs / indx.co.il index names).
//
// Each sector entry can have MULTIPLE instruments (e.g. broad vs. narrow ETF)
// so the scanner can present options, not just one ticker.
//
// benchmarkTicker = what we compute Relative Strength (RS) against.

const US_SECTORS = {
  technology: {
    label: "טכנולוגיה",
    benchmarkTicker: "^GSPC", // S&P 500
    instruments: [
      { ticker: "XLK", name: "טכנולוגיה רחב (XLK)", type: "broad" },
      { ticker: "VGT", name: "טכנולוגיית מידע - ואנגארד (VGT)", type: "broad" },
      { ticker: "SMH", name: "מוליכים למחצה - ואנאק (SMH)", type: "narrow" },
      { ticker: "SOXX", name: "מוליכים למחצה - אישרס (SOXX)", type: "narrow" },
    ],
  },
  healthcare: {
    label: "בריאות",
    benchmarkTicker: "^GSPC",
    instruments: [
      { ticker: "XLV", name: "בריאות רחב (XLV)", type: "broad" },
      { ticker: "IBB", name: "ביוטכנולוגיה - אישרס (IBB)", type: "narrow" },
      { ticker: "XBI", name: "ביוטכנולוגיה - SPDR (XBI)", type: "narrow" },
    ],
  },
  financials: {
    label: "פיננסים",
    benchmarkTicker: "^GSPC",
    instruments: [
      { ticker: "XLF", name: "פיננסים רחב (XLF)", type: "broad" },
      { ticker: "KRE", name: "בנקים אזוריים (KRE)", type: "narrow" },
    ],
  },
  energy: {
    label: "אנרגיה",
    benchmarkTicker: "^GSPC",
    instruments: [
      { ticker: "XLE", name: "אנרגיה רחב (XLE)", type: "broad" },
      { ticker: "NLR", name: "אנרגיה גרעינית - ואנאק (NLR)", type: "narrow" },
      { ticker: "ICLN", name: "אנרגיה מתחדשת גלובלית (ICLN)", type: "narrow" },
    ],
  },
  industrials: {
    label: "תעשייה",
    benchmarkTicker: "^GSPC",
    instruments: [
      { ticker: "XLI", name: "תעשייה רחב (XLI)", type: "broad" },
      { ticker: "ITA", name: "תעופה וביטחון - אישרס (ITA)", type: "narrow" },
      { ticker: "XAR", name: "תעופה וביטחון - SPDR (XAR)", type: "narrow" },
    ],
  },
  materials: {
    label: "חומרי גלם",
    benchmarkTicker: "^GSPC",
    instruments: [
      { ticker: "XLB", name: "חומרי גלם רחב (XLB)", type: "broad" },
    ],
  },
  realEstate: {
    label: "נדל\"ן",
    benchmarkTicker: "^GSPC",
    instruments: [
      { ticker: "XLRE", name: "נדל\"ן רחב (XLRE)", type: "broad" },
    ],
  },
  utilities: {
    label: "שירותים ציבוריים",
    benchmarkTicker: "^GSPC",
    instruments: [
      { ticker: "XLU", name: "שירותים ציבוריים רחב (XLU)", type: "broad" },
    ],
  },
  consumerDiscretionary: {
    label: "צריכה מחזורית",
    benchmarkTicker: "^GSPC",
    instruments: [
      { ticker: "XLY", name: "צריכה מחזורית רחב (XLY)", type: "broad" },
    ],
  },
  consumerStaples: {
    label: "צריכה בסיסית",
    benchmarkTicker: "^GSPC",
    instruments: [
      { ticker: "XLP", name: "צריכה בסיסית רחב (XLP)", type: "broad" },
    ],
  },
  communication: {
    label: "תקשורת ומדיה",
    benchmarkTicker: "^GSPC",
    instruments: [
      { ticker: "XLC", name: "תקשורת ומדיה רחב (XLC)", type: "broad" },
    ],
  },
  cybersecurity: {
    label: "סייבר",
    benchmarkTicker: "^GSPC",
    instruments: [
      { ticker: "CIBR", name: "סייבר - פירסט טראסט (CIBR)", type: "narrow" },
    ],
  },
  softwareCloud: {
    label: "תוכנה וענן",
    benchmarkTicker: "^GSPC",
    instruments: [
      { ticker: "IGV", name: "תוכנה - אישרס (IGV)", type: "narrow" },
    ],
  },
};

// Israeli sectors, scraped live from indx.co.il category pages
// (confirmed working 2026-07-11 via services/indxScraper.js). Keyed by the
// indx.co.il index ID (_indexId from the scrape) since that's a stable
// identifier - Hebrew labels can theoretically be edited on their end.
//
// knownInstruments are pre-filled ONLY for sectors Alon already holds
// (from his portfolio notes); for everything else the scanner surfaces the
// sector + index link and Alon picks the instrument himself, as requested -
// this scanner's job is trend identification, not instrument selection.
const IL_SECTORS = {
  // --- category: מדדי מניות ענפיים בישראל ---
  "2161": { label: "תיירות", category: "sectorsIL", knownInstruments: [] },
  "2159": { label: "חברות פרויקטים מניבים", category: "sectorsIL", knownInstruments: [] },
  "2160": { label: "תעשיות ביטחוניות", category: "sectorsIL", knownInstruments: [{ name: "Tachlit TTF Defense", note: "מוחזק בתיק שלך" }] },
  "2156": { label: "תשתיות חיוניות ובנייה", category: "sectorsIL", knownInstruments: [{ name: "Harel Infrastructure", note: "מוחזק בתיק שלך" }] },
  "2143": { label: "אנרגיה מתחדשת", category: "sectorsIL", knownInstruments: [{ name: "MTF Renewable Energy", note: "מוחזק בתיק שלך" }] },
  "2112": { label: "אנרגיה ישראלית", category: "sectorsIL", knownInstruments: [] },
  "2116": { label: "תעשייה", category: "sectorsIL", knownInstruments: [] },
  "2122": { label: "בינוי והנדסת תשתיות", category: "sectorsIL", knownInstruments: [] },
  "2126": { label: "תשתיות לאומיות", category: "sectorsIL", knownInstruments: [] },
  "2142": { label: "טכנולוגיה (רווחיות, משקל שווה)", category: "sectorsIL", knownInstruments: [{ name: "Harel Technology", note: "מוחזק בתיק שלך" }] },

  // --- category: מדדי מניות פיננסים בישראל ---
  "2158": { label: "פיננסים ישראל Top15", category: "financialsIL", knownInstruments: [] },
  "2146": { label: "פיננסים ישראל איזון ענפי", category: "financialsIL", knownInstruments: [] },
  "2113": { label: "ביטוח", category: "financialsIL", knownInstruments: [] },
  "2114": { label: "בנקים וביטוח", category: "financialsIL", knownInstruments: [{ name: "ATF Banks & Insurance", note: "מוחזק בתיק שלך" }] },
  "2139": { label: "בנקים משקל שווה", category: "financialsIL", knownInstruments: [] },
  "2140": { label: "ביטוח משקל שווה", category: "financialsIL", knownInstruments: [] },
  "2141": { label: "בנקים ישראל", category: "financialsIL", knownInstruments: [] },
  "2145": { label: "אשראי חוץ בנקאי ושירותים פיננסיים אחרים", category: "financialsIL", knownInstruments: [] },

  // --- category: מדדי מניות צריכה בישראל ---
  "2133": { label: "צריכה ישראלית", category: "consumerIL", knownInstruments: [] },
  "2135": { label: "מזון ישראלי", category: "consumerIL", knownInstruments: [] },
  "2136": { label: "קמעונאות ומסחר", category: "consumerIL", knownInstruments: [] },
  "2137": { label: "צריכה בסיסית", category: "consumerIL", knownInstruments: [] },
  "2138": { label: "צריכה מחזורית", category: "consumerIL", knownInstruments: [] },

  // --- category: מדדי מניות נדל"ן בישראל ---
  "2157": { label: "התחדשות עירונית", category: "realEstateIL", knownInstruments: [] },
  "2117": { label: "נדל\"ן משרדים ומרכזי קניות", category: "realEstateIL", knownInstruments: [] },
  "2118": { label: "נדל\"ן למגורים", category: "realEstateIL", knownInstruments: [] },
  "2127": { label: "בנייה - מינוף פיננסי נמוך", category: "realEstateIL", knownInstruments: [] },
};

const IL_CATEGORY_URLS = {
  sectorsIL: "https://indx.co.il/index_cat/%d7%9e%d7%93%d7%93%d7%99-%d7%9e%d7%a0%d7%99%d7%95%d7%aa-%d7%a2%d7%a0%d7%a4%d7%99%d7%99%d7%9d-%d7%91%d7%99%d7%a9%d7%a8%d7%90%d7%9c/",
  financialsIL: "https://indx.co.il/index_cat/%d7%9e%d7%93%d7%93%d7%99-%d7%9e%d7%a0%d7%99%d7%95%d7%aa-%d7%a4%d7%99%d7%a0%d7%a0%d7%a1%d7%99%d7%9d-%d7%91%d7%99%d7%a9%d7%a8%d7%90%d7%9c/",
  consumerIL: "https://indx.co.il/index_cat/%d7%9e%d7%93%d7%93%d7%99-%d7%9e%d7%a0%d7%99%d7%95%d7%aa-%d7%a6%d7%a8%d7%99%d7%9b%d7%94-%d7%91%d7%99%d7%a9%d7%a8%d7%90%d7%9c/",
  realEstateIL: "https://indx.co.il/index_cat/%d7%9e%d7%93%d7%93%d7%99-%d7%9e%d7%a0%d7%99%d7%95%d7%aa-%d7%a0%d7%93%d7%9c%d7%9f-%d7%91%d7%99%d7%a9%d7%a8%d7%90%d7%9c/",
};

module.exports = { US_SECTORS, IL_SECTORS, IL_CATEGORY_URLS };
