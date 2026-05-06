import { createClient } from '@supabase/supabase-js';

const SERVICE_NAME = 'bls-cex-flow-bot';
const HEARTBEAT_MS = 15 * 60 * 1000; // 15 minutes
const EXPECTED_INTERVAL_SECONDS = 900;

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function beat() {
  const now = new Date().toISOString();
  try {
    // Update first to preserve first_heartbeat_at on existing rows
    const { data: updated, error: updErr } = await sb
      .from('service_health')
      .update({
        last_heartbeat_at: now,
        status: 'ok',
        expected_interval_seconds: EXPECTED_INTERVAL_SECONDS,
        notes: null,
      })
      .eq('service_name', SERVICE_NAME)
      .select();

    if (updErr) {
      console.error('[heartbeat] update error:', updErr.message);
      return;
    }

    // No row existed — insert with first_heartbeat_at
    if (!updated || updated.length === 0) {
      const { error: insErr } = await sb.from('service_health').insert({
        service_name: SERVICE_NAME,
        first_heartbeat_at: now,
        last_heartbeat_at: now,
        status: 'ok',
        expected_interval_seconds: EXPECTED_INTERVAL_SECONDS,
      });
      if (insErr) console.error('[heartbeat] insert error:', insErr.message);
      else console.log('[heartbeat] first beat recorded');
    }
  } catch (e) {
    console.error('[heartbeat] exception:', e.message);
  }
}

export function startHeartbeat() {
  beat();
  setInterval(beat, HEARTBEAT_MS);
  console.log(`[heartbeat] scheduled every ${HEARTBEAT_MS / 60000}min`);
}

export async function setStatus(status, notes = null) {
  try {
    await sb
      .from('service_health')
      .update({ status, notes, last_heartbeat_at: new Date().toISOString() })
      .eq('service_name', SERVICE_NAME);
  } catch (e) {
    console.error('[heartbeat setStatus] error:', e.message);
  }
}
