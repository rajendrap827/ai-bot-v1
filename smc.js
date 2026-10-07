/**
 * Guardeer SMC (strategyId: 'smc') - bias + liquidity sweep + BOS + order-block retest.
 *
 * PRE-REGISTERED 2026-10-07, before any result was seen. Do not tune after testing.
 *
 *   timeframe  15m built from the 5m feed; evaluated when a 15m bar completes
 *   swings     pivot high/low with 3 bars each side (confirmed 3 bars later)
 *   bias       bullish = last swing high > previous AND last swing low > previous
 *              bearish = mirror
 *   sweep      (long) bias bullish, a bar trades below the last swing low but
 *              closes back above it
 *   BOS        within 20 bars (5h): a close above the last swing high (as of the sweep)
 *   OB         last bearish candle between the sweep and the BOS (sweep bar if none)
 *   entry      within 24 bars (6h) of BOS: a bar touches the OB (low <= OB high)
 *              and closes above OB low -> enter at that close
 *   invalid    a close below the sweep low (before BOS) or below OB low (after BOS)
 *   stop       OB low - 0.1 x ATR(15m), at least 0.5 ATR away, skip if > 3 ATR
 *   target     2R (Fixed RR). Trailing mode trails on ATR(15m).
 *   short      mirror. One trade per setup.
 */

const T15 = 15 * 60000;

const defaults = {
  smcPiv: 3,
  smcMaxBos: 20,
  smcMaxRetrace: 24,
  smcSlBuf: 0.1,
  smcMinStop: 0.5,
  smcMaxStop: 3.0,
  smcRR: 2.0,
};

const window = 2400; // 5m bars = ~200 hours = ~800 15m bars
const trailTf = 15;

function shouldEval(bar) {
  return new Date(bar.t).getUTCMinutes() % 15 === 10;
}

function to15(c5) {
  const out = [];
  let cur = null;
  for (const b of c5) {
    const key = Math.floor(new Date(b.t).getTime() / T15) * T15;
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

function isPivH(b, i, L) {
  for (let k = i - L; k <= i + L; k++) {
    if (k === i) continue;
    if (k < i ? b[k].h >= b[i].h : b[k].h > b[i].h) return false;
  }
  return true;
}
function isPivL(b, i, L) {
  for (let k = i - L; k <= i + L; k++) {
    if (k === i) continue;
    if (k < i ? b[k].l <= b[i].l : b[k].l < b[i].l) return false;
  }
  return true;
}

function compute(candles, cfg) {
  const k = { ...defaults, ...(cfg || {}) };
  const last = candles[candles.length - 1];
  if (!shouldEval(last)) return { signal: null, reason: 'not_15m_close' };

  const b = to15(candles);
  const n = b.length;
  const L = k.smcPiv;
  if (n < 60) return { signal: null, reason: 'warmup' };
  const a = atr(b, 14);

  const highs = []; // confirmed swing highs {i, p}
  const lows = [];
  let bull = { phase: 0 };
  let bear = { phase: 0 };
  let result = null;

  for (let i = 0; i < n; i++) {
    const x = b[i];
    const c = i - L;
    if (c >= L) {
      if (isPivH(b, c, L)) highs.push({ i: c, p: b[c].h });
      if (isPivL(b, c, L)) lows.push({ i: c, p: b[c].l });
    }
    const isLast = i === n - 1;
    const h1 = highs[highs.length - 1], h0 = highs[highs.length - 2];
    const l1 = lows[lows.length - 1], l0 = lows[lows.length - 2];
    const biasBull = h0 && l0 && h1.p > h0.p && l1.p > l0.p;
    const biasBear = h0 && l0 && h1.p < h0.p && l1.p < l0.p;

    // ── Bullish setup ──
    if (bull.phase === 2) {
      if (i - bull.bosBar > k.smcMaxRetrace || x.c < bull.obLow) bull = { phase: 0 };
      else if (i > bull.bosBar && x.l <= bull.obHigh && x.c > bull.obLow) {
        const sl = Math.min(bull.obLow - k.smcSlBuf * a[i], x.c - k.smcMinStop * a[i]);
        const risk = x.c - sl;
        if (isLast && risk > 0 && risk <= k.smcMaxStop * a[i]) result = { dir: 'LONG', entry: x.c, sl, tp: x.c + k.smcRR * risk, a: a[i] };
        bull = { phase: 0 };
      }
    } else if (bull.phase === 1) {
      if (i - bull.sweepBar > k.smcMaxBos || x.c < bull.sweepLow) bull = { phase: 0 };
      else if (x.c > bull.bosLevel) {
        let ob = bull.sweepBar;
        for (let j = i - 1; j >= bull.sweepBar; j--) if (b[j].c < b[j].o) { ob = j; break; }
        bull = { phase: 2, bosBar: i, obHigh: b[ob].h, obLow: b[ob].l };
      }
    }
    if (bull.phase === 0 && biasBull && x.l < l1.p && x.c > l1.p && h1.p > x.c) {
      bull = { phase: 1, sweepBar: i, sweepLow: x.l, bosLevel: h1.p };
    }

    // ── Bearish setup (mirror) ──
    if (bear.phase === 2) {
      if (i - bear.bosBar > k.smcMaxRetrace || x.c > bear.obHigh) bear = { phase: 0 };
      else if (i > bear.bosBar && x.h >= bear.obLow && x.c < bear.obHigh) {
        const sl = Math.max(bear.obHigh + k.smcSlBuf * a[i], x.c + k.smcMinStop * a[i]);
        const risk = sl - x.c;
        if (isLast && !result && risk > 0 && risk <= k.smcMaxStop * a[i]) result = { dir: 'SHORT', entry: x.c, sl, tp: x.c - k.smcRR * risk, a: a[i] };
        bear = { phase: 0 };
      }
    } else if (bear.phase === 1) {
      if (i - bear.sweepBar > k.smcMaxBos || x.c > bear.sweepHigh) bear = { phase: 0 };
      else if (x.c < bear.bosLevel) {
        let ob = bear.sweepBar;
        for (let j = i - 1; j >= bear.sweepBar; j--) if (b[j].c > b[j].o) { ob = j; break; }
        bear = { phase: 2, bosBar: i, obHigh: b[ob].h, obLow: b[ob].l };
      }
    }
    if (bear.phase === 0 && biasBear && x.h > h1.p && x.c < h1.p && l1.p < x.c) {
      bear = { phase: 1, sweepBar: i, sweepHigh: x.h, bosLevel: l1.p };
    }
  }

  if (!result) return { signal: null, reason: 'no_setup' };
  const long = result.dir === 'LONG';
  return {
    signal: result.dir,
    time: last.t,
    entry: result.entry,
    sl: result.sl,
    tp1: result.tp,
    tp2: result.tp,
    atr: result.a,
    stage: long ? 'ADVANCING' : 'DECLINING',
    htfTrend: 'NA',
    adx: 0,
    bullScore: long ? 4 : 0,
    bearScore: long ? 0 : 4,
    score: 4,
    oppScore: 0,
    netMargin: 4,
    confirmationCandle: true,
    checks: {
      stage: { passed: true, weight: 1, value: long ? 'structure_bull' : 'structure_bear' },
      aov: { passed: true, weight: 1, value: 'order_block_retest' },
      pattern: { passed: false, weight: 0, value: 'not_used' },
      ema: { passed: false, weight: 0, value: 'not_used' },
      smc: { passed: true, weight: 1, value: 'sweep_then_bos' },
      volume: { passed: false, weight: 0, value: 'not_used' },
    },
    setupFingerprint: `SMC-${result.dir}`,
  };
}

module.exports = { compute, defaults, window, trailTf, shouldEval, usesHtf: false, name: 'Guardeer SMC (sweep + BOS + OB, 15m)' };
