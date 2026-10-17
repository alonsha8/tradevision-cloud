// services/backtest.js — בדיקה היסטורית של כללי ההחלטה (נכנס / ממתין / לא נכנס)
//
// עקרונות (כדי שהתוצאות יהיו אמינות ולא "יפות"):
//  • בכל יום המנוע רואה רק נתונים עד אותו יום — אין הצצה לעתיד.
//  • איתות בסגירת יום i → פעולה רק מיום i+1 (כניסה בפתיחה / פקודה ממתינה).
//  • סטופ ויעד באותו נר → נרשם כהפסד (שמרני).
//  • פער פתיחה מעבר לסטופ/יעד → יציאה במחיר הפתיחה (לא במחיר הסטופ).
//  • עמלה + החלקה מנוכות בכל צד.
//  • עסקה אחת פתוחה לכל מניה בכל זמן.

const { analyze } = require('./analysisEngine');

const WINDOW = 300;      // נרות לכל ניתוח (SMA200 + רמות שנה אחורה)
const ORDER_DAYS = 5;    // תוקף פקודה ממתינה (ימי מסחר)

function simulateTicker(bars, opts) {
  const { maxHold = 30, costPct = 0.1, step = 1, includeWait = true, startIndex = 250, currency, regimeAt, regimeLabel } = opts;
  const cost = costPct / 100;
  const trades = [];
  let pos = null, order = null;
  const n = bars.length;

  for (let j = startIndex; j < n; j++) {
    const b = bars[j];

    // 1) מימוש פקודה ממתינה
    if (!pos && order) {
      if (j > order.until) order = null;
      else {
        let entry = null;
        if (order.type === 'market') entry = b.o;
        else if (order.type === 'limit') entry = b.o <= order.price ? b.o : (b.l <= order.price ? order.price : null);
        else if (order.type === 'stop') entry = b.o >= order.price ? b.o : (b.h >= order.price ? order.price : null);
        if (entry != null) {
          if (entry > order.stop && order.target > entry) {
            pos = { ...order, entry, entryIdx: j };
          }
          order = null;
        }
      }
    }

    // 2) ניהול פוזיציה פתוחה (כולל יום הכניסה — שמרני: אם הנר נגע בסטופ, יוצאים בהפסד)
    if (pos) {
      let exit = null, why = null;
      const isEntryBar = j === pos.entryIdx;
      if (!isEntryBar && b.o <= pos.stop) { exit = b.o; why = 'stop'; }
      else if (!isEntryBar && b.o >= pos.target) { exit = b.o; why = 'target'; }
      else if (b.l <= pos.stop) { exit = pos.stop; why = 'stop'; }
      else if (b.h >= pos.target) { exit = pos.target; why = 'target'; }
      else if (j - pos.entryIdx >= maxHold) { exit = b.c; why = 'time'; }
      if (exit != null) {
        const grossPct = (exit - pos.entry) / pos.entry;
        const netPct = grossPct - 2 * cost;
        const riskPct = (pos.entry - pos.stop) / pos.entry;
        trades.push({
          kind: pos.kind, type: pos.type,
          entryDate: bars[pos.entryIdx].t, exitDate: b.t, days: j - pos.entryIdx,
          entry: pos.entry, exit, stop: pos.stop, target: pos.target, outcome: why,
          retPct: netPct * 100, R: netPct / riskPct,
        });
        pos = null;
      }
    }

    // 3) איתות חדש בסגירת היום (רק כשאין פוזיציה ואין פקודה)
    if (!pos && !order && j < n - 1 && (j - startIndex) % step === 0) {
      const win = bars.slice(Math.max(0, j - WINDOW + 1), j + 1);
      let a;
      const regime = regimeAt ? (r => (r == null ? undefined : { ok: r, label: regimeLabel }))(regimeAt(b.t)) : undefined;
      try { a = analyze(win, { currency, nowSec: b.t + 3600, lite: true, regime }); } catch (e) { continue; }
      const v = a.verdict;
      if (!v || !v.raw) continue;
      if (v.decision === 'enter' || (includeWait && v.decision === 'wait')) {
        order = {
          kind: v.decision, type: v.decision === 'enter' ? 'market' : v.planType,
          price: v.raw.entry, stop: v.raw.stop, target: v.raw.target,
          until: j + (v.decision === 'enter' ? 1 : ORDER_DAYS),
        };
      }
    }
  }
  return trades;
}

// מעקב אחרי תוכנית אחת (יומן עסקאות): מחשב מחדש מהנרות בכל פעם — תוצאה זהה לבדיקה ההיסטורית.
// plan: { type: 'market'|'limit'|'stop', entry, stop, target, createdAt (שניות) }
// מחזיר: { status: 'pending'|'open'|'target'|'stop'|'time'|'expired'|'invalid', fillPrice, fillTime, exitPrice, exitTime, R, retPct }
function evaluatePlan(bars, plan, opts = {}) {
  const { maxHold = 30, orderDays = ORDER_DAYS, costPct = 0.1 } = opts;
  const after = bars.filter(b => b.t > plan.createdAt);
  // נר של אותו יום מסחר שבו נוצרה התוכנית לא נחשב (האיתות ניתן לפי הסגירה/המחיר באותו רגע)
  const day = t => Math.floor(t / 86400);
  const future = after.filter(b => day(b.t) > day(plan.createdAt));
  let pos = null;
  for (let k = 0; k < future.length; k++) {
    const b = future[k];
    if (!pos) {
      if (k >= (plan.type === 'market' ? 1 : orderDays)) return { status: 'expired' };
      let e = null;
      if (plan.type === 'market') e = b.o;
      else if (plan.type === 'limit') e = b.o <= plan.entry ? b.o : (b.l <= plan.entry ? plan.entry : null);
      else e = b.o >= plan.entry ? b.o : (b.h >= plan.entry ? plan.entry : null);
      if (e == null) continue;
      if (!(e > plan.stop && plan.target > e)) return { status: 'invalid', fillPrice: e, fillTime: b.t };
      pos = { e, k, t: b.t };
    }
    const first = k === pos.k;
    let x = null, why = null;
    if (!first && b.o <= plan.stop) { x = b.o; why = 'stop'; }
    else if (!first && b.o >= plan.target) { x = b.o; why = 'target'; }
    else if (b.l <= plan.stop) { x = plan.stop; why = 'stop'; }
    else if (b.h >= plan.target) { x = plan.target; why = 'target'; }
    else if (k - pos.k >= maxHold) { x = b.c; why = 'time'; }
    if (x != null) {
      const net = (x - pos.e) / pos.e - 2 * costPct / 100;
      return { status: why, fillPrice: pos.e, fillTime: pos.t, exitPrice: x, exitTime: b.t, retPct: net * 100, R: net / ((pos.e - plan.stop) / pos.e) };
    }
  }
  if (!pos) return { status: 'pending' };
  const last = future[future.length - 1];
  return { status: 'open', fillPrice: pos.e, fillTime: pos.t, lastPrice: last.c, openR: (last.c - pos.e) / (pos.e - plan.stop) };
}

function stats(trades) {
  if (!trades.length) return { trades: 0 };
  const wins = trades.filter(t => t.retPct > 0), losses = trades.filter(t => t.retPct <= 0);
  const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
  const grossWin = sum(wins, t => t.retPct), grossLoss = -sum(losses, t => t.retPct);
  // עקומת הון: סיכון 1% מההון בכל עסקה, לפי סדר תאריכי היציאה
  const sorted = trades.slice().sort((a, b) => a.exitDate - b.exitDate);
  let eq = 100, peak = 100, maxDD = 0;
  const curve = [];
  for (const t of sorted) {
    eq *= 1 + 0.01 * t.R;
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, (peak - eq) / peak);
    curve.push({ t: t.exitDate, v: +eq.toFixed(2) });
  }
  return {
    trades: trades.length,
    winRate: +(wins.length / trades.length * 100).toFixed(1),
    avgWinPct: wins.length ? +(grossWin / wins.length).toFixed(2) : 0,
    avgLossPct: losses.length ? +(-grossLoss / losses.length).toFixed(2) : 0,
    profitFactor: grossLoss ? +(grossWin / grossLoss).toFixed(2) : null,
    expectancyPct: +(sum(trades, t => t.retPct) / trades.length).toFixed(2),
    expectancyR: +(sum(trades, t => t.R) / trades.length).toFixed(2),
    avgDays: +(sum(trades, t => t.days) / trades.length).toFixed(1),
    byOutcome: { target: trades.filter(t => t.outcome === 'target').length, stop: trades.filter(t => t.outcome === 'stop').length, time: trades.filter(t => t.outcome === 'time').length },
    equityEnd: +eq.toFixed(1), maxDrawdownPct: +(maxDD * 100).toFixed(1),
    curve: curve.length > 400 ? curve.filter((_, k) => k % Math.ceil(curve.length / 400) === 0 || k === curve.length - 1) : curve,
  };
}

function byYear(trades) {
  const out = {};
  for (const t of trades) {
    const y = new Date(t.exitDate * 1000).getUTCFullYear();
    (out[y] = out[y] || []).push(t);
  }
  return Object.fromEntries(Object.entries(out).map(([y, ts]) => {
    const s = stats(ts);
    return [y, { trades: s.trades, winRate: s.winRate, expectancyR: s.expectancyR, profitFactor: s.profitFactor }];
  }));
}

module.exports = { simulateTicker, stats, byYear, evaluatePlan };
