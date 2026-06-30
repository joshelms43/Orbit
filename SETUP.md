# Orbit — going live (no terminal needed)

Everything here is done in a browser: Supabase dashboard + GitHub + Vercel. Same flow you used for Spot Logger / OddsLab.

## 1. Supabase (the database + login)
1. Create a project at supabase.com → **New project**. Pick a region near you (Sydney).
2. Open **SQL Editor → New query**, paste the whole of `db/schema.sql`, hit **Run**. (Safe to re-run anytime.)
3. **Project Settings → API**: copy the **Project URL** and the **anon / public** key. (Also copy the **service_role** key — you'll need it for Vercel in step 3. Keep that one secret.)
4. **Authentication → Providers → Email** is on by default. That's all you need — Orbit signs people in with a magic link, no passwords.

## 2. Point the app at your project
1. Rename `config.example.js` → **`config.js`**.
2. Paste your **Project URL** and **anon key** into it. (The anon key is safe in the browser — Row-Level Security stops anyone reading anyone else's raw GPS.)

## 3. Deploy (GitHub → Vercel)
1. Push this whole `orbit-app/` folder to a GitHub repo.
2. In Vercel → **Add New → Project → Import** that repo. Framework preset: **Other**. Deploy.
3. In Vercel → **Project → Settings → Environment Variables**, add three (these power the nightly compute job, server-side only):
   - `SUPABASE_URL` — your Project URL
   - `SUPABASE_SERVICE_ROLE_KEY` — the **service_role** secret from step 1.3
   - `CRON_SECRET` — any long random string you make up
4. **Redeploy** so the env vars take effect.

Done. `vercel.json` already schedules `/api/compute-daily` to run every morning (06:00 your time) and write yesterday's "closest moment" for every friend pair.

## 4. Use it
- Open your Vercel URL on your phone → enter email → tap the link it sends → set your name.
- Tap the **account button** (top-right) → share your invite code with a friend, or paste theirs.
- Leave the app open while you go about your day so it logs location. The reveal for a given day shows up the next morning.

### Force a compute now (for testing / backfill)
Visit, in a browser:
```
https://YOUR-APP.vercel.app/api/compute-daily?key=YOUR_CRON_SECRET&days=5
```
That recomputes the last 5 days for all pairs immediately. Refresh the app to see records appear.

## What's real vs. what's next
- **Real now:** accounts, friends, your real GPS logging, server-side closest-approach computed by your exact engine, the full reveal/home/records/replay UI on live data.
- **The one honest gap:** the web can only log location **while the app is open** (iOS blocks background geolocation for web entirely). True passive all-day tracking needs a native app — that's the next build, and the whole backend here carries straight over to it.

## Notes
- No `config.js` present? The app automatically runs on the built-in demo data, so it always loads.
- Privacy model: `locations` (raw fixes) are readable only by you. The only thing shared with a friend is the computed `daily_records` row for the two of you — the closest distance, the time, and the short convergence path for the replay.
