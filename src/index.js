import http from 'http';
import cron from 'node-cron';
import { computeFlows } from './compute_flows.js';
import { refreshAddresses } from './refresh_addresses.js';
import { startHeartbeat, setStatus } from './heartbeat.js';

const PORT = process.env.PORT || 8080;
const SERVICE_NAME = 'bls-cex-flow-bot';

console.log(`[${SERVICE_NAME}] starting at ${new Date().toISOString()}`);

// Validate env (don't exit on missing — keep server up so /health is reachable)
const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'BITQUERY_API_KEY'];
const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`[startup] missing env vars: ${missing.join(', ')}`);
}

// HTTP server FIRST so Railway healthcheck doesn't fail before crons start
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: missing.length ? 'starting' : 'ok',
      service: SERVICE_NAME,
      uptime_seconds: process.uptime(),
      missing_env: missing,
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
server.listen(PORT, () => console.log(`[server] listening on :${PORT}`));

if (missing.length) {
  console.error('[startup] cannot start crons due to missing env');
} else {
  startHeartbeat();

  // Hourly compute at minute :05 of each hour (queries previous full hour)
  cron.schedule('5 * * * *', async () => {
    console.log('[cron] hourly compute starting');
    try {
      await computeFlows();
      console.log('[cron] hourly compute done');
    } catch (e) {
      console.error('[cron compute] error:', e.message);
      await setStatus('error', `compute_flows: ${e.message.slice(0, 200)}`);
    }
  });

  // Sunday 5am UTC: refresh CEX address list
  cron.schedule('0 5 * * 0', async () => {
    console.log('[cron] weekly address refresh');
    try {
      await refreshAddresses();
    } catch (e) {
      console.error('[cron refresh] error:', e.message);
    }
  });

  // Run compute once 5s after boot for immediate signal
  setTimeout(async () => {
    console.log('[boot] initial compute run');
    try {
      await computeFlows();
    } catch (e) {
      console.error('[boot compute] error:', e.message);
      await setStatus('error', `boot compute: ${e.message.slice(0, 200)}`);
    }
  }, 5000);

  console.log('[startup] crons scheduled — hourly :05 + weekly Sun 5am UTC');
}

// Graceful shutdown
process.on('SIGTERM', () => { console.log('[shutdown] SIGTERM'); server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { console.log('[shutdown] SIGINT');  server.close(() => process.exit(0)); });
