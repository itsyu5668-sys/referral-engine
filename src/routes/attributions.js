const express = require('express');
const supabase = require('../db');
const { scopedProgram } = require('../middleware/auth');

const router = express.Router();

// POST /v1/attributions  { program_id, referral_code, referred_customer_id, referred_email? }
// Called by the founder's backend on signup. Respects first_touch / last_touch per program.
router.post('/', async (req, res) => {
  const { program_id, referral_code, referred_customer_id, referred_email } = req.body || {};
  if (!program_id || !referral_code || !referred_customer_id) {
    return res.status(400).json({ error: 'program_id, referral_code and referred_customer_id are required' });
  }

  const program = await scopedProgram(program_id, req.workspace.id);
  if (!program) return res.status(404).json({ error: 'program not found' });

  const { data: link } = await supabase
    .from('referral_links')
    .select('id, referrer_customer_id')
    .eq('program_id', program_id)
    .eq('code', referral_code)
    .single();
  if (!link) return res.status(404).json({ error: 'referral code not found' });

  // Prevent self-referral
  if (link.referrer_customer_id === referred_customer_id) {
    return res.status(400).json({ error: 'self-referral not allowed' });
  }

  // Most recent click for fraud context (optional, best-effort)
  const { data: lastClick } = await supabase
    .from('clicks')
    .select('clicked_at, ip_hash')
    .eq('link_id', link.id)
    .order('clicked_at', { ascending: false })
    .limit(1)
    .single();

  const now = new Date();
  const expiresAt = new Date(now.getTime() + program.attribution_window_days * 86400000);
  const fraudFlags = [];
  if (lastClick && lastClick.ip_hash) {
    // Placeholder: cross-check IP against referrer's known IPs in a fuller implementation.
    fraudFlags.push('ip_logged');
  }

  const row = {
    program_id,
    link_id: link.id,
    referrer_customer_id: link.referrer_customer_id,
    referred_customer_id,
    referred_email: referred_email || null,
    clicked_at: lastClick ? lastClick.clicked_at : null,
    expires_at: expiresAt.toISOString(),
    fraud_flags: fraudFlags,
  };

  if (program.attribution_model === 'first_touch') {
    const { data: existing } = await supabase
      .from('attributions')
      .select('id')
      .eq('program_id', program_id)
      .eq('referred_customer_id', referred_customer_id)
      .limit(1)
      .single();
    if (existing) return res.json({ attribution: existing, created: false, note: 'first_touch kept existing attribution' });
  }

  // last_touch: upsert (replace any prior attribution for this referred customer)
  const { data, error } = await supabase
    .from('attributions')
    .upsert(row, { onConflict: 'program_id,referred_customer_id' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: 'failed to record attribution' });

  res.status(201).json({ attribution: data, created: true });
});

module.exports = router;
