// Bitquery GraphQL client (v2 EAP endpoint with v1 fallback)
// Docs: https://docs.bitquery.io/docs/start/getting-started/

const BITQUERY_V2_ENDPOINT = 'https://streaming.bitquery.io/graphql';
const BITQUERY_V1_ENDPOINT = 'https://graphql.bitquery.io';

/**
 * Send GraphQL query to Bitquery.
 * Sets both Authorization Bearer (v2) + X-API-KEY (v1) headers
 * since most accounts have both styles working.
 */
export async function bitqueryQuery(query, variables = {}, options = {}) {
  const apiKey = process.env.BITQUERY_API_KEY;
  if (!apiKey) throw new Error('BITQUERY_API_KEY env var not set');

  const endpoint = options.useV1 ? BITQUERY_V1_ENDPOINT : BITQUERY_V2_ENDPOINT;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'X-API-KEY': apiKey,
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Bitquery HTTP ${res.status}: ${text.slice(0, 400)}`);
  }

  const json = await res.json();
  if (json.errors && json.errors.length) {
    throw new Error(`Bitquery GraphQL errors: ${JSON.stringify(json.errors).slice(0, 400)}`);
  }

  return json.data;
}

/**
 * Retry wrapper with exponential backoff for transient failures.
 */
export async function bitqueryQueryWithRetry(query, variables = {}, options = {}, maxRetries = 3) {
  let lastErr;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await bitqueryQuery(query, variables, options);
    } catch (e) {
      lastErr = e;
      const isTransient = /5\d\d|timeout|network|rate/i.test(e.message);
      if (!isTransient) throw e;
      const wait = Math.min(1000 * Math.pow(2, i), 10000);
      console.warn(`[bitquery] retry ${i + 1}/${maxRetries} after ${wait}ms — ${e.message.slice(0, 100)}`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}
