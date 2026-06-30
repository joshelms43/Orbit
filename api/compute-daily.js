// ============================================================================
//  /api/compute-daily  — runs the Orbit engine over yesterday's real GPS and
//  writes one "closest moment" record per friend pair into daily_records.
//
//  Triggered automatically by Vercel Cron (see vercel.json), and can be hit
//  manually to backfill:   /api/compute-daily?key=YOUR_CRON_SECRET&days=5
//                          /api/compute-daily?key=YOUR_CRON_SECRET&day=2026-07-05
//
//  Needs these Environment Variables in Vercel (Project → Settings → Env Vars):
//    SUPABASE_URL                 (your project URL)
//    SUPABASE_SERVICE_ROLE_KEY    (service_role secret — server only, never shipped to the browser)
//    CRON_SECRET                  (any long random string; Vercel sends it as a Bearer token on cron)
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const { processDay, smoothFixes } = require('./_engine.js');

const TZ_OFFSET_MIN = 600; // Australia/Brisbane = UTC+10 (no daylight saving)

function brisbaneDayKey(instant) {           // YYYY-MM-DD for the Brisbane local day
  const local = new Date(instant.getTime() + TZ_OFFSET_MIN * 60000);
  return local.toISOString().slice(0, 10);
}
const dayStartEpoch = key => Date.parse(key + 'T00:00:00+10:00');

async function fetchFixes(sb, userId, startISO, endISO) {
  const { data, error } = await sb.from('locations')
    .select('recorded_at,lat,lng,accuracy')
    .eq('user_id', userId)
    .gte('recorded_at', startISO).lt('recorded_at', endISO)
    .order('recorded_at', { ascending: true })
    .limit(50000);
  if (error) throw error;
  return (data || []).map(p => ({ t: Date.parse(p.recorded_at), lat: p.lat, lng: p.lng, acc: p.accuracy }));
}

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    const secret = process.env.CRON_SECRET;
    const provided = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') || q.key;
    if (secret && provided !== secret) { res.status(401).json({ error: 'unauthorized' }); return; }

    const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) { res.status(500).json({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars' }); return; }
    const sb = createClient(url, key, { auth: { persistSession: false } });

    // which local days to compute
    let days = [];
    if (q.day) days = [String(q.day)];
    else {
      const n = Math.max(1, Math.min(31, parseInt(q.days || '1', 10)));
      const now = Date.now();
      for (let i = 1; i <= n; i++) days.push(brisbaneDayKey(new Date(now - i * 86400000)));
    }

    const { data: friendships, error: fe } = await sb.from('friendships').select('user_a,user_b');
    if (fe) { res.status(500).json({ error: fe.message }); return; }

    let written = 0, skipped = 0;
    for (const dayKey of days) {
      const startISO = new Date(dayStartEpoch(dayKey)).toISOString();
      const endISO = new Date(dayStartEpoch(dayKey) + 86400000).toISOString();
      const dayStart = dayStartEpoch(dayKey);

      for (const f of friendships || []) {
        const [fa, fb] = await Promise.all([
          fetchFixes(sb, f.user_a, startISO, endISO),
          fetchFixes(sb, f.user_b, startISO, endISO),
        ]);
        if (fa.length < 2 || fb.length < 2) { skipped++; continue; }

        const r = processDay(smoothFixes(fa), smoothFixes(fb));   // me = user_a, them = user_b
        if (!isFinite(r.closest)) { skipped++; continue; }

        let closestMin = Math.floor((r.closestT - dayStart) / 60000);
        closestMin = ((closestMin % 1440) + 1440) % 1440;

        const row = {
          user_a: f.user_a, user_b: f.user_b, day: dayKey,
          closest_m: r.closest,
          closest_t: new Date(r.closestT).toISOString(),
          closest_min: closestMin,
          replay: r.replay.map(p => ({ t: p.t, a: p.me, b: p.them })),
          closest_index: r.closestIndexInReplay,
          a_start_idx: r.meStartIdx, b_start_idx: r.themStartIdx,
          computed_at: new Date().toISOString(),
        };
        const { error: ue } = await sb.from('daily_records').upsert(row, { onConflict: 'user_a,user_b,day' });
        if (ue) { skipped++; } else { written++; }
      }
    }
    res.status(200).json({ ok: true, days, friendships: (friendships || []).length, written, skipped });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
};
