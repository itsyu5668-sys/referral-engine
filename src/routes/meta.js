const express = require('express');
const config = require('../config');

const router = express.Router();

// GET /v1/meta -> deployment info for the dashboard (auth required)
router.get('/', (req, res) => {
  res.json({
    service: 'referral-engine-api',
    version: '0.2.0',
    api_base_url: config.baseUrl,
    stripe_configured: !!(config.stripeSecretKey && config.stripeWebhookSecret),
    webhook_url: `${config.baseUrl}/v1/webhooks/stripe`,
  });
});

module.exports = router;
