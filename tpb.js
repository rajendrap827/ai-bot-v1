/**
 * 1H Trend Pullback (strategyId: 'tpb')
 *
 * PRE-REGISTERED 2026-10-07, before any result was seen. Do not tune after testing.
 *
 *   timeframe  1H, built from the 5m feed; evaluated only when an hour completes
 *              (the 5m bar opening at :55 UTC)
 *   uptrend    close > EMA200 and EMA50 > EMA200   (downtrend: mirror)
 *   long       in an uptrend, RSI(14) crosses back UP through 40 (pullback ended)
 *   short      in a downtrend, RSI(14) crosses back DOWN through 60
 *   stop       long: lowest low of the last 5 hours - 0.2 x ATR(1H), and at least
 *              1.0 x ATR(1H) away; skip if wider than 3 x ATR(1H)   (short: mirror)
 *   target     2R (Fixed RR mode). Trailing mode trails on ATR(1H) (trailTf = 60).
 *
 * Why: enter the larger trend after a pullback. Hourly stops are several times
 * wider than 5m stops, so spread costs far less per trade in R terms - the cost
 * that sank the 5m strategies.
 */

const H = 3600000;

const defaults = {
  tpbEmaFast: 50,
  tpbEmaSlow: 200,
  tpbRsiLen: 14,
  tpbRsiLow: 40,
  tpbRsiHigh: 60,
  tpbSwing: 5,
  tpbSlBuf: 0.2,
  tpbMinStop: 1.0,
  tpbMaxStop: 3.0,
  tpbRR: 2.0,
};

// ~500 hours of 5m bars so EMA200 is well converged
const window = 6000;
const trailTf = 60;

function shouldEval(bar) {
  return new Date(bar.t).getUTCMinutes() === 55;
}

function toHourly(c5) {
  const out = [];
  let cur = null;
  for (const b of c5) {
    const key = Math.floor(new Date(b.t).getTime() / H) * H;
    if (!cur || cur.key !== key) {
      if (cur) out.push(cur);
      cur = { key, o: b.o, h: b.h, l: b.l, c: b.c };
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function ema(vals, p) {
  const k = 2 / (p + 1);
  const out = [];
  let e = null;
  for (const v of vals) { e = e == null ? v : v * k + e * (1 - k); out.push(e); }
  return out;
}

function rsi(vals, p) {
  const out = new Array(vals.length).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i < vals.length; i++) {
    const d = vals[i] - vals[i - 1];
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= p) {
      ag += g / p; al += l / p;
      if (i === p) out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    } else {
      ag = (ag * (p - 1) + g) / p;
      al = (al * (p - 1) + l) / p;
      out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
  }
  return out;
}

function atr(bars, p = 14) {
  const out = [];
  let prev = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const tr = i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c));
    prev = prev == null ? tr : (prev * (p - 1) + tr) / p;
    out.push(prev);
  }
  return out;
}

function compute(candles, cfg) {
  const k = { ...defaults, ...(cfg || {}) };
  const last = candles[candles.length - 1];
  if (!shouldEval(last)) return { signal: null, reason: 'not_hour_close' };

  const hb = toHourly(candles);
  const n = hb.length;
  if (n < k.tpbEmaSlow + 20) return { signal: null, reason: 'warmup' };

  const closes = hb.map((b) => b.c);
  const eF = ema(closes, k.tpbEmaFast);
  const eS = ema(closes, k.tpbEmaSlow);
  const r = rsi(closes, k.tpbRsiLen);
  const a = atr(hb, 14);
  const i = n - 1;
  if (r[i] == null || r[i - 1] == null) return { signal: null, reason: 'warmup' };

  const up = closes[i] > eS[i] && eF[i] > eS[i];
  const dn = closes[i] < eS[i] && eF[i] < eS[i];
  const longT = up && r[i - 1] < k.tpbRsiLow && r[i] >= k.tpbRsiLow;
  const shortT = dn && r[i - 1] > k.tpbRsiHigh && r[i] <= k.tpbRsiHigh;
  if (!longT && !shortT) return { signal: null, reason: 'no_setup' };

  const from = Math.max(0, i - k.tpbSwing + 1);
  let lo = Infinity, hi = -Infinity;
  for (let j = from; j <= i; j++) { lo = Math.min(lo, hb[j].l); hi = Math.max(hi, hb[j].h); }

  const entry = closes[i];
  const dir = longT ? 'LONG' : 'SHORT';
  const sl = longT
    ? Math.min(lo - k.tpbSlBuf * a[i], entry - k.tpbMinStop * a[i])
    : Math.max(hi + k.tpbSlBuf * a[i], entry + k.tpbMinStop * a[i]);
  const risk = Math.abs(entry - sl);
  if (!(risk > 0) || risk > k.tpbMaxStop * a[i]) return { signal: null, reason: 'stop_too_wide' };
  const tp = longT ? entry + k.tpbRR * risk : entry - k.tpbRR * risk;

  return {
    signal: dir,
    time: last.t,
    entry,
    sl,
    tp1: tp,
    tp2: tp,
    atr: a[i],
    stage: longT ? 'ADVANCING' : 'DECLINING',
    htfTrend: longT ? 'UP' : 'DOWN',
    adx: 0,
    bullScore: longT ? 3 : 0,
    bearScore: longT ? 0 : 3,
    score: 3,
    oppScore: 0,
    netMargin: 3,
    confirmationCandle: false,
    checks: {
      stage: { passed: true, weight: 1, value: longT ? 'h1_uptrend' : 'h1_downtrend' },
      aov: { passed: true, weight: 1, value: 'rsi_pullback' },
      pattern: { passed: false, weight: 0, value: 'not_used' },
      ema: { passed: true, weight: 1, value: 'ema50_vs_ema200' },
      smc: { passed: false, weight: 0, value: 'not_used' },
      volume: { passed: false, weight: 0, value: 'not_used' },
    },
    setupFingerprint: `TPB-${dir}`,
  };
}

module.exports = { compute, defaults, window, trailTf, shouldEval, usesHtf: false, name: '1H Trend Pullback (RSI 40/60)' };
