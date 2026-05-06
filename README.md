# bls-cex-flow-bot

Tracks CEX deposit/withdrawal flows via Bitquery. Stores hourly aggregated 
inflow/outflow per (exchange, asset) in Supabase. Posts Discord alerts when 
net flow breaches thresholds.

## What this fills

Existing BLS stack signals: HL perp whales, DEX swaps via Bitquery, technical 
breakouts, pre-spike whale signatures. **Missing piece:** real-time CEX flow. 
Large stablecoin outflows from exchanges are historically bullish (whales 
withdrawing dry powder); large inflows are bearish (whales depositing to sell).

## Architecture

| Job | Schedule | What |
|---|---|---|
| Heartbeat | every 15min | Upsert to `service_health` table |
| Hourly compute | `5 * * * *` | Query Bitquery for transfers to/from CEX wallets, aggregate by (exchange, asset), upsert to `cex_flow_hourly`, post Discord alerts on threshold breaches |
| Weekly refresh | `0 5 * * 0` (Sun 5am UTC) | Log address counts (v1). v2: auto-discover new CEX addresses via Etherscan |

## Schema (already applied to Supabase)

Migration: `cex_flow_and_entity_label_foundation` (May 4, 2026)

- `cex_addresses` — known exchange wallet addresses (57 seeded across 11 exchanges)
- `cex_flow_hourly` — hourly aggregated flow per (exchange, asset)
- `wallet_entity_labels` — multi-source entity identity (for future enrichment)
- `vw_wallet_best_label`, `vw_tracked_wallets_with_entity` — helper views

## Tracked tokens (Ethereum mainnet)

- USDT, USDC, DAI (stablecoins — primary signal)
- WETH, WBTC (large-cap proxies)

Solana hot wallets are seeded but Bitquery query path for SOL is not yet 
implemented. v2 work.

## Environment variables

| Var | Required | Notes |
|---|---|---|
| `BITQUERY_API_KEY` | yes | Your existing Bitquery account key |
| `SUPABASE_URL` | yes | `https://wvmlotamldkwgcyrwgxb.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | From Supabase project settings |
| `DISCORD_WEBHOOK_CEX_FLOW` | yes | Create webhook in #cex-flow-alerts channel |
| `ALERT_THRESHOLD_USD` | no | Default `5000000` ($5M abs) |
| `ALERT_THRESHOLD_PCT_DAILY_AVG` | no | Default `20` (20% of 7d daily avg) |
| `ETHERSCAN_API_KEY` | no | Free tier; only used in v2 weekly refresh |
| `PORT` | no | Railway sets this. Default 8080 for local dev. |

## Deploy to Railway (step-by-step)

### Step 1 — Create Discord webhook

1. In your BLS Discord server, create a new channel `#cex-flow-alerts`
2. Channel Settings → Integrations → Webhooks → New Webhook
3. Name it `BLS CEX Flow Alerts`, copy the webhook URL
4. Save the URL — you'll paste it as `DISCORD_WEBHOOK_CEX_FLOW` in Step 3

### Step 2 — Create Railway service

```bash
# Option A: via Railway CLI
railway login
railway init                                    # link to new project
railway service create bls-cex-flow-bot
railway link                                    # link this directory to the service

# Option B: via Railway dashboard
# 1. railway.com/dashboard → New Project → Deploy from GitHub repo
# 2. Pick: RonnieG718/bls-cex-flow-bot
# 3. Railway auto-detects Node.js + railway.json
```

### Step 3 — Set environment variables (CRITICAL — must be done before deploy)

```bash
railway variables --set BITQUERY_API_KEY="..." \
                  --set SUPABASE_URL="https://wvmlotamldkwgcyrwgxb.supabase.co" \
                  --set SUPABASE_SERVICE_ROLE_KEY="sb_secret_..." \
                  --set DISCORD_WEBHOOK_CEX_FLOW="https://discord.com/api/webhooks/..." \
                  --set ALERT_THRESHOLD_USD="5000000" \
                  --set ALERT_THRESHOLD_PCT_DAILY_AVG="20"
```

Or paste them in the Railway dashboard under Variables.

### Step 4 — Deploy

```bash
railway up
```

### Step 5 — Verify

Check the Railway logs. You should see:

```
[bls-cex-flow-bot] starting at 2026-05-04T...
[server] listening on :8080
[heartbeat] scheduled every 15min
[heartbeat] first beat recorded
[startup] crons scheduled — hourly :05 + weekly Sun 5am UTC
[boot] initial compute run
[compute_flows] 49 addresses across 11 exchanges
[compute_flows] window: ... -> ...
[compute_flows] upserted N (exchange, asset) rows
```

Then run these SQL checks in Supabase:

```sql
-- Heartbeat is alive
SELECT * FROM service_health WHERE service_name='bls-cex-flow-bot';

-- Flow data is being recorded
SELECT * FROM cex_flow_hourly ORDER BY hour DESC LIMIT 10;

-- Eyeball the most recent net flows
SELECT exchange, asset, hour, net_flow_usd, inflow_tx_count, outflow_tx_count
FROM cex_flow_hourly
WHERE hour > NOW() - INTERVAL '4 hours'
ORDER BY ABS(net_flow_usd) DESC
LIMIT 20;
```

## Validation period (4 weeks)

Track signal quality before treating as production:

1. Did large stablecoin outflows precede positive price moves on universe symbols?
2. Did large stablecoin inflows precede negative moves?
3. Hit rate vs random — backtest against `spike_alerts` table
4. False positive rate during low-volatility periods

After 4 weeks, run this validation query:

```sql
-- Did CEX flow alerts predict subsequent price moves?
-- (Custom view to be built once we have 4 weeks of data)
```

If signal validates, integrate into:
- `bls-morning-briefing` (add CEX flow summary section)
- `bls-spikebot-*` (filter spike alerts by CEX flow regime)
- `bls-dashboard` (new "CEX Flow" panel)

If signal does NOT validate, kill the service and pocket the Bitquery points.

## Cost estimate

| Resource | Estimated monthly |
|---|---|
| Bitquery points | ~50–150 pts/hour × 720 hours = 36–108K pts/mo |
| Railway compute | ~$5–10 (small Node service) |
| Supabase storage | <100 MB hourly data — negligible |
| Discord webhook | Free |

**Total marginal cost:** ~$5–10/mo + Bitquery points (you have +30K grant cushion).

## Local development

```bash
git clone https://github.com/RonnieG718/bls-cex-flow-bot
cd bls-cex-flow-bot
cp .env.example .env                            # then fill in values
npm install
npm run compute                                 # run compute_flows once
npm start                                       # full service with crons
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `service_health` not updating | Heartbeat error — check logs for Supabase auth |
| `cex_flow_hourly` empty | Bitquery query failure — check logs for `Bitquery HTTP` or GraphQL errors |
| No Discord alerts | Webhook not set OR thresholds too high. Check logs for `[alert]` |
| Bitquery 429 / rate limit | Service auto-retries with backoff. If persistent, reduce frequency |
| Empty boot run, hourly works | Boot runs partial-hour data; this is by design (queries previous *full* hour) |

## File layout

```
bls-cex-flow-bot/
├── src/
│   ├── index.js                  # Entry: HTTP server + cron schedules
│   ├── heartbeat.js              # service_health upsert every 15min
│   ├── bitquery_client.js        # GraphQL wrapper with retry
│   ├── compute_flows.js          # Hourly: query + aggregate + insert + alert
│   ├── alert_logic.js            # Threshold detection + Discord post
│   └── refresh_addresses.js      # Weekly stub (v2: Etherscan/Dune integration)
├── package.json
├── railway.json
├── .env.example
├── .gitignore
└── README.md
```

## Related BLS infrastructure

- **Dashboard:** [bls-dashboard-lime.vercel.app](https://bls-dashboard-lime.vercel.app)
- **Sister services:** `bls-spikebot-*`, `bls-whale-bot`, `bls-pattern-scanner`
- **DB project:** Supabase `wvmlotamldkwgcyrwgxb`
- **Brief author:** Claude (May 4, 2026 multi-agent build session)

## Status

- [x] Schema migration applied
- [x] CEX address seed data loaded (57 addresses, 11 exchanges)
- [x] Source code committed
- [ ] Railway service created
- [ ] Env vars set
- [ ] First successful deploy
- [ ] First successful flow data captured
- [ ] First Discord alert posted (will only fire on threshold breach)
- [ ] 4-week validation complete
