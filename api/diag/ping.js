// ---- TEMPORARY diagnostic route (2026-08-16) -- NOT part of the app,
// added purely to compare Vercel function region candidates against real
// Google API latency without needing a logged-in session (deliberately
// bypasses withDrive/OAuth -- see PROGRESS.md's region-testing entry for
// why). Hits a real, public, unauthenticated Google endpoint (the Drive v3
// discovery doc) 3 times and reports each round trip plus which region
// actually executed (`process.env.VERCEL_REGION`, set automatically by the
// platform at runtime).
//
// DELETE THIS FILE once region testing is done -- it counts against the
// Hobby plan's 12-function cap for zero ongoing value once the region
// question is settled. See PROGRESS.md.
module.exports = async function handler(req, res) {
  const target = 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest';
  const results = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    try {
      const r = await fetch(target);
      await r.text();
      results.push(Date.now() - t0);
    } catch (e) {
      results.push('error: ' + (e && e.message));
    }
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    region: process.env.VERCEL_REGION || 'unknown',
    target,
    pingsMs: results
  }));
};
