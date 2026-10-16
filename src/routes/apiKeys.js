const express = require('express');
const crypto = require('crypto');
const supabase = require('../db');
const { hashKey } = require('../middleware/auth');

const router = express.Router();

function publicKey(k) {
  return {
    id: k.id,
    name: k.name,
    key_prefix: k.key_prefix,
    last_used_at: k.last_used_at,
    revoked_at: k.revoked_at,
    created_at: k.created_at,
  };
}

// GET /v1/api-keys -> list keys (never the secret)
router.get('/', async (req, res) => {
  const { data } = await supabase
    .from('api_keys')
    .select('*')
    .eq('workspace_id', req.workspace.id)
    .order('created_at', { ascending: false });
  res.json({ api_keys: (data || []).map(publicKey) });
});

// POST /v1/api-keys  { name } -> generate a key, returned once
router.post('/', async (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name required' });
  const raw = 'vouch_' + crypto.randomBytes(24).toString('hex');
  const prefix = `vouch_…${raw.slice(-4)}`;
  const { data, error } = await supabase
    .from('api_keys')
    .insert({ workspace_id: req.workspace.id, name: name.trim(), key_hash: hashKey(raw), key_prefix: prefix })
    .select()
    .single();
  if (error) return res.status(500).json({ error: 'failed to create key' });
  res.status(201).json({
    api_key: publicKey(data),
    key: raw,
    warning: 'Copy this key now. It will not be shown again.',
  });
});

// DELETE /v1/api-keys/:id -> revoke
router.delete('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('workspace_id', req.workspace.id)
    .select('id')
    .single();
  if (error || !data) return res.status(404).json({ error: 'key not found' });
  res.json({ revoked: true });
});

module.exports = router;
