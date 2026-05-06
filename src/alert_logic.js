import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ABS_THRESHOLD = parseFloat(process.env.ALERT_THRESHOLD_USD || '5000000');
const PCT_THRESHOLD = parseFloat(process.env.ALERT_THRESHOLD_PCT_DAILY_AVG || '20');
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_CEX_FLOW;

export async function checkAndAlert(rows, hour) {
  if (!WEBHOOK_URL) {
    console.warn('[alert] DISCORD_WEBHOOK_CEX_FLOW not set — skipping alerts');
    return;
  }
  if (!rows?.length) return;

  for (const row of rows) {
    const net = (row.inflow_usd || 0) - (row.outflow_usd || 0);
    const absNet = Math.abs(net);

    let shouldAlert = false;
    let reason = '';

    if (absNet >= ABS_THRESHOLD) {
      shouldAlert = true;
      reason = `abs threshold ($${(absNet / 1e6).toFixed(2)}M >= $${(ABS_THRESHOLD / 1e6).toFixed(1)}M)`;
    } else {
      const avg = await get7DayDailyAverage(row.exchange, row.asset);
      if (avg && Math.abs(absNet / avg) >= PCT_THRESHOLD / 100) {
        shouldAlert = true;
        reason = `${((absNet / avg) * 100).toFixed(0)}% of 7d daily avg ($${(avg / 1e6).toFixed(2)}M)`;
      }
    }

    if (shouldAlert) {
      await postDiscordAlert({ row, net, reason, hour });
    }
  }
}

async function get7DayDailyAverage(exchange, asset) {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await sb
    .from('cex_flow_hourly')
    .select('net_flow_usd')
    .eq('exchange', exchange)
    .eq('asset', asset)
    .gte('hour', since);

  if (error || !data?.length) return null;
  const totalAbs = data.reduce((s, r) => s + Math.abs(parseFloat(r.net_flow_usd) || 0), 0);
  return totalAbs / 7;
}

async function postDiscordAlert({ row, net, reason, hour }) {
  const direction = net >= 0 ? 'INFLOW' : 'OUTFLOW';
  const color = net >= 0 ? 0xff5555 : 0x00ff7f; // red inflow (bearish), green outflow (bullish)
  const sign = net >= 0 ? '+' : '-';
  const interpretation = interpret(row.exchange, row.asset, net);

  const embed = {
    title: `🐋 CEX FLOW ALERT — ${row.exchange.toUpperCase()}`,
    color,
    fields: [
      { name: 'Asset', value: `${row.asset} (${row.chain})`, inline: true },
      { name: 'Direction', value: direction, inline: true },
      { name: 'Net Flow', value: `${sign}$${(Math.abs(net) / 1e6).toFixed(2)}M`, inline: true },
      { name: 'Inflow',  value: `$${(row.inflow_usd  / 1e6).toFixed(2)}M / ${row.inflow_tx_count} tx`,  inline: true },
      { name: 'Outflow', value: `$${(row.outflow_usd / 1e6).toFixed(2)}M / ${row.outflow_tx_count} tx`, inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: 'Trigger', value: reason, inline: false },
      { name: 'Interpretation', value: interpretation, inline: false },
    ],
    footer: { text: `Hour: ${hour.toISOString()} • bls-cex-flow-bot` },
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[alert] Discord ${res.status}: ${text.slice(0, 200)}`);
    } else {
      console.log(`[alert] sent: ${row.exchange} ${row.asset} ${direction} $${(Math.abs(net) / 1e6).toFixed(1)}M`);
    }
  } catch (e) {
    console.error('[alert] post error:', e.message);
  }
}

function interpret(exchange, asset, net) {
  if (['USDT', 'USDC', 'DAI'].includes(asset)) {
    if (net > 0) return `Stablecoin INFLOW to ${exchange} — historically bearish (deposits often precede selling)`;
    return `Stablecoin OUTFLOW from ${exchange} — historically bullish (withdrawing dry powder, often to buy)`;
  }
  if (['WETH', 'WBTC', 'ETH', 'BTC'].includes(asset)) {
    if (net > 0) return `${asset} INFLOW to ${exchange} — historically bearish (often precedes sell-off)`;
    return `${asset} OUTFLOW from ${exchange} — historically bullish (HODLer accumulation pattern)`;
  }
  return `${asset} ${net > 0 ? 'INFLOW' : 'OUTFLOW'} on ${exchange}`;
}
