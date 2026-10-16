const express = require('express');
const cors = require('cors');
const config = require('./config');
const { auth } = require('./middleware/auth');
const { processDueRewards } = require('./services/rewards');

const app = express();
app.use(cors());

// Stripe webhooks need the raw body: mount before express.json(), no auth (signature-verified)
app.use('/v1/webhooks/stripe', require('./routes/webhooks'));

app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, service: 'referral-engine-api' }));

// Everything under /v1 (except webhooks above) requires auth:
// Bearer <Supabase JWT> from the dashboard, or Bearer vouch_<key> for server-to-server.
app.use('/v1/workspaces', auth, require('./routes/workspaces'));
app.use('/v1/api-keys', auth, require('./routes/apiKeys'));
app.use('/v1/meta', auth, require('./routes/meta'));
app.use('/v1/programs', auth, require('./routes/programs'));
app.use('/v1/referral-links', auth, require('./routes/links'));
app.use('/v1/attributions', auth, require('./routes/attributions'));
app.use('/r', require('./routes/track'));

app.use((req, res) => res.status(404).json({ error: 'not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

// Background worker: issue due rewards every 60s.
// On Render free tier this runs in-process; move to a cron worker at scale.
setInterval(async () => {
  try {
    const results = await processDueRewards();
    if (results.length) console.log(`[worker] processed ${results.length} due rewards`);
  } catch (err) {
    console.error('[worker] error:', err);
  }
}, 60000);

app.listen(config.port, () => {
  console.log(`referral-engine-api listening on :${config.port}`);
});
