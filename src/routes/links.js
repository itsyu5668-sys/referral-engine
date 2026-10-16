const express = require('express');
const { customAlphabet } = require('nanoid');
const supabase = require('../db');
const { scopedProgram } = require('../middleware/auth');

const router = express.Router();
const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 10);

// POST /v1/referral-links  { program_id, referrer_customer_id, label? }
// Idempotent: returns existing link if the referrer already has one.
router.post('/', async (req, res) => {
  const { program_id, referrer_customer_id, label } = req.body || {};
  if (!program_id || !referrer_customer_id) {
    return res.status(400).json({ error: 'program_id and referrer_customer_id are required' });
  }

  const program = await scopedProgram(program_id, req.workspace.id);
  if (!program) return res.status(404).json({ error: 'program not found' });
  if (program.status === 'archived') return res.status(400).json({ error: 'program is archived' });

  const { data: existing } = await supabase
    .from('referral_links')
    .select('*')
    .eq('program_id', program.id)
    .eq('referrer_customer_id', referrer_customer_id)
    .single();
  if (existing) return res.json({ link: existing, created: false });

  const code = nanoid();
  const { data, error } = await supabase
    .from('referral_links')
    .insert({ program_id: program.id, referrer_customer_id, code, label: label || null })
    .select()
    .single();
  if (error) return res.status(500).json({ error: 'failed to create link' });

  res.status(201).json({ link: data, created: true });
});

module.exports = router;
