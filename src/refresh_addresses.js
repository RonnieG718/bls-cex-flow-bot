import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY;

/**
 * Weekly job to discover new CEX wallets and refresh existing labels.
 *
 * v1: stub — logs current address counts.
 * v2: scrape Etherscan tagged-address pages for major exchanges and upsert.
 *
 * Manual seed in cex_addresses table is the v1 source of truth (~57 addresses
 * across 11 exchanges, applied via cex_flow_and_entity_label_foundation migration).
 */
export async function refreshAddresses() {
  console.log('[refresh_addresses] v1 stub — manual seed is source of truth');

  const { data, error } = await sb
    .from('cex_addresses')
    .select('exchange, chain, is_active');

  if (error) {
    console.error('[refresh_addresses] query error:', error.message);
    return;
  }

  const byExchange = (data || []).reduce((m, r) => {
    const k = `${r.exchange}:${r.chain}`;
    m[k] = (m[k] || 0) + (r.is_active ? 1 : 0);
    return m;
  }, {});

  console.log('[refresh_addresses] active address counts:', byExchange);

  if (!ETHERSCAN_KEY) {
    console.log('[refresh_addresses] ETHERSCAN_API_KEY not set — auto-refresh disabled');
    return;
  }

  // TODO v2: Etherscan does not expose tagged-address lists via API directly.
  // Two options:
  //   1. Scrape https://etherscan.io/accounts/label/{exchange-name} HTML pages
  //   2. Query Dune Analytics labels table (requires Dune API key, free tier exists)
  // Both are deferred until v1 signal validation completes.
  console.log('[refresh_addresses] auto-refresh not implemented in v1');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  refreshAddresses()
    .then(() => process.exit(0))
    .catch(e => { console.error(e); process.exit(1); });
}
