// services/journal.js — יומן עסקאות עם מעקב אוטומטי + סריקות מתוזמנות בשרת
//
// • כל תוכנית שנשמרת מהניתוח (כניסה/סטופ/יעד) נבדקת אוטומטית מול הנרות — אותה לוגיקה של הבדיקה ההיסטורית.
// • מייל נשלח כשהפקודה מתממשת, כשהיעד או הסטופ נפגעים, או כשהפקודה פגה.
// • סריקה מתוזמנת בשעות המסחר: הסורק תמיד "חם", ומייל נשלח כשמניה עוברת ל"נכנס".

const cron = require('node-cron');
const { evaluatePlan, stats } = require('./backtest');
const scanner = require('./scanner');
const { sendAlertEmail } = require('../watchers/emailAlert');

const getBars = (...a) => require('../routes/stockAnalysisApi').getBars(...a);

async function initTables(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS trade_journal (
    id SERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    ticker TEXT NOT NULL, currency TEXT, decision TEXT, plan_type TEXT NOT NULL,
    entry NUMERIC NOT NULL, stop NUMERIC NOT NULL, target NUMERIC NOT NULL,
    shares INTEGER, notes TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    fill_price NUMERIC, fill_time TIMESTAMPTZ, exit_price NUMERIC, exit_time TIMESTAMPTZ,
    r_multiple NUMERIC, ret_pct NUMERIC, last_price NUMERIC, checked_at TIMESTAMPTZ
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS scan_snapshots (
    id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT NOW(), market TEXT NOT NULL, enter_tickers TEXT[] NOT NULL
  )`);
}

const LABEL = { pending: '⏳ ממתין למימוש', open: '🟢 פתוחה', target: '🎯 יעד', stop: '🛑 סטופ', time: '⌛ 30 יום', expired: '⌛ פקודה פגה', invalid: '⚠️ פער מעבר לסטופ', cancelled: '✖ בוטל' };
const fmt = (v, cur) => (cur === 'ILA' ? Math.round(v).toLocaleString('en-US') + ' אג׳' : (cur === 'USD' ? '$' : '') + Number(v).toFixed(2));

async function trackAll(pool) {
  const r = await pool.query(`SELECT * FROM trade_journal WHERE status IN ('pending','open') ORDER BY id`);
  for (const row of r.rows) {
    try {
      const { bars } = await getBars(row.ticker);
      const isTA = row.ticker.endsWith('.TA');
      const ev = evaluatePlan(bars, {
        type: row.plan_type, entry: +row.entry, stop: +row.stop, target: +row.target,
        createdAt: Math.floor(new Date(row.created_at).getTime() / 1000),
      }, { costPct: isTA ? 0.2 : 0.1 });
      const ts = x => (x ? new Date(x * 1000) : null);
      await pool.query(`UPDATE trade_journal SET status=$2, fill_price=$3, fill_time=$4, exit_price=$5, exit_time=$6, r_multiple=$7, ret_pct=$8, last_price=$9, checked_at=NOW() WHERE id=$1`,
        [row.id, ev.status, ev.fillPrice ?? null, ts(ev.fillTime), ev.exitPrice ?? null, ts(ev.exitTime), ev.R ?? ev.openR ?? null, ev.retPct ?? null, ev.lastPrice ?? bars[bars.length - 1].c]);
      if (ev.status !== row.status) {
        const cur = row.currency;
        const msg = ev.status === 'open' ? `הפקודה מומשה ב-${fmt(ev.fillPrice, cur)}. סטופ ${fmt(row.stop, cur)}, יעד ${fmt(row.target, cur)}.`
          : ['target', 'stop', 'time'].includes(ev.status) ? `יציאה ב-${fmt(ev.exitPrice, cur)} (${ev.retPct >= 0 ? '+' : ''}${ev.retPct.toFixed(2)}%, ${ev.R >= 0 ? '+' : ''}${ev.R.toFixed(2)}R).`
          : ev.status === 'expired' ? 'הפקודה לא מומשה בזמן ופגה.' : 'המחיר נפתח מעבר לסטופ — העסקה לא נפתחה.';
        await sendAlertEmail({ subject: `${LABEL[ev.status]} | ${row.ticker} — יומן עסקאות`, message: msg, link: '' }).catch(() => {});
      }
    } catch (e) {
      console.error('journal track', row.ticker, e.message);
    }
  }
}

async function scheduledScan(pool, market) {
  const v = await scanner.scanMarket(market, true);
  const enter = v.rows.filter(r => r.signal === 'BUY').map(r => r.ticker).sort();
  if (!pool) return;
  const prev = await pool.query('SELECT enter_tickers FROM scan_snapshots WHERE market=$1 ORDER BY id DESC LIMIT 1', [market]);
  const before = new Set(prev.rows.length ? prev.rows[0].enter_tickers : []);
  await pool.query('INSERT INTO scan_snapshots (market, enter_tickers) VALUES ($1, $2)', [market, enter]);
  await pool.query(`DELETE FROM scan_snapshots WHERE created_at < NOW() - INTERVAL '30 days'`);
  const fresh = v.rows.filter(r => r.signal === 'BUY' && !before.has(r.ticker));
  if (prev.rows.length && fresh.length) {
    const lines = fresh.map(r => `${r.ticker}: כניסה ${fmt(r.entry, r.currency)} · סטופ ${fmt(r.stopLoss, r.currency)} · יעד ${fmt(r.target, r.currency)} (${r.rr})`).join('\n');
    await sendAlertEmail({ subject: `✅ ${fresh.length} מניות חדשות במצב "נכנס" (${market === 'TA' ? 'ת"א' : 'ארה"ב'})`, message: lines, link: '' }).catch(() => {});
  }
}

function startSchedules(pool) {
  const tz = { timezone: 'Asia/Jerusalem' };
  const safe = (name, fn) => async () => { try { await fn(); } catch (e) { console.error(`❌ ${name}:`, e.message); } };
  // ת"א: ב'-ו', 10:00–17:30 · ארה"ב: ב'-ו', 16:30–23:00 (שעון ישראל)
  cron.schedule('*/10 10-17 * * 1-5', safe('scan TA', () => scheduledScan(pool, 'TA')), tz);
  cron.schedule('*/10 16-23 * * 1-5', safe('scan US', () => scheduledScan(pool, 'US')), tz);
  if (pool) cron.schedule('*/15 10-23 * * 1-5', safe('journal', () => trackAll(pool)), tz);
  console.log('⏰ סריקות מתוזמנות: ת"א 10-17, ארה"ב 16-23 (כל 10 דק׳)' + (pool ? ' · מעקב יומן כל 15 דק׳' : ''));
}

async function journalStats(pool) {
  const r = await pool.query(`SELECT * FROM trade_journal ORDER BY id DESC LIMIT 500`);
  const closed = r.rows.filter(x => ['target', 'stop', 'time'].includes(x.status)).map(x => ({
    retPct: +x.ret_pct, R: +x.r_multiple, days: x.exit_time && x.fill_time ? Math.round((new Date(x.exit_time) - new Date(x.fill_time)) / 86400000) : 0,
    exitDate: Math.floor(new Date(x.exit_time).getTime() / 1000), outcome: x.status,
  }));
  return { rows: r.rows, stats: stats(closed) };
}

module.exports = { initTables, trackAll, startSchedules, journalStats, scheduledScan, LABEL };
