#!/usr/bin/env node
/**
 * Backtest runner — replays a strategy over stored 5m candles and reports both
 * exit modes (Fixed RR and Trailing only), using the same simulation rules as the
 * Pine indicators:
 *   - entry at the signal candle's close
 *   - exits checked from the next candle; stop first if a candle hits both
 *   - a candle opening beyond the stop exits at the open
 *   - trailing stop = best price since entry -/+ N x ATR, moved at candle close,
 *     only tightens, never looser than the initial stop
 *   - one open trade per asset
 *
 * READ-ONLY: it never writes to the database and does not touch the running bot.
 *
 * Usage (from ~/ai-bot-v1/scalp-bot/backend):
 *   node backtest/run.js --strategy=bnb
 *   node backtest/run.js --strategy=bnb --assets=GOLD --from=2026-05-01 --to=2026-08-31
 *   node backtest/run.js --strategy=bnb --spread=GOLD:0.2,BTC:15,ETH:1.5 --trail=2
 *
 * Strategies: a file in backtest/strategies/<id>.js, or any id in src/strategy/registry.js.
 * Candles: backtest/data/<ASSET>_5m.json (from fetch_history.js) merged with the live
 * `candles` collection.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ASSETS_ALL = ['BTC', 'ETH', 'GOLD'];

// Rough Exness Standard spreads in price units. CHECK these in the MT5 app and pass
// --spread=... with real values: they decide whether a small edge survives.
const DEFAULT_SPREAD = { GOLD: 0.2, BTC: 15, ETH: 1.5 };

function loadEnv() {
  const p = path.join(ROOT, '.env');
  const env = {};
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
  return env;
}

function parseArgs(argv) {
  const a = {};
  for (const s of argv) {
    const m = s.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) a[m[1]] = m[2] === undefined ? true : m[2];
  }
  return a;
}

function norm(c) {
  return { t: new Date(c.t), o: +c.o, h: +c.h, l: +c.l, c: +c.c, v: +(c.v || 0) };
}

async function loadCandles(asset, db) {
  const byT = new Map();
  const file = path.join(__dirname, 'data', `${asset}_5m.json`);
  let fromFile = 0, fromDb = 0;
  if (fs.existsSync(file)) {
    for (const c of JSON.parse(fs.readFileSync(file, 'utf8'))) { byT.set(new Date(c.t).getTime(), norm(c)); fromFile++; }
  }
  if (db) {
    const docs = await db.collection('candles').find({ asset, timeframe: '5m' })
      .project({ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1, _id: 0 }).toArray();
    for (const d of docs) { byT.set(new Date(d.t).getTime(), norm(d)); fromDb++; }
  }
  const sorted = [...byT.entries()].sort((x, y) => x[0] - y[0]).map(([, c]) => c);

  // Same sanity rule as the live candle guard: drop bars that jump > 5% from the last kept close
  const out = [];
  let dropped = 0;
  for (const c of sorted) {
    if (![c.o, c.h, c.l, c.c].every(Number.isFinite) || c.h < c.l) { dropped++; continue; }
    const prev = out[out.length - 1];
    if (prev && Math.abs(c.c - prev.c) / prev.c > 0.05) { dropped++; continue; }
    out.push(c);
  }
  return { candles: out, fromFile, fromDb, dropped };
}

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

// 1H trend (last CLOSED hour's close vs EMA50 of hourly closes), for strategies that use it
function htfSeries(c, len = 50) {
  const H = 3600000;
  const hours = [];
  for (const b of c) {
    const key = Math.floor(b.t.getTime() / H) * H;
    const last = hours[hours.length - 1];
    if (!last || last.key !== key) hours.push({ key, close: b.c });
    else last.close = b.c;
  }
  const k = 2 / (len + 1);
  let e = null;
  for (const h of hours) { e = e == null ? h.close : h.close * k + e * (1 - k); h.ema = e; }
  const out = new Array(c.length);
  let hi = -1;
  for (let i = 0; i < c.length; i++) {
    const barEnd = c[i].t.getTime() + 5 * 60000;
    while (hi + 1 < hours.length && hours[hi + 1].key + H <= barEnd) hi++;
    out[i] = hi >= len ? { bull: hours[hi].close > hours[hi].ema, bear: hours[hi].close < hours[hi].ema } : { bull: null, bear: null };
  }
  return out;
}

function tfAtrSeries(c, tfMin, p = 14) {
  if (tfMin <= 5) return atrSeries(c, p);
  const T = tfMin * 60000;
  const bars = [];
  for (const b of c) {
    const key = Math.floor(b.t.getTime() / T) * T;
    const last = bars[bars.length - 1];
    if (!last || last.key !== key) bars.push({ key, h: b.h, l: b.l, c: b.c });
    else { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; }
  }
  const a = atrSeries(bars, p);
  const out = new Array(c.length);
  let bi = -1;
  for (let i = 0; i < c.length; i++) {
    const end = c[i].t.getTime() + 5 * 60000;
    while (bi + 1 < bars.length && bars[bi + 1].key + T <= end) bi++;
    out[i] = bi >= 0 ? a[bi] : atrSeries([c[i]], p)[0];
  }
  return out;
}

function loadStrategy(id) {
  const local = path.join(__dirname, 'strategies', `${id}.js`);
  if (fs.existsSync(local)) {
    const m = require(local);
    return { id, name: m.name || id, compute: m.compute, defaults: m.defaults || {}, usesHtf: !!m.usesHtf, window: m.window || 600, shouldEval: m.shouldEval, trailTf: m.trailTf || 5 };
  }
  const { getStrategy, allStrategyIds } = require(path.join(ROOT, 'src', 'strategy', 'registry'));
  if (!allStrategyIds().includes(id)) throw new Error(`unknown strategy "${id}" (not in backtest/strategies or registry)`);
  const s = getStrategy(id);
  return { id, name: s.name || id, compute: s.compute, defaults: s.defaults || {}, usesHtf: !!s.usesHtf, window: 400, trailTf: 5 };
}

function signalsFor(c, strat, asset, from, to) {
  const htf = strat.usesHtf ? htfSeries(c) : null;
  const sigs = new Array(c.length).fill(null);
  // Start early and pass whatever history exists; each strategy reports its own warmup.
  for (let i = 50; i < c.length; i++) {
    const t = c[i].t.getTime();
    if (t < from || t > to) continue;
    if (strat.shouldEval && !strat.shouldEval(c[i])) continue; // e.g. hourly strategies
    const win = c.slice(Math.max(0, i - strat.window + 1), i + 1);
    const s = strat.compute(win, { ...strat.defaults }, asset, htf ? htf[i] : undefined);
    if (s && s.signal && Number.isFinite(s.entry) && Number.isFinite(s.sl)) sigs[i] = s;
  }
  return sigs;
}

function simulate(c, atr, sigs, mode, trailMult, trailStart, to) {
  const trades = [];
  let pos = null;
  for (let i = 0; i < c.length; i++) {
    const b = c[i];
    if (pos && i > pos.eBar) {
      let exit = null;
      let hitTarget = false;
      if (pos.dir === 1) {
        if (b.l <= pos.trail) exit = b.o < pos.trail ? b.o : pos.trail;
        else if (mode === 'fixed' && b.h >= pos.tp) { exit = pos.tp; hitTarget = true; }
      } else {
        if (b.h >= pos.trail) exit = b.o > pos.trail ? b.o : pos.trail;
        else if (mode === 'fixed' && b.l <= pos.tp) { exit = pos.tp; hitTarget = true; }
      }
      if (exit !== null) {
        const r = (pos.dir === 1 ? exit - pos.e : pos.e - exit) / pos.risk;
        trades.push({ entryT: pos.t, exitT: b.t, dir: pos.dir, r, risk: pos.risk, hitTarget, fp: pos.fp });
        pos = null;
      } else if (mode === 'trail') {
        if (pos.dir === 1) {
          pos.extreme = Math.max(pos.extreme, b.h);
          if ((pos.extreme - pos.e) / pos.risk >= trailStart) pos.trail = Math.max(pos.trail, pos.extreme - trailMult * atr[i]);
        } else {
          pos.extreme = Math.min(pos.extreme, b.l);
          if ((pos.e - pos.extreme) / pos.risk >= trailStart) pos.trail = Math.min(pos.trail, pos.extreme + trailMult * atr[i]);
        }
      }
    }
    if (!pos && sigs[i]) {
      const s = sigs[i];
      const dir = s.signal === 'LONG' ? 1 : -1;
      const risk = Math.abs(s.entry - s.sl);
      const tp = Number.isFinite(s.tp1) ? s.tp1 : s.entry + dir * 2 * risk;
      if (risk > 0) pos = { dir, e: s.entry, risk, tp, trail: s.sl, extreme: s.entry, eBar: i, t: c[i].t, fp: s.setupFingerprint || '' };
    }
    if (c[i].t.getTime() > to && !pos) break;
  }
  return { trades, open: pos };
}

function fmt(x, d = 2, sign = true) {
  if (!Number.isFinite(x)) return '-';
  const s = x.toFixed(d);
  return sign && x > 0 ? '+' + s : s;
}

function report(trades, spread) {
  const n = trades.length;
  if (!n) return { n: 0, lines: ['no trades'] };
  const rs = trades.map((t) => t.r);
  const net = trades.map((t) => t.r - spread / t.risk);
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r <= 0);
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const total = sum(rs);
  const totalNet = sum(net);
  const sortedDesc = [...rs].sort((a, b) => b - a);
  const top3 = sum(sortedDesc.slice(0, 3));
  const avgRisk = sum(trades.map((t) => t.risk)) / n;

  const months = {};
  trades.forEach((t, i) => {
    const m = t.exitT.toISOString().slice(0, 7);
    months[m] = months[m] || { n: 0, net: 0 };
    months[m].n++;
    months[m].net += net[i];
  });

  const lines = [
    `trades ${n}  win ${(100 * wins.length / n).toFixed(1)}%`,
    `avg win ${fmt(wins.length ? sum(wins) / wins.length : NaN)}  avg loss ${fmt(losses.length ? sum(losses) / losses.length : NaN)}`,
    `total ${fmt(total)}R  avg ${fmt(total / n, 3)}R`,
    `NET of spread: total ${fmt(totalNet)}R  avg ${fmt(totalNet / n, 3)}R`,
    `best ${fmt(sortedDesc[0])}R  w/o best 3: avg ${n > 3 ? fmt((total - top3) / (n - 3), 3) + 'R' : '-'}`,
    `avg stop ${avgRisk.toPrecision(5)}  spread ${spread} = ${(spread / avgRisk).toFixed(3)}R/trade`,
    'month    n   net avgR',
    ...Object.keys(months).sort().map((m) => `${m}  ${String(months[m].n).padStart(3)}  ${fmt(months[m].net / months[m].n, 3)}`),
  ];
  return { n, total, totalNet, lines };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.strategy) {
    console.log('usage: node backtest/run.js --strategy=<id> [--assets=BTC,ETH,GOLD] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--spread=GOLD:0.2,BTC:15,ETH:1.5] [--trail=2] [--trailStart=0] [--db=false]');
    process.exit(1);
  }
  const env = loadEnv();
  const assets = args.assets ? String(args.assets).toUpperCase().split(',') : ASSETS_ALL;
  const from = args.from ? new Date(args.from + 'T00:00:00Z').getTime() : -Infinity;
  const to = args.to ? new Date(args.to + 'T23:59:59Z').getTime() : Infinity;
  const trailMult = args.trail ? parseFloat(args.trail) : 2.0;
  const trailStart = args.trailStart ? parseFloat(args.trailStart) : 0;
  const spread = { ...DEFAULT_SPREAD };
  if (args.spread) for (const kv of String(args.spread).split(',')) { const [k, v] = kv.split(':'); spread[k.toUpperCase()] = parseFloat(v); }

  const strat = loadStrategy(args.strategy);

  // Database is optional: if it can't be reached, run on the downloaded files only.
  let db = null, mongoose = null;
  if (args.db !== 'false') {
    try {
      mongoose = require('mongoose');
      const uri = env.MONGO_URI || env.MONGODB_URI || 'mongodb://localhost:27017/scalpbot?replicaSet=rs0';
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 4000 });
      db = mongoose.connection.db;
    } catch (err) {
      console.log(`[db] not used (${err.message.split('\n')[0]}) - files only`);
      db = null;
    }
  }

  console.log(`\n### ${strat.name} [${strat.id}]  trail ${trailMult} x ATR(${strat.trailTf}m), start ${trailStart}R`);
  const combined = { fixed: [], trail: [] };

  for (const asset of assets) {
    const { candles, fromFile, fromDb, dropped } = await loadCandles(asset, db);
    if (candles.length < 300) { console.log(`\n== ${asset}: not enough candles (${candles.length})`); continue; }
    const atr = tfAtrSeries(candles, strat.trailTf);
    const sigs = signalsFor(candles, strat, asset, from, to);
    const first = candles[0].t.toISOString().slice(0, 10);
    const last = candles[candles.length - 1].t.toISOString().slice(0, 10);
    console.log(`\n== ${asset}  ${first} -> ${last}  bars ${candles.length} (file ${fromFile}, db ${fromDb}, dropped ${dropped})`);
    for (const mode of ['fixed', 'trail']) {
      const { trades, open } = simulate(candles, atr, sigs, mode, trailMult, trailStart, to);
      const rep = report(trades, spread[asset] || 0);
      console.log(`-- ${mode === 'fixed' ? 'Fixed RR' : 'Trailing only'}${open ? '  (1 still open, not counted)' : ''}`);
      rep.lines.forEach((l) => console.log('   ' + l));
      trades.forEach((t) => combined[mode].push({ ...t, cost: (spread[asset] || 0) / t.risk }));
    }
  }

  console.log('\n== ALL ASSETS COMBINED');
  for (const mode of ['fixed', 'trail']) {
    const t = combined[mode];
    if (!t.length) { console.log(`   ${mode}: no trades`); continue; }
    const tot = t.reduce((s, x) => s + x.r, 0);
    const net = t.reduce((s, x) => s + x.r - x.cost, 0);
    console.log(`   ${mode === 'fixed' ? 'Fixed   ' : 'Trailing'}  n ${t.length}  avg ${fmt(tot / t.length, 3)}R  net ${fmt(net / t.length, 3)}R`);
  }
  console.log('\nPass bar: net avg >= +0.10R combined, positive on every asset, positive in 2+ months.');

  if (mongoose) await mongoose.disconnect().catch(() => {});
}

main().catch((err) => {
  console.error('backtest failed:', err.message);
  process.exit(1);
});
