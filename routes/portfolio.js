// ============================================================
// routes/portfolio.js — $trade Portfolio API
// הוסף ב-server.js: app.use('/api/portfolio', require('./routes/portfolio'));
// ============================================================
const express = require('express');
const router  = express.Router();
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ─── אתחול טבלאות אוטומטי ───
(async () => {
  try {
    const c = await pool.connect();
    await c.query(`
      CREATE TABLE IF NOT EXISTS portfolio_holdings (
        id SERIAL PRIMARY KEY, ticker VARCHAR(20) NOT NULL, name VARCHAR(100) NOT NULL,
        name_en VARCHAR(60), quantity NUMERIC(14,4) NOT NULL, avg_buy_price NUMERIC(14,4) NOT NULL,
        last_price NUMERIC(14,4), value_ils NUMERIC(14,2), pnl_pct NUMERIC(8,2), pnl_ils NUMERIC(14,2),
        currency CHAR(3) NOT NULL DEFAULT 'USD', market VARCHAR(10) DEFAULT 'US',
        is_active BOOLEAN DEFAULT true, notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS portfolio_transactions (
        id SERIAL PRIMARY KEY, holding_id INT REFERENCES portfolio_holdings(id),
        ticker VARCHAR(20) NOT NULL, action VARCHAR(10) NOT NULL,
        quantity NUMERIC(14,4) NOT NULL, price NUMERIC(14,4) NOT NULL, currency CHAR(3) NOT NULL,
        total_ils NUMERIC(14,2), usd_ils_rate NUMERIC(8,4), notes TEXT,
        executed_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS portfolio_ratings (
        id SERIAL PRIMARY KEY, holding_id INT REFERENCES portfolio_holdings(id),
        ticker VARCHAR(20) NOT NULL, rating_date DATE NOT NULL DEFAULT CURRENT_DATE,
        score NUMERIC(3,1), grade CHAR(2), recommendation VARCHAR(20),
        thesis_changed BOOLEAN DEFAULT false, analysis TEXT,
        close_price NUMERIC(14,4), daily_pct NUMERIC(6,2),
        created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(ticker, rating_date)
      );
      CREATE TABLE IF NOT EXISTS portfolio_daily_summary (
        id SERIAL PRIMARY KEY, summary_date DATE NOT NULL UNIQUE DEFAULT CURRENT_DATE,
        total_value_ils NUMERIC(14,2), daily_change_ils NUMERIC(14,2), daily_change_pct NUMERIC(6,2),
        portfolio_score NUMERIC(3,1), portfolio_grade CHAR(2), cash_ils NUMERIC(14,2),
        usd_ils_rate NUMERIC(8,4), report_sent BOOLEAN DEFAULT false, report_text TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS portfolio_cash (
        id SERIAL PRIMARY KEY, currency CHAR(3) NOT NULL,
        amount NUMERIC(14,2) NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    // הזרע אחזקות אם הטבלה ריקה
    const { rows } = await c.query('SELECT COUNT(*) FROM portfolio_holdings');
    if (parseInt(rows[0].count) === 0) {
      await c.query(`
        INSERT INTO portfolio_holdings (ticker,name,name_en,quantity,avg_buy_price,last_price,value_ils,pnl_pct,pnl_ils,currency,market) VALUES
        ('1232750','אוריון','ORION',0.63,307.94,94.60,0.60,-69.28,-1.36,'ILS','TASE'),
        ('1148774','IBI סל בנקים ישראל','IBI BANKS',72,7345.14,7010.00,5047.20,-4.56,-241.30,'ILS','TASE'),
        ('1148899','הראל סל ת"א 125','HAREL125',661,3930.48,3737.00,24701.57,-4.92,-1278.90,'ILS','TASE'),
        ('475020','ניו-מד אנרגיה','NEW-MED',409,1711.20,1683.00,6883.47,-1.65,-115.34,'ILS','TASE'),
        ('5133236','ATF בנקים וביטוח ישראל','ATF BANKS',2612,421.14,398.42,10406.73,-5.39,-593.45,'ILS','TASE'),
        ('1150432','MTF סל בריאות S&P','MTF HEALTH',0.53,5826.42,7295.00,38.66,25.21,7.78,'ILS','TASE'),
        ('60032877','ALPHABET (GOOGL)','GOOGL',28,310.39,273.10,25375.14,-12.01,-3464.81,'USD','US'),
        ('60400637','BROADCOM (AVGO)','AVGO',7,306.86,300.86,6988.62,-1.96,-139.37,'USD','US'),
        ('60458759','DELL TECHNOLOGIES','DELL',9,338.43,297.06,8871.87,-12.22,-1235.54,'USD','US'),
        ('24368755','QQQM (INVESCO QQQ)','QQQM',47.3,269.59,261.05,40974.49,-3.17,-1340.44,'USD','US'),
        ('60606209','META PLATFORMS','META',4,643.22,609.89,8095.44,-5.18,-442.41,'USD','US'),
        ('105049','MICROSOFT (MSFT)','MSFT',5.31,413.32,489.93,8632.91,18.54,1349.92,'USD','US'),
        ('119636','NVIDIA (NVDA)','NVDA',31,200.26,149.30,15358.55,-25.45,-5242.28,'USD','US'),
        ('60036712','SPDR GOLD (GLD)','GLD',6,344.00,327.45,6519.66,-4.81,-329.52,'USD','US')
      `);
      await c.query(`INSERT INTO portfolio_cash (currency,amount) VALUES ('ILS',23760.00)`);
      console.log('✅ Portfolio seed data inserted');
    }
    c.release();
    console.log('✅ Portfolio tables ready');
  } catch(e) { console.error('Portfolio init error:', e.message); }
})();

// ─────────────────────────────────────────────
// GET /api/portfolio/holdings
// מחזיר כל האחזקות הפעילות + מזומן
// ─────────────────────────────────────────────
router.get('/holdings', async (req, res) => {
  try {
    const [holdingsRes, cashRes, summaryRes] = await Promise.all([
      pool.query(`
        SELECT h.*,
          r.score, r.grade, r.recommendation, r.thesis_changed, r.analysis, r.daily_pct
        FROM portfolio_holdings h
        LEFT JOIN LATERAL (
          SELECT * FROM portfolio_ratings
          WHERE ticker = h.ticker
          ORDER BY rating_date DESC LIMIT 1
        ) r ON true
        WHERE h.is_active = true
        ORDER BY h.market, h.value_ils DESC
      `),
      pool.query(`SELECT currency, amount FROM portfolio_cash`),
      pool.query(`
        SELECT * FROM portfolio_daily_summary
        ORDER BY summary_date DESC LIMIT 1
      `)
    ]);
    res.json({
      holdings: holdingsRes.rows,
      cash: cashRes.rows,
      summary: summaryRes.rows[0] || null,
      as_of: new Date().toISOString()
    });
  } catch (err) {
    console.error('[portfolio/holdings]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/portfolio/transaction
// רישום פעולה: BUY / SELL / DIVIDEND
// body: { ticker, action, quantity, price, currency, usd_ils_rate?, notes? }
// ─────────────────────────────────────────────
router.post('/transaction', async (req, res) => {
  const { ticker, action, quantity, price, currency, usd_ils_rate, notes } = req.body;
  if (!ticker || !action || !quantity || !price) {
    return res.status(400).json({ error: 'ticker, action, quantity, price חובה' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const rate = usd_ils_rate || (currency === 'USD' ? 3.72 : 1); // שער ברירת מחדל
    const total_ils = quantity * price * rate;

    // רישום הפעולה
    await client.query(`
      INSERT INTO portfolio_transactions
        (ticker, action, quantity, price, currency, total_ils, usd_ils_rate, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [ticker, action.toUpperCase(), quantity, price, currency, total_ils, rate, notes]);

    // עדכון האחזקה
    const holdingRes = await client.query(
      `SELECT * FROM portfolio_holdings WHERE ticker = $1 AND is_active = true`,
      [ticker]
    );

    if (action.toUpperCase() === 'BUY') {
      if (holdingRes.rows.length === 0) {
        // אחזקה חדשה
        return res.status(400).json({ error: 'אחזקה לא קיימת — הוסף קודם דרך ממשק הניהול' });
      }
      const h = holdingRes.rows[0];
      const newQty = parseFloat(h.quantity) + parseFloat(quantity);
      const newAvg = (parseFloat(h.quantity) * parseFloat(h.avg_buy_price) + parseFloat(quantity) * parseFloat(price)) / newQty;
      await client.query(`
        UPDATE portfolio_holdings
        SET quantity = $1, avg_buy_price = $2
        WHERE ticker = $3 AND is_active = true
      `, [newQty, newAvg, ticker]);

    } else if (action.toUpperCase() === 'SELL') {
      if (holdingRes.rows.length === 0) {
        return res.status(400).json({ error: 'אחזקה לא נמצאה' });
      }
      const h = holdingRes.rows[0];
      const newQty = parseFloat(h.quantity) - parseFloat(quantity);
      if (newQty < 0) return res.status(400).json({ error: 'כמות מכירה עולה על האחזקה' });
      if (newQty === 0) {
        await client.query(`UPDATE portfolio_holdings SET is_active = false WHERE ticker = $1`, [ticker]);
      } else {
        await client.query(`UPDATE portfolio_holdings SET quantity = $1 WHERE ticker = $2 AND is_active = true`, [newQty, ticker]);
      }
      // עדכון מזומן
      await client.query(`UPDATE portfolio_cash SET amount = amount + $1 WHERE currency = 'ILS'`, [total_ils]);
    }

    await client.query('COMMIT');
    res.json({ ok: true, action, ticker, quantity, price, total_ils });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[portfolio/transaction]', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────
// PUT /api/portfolio/cash
// עדכון יתרת מזומן
// body: { amount }
// ─────────────────────────────────────────────
router.put('/cash', async (req, res) => {
  const { amount } = req.body;
  await pool.query(`UPDATE portfolio_cash SET amount = $1 WHERE currency = 'ILS'`, [amount]);
  res.json({ ok: true, amount });
});

// ─────────────────────────────────────────────
// POST /api/portfolio/holding
// הוספת אחזקה חדשה (ידנית)
// ─────────────────────────────────────────────
router.post('/holding', async (req, res) => {
  const { ticker, name, name_en, quantity, avg_buy_price, currency, market, notes } = req.body;
  try {
    const r = await pool.query(`
      INSERT INTO portfolio_holdings (ticker, name, name_en, quantity, avg_buy_price, currency, market, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [ticker, name, name_en || null, quantity, avg_buy_price, currency, market || 'US', notes || null]);
    res.json({ ok: true, holding: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// PATCH /api/portfolio/holding/:id
// עדכון שדות אחזקה (כמות / מחיר קנייה / סטטוס)
// ─────────────────────────────────────────────
router.patch('/holding/:id', async (req, res) => {
  const { id } = req.params;
  const { quantity, avg_buy_price, is_active, notes } = req.body;
  const updates = [];
  const vals = [];
  let idx = 1;
  if (quantity      !== undefined) { updates.push(`quantity = $${idx++}`);       vals.push(quantity); }
  if (avg_buy_price !== undefined) { updates.push(`avg_buy_price = $${idx++}`);  vals.push(avg_buy_price); }
  if (is_active     !== undefined) { updates.push(`is_active = $${idx++}`);      vals.push(is_active); }
  if (notes         !== undefined) { updates.push(`notes = $${idx++}`);          vals.push(notes); }
  if (!updates.length) return res.status(400).json({ error: 'אין שדות לעדכן' });
  vals.push(id);
  await pool.query(`UPDATE portfolio_holdings SET ${updates.join(', ')} WHERE id = $${idx}`, vals);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// GET /api/portfolio/transactions
// היסטוריית פעולות
// ─────────────────────────────────────────────
router.get('/transactions', async (req, res) => {
  const { ticker, limit = 50 } = req.query;
  const where = ticker ? `WHERE ticker = $1` : '';
  const params = ticker ? [ticker] : [];
  const r = await pool.query(
    `SELECT * FROM portfolio_transactions ${where} ORDER BY executed_at DESC LIMIT ${limit}`,
    params
  );
  res.json(r.rows);
});

// ─────────────────────────────────────────────
// POST /api/portfolio/update-prices
// Claude task קורא לזה אחרי חישוב מחירים
// body: { prices: [{ticker, last_price, value_ils, pnl_pct, pnl_ils, daily_pct}], usd_ils_rate }
// ─────────────────────────────────────────────
router.post('/update-prices', async (req, res) => {
  const { prices, usd_ils_rate } = req.body;
  if (!Array.isArray(prices)) return res.status(400).json({ error: 'prices חייב להיות מערך' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of prices) {
      await client.query(`
        UPDATE portfolio_holdings
        SET last_price = $1, value_ils = $2, pnl_pct = $3, pnl_ils = $4
        WHERE ticker = $5 AND is_active = true
      `, [p.last_price, p.value_ils, p.pnl_pct, p.pnl_ils, p.ticker]);
    }
    await client.query('COMMIT');
    res.json({ ok: true, updated: prices.length, usd_ils_rate });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────
// POST /api/portfolio/save-report
// Claude task שומר את הדוח + ציונים אחרי עיבוד
// body: { summary, ratings: [{ticker, score, grade, recommendation, analysis, ...}] }
// ─────────────────────────────────────────────
router.post('/save-report', async (req, res) => {
  const { summary, ratings } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // שמירת סיכום יומי
    await client.query(`
      INSERT INTO portfolio_daily_summary
        (summary_date, total_value_ils, daily_change_ils, daily_change_pct,
         portfolio_score, portfolio_grade, cash_ils, usd_ils_rate, report_text, report_sent)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (summary_date) DO UPDATE SET
        total_value_ils = EXCLUDED.total_value_ils,
        daily_change_ils = EXCLUDED.daily_change_ils,
        daily_change_pct = EXCLUDED.daily_change_pct,
        portfolio_score = EXCLUDED.portfolio_score,
        portfolio_grade = EXCLUDED.portfolio_grade,
        cash_ils = EXCLUDED.cash_ils,
        report_text = EXCLUDED.report_text,
        report_sent = EXCLUDED.report_sent
    `, [
      summary.date, summary.total_value_ils, summary.daily_change_ils,
      summary.daily_change_pct, summary.portfolio_score, summary.portfolio_grade,
      summary.cash_ils, summary.usd_ils_rate, summary.report_text, summary.report_sent
    ]);
    // שמירת ציונים לכל אחזקה
    for (const r of (ratings || [])) {
      await client.query(`
        INSERT INTO portfolio_ratings
          (ticker, rating_date, score, grade, recommendation, thesis_changed, analysis, close_price, daily_pct)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (ticker, rating_date) DO UPDATE SET
          score = EXCLUDED.score, grade = EXCLUDED.grade,
          recommendation = EXCLUDED.recommendation,
          thesis_changed = EXCLUDED.thesis_changed,
          analysis = EXCLUDED.analysis
      `, [r.ticker, summary.date, r.score, r.grade, r.recommendation,
          r.thesis_changed || false, r.analysis, r.close_price, r.daily_pct]);
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
