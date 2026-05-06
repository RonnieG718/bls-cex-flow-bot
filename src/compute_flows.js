import { createClient } from '@supabase/supabase-js';
import { bitqueryQueryWithRetry } from './bitquery_client.js';
import { checkAndAlert } from './alert_logic.js';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Major asset contracts to track on Ethereum mainnet
const TRACKED_TOKENS = {
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
  '0x6b175474e89094c44da98b954eedeac495271d0f': 'DAI',
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH',
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 'WBTC',
};
const TRACKED_CONTRACTS = Object.keys(TRACKED_TOKENS);

// Bitquery v2 EAP query — aggregated transfer data per (cex_address, currency)
// Single query gets both inflow + outflow for all 5 tokens across all CEX addresses
const QUERY = `
  query CexFlow($cexAddresses: [String!], $tokens: [String!], $since: DateTime, $until: DateTime) {
    EVM(network: eth, dataset: combined) {
      inflow: Transfers(
        where: {
          Block: { Time: { since: $since, till: $until } }
          Transfer: {
            Receiver: { in: $cexAddresses }
            Currency: { SmartContract: { in: $tokens } }
            AmountInUSD: { gt: "1000" }
          }
        }
        limit: { count: 50000 }
      ) {
        Transfer {
          Receiver
          Currency { Symbol SmartContract }
        }
        sum: sum(of: Transfer_AmountInUSD)
        count
      }
      outflow: Transfers(
        where: {
          Block: { Time: { since: $since, till: $until } }
          Transfer: {
            Sender: { in: $cexAddresses }
            Currency: { SmartContract: { in: $tokens } }
            AmountInUSD: { gt: "1000" }
          }
        }
        limit: { count: 50000 }
      ) {
        Transfer {
          Sender
          Currency { Symbol SmartContract }
        }
        sum: sum(of: Transfer_AmountInUSD)
        count
      }
    }
  }
`;

export async function computeFlows() {
  // 1. Pull active Ethereum CEX addresses
  const { data: addresses, error: addrErr } = await sb
    .from('cex_addresses')
    .select('address, exchange')
    .eq('chain', 'ethereum')
    .eq('is_active', true);

  if (addrErr) throw new Error(`Address fetch: ${addrErr.message}`);
  if (!addresses?.length) {
    console.warn('[compute_flows] no active ETH CEX addresses');
    return { rows: 0 };
  }

  const addressList = addresses.map(a => a.address.toLowerCase());
  const addrToExchange = Object.fromEntries(
    addresses.map(a => [a.address.toLowerCase(), a.exchange])
  );

  console.log(`[compute_flows] ${addressList.length} addresses across ${new Set(addresses.map(a => a.exchange)).size} exchanges`);

  // 2. Time window: previous full hour
  const until = new Date();
  until.setMinutes(0, 0, 0);
  const since = new Date(until.getTime() - 60 * 60 * 1000);

  console.log(`[compute_flows] window: ${since.toISOString()} -> ${until.toISOString()}`);

  // 3. Query Bitquery
  let data;
  try {
    data = await bitqueryQueryWithRetry(QUERY, {
      cexAddresses: addressList,
      tokens: TRACKED_CONTRACTS,
      since: since.toISOString(),
      until: until.toISOString(),
    });
  } catch (e) {
    console.error('[compute_flows] Bitquery query failed:', e.message);
    throw e;
  }

  if (!data?.EVM) {
    console.error('[compute_flows] empty data — query may have failed silently');
    console.error('[compute_flows] raw:', JSON.stringify(data).slice(0, 400));
    return { rows: 0 };
  }

  // 4. Aggregate by (exchange, asset)
  const aggregates = new Map();

  function ensure(exchange, asset) {
    const k = `${exchange}|${asset}`;
    if (!aggregates.has(k)) {
      aggregates.set(k, {
        exchange, asset, chain: 'ethereum',
        inflow_usd: 0, outflow_usd: 0,
        inflow_tx_count: 0, outflow_tx_count: 0,
      });
    }
    return aggregates.get(k);
  }

  for (const row of (data.EVM.inflow || [])) {
    const cexAddr = row?.Transfer?.Receiver?.toLowerCase?.();
    const exchange = cexAddr ? addrToExchange[cexAddr] : null;
    if (!exchange) continue;
    const symbol = row?.Transfer?.Currency?.Symbol || 'UNKNOWN';
    const agg = ensure(exchange, symbol);
    agg.inflow_usd += parseFloat(row.sum) || 0;
    agg.inflow_tx_count += parseInt(row.count) || 0;
  }

  for (const row of (data.EVM.outflow || [])) {
    const cexAddr = row?.Transfer?.Sender?.toLowerCase?.();
    const exchange = cexAddr ? addrToExchange[cexAddr] : null;
    if (!exchange) continue;
    const symbol = row?.Transfer?.Currency?.Symbol || 'UNKNOWN';
    const agg = ensure(exchange, symbol);
    agg.outflow_usd += parseFloat(row.sum) || 0;
    agg.outflow_tx_count += parseInt(row.count) || 0;
  }

  // 5. Upsert to Supabase
  const rows = [...aggregates.values()].map(agg => ({
    hour: since.toISOString(),
    exchange: agg.exchange,
    asset: agg.asset,
    chain: 'ethereum',
    inflow_usd: Math.round(agg.inflow_usd * 100) / 100,
    outflow_usd: Math.round(agg.outflow_usd * 100) / 100,
    inflow_tx_count: agg.inflow_tx_count,
    outflow_tx_count: agg.outflow_tx_count,
    data_source: 'bitquery',
  }));

  if (!rows.length) {
    console.log('[compute_flows] zero-flow hour');
    return { rows: 0 };
  }

  const { error: insErr } = await sb
    .from('cex_flow_hourly')
    .upsert(rows, { onConflict: 'hour,exchange,asset,chain' });

  if (insErr) throw new Error(`Insert: ${insErr.message}`);

  console.log(`[compute_flows] upserted ${rows.length} (exchange, asset) rows`);

  // 6. Threshold check + Discord alert
  await checkAndAlert(rows, since);

  return { rows: rows.length };
}

// CLI: `node src/compute_flows.js` runs once
if (import.meta.url === `file://${process.argv[1]}`) {
  computeFlows()
    .then(r => { console.log('done', r); process.exit(0); })
    .catch(e => { console.error('error', e); process.exit(1); });
}
