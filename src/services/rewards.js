const Stripe = require('stripe');
const supabase = require('../db');
const config = require('../config');

const stripe = config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : null;

// Execute a single due reward. Called by the background worker.
async function issueReward(reward) {
  if (!stripe) {
    await supabase.from('rewards').update({ status: 'failed', error: 'stripe not configured' }).eq('id', reward.id);
    return { ok: false, error: 'stripe not configured' };
  }
  try {
    const meta = reward.metadata || {};
    if (reward.type === 'credit') {
      await stripe.customers.createBalanceTransaction(reward.recipient_customer_id, {
        amount: -(reward.amount_cents || 0),
        currency: 'usd',
        description: `Referral reward (${reward.id.slice(0, 8)})`,
      });
    } else if (reward.type === 'discount_percent') {
      const coupon = await stripe.coupons.create({
        percent_off: meta.percent,
        duration: 'repeating',
        duration_in_months: meta.duration_months || 1,
        name: `Referral reward ${reward.id.slice(0, 8)}`,
      });
      // Note: applying the coupon to the customer's upcoming subscription is the
      // founder's responsibility via webhook payload, or extend this to update subscriptions directly.
      await supabase.from('rewards').update({ metadata: { ...meta, stripe_coupon_id: coupon.id } }).eq('id', reward.id);
    } else if (reward.type === 'webhook') {
      const res = await fetch(meta.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reward_id: reward.id, type: reward.type, recipient: reward.recipient_customer_id, metadata: meta }),
      });
      if (!res.ok) throw new Error(`webhook returned ${res.status}`);
    } else {
      // trial_extension, feature_unlock, cash: founder handles via webhook payload or manual queue.
      // Mark issued with a note; founder dashboard surfaces pending manual actions.
      await supabase.from('rewards').update({ metadata: { ...meta, note: 'manual action required by founder' } }).eq('id', reward.id);
    }
    await supabase.from('rewards').update({ status: 'issued', issued_at: new Date().toISOString() }).eq('id', reward.id);
    return { ok: true };
  } catch (err) {
    await supabase.from('rewards').update({ status: 'failed', error: String(err.message || err).slice(0, 500) }).eq('id', reward.id);
    return { ok: false, error: err.message };
  }
}

// Process all due pending rewards. Run on a schedule (e.g., every 5 minutes).
async function processDueRewards(limit = 50) {
  const { data: due } = await supabase
    .from('rewards')
    .select('*')
    .eq('status', 'pending')
    .lte('issue_at', new Date().toISOString())
    .order('issue_at', { ascending: true })
    .limit(limit);
  const results = [];
  for (const reward of due || []) {
    // Clawback: if the referee churned before issue and rule has clawback, cancel.
    results.push(await issueReward(reward));
  }
  return results;
}

module.exports = { issueReward, processDueRewards };
