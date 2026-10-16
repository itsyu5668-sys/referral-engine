const express = require('express');
const supabase = require('../db');

const router = express.Router();

// GET /v1/programs/:id/stats -> dashboard numbers
router.get('/:id/stats', async (req, res) => {
  const { id } = req.params;
  const [[, links], [, clicks], [, attributions], [, conversions], [, rewards]] = await Promise.all([
    supabase.from('referral_links').select('id', { count: 'exact', head: true }).eq('program_id', id),
    supabase.from('clicks').select('id, referral_links!inner(program_id)', { count: 'exact', head: true }).eq('referral_links.program_id', id),
    supabase.from('attributions').select('id', { count: 'exact', head: true }).eq('program_id', id),
    supabase.from('conversions').select('id,mrr_cents', { count: 'exact' }).eq('attributions.program_id', id),
    supabase.from('rewards').select('id,status,amount_cents', { count: 'exact' }).eq('program_id', id),
  ]);

  const attributedMrr = (conversions || []).reduce((s, c) => s + (c.mrr_cents || 0), 0);
  const byStatus = {};
  for (const r of rewards || []) byStatus[r.status] = (byStatus[r.status] || 0) + 1;

  res.json({
    links: links ?? 0,
    clicks: clicks ?? 0,
    signups: attributions ?? 0,
    conversions: conversions ? conversions.length : 0,
    attributed_mrr_cents: attributedMrr,
    rewards_by_status: byStatus,
  });
});

// POST /v1/programs  { name, owner_id, attribution_window_days? }
router.post('/', async (req, res) => {
  const { name, owner_id, attribution_window_days } = req.body || {};
  if (!name || !owner_id) return res.status(400).json({ error: 'name and owner_id required' });
  const { data, error } = await supabase
    .from('programs')
    .insert({ name, owner_id, attribution_window_days: attribution_window_days || 30 })
    .select()
    .single();
  if (error) return res.status(500).json({ error: 'failed to create program' });
  res.status(201).json({ program: data });
});

// POST /v1/programs/:id/rules  { name, trigger, trigger_config, conditions, actions, ... }
router.post('/:id/rules', async (req, res) => {
  const { id } = req.params;
  const { name, trigger, trigger_config, conditions, actions, clawback_days, priority } = req.body || {};
  if (!name || !trigger || !actions) return res.status(400).json({ error: 'name, trigger and actions required' });
  const { data, error } = await supabase
    .from('reward_rules')
    .insert({
      program_id: id, name, trigger,
      trigger_config: trigger_config || {},
      conditions: conditions || [],
      actions,
      clawback_days: clawback_days || 0,
      priority: priority || 0,
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: 'failed to create rule' });
  res.status(201).json({ rule: data });
});

module.exports = router;
