# Backtester (read-only)

Replays a strategy over Exness 5m candles. Never writes to the bot's database,
no restart needed, the live bot keeps running.

Install (from ~/ai-bot-v1):
  git pull && unzip -o backtest.zip && cp -r backtest scalp-bot/backend/

Download history once (180 days, BTC ETH GOLD -> backtest/data/*.json):
  cd ~/ai-bot-v1/scalp-bot/backend && node backtest/fetch_history.js --days=180

Run:
  node backtest/run.js --strategy=bnb --spread=GOLD:0.2,BTC:15,ETH:1.5

Options: --assets=GOLD,BTC  --from=YYYY-MM-DD  --to=YYYY-MM-DD  --trail=2
         --trailStart=0  --db=false
Strategies: backtest/strategies/<id>.js (bnb, tpb), or any registry id (babalu, mmt, default).
1H strategies (tpb) trail on 1H ATR automatically.
Spreads are rough guesses unless you pass real ones from the MT5 app.
