const express = require('express');
const Stripe = require('stripe');
const supabase = require('../db');
const config = require('../config');
const { evaluateRules } = require('../services/rules');

const router = express.Router();
const stripe = config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : null;

// Stripe sends raw body; signature verified here.
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !config.stripeWebhookSecret) {
    return res.status(500).json({ error: 'stripe not configured' });
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], config.stripeWebhookSecret);
  } catch (err) {
    return res.status(400).json({ error: 'invalid signature' });
  }

  try {
    if (event.type === 'invoice.paid') {
      await handleInvoicePaid(event.data.object);
    } else if (event.type === 'customer.subscription.deleted') {
      await handleSubscriptionDeleted(event.data.object);
    }
  } catch (err) {
    console.error('webhook handler error:', err);
    return res.status(500).json({ error: 'handler failed' });
  }
  res.json({ received: true });
});

async function handleInvoicePaid(invoice) {
  const stripeCustomerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer.id;

  // Find active attribution for this Stripe customer (founder maps their customer IDs to Stripe IDs).
  const { data: attribution } = await supabase
    .from('attributions')
    .select('*, programs!inner(id)')
    .eq('referred_customer_id', stripeCustomerId)
    .eq('status', 'active')
    .gt('expires_at', new Date().toISOString())
    .order('attributed_at', { ascending: false })
    .limit(1)
    .single();
  if (!attribution) return;

  // Only the first paid invoice counts as the conversion.
  const { data: existing } = await supabase
    .from('conversions')
    .select('id')
    .eq('attribution_id', attribution.id)
    .limit(1)
    .single();
  const isFirst = !existing;

  const mrrCents = invoice.lines && invoice.lines.data && invoice.lines.data[0]
    ? (invoice.lines.data[0].amount || 0)
    : (invoice.amount_paid || 0);

  let conversionId = existing ? existing.id : null;
  if (isFirst) {
    const { data: conv } = await supabase
      .from('conversions')
      .insert({
        attribution_id: attribution.id,
        stripe_customer_id: stripeCustomerId,
        mrr_cents: mrrCents,
        plan_id: (invoice.lines && invoice.lines.data[0] && invoice.lines.data[0].price && invoice.lines.data[0].price.id) || null,
      })
      .select()
      .single();
    conversionId = conv.id;
    await supabase.from('attributions').update({ status: 'converted' }).eq('id', attribution.id);
  }

  const context = {
    conversion_id: conversionId,
    referrer: { customer_id: attribution.referrer_customer_id },
    referee: { customer_id: attribution.referred_customer_id, email: attribution.referred_email },
    mrr_cents: mrrCents,
    plan: (invoice.lines && invoice.lines.data[0] && invoice.lines.data[0].price && invoice.lines.data[0].price.nickname) || null,
    is_first_payment: isFirst,
  };

  // Fire payment-triggered rules now; retained_days rules are evaluated by the scheduler.
  await evaluateRules({ program_id: attribution.program_id, trigger: 'referee.first_payment', context });
  if (isFirst) {
    await evaluateRules({ program_id: attribution.program_id, trigger: 'referee.signup', context });
  }
}

async function handleSubscriptionDeleted(subscription) {
  const stripeCustomerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
  const { data: conv } = await supabase
    .from('conversions')
    .select('id, attribution_id')
    .eq('stripe_customer_id', stripeCustomerId)
    .order('first_paid_at', { ascending: false })
    .limit(1)
    .single();
  if (!conv) return;
  await supabase.from('conversions').update({ status: 'churned' }).eq('id', conv.id);

  // Clawback: cancel pending rewards whose rule has clawback_days covering this churn.
  const { data: pending } = await supabase
    .from('rewards')
    .select('id, rule_id, created_at, reward_rules!inner(clawback_days)')
    .eq('conversion_id', conv.id)
    .eq('status', 'pending');
  for (const r of pending || []) {
    const clawbackDays = (r.reward_rules && r.reward_rules.clawback_days) || 0;
    if (clawbackDays > 0) {
      const ageDays = (Date.now() - new Date(r.created_at).getTime()) / 86400000;
      if (ageDays <= clawbackDays) {
        await supabase.from('rewards').update({ status: 'cancelled', error: 'clawback: referee churned' }).eq('id', r.id);
      }
    }
  }
}

module.exports = router;
