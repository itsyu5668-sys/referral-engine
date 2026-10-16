const express = require('express');
const supabase = require('../db');
const { scopedProgram } = require('../middleware/auth');

const router = express.Router();

function slugify(name) {
  return (name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'program';
}

async function programCounts(programId) {
  const { count: links } = await supabase
    .from('referral_links').select('id', { count: 'exact', head: true }).eq('program_id', programId);
  const { count: signups } = await supabase
    .from('attributions').select('id', { count: 'exact', head: true }).eq('program_id', programId);
  const { count: conversions } = await supabase
    .from('conversions')
    .select('id, attributions!inner(program_id)', { count: 'exact', head: true })
    .eq('attributions.program_id', programId);
  return { links: links || 0, signups: signups || 0, conversions: conversions || 0 };
}

// GET /v1/programs -> list with summary counts
router.get('/', async (req, res) => {
  const { data: programs, error } = await supabase
    .from('programs')
    .select('*')
    .eq('workspace_id', req.workspace.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'failed to list programs' });
  const out = [];
  for (const p of programs || []) {
    out.push({ ...p, counts: await programCounts(p.id) });
  }
  res.json({ programs: out });
});

// POST /v1/programs  { name, slug?, description?, redirect_url?, attribution_window_days?, attribution_model? }
router.post('/', async (req, res) => {
  const { name, slug, description, redirect_url, attribution_window_days, attribution_model } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });

  let finalSlug = (slug || slugify(name)).toLowerCase();
  // Ensure uniqueness within the workspace
  for (let i = 0; i < 10; i++) {
    const { data: clash } = await supabase
      .from('programs').select('id')
      .eq('workspace_id', req.workspace.id).eq('slug', finalSlug).limit(1).single();
    if (!clash) break;
    finalSlug = `${slugify(name)}-${Math.floor(Math.random() * 9000 + 1000)}`;
  }

  const { data, error } = await supabase
    .from('programs')
    .insert({
      name: name.trim(),
      slug: finalSlug,
      description: description || null,
      redirect_url: redirect_url || null,
      owner_id: req.workspace.owner_id,
      workspace_id: req.workspace.id,
      attribution_window_days: attribution_window_days || 30,
      attribution_model: ['first_touch', 'last_touch'].includes(attribution_model) ? attribution_model : 'last_touch',
      status: 'active',
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: 'failed to create program' });
  res.status(201).json({ program: data });
});

// GET /v1/programs/:id -> single program with counts
router.get('/:id', async (req, res) => {
  const program = await scopedProgram(req.params.id, req.workspace.id);
  if (!program) return res.status(404).json({ error: 'program not found' });
  res.json({ program: { ...program, counts: await programCounts(program.id) } });
});

// PATCH /v1/programs/:id  { name?, description?, redirect_url?, status?, attribution_window_days?, attribution_model? }
router.patch('/:id', async (req, res) => {
  const program = await scopedProgram(req.params.id, req.workspace.id);
  if (!program) return res.status(404).json({ error: 'program not found' });
  const allowed = ['name', 'description', 'redirect_url', 'status', 'attribution_window_days', 'attribution_model'];
  const updates = {};
  for (const k of allowed) if (req.body && req.body[k] !== undefined) updates[k] = req.body[k];
  if (updates.status && !['active', 'paused', 'archived'].includes(updates.status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'nothing to update' });
  const { data, error } = await supabase
    .from('programs').update(updates).eq('id', program.id).select().single();
  if (error) return res.status(500).json({ error: 'update failed' });
  res.json({ program: data });
});

// GET /v1/programs/:id/stats -> dashboard numbers (scoped)
router.get('/:id/stats', async (req, res) => {
  const program = await scopedProgram(req.params.id, req.workspace.id);
  if (!program) return res.status(404).json({ error: 'program not found' });
  const id = program.id;

  const { count: linkCount } = await supabase
    .from('referral_links').select('id', { count: 'exact', head: true }).eq('program_id', id);
  const { count: signupCount } = await supabase
    .from('attributions').select('id', { count: 'exact', head: true }).eq('program_id', id);

  const { data: linkRows } = await supabase.from('referral_links').select('id').eq('program_id', id);
  const linkIds = (linkRows || []).map((r) => r.id);
  let clickCount = 0;
  if (linkIds.length) {
    const { count } = await supabase.from('clicks')
      .select('id', { count: 'exact', head: true }).in('link_id', linkIds);
    clickCount = count || 0;
  }

  const { data: conversions } = await supabase
    .from('conversions').select('id,mrr_cents,attributions!inner(program_id)')
    .eq('attributions.program_id', id);
  const { data: rewards } = await supabase
    .from('rewards').select('id,status,amount_cents').eq('program_id', id);

  const attributedMrr = (conversions || []).reduce((s, c) => s + (c.mrr_cents || 0), 0);
  const byStatus = {};
  let rewardsIssuedCents = 0;
  for (const r of rewards || []) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    if (r.status === 'issued') rewardsIssuedCents += r.amount_cents || 0;
  }

  res.json({
    links: linkCount || 0,
    clicks: clickCount,
    signups: signupCount || 0,
    conversions: conversions ? conversions.length : 0,
    attributed_mrr_cents: attributedMrr,
    rewards_by_status: byStatus,
    rewards_issued_cents: rewardsIssuedCents,
  });
});

// POST /v1/programs/:id/rules  { name, trigger, trigger_config, conditions, actions, clawback_days?, priority? }
router.post('/:id/rules', async (req, res) => {
  const program = await scopedProgram(req.params.id, req.workspace.id);
  if (!program) return res.status(404).json({ error: 'program not found' });
  const { name, trigger, trigger_config, conditions, actions, clawback_days, priority } = req.body || {};
  if (!name || !trigger || !actions) return res.status(400).json({ error: 'name, trigger and actions required' });
  const { data, error } = await supabase
    .from('reward_rules')
    .insert({
      program_id: program.id, name, trigger,
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

// GET /v1/programs/:id/rules -> list rules
router.get('/:id/rules', async (req, res) => {
  const program = await scopedProgram(req.params.id, req.workspace.id);
  if (!program) return res.status(404).json({ error: 'program not found' });
  const { data } = await supabase
    .from('reward_rules').select('*').eq('program_id', program.id).order('priority', { ascending: true });
  res.json({ rules: data || [] });
});

// PATCH /v1/programs/:id/rules/:ruleId
router.patch('/:id/rules/:ruleId', async (req, res) => {
  const program = await scopedProgram(req.params.id, req.workspace.id);
  if (!program) return res.status(404).json({ error: 'program not found' });
  const allowed = ['name', 'trigger', 'trigger_config', 'conditions', 'actions', 'clawback_days', 'priority', 'active'];
  const updates = {};
  for (const k of allowed) if (req.body && req.body[k] !== undefined) updates[k] = req.body[k];
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'nothing to update' });
  const { data, error } = await supabase
    .from('reward_rules').update(updates)
    .eq('id', req.params.ruleId).eq('program_id', program.id).select().single();
  if (error || !data) return res.status(404).json({ error: 'rule not found' });
  res.json({ rule: data });
});

// DELETE /v1/programs/:id/rules/:ruleId
router.delete('/:id/rules/:ruleId', async (req, res) => {
  const program = await scopedProgram(req.params.id, req.workspace.id);
  if (!program) return res.status(404).json({ error: 'program not found' });
  const { error } = await supabase
    .from('reward_rules').delete().eq('id', req.params.ruleId).eq('program_id', program.id);
  if (error) return res.status(500).json({ error: 'delete failed' });
  res.json({ deleted: true });
});

// GET /v1/programs/:id/links -> links with per-link counts
router.get('/:id/links', async (req, res) => {
  const program = await scopedProgram(req.params.id, req.workspace.id);
  if (!program) return res.status(404).json({ error: 'program not found' });
  const { data: links } = await supabase
    .from('referral_links').select('*').eq('program_id', program.id).order('created_at', { ascending: false });
  const out = [];
  for (const l of links || []) {
    const [{ count: clicks }, { count: signups }] = await Promise.all([
      supabase.from('clicks').select('id', { count: 'exact', head: true }).eq('link_id', l.id),
      supabase.from('attributions').select('id', { count: 'exact', head: true }).eq('link_id', l.id),
    ]);
    const { count: paid } = await supabase.from('conversions')
      .select('id, attributions!inner(link_id)', { count: 'exact', head: true })
      .eq('attributions.link_id', l.id);
    out.push({ ...l, counts: { clicks: clicks || 0, signups: signups || 0, paid: paid || 0 } });
  }
  res.json({ links: out });
});

// GET /v1/programs/:id/rewards?status=pending|issued|cancelled|failed
router.get('/:id/rewards', async (req, res) => {
  const program = await scopedProgram(req.params.id, req.workspace.id);
  if (!program) return res.status(404).json({ error: 'program not found' });
  let q = supabase
    .from('rewards')
    .select('*, reward_rules(name)')
    .eq('program_id', program.id)
    .order('created_at', { ascending: false })
    .limit(200);
  if (req.query.status) q = q.eq('status', req.query.status);
  const { data } = await q;
  res.json({ rewards: data || [] });
});

// POST /v1/programs/:id/rewards/:rewardId/issue -> issue a pending reward now
router.post('/:id/rewards/:rewardId/issue', async (req, res) => {
  const program = await scopedProgram(req.params.id, req.workspace.id);
  if (!program) return res.status(404).json({ error: 'program not found' });
  const { data, error } = await supabase
    .from('rewards')
    .update({ issue_at: new Date().toISOString() })
    .eq('id', req.params.rewardId)
    .eq('program_id', program.id)
    .eq('status', 'pending')
    .select()
    .single();
  if (error || !data) return res.status(404).json({ error: 'pending reward not found' });
  res.json({ reward: data, note: 'worker will issue within 60 seconds' });
});

// GET /v1/programs/:id/activity -> merged recent feed
router.get('/:id/activity', async (req, res) => {
  const program = await scopedProgram(req.params.id, req.workspace.id);
  if (!program) return res.status(404).json({ error: 'program not found' });
  const [attrs, convs, rwds] = await Promise.all([
    supabase.from('attributions')
      .select('id, referrer_customer_id, referred_customer_id, attributed_at')
      .eq('program_id', program.id).order('attributed_at', { ascending: false }).limit(15),
    supabase.from('conversions')
      .select('id, mrr_cents, first_paid_at, attributions!inner(program_id, referrer_customer_id)')
      .eq('attributions.program_id', program.id).order('first_paid_at', { ascending: false }).limit(15),
    supabase.from('rewards')
      .select('id, type, amount_cents, status, recipient_customer_id, created_at, issued_at')
      .eq('program_id', program.id).order('created_at', { ascending: false }).limit(15),
  ]);
  const feed = [];
  for (const a of attrs.data || []) {
    feed.push({ type: 'signup', at: a.attributed_at, text: `${a.referred_customer_id} signed up via ${a.referrer_customer_id}'s link`, meta: a });
  }
  for (const c of convs.data || []) {
    const dollars = ((c.mrr_cents || 0) / 100).toFixed(2);
    feed.push({ type: 'conversion', at: c.first_paid_at, text: `Paid conversion: $${dollars} (referred by ${c.attributions.referrer_customer_id})`, meta: c });
  }
  for (const r of rwds.data || []) {
    const dollars = ((r.amount_cents || 0) / 100).toFixed(2);
    if (r.status === 'issued') {
      feed.push({ type: 'reward_issued', at: r.issued_at || r.created_at, text: `Reward issued: $${dollars} ${r.type} to ${r.recipient_customer_id}`, meta: r });
    } else if (r.status === 'cancelled') {
      feed.push({ type: 'clawback', at: r.created_at, text: `Clawback: $${dollars} reward to ${r.recipient_customer_id} cancelled`, meta: r });
    }
  }
  feed.sort((a, b) => new Date(b.at) - new Date(a.at));
  res.json({ activity: feed.slice(0, 30) });
});

// GET /v1/programs/:id/links/:linkId/journey -> full event timeline for a link
router.get('/:id/links/:linkId/journey', async (req, res) => {
  const program = await scopedProgram(req.params.id, req.workspace.id);
  if (!program) return res.status(404).json({ error: 'program not found' });
  const { data: link } = await supabase
    .from('referral_links').select('*')
    .eq('id', req.params.linkId).eq('program_id', program.id).single();
  if (!link) return res.status(404).json({ error: 'link not found' });

  const { data: clicks } = await supabase
    .from('clicks').select('id, clicked_at').eq('link_id', link.id).order('clicked_at', { ascending: true });
  const { data: attrs } = await supabase
    .from('attributions').select('id, referred_customer_id, attributed_at, status')
    .eq('link_id', link.id).order('attributed_at', { ascending: true });

  const attrIds = (attrs || []).map((a) => a.id);
  let convs = [];
  let rwds = [];
  if (attrIds.length) {
    const { data: c } = await supabase
      .from('conversions').select('id, attribution_id, mrr_cents, first_paid_at, status')
      .in('attribution_id', attrIds);
    convs = c || [];
    const convIds = convs.map((x) => x.id);
    if (convIds.length) {
      const { data: r } = await supabase
        .from('rewards')
        .select('id, conversion_id, type, amount_cents, status, recipient_customer_id, created_at, issued_at')
        .in('conversion_id', convIds);
      rwds = r || [];
    }
  }

  const money = (cents) => `$${((cents || 0) / 100).toFixed(2)}`;
  const events = [
    { id: `link-${link.id}`, type: 'link_created', at: link.created_at, label: `Link created for ${link.referrer_customer_id}` },
  ];
  for (const c of clicks || []) events.push({ id: `click-${c.id}`, type: 'click', at: c.clicked_at, label: 'Link clicked' });
  for (const a of attrs || []) {
    events.push({ id: `attr-${a.id}`, type: 'signup', at: a.attributed_at, label: `${a.referred_customer_id} signed up` });
  }
  for (const c of convs) {
    events.push({ id: `conv-${c.id}`, type: 'payment', at: c.first_paid_at, label: `First payment: ${money(c.mrr_cents)}` });
  }
  for (const r of rwds) {
    events.push({
      id: `reward-${r.id}`,
      type: r.status === 'cancelled' ? 'clawback' : 'reward_issued',
      at: r.issued_at || r.created_at,
      label: `Reward ${r.status}: ${money(r.amount_cents)} ${r.type} to ${r.recipient_customer_id}`,
    });
  }
  events.sort((a, b) => new Date(a.at) - new Date(b.at));
  res.json({ link, journey: events });
});

// GET /v1/programs/:id/timeseries?days=30 -> per-day clicks/signups/conversions
router.get('/:id/timeseries', async (req, res) => {
  const program = await scopedProgram(req.params.id, req.workspace.id);
  if (!program) return res.status(404).json({ error: 'program not found' });
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const { data: linkRows } = await supabase.from('referral_links').select('id').eq('program_id', program.id);
  const linkIds = (linkRows || []).map((r) => r.id);
  let clicks = [];
  if (linkIds.length) {
    const { data } = await supabase.from('clicks').select('clicked_at')
      .in('link_id', linkIds).gte('clicked_at', since);
    clicks = data || [];
  }
  const { data: signups } = await supabase.from('attributions').select('attributed_at')
    .eq('program_id', program.id).gte('attributed_at', since);
  const { data: convs } = await supabase.from('conversions')
    .select('first_paid_at, attributions!inner(program_id)')
    .eq('attributions.program_id', program.id).gte('first_paid_at', since);

  const buckets = {};
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    buckets[d] = { date: d, clicks: 0, signups: 0, conversions: 0 };
  }
  const bump = (arr, key, field) => {
    for (const r of arr || []) {
      const d = (r[field] || '').slice(0, 10);
      if (buckets[d]) buckets[d][key] += 1;
    }
  };
  bump(clicks, 'clicks', 'clicked_at');
  bump(signups, 'signups', 'attributed_at');
  bump(convs, 'conversions', 'first_paid_at');
  res.json({ series: Object.values(buckets) });
});

module.exports = router;
