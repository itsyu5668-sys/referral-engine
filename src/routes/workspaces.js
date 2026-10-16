const express = require('express');
const supabase = require('../db');

const router = express.Router();

// GET /v1/workspaces/me -> the caller's workspace (created on first login by auth middleware)
router.get('/me', async (req, res) => {
  const role = req.user && req.workspace.owner_id === req.user.id
    ? 'owner'
    : (req.memberRole || 'viewer');
  res.json({ workspace: req.workspace, role, auth_type: req.authType });
});

// PATCH /v1/workspaces/me  { name?, notification_prefs? }
router.patch('/me', async (req, res) => {
  const { name, notification_prefs } = req.body || {};
  const updates = {};
  if (typeof name === 'string' && name.trim()) updates.name = name.trim();
  if (notification_prefs && typeof notification_prefs === 'object') updates.notification_prefs = notification_prefs;
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'nothing to update' });
  const { data, error } = await supabase
    .from('workspaces')
    .update(updates)
    .eq('id', req.workspace.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: 'update failed' });
  res.json({ workspace: data });
});

// GET /v1/workspaces/me/members
router.get('/me/members', async (req, res) => {
  const { data } = await supabase
    .from('workspace_members')
    .select('id, email, role, status, created_at')
    .eq('workspace_id', req.workspace.id)
    .order('created_at', { ascending: true });
  const ownerEmail = req.user && req.user.email ? req.user.email : null;
  const members = (data || []).map((m) => ({ ...m }));
  res.json({
    members,
    owner: { email: ownerEmail, role: 'owner', status: 'active' },
  });
});

// POST /v1/workspaces/me/members  { email, role? } -> invite a teammate
router.post('/me/members', async (req, res) => {
  const { email, role } = req.body || {};
  const cleanEmail = (email || '').toLowerCase().trim();
  if (!cleanEmail || !cleanEmail.includes('@')) return res.status(400).json({ error: 'valid email required' });
  const cleanRole = ['admin', 'viewer'].includes(role) ? role : 'viewer';

  const { data, error } = await supabase
    .from('workspace_members')
    .upsert(
      { workspace_id: req.workspace.id, email: cleanEmail, role: cleanRole, status: 'invited' },
      { onConflict: 'workspace_id,email' }
    )
    .select()
    .single();
  if (error) return res.status(500).json({ error: 'invite failed' });

  // Best-effort: send a real invite email via Supabase Auth.
  try {
    await supabase.auth.admin.inviteUserByEmail(cleanEmail, {
      data: { workspace_id: req.workspace.id, invited_by: req.workspace.name },
    });
  } catch (e) {
    console.error('[invite] email failed:', e.message);
  }
  res.status(201).json({ member: data, note: 'invite recorded; email sent if auth email is configured' });
});

// DELETE /v1/workspaces/me/members/:id -> remove a teammate
router.delete('/me/members/:id', async (req, res) => {
  const { error } = await supabase
    .from('workspace_members')
    .delete()
    .eq('id', req.params.id)
    .eq('workspace_id', req.workspace.id);
  if (error) return res.status(500).json({ error: 'remove failed' });
  res.json({ removed: true });
});

// DELETE /v1/workspaces/me  { name } -> delete workspace and all its data
router.delete('/me', async (req, res) => {
  const { name } = req.body || {};
  if (name !== req.workspace.name) {
    return res.status(400).json({ error: 'workspace name does not match' });
  }
  const { error } = await supabase.from('workspaces').delete().eq('id', req.workspace.id);
  if (error) return res.status(500).json({ error: 'delete failed' });
  res.json({ deleted: true });
});

module.exports = router;
