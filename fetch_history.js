#!/usr/bin/env node
/**
 * Downloads 5m history from MetaApi (the same Exness feed the bot uses) into
 * backtest/data/<ASSET>_5m.json. It does NOT write to the bot's database and does
 * not touch the running bot's connection.
 *
 * Usage (from ~/ai-bot-v1/scalp-bot/backend):
 *   node backtest/fetch_history.js              # 180 days, BTC ETH GOLD
 *   node backtest/fetch_history.js --days=365 --assets=GOLD
 *
 * Re-running merges with what is already saved, so it can be resumed.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, tries = 3) {
  let last;
  for (let k = 0; k < tries; k++) {
    try { return await fn(); } catch (err) { last = err; await sleep(2000 * (k + 1)); }
  }
  throw last;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const days = args.days ? parseInt(args.days, 10) : 180;
  const assets = args.assets ? String(args.assets).toUpperCase().split(',') : ['BTC', 'ETH', 'GOLD'];
  const symbols = {
    BTC: env.SYMBOL_BTC || 'BTCUSDm',
    ETH: env.SYMBOL_ETH || 'ETHUSDm',
    GOLD: env.SYMBOL_GOLD || 'XAUUSDm',
  };
  if (!env.METAAPI_TOKEN || !env.METAAPI_ACCOUNT_ID) {
    console.error('METAAPI_TOKEN / METAAPI_ACCOUNT_ID missing in .env');
    process.exit(1);
  }

  const MetaApi = require('metaapi.cloud-sdk').default;
  const api = new MetaApi(env.METAAPI_TOKEN);
  const account = await api.metatraderAccountApi.getAccount(env.METAAPI_ACCOUNT_ID);
  const cutoff = Date.now() - days * 86400000;
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });

  for (const asset of assets) {
    const symbol = symbols[asset];
    const file = path.join(__dirname, 'data', `${asset}_5m.json`);
    const byT = new Map();
    if (fs.existsSync(file)) for (const c of JSON.parse(fs.readFileSync(file, 'utf8'))) byT.set(new Date(c.t).getTime(), c);

    let start; // undefined = most recent; MetaApi loads backwards from start
    let calls = 0;
    console.log(`\n[${asset}] ${symbol}: fetching back to ${new Date(cutoff).toISOString().slice(0, 10)}`);
    while (calls < 500) {
      const batch = await withRetry(() => account.getHistoricalCandles(symbol, '5m', start, 1000));
      calls++;
      if (!batch || !batch.length) { console.log(`[${asset}] no more history from broker`); break; }
      let minT = Infinity;
      for (const x of batch) {
        const t = new Date(x.time).getTime();
        minT = Math.min(minT, t);
        byT.set(t, { t: new Date(t).toISOString(), o: x.open, h: x.high, l: x.low, c: x.close, v: x.tickVolume || 0 });
      }
      process.stdout.write(`[${asset}] batch ${calls}: back to ${new Date(minT).toISOString().slice(0, 16)}  total ${byT.size}\n`);
      if (minT <= cutoff) break;
      const next = new Date(minT - 1000);
      if (start && next.getTime() >= start.getTime()) { console.log(`[${asset}] broker returned no older data`); break; }
      start = next;
      await sleep(300);
    }

    const out = [...byT.entries()].filter(([t]) => t >= cutoff).sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    fs.writeFileSync(file, JSON.stringify(out));
    const first = out.length ? out[0].t.slice(0, 10) : '-';
    const last = out.length ? out[out.length - 1].t.slice(0, 10) : '-';
    console.log(`[${asset}] saved ${out.length} bars  ${first} -> ${last}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('fetch failed:', err.message);
  process.exit(1);
});
