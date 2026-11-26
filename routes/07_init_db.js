// ============================================================
// 07_init_db.js — אתחול DB אוטומטי
// שמור כ: scripts/init-db.js
// הרץ פעם אחת: node scripts/init-db.js
// או הוסף ל-package.json: "init-db": "node scripts/init-db.js"
// ============================================================

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  const client = await pool.connect();
  console.log('✅ Connected to DB');

  try {
    await client.query('BEGIN');

    // טבלת אחזקות
    await client.query(`
      CREATE TABLE IF NOT EXISTS portfolio_holdings (
        id              SERIAL PRIMARY KEY,
        ticker          VARCHAR(20) NOT NULL,
        name            VARCHAR(100) NOT NULL,
        name_en         VARCHAR(60),
        quantity        NUMERIC(14,4) NOT NULL,
        avg_buy_price   NUMERIC(14,4) NOT NULL,
        last_price      NUMERIC(14,4),
        value_ils       NUMERIC(14,2),
        pnl_pct         NUMERIC(8,2),
        pnl_ils         NUMERIC(14,2),
        currency        CHAR(3) NOT NULL DEFAULT 'USD',
        market          VARCHAR(10) DEFAULT 'US',
        is_active       BOOLEAN DEFAULT true,
        notes           TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // טבלת עסקאות
    await client.query(`
      CREATE TABLE IF NOT EXISTS portfolio_transactions (
        id              SERIAL PRIMARY KEY,
        holding_id      INT REFERENCES portfolio_holdings(id),
        ticker          VARCHAR(20) NOT NULL,
        action          VARCHAR(10) NOT NULL,
        quantity        NUMERIC(14,4) NOT NULL,
        price           NUMERIC(14,4) NOT NULL,
        currency        CHAR(3) NOT NULL,
        total_ils       NUMERIC(14,2),
        usd_ils_rate    NUMERIC(8,4),
        notes           TEXT,
        executed_at     TIMESTAMPTZ DEFAULT NOW(),
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // טבלת דירוגים
    await client.query(`
      CREATE TABLE IF NOT EXISTS portfolio_ratings (
        id              SERIAL PRIMARY KEY,
        holding_id      INT REFERENCES portfolio_holdings(id),
        ticker          VARCHAR(20) NOT NULL,
        rating_date     DATE NOT NULL DEFAULT CURRENT_DATE,
        score           NUMERIC(3,1),
        grade           CHAR(2),
        recommendation  VARCHAR(20),
        thesis_changed  BOOLEAN DEFAULT false,
        analysis        TEXT,
        close_price     NUMERIC(14,4),
        daily_pct       NUMERIC(6,2),
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(ticker, rating_date)
      )
    `);

    // טבלת סיכום יומי
    await client.query(`
      CREATE TABLE IF NOT EXISTS portfolio_daily_summary (
        id               SERIAL PRIMARY KEY,
        summary_date     DATE NOT NULL UNIQUE DEFAULT CURRENT_DATE,
        total_value_ils  NUMERIC(14,2),
        daily_change_ils NUMERIC(14,2),
        daily_change_pct NUMERIC(6,2),
        portfolio_score  NUMERIC(3,1),
        portfolio_grade  CHAR(2),
        cash_ils         NUMERIC(14,2),
        usd_ils_rate     NUMERIC(8,4),
        report_sent      BOOLEAN DEFAULT false,
        report_text      TEXT,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // טבלת מזומן
    await client.query(`
      CREATE TABLE IF NOT EXISTS portfolio_cash (
        id         SERIAL PRIMARY KEY,
        currency   CHAR(3) NOT NULL,
        amount     NUMERIC(14,2) NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // אינדקסים
    await client.query(`CREATE INDEX IF NOT EXISTS idx_holdings_ticker ON portfolio_holdings(ticker)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_holdings_active ON portfolio_holdings(is_active)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ratings_date ON portfolio_ratings(rating_date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ratings_ticker ON portfolio_ratings(ticker)`);

    console.log('✅ All tables created');

    // בדוק אם כבר יש נתונים
    const { rows } = await client.query('SELECT COUNT(*) FROM portfolio_holdings');
    if (parseInt(rows[0].count) > 0) {
      console.log(`ℹ️  Holdings already exist (${rows[0].count} rows) — skipping seed`);
      await client.query('COMMIT');
      return;
    }

    // הזרעת אחזקות מ-26.11.2026
    await client.query(`
      INSERT INTO portfolio_holdings
        (ticker, name, name_en, quantity, avg_buy_price, last_price, value_ils, pnl_pct, pnl_ils, currency, market)
      VALUES
        ('1232750',  'אוריון',                  'ORION',       0.63,  307.94,  94.60,     0.60,   -69.28,    -1.36, 'ILS', 'TASE'),
        ('1148774',  'IBI סל בנקים ישראל',     'IBI BANKS',  72,    7345.14, 7010.00,  5047.20,   -4.56,  -241.30, 'ILS', 'TASE'),
        ('1148899',  'הראל סל ת"א 125',         'HAREL125',  661,   3930.48, 3737.00, 24701.57,   -4.92, -1278.90, 'ILS', 'TASE'),
        ('475020',   'ניו-מד אנרגיה',           'NEW-MED',   409,   1711.20, 1683.00,  6883.47,   -1.65,  -115.34, 'ILS', 'TASE'),
        ('5133236',  'ATF בנקים וביטוח ישראל', 'ATF BANKS', 2612,   421.14,  398.42, 10406.73,   -5.39,  -593.45, 'ILS', 'TASE'),
        ('1150432',  'MTF סל בריאות S&P',      'MTF HEALTH',  0.53, 5826.42, 7295.00,    38.66,   25.21,     7.78, 'ILS', 'TASE'),
        ('60032877', 'ALPHABET (GOOGL)',         'GOOGL',      28,    310.39,  273.10, 25375.14,  -12.01, -3464.81, 'USD', 'US'),
        ('60400637', 'BROADCOM (AVGO)',          'AVGO',        7,    306.86,  300.86,  6988.62,   -1.96,  -139.37, 'USD', 'US'),
        ('60458759', 'DELL TECHNOLOGIES',       'DELL',        9,    338.43,  297.06,  8871.87,  -12.22, -1235.54, 'USD', 'US'),
        ('24368755', 'QQQM (INVESCO QQQ)',      'QQQM',       47.3,  269.59,  261.05, 40974.49,   -3.17, -1340.44, 'USD', 'US'),
        ('60606209', 'META PLATFORMS',          'META',         4,   643.22,  609.89,  8095.44,   -5.18,  -442.41, 'USD', 'US'),
        ('105049',   'MICROSOFT (MSFT)',         'MSFT',       5.31,  413.32,  489.93,  8632.91,   18.54,  1349.92, 'USD', 'US'),
        ('119636',   'NVIDIA (NVDA)',            'NVDA',       31,    200.26,  149.30, 15358.55,  -25.45, -5242.28, 'USD', 'US'),
        ('60036712', 'SPDR GOLD (GLD)',          'GLD',         6,    344.00,  327.45,  6519.66,   -4.81,  -329.52, 'USD', 'US')
    `);

    // מזומן
    await client.query(`INSERT INTO portfolio_cash (currency, amount) VALUES ('ILS', 23760.00)`);

    await client.query('COMMIT');
    console.log('✅ Seed data inserted — 14 holdings + ₪23,760 cash');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

initDB();
