/**
 * Break & Bounce (strategyId: 'bnb') — port of the "Break & Bounce [Raj]" Pine indicator.
 *
 * Self-contained (own ATR) so the same file works in the backtester and, later,
 * in src/strategy/ for the live bot.
 *
 * Rules (same as Pine):
 *   levels        previous UTC trading day's high/low (last day with bars, so Gold
 *                 on Monday uses Friday)
 *   breakout      a 15m candle closes beyond the level (the 5m bar opening at
 *                 :10/:25/:40/:55 completes a 15m bar)
 *   retest+confirm a later 5m candle touches the level (tolerance x ATR), closes on
 *                 the breakout side, and is a hammer/bullish engulfing (long) or
 *                 inverted hammer/bearish engulfing (short)
 *   cancel        15m close back through the level, or no setup within maxWait bars
 *   stop          beyond the confirmation candle + buffer, at least minStop x ATR
 *   target        rr x risk (used by Fixed RR; ignored by trailing)
 *   one setup per direction per day
 *
 * Stateless: each call replays today's bars to rebuild the day's breakout state.
 * Difference from Pine: Pine only consumes a setup while flat; here a setup is
 * consumed even if a position is open (the caller then skips it). Rarely matters.
 */

const DAY_MS = 86400000;

const defaults = {
  bnbTol: 0.1,
  bnbMaxWait: 36,
  bnbWickMult: 2.0,
  bnbSlBuf: 0.1,
  bnbMinStop: 0.5,
  bnbMaxStop: 3.0,
  bnbRR: 3.0,
};

// Needs the whole previous trading day plus today (and a weekend for Gold).
const window = 1500;

function atrSeries(c, p = 14) {
  const out = new Array(c.length);
  let prev = null;
  for (let i = 0; i < c.length; i++) {
    const tr = i === 0 ? c[i].h - c[i].l
      : Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
    prev = prev == null ? tr : (prev * (p - 1) + tr) / p;
    out[i] = prev;
  }
  return out;
}

function compute(candles, cfg) {
  const k = { ...defaults, ...(cfg || {}) };
  const n = candles.length;
  if (n < 50) return { signal: null, reason: 'warmup' };

  const dayOf = (x) => Math.floor(new Date(x.t).getTime() / DAY_MS);
  const today = dayOf(candles[n - 1]);

  // First bar of today, and the previous trading day's range
  let start = n - 1;
  while (start > 0 && dayOf(candles[start - 1]) === today) start--;
  if (start === 0) return { signal: null, reason: 'no_prev_day' };
  const prevDay = dayOf(candles[start - 1]);
  let pdh = -Infinity, pdl = Infinity, j = start - 1;
  while (j >= 0 && dayOf(candles[j]) === prevDay) {
    pdh = Math.max(pdh, candles[j].h);
    pdl = Math.min(pdl, candles[j].l);
    j--;
  }
  // If the window begins inside the previous day we have only part of its range.
  // Starting exactly at 00:00 UTC of that day is still complete.
  if (j < 0) {
    const t0 = new Date(candles[0].t).getTime();
    if (t0 !== prevDay * DAY_MS) return { signal: null, reason: 'prev_day_incomplete' };
  }

  const atr = atrSeries(candles, 14);
  let upBroken = false, upBar = -1, upDone = false;
  let dnBroken = false, dnBar = -1, dnDone = false;
  let result = null;

  for (let i = start; i < n; i++) {
    const b = candles[i], p = candles[i - 1], a = atr[i];
    const is15Close = new Date(b.t).getUTCMinutes() % 15 === 10;
    const isLast = i === n - 1;

    // Breakouts on 15m closes
    if (is15Close && !upBroken && !upDone && b.c > pdh) { upBroken = true; upBar = i; }
    if (is15Close && !dnBroken && !dnDone && b.c < pdl) { dnBroken = true; dnBar = i; }

    // Cancel failed / stale breakouts
    if (upBroken && !upDone && ((is15Close && b.c < pdh - k.bnbTol * a) || i - upBar > k.bnbMaxWait)) upDone = true;
    if (dnBroken && !dnDone && ((is15Close && b.c > pdl + k.bnbTol * a) || i - dnBar > k.bnbMaxWait)) dnDone = true;

    // Candle patterns
    const rng = b.h - b.l;
    const body = Math.abs(b.c - b.o);
    const upWick = b.h - Math.max(b.o, b.c);
    const lowWick = Math.min(b.o, b.c) - b.l;
    const bodyRef = Math.max(body, 0.1 * rng);
    const hammer = rng > 0 && lowWick >= k.bnbWickMult * bodyRef && upWick <= 0.25 * rng;
    const invHam = rng > 0 && upWick >= k.bnbWickMult * bodyRef && lowWick <= 0.25 * rng;
    const bullEng = b.c > b.o && p.c < p.o && b.c >= p.o && b.o <= p.c;
    const bearEng = b.c < b.o && p.c > p.o && b.c <= p.o && b.o >= p.c;

    // LONG: retest of PDH + bullish confirmation
    if (upBroken && !upDone && i > upBar && b.l <= pdh + k.bnbTol * a && b.c > pdh && (hammer || bullEng)) {
      upDone = true;
      const sl = Math.min(b.l - k.bnbSlBuf * a, b.c - k.bnbMinStop * a);
      const risk = b.c - sl;
      if (isLast && risk > 0 && risk <= k.bnbMaxStop * a) {
        result = { dir: 'LONG', entry: b.c, sl, tp: b.c + k.bnbRR * risk, a, pattern: hammer ? 'HAMMER' : 'ENGULF', level: pdh };
      }
    }

    // SHORT: retest of PDL + bearish confirmation (Pine checks this only if no long opened)
    if (!result && dnBroken && !dnDone && i > dnBar && b.h >= pdl - k.bnbTol * a && b.c < pdl && (invHam || bearEng)) {
      dnDone = true;
      const sl = Math.max(b.h + k.bnbSlBuf * a, b.c + k.bnbMinStop * a);
      const risk = sl - b.c;
      if (isLast && risk > 0 && risk <= k.bnbMaxStop * a) {
        result = { dir: 'SHORT', entry: b.c, sl, tp: b.c - k.bnbRR * risk, a, pattern: invHam ? 'INVHAMMER' : 'ENGULF', level: pdl };
      }
    }
  }

  if (!result) return { signal: null, reason: 'no_setup' };

  const last = candles[n - 1];
  return {
    signal: result.dir,
    time: last.t,
    entry: result.entry,
    sl: result.sl,
    tp1: result.tp, // single target: tp1 = tp2 so the bot exits fully at the target
    tp2: result.tp,
    atr: result.a,
    stage: result.dir === 'LONG' ? 'ADVANCING' : 'DECLINING',
    htfTrend: 'NA',
    adx: 0,
    bullScore: result.dir === 'LONG' ? 3 : 0,
    bearScore: result.dir === 'SHORT' ? 3 : 0,
    score: 3,
    oppScore: 0,
    netMargin: 3,
    confirmationCandle: true,
    checks: {
      stage: { passed: false, weight: 0, value: 'not_used' },
      aov: { passed: true, weight: 1, value: 'pdh_pdl_retest' },
      pattern: { passed: true, weight: 1, value: result.pattern.toLowerCase() },
      ema: { passed: false, weight: 0, value: 'not_used' },
      smc: { passed: true, weight: 1, value: 'level_break_15m' },
      volume: { passed: false, weight: 0, value: 'not_used' },
    },
    setupFingerprint: `BNB-${result.dir}-${result.pattern}`,
  };
}

module.exports = { compute, defaults, window, usesHtf: false, name: 'Break & Bounce (PDH/PDL retest)' };
