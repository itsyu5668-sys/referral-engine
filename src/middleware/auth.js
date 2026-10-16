const crypto = require('crypto');
const supabase = require('../db');

function hashKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// Resolve the workspace for a Supabase Auth user: owner match, then team-member
// match by email (activating invites), otherwise create a fresh workspace.
async function getOrCreateWorkspace(user) {
  const { data: owned } = await supabase
    .from('workspaces')
    .select('*')
    .eq('owner_id', user.id)
    .single();
  if (owned) return owned;

  const email = (user.email || '').toLowerCase();
  if (email) {
    const { data: membership } = await supabase
      .from('workspace_members')
      .select('workspace_id, status')
      .eq('email', email)
      .limit(1)
      .single();
    if (membership) {
      if (membership.status === 'invited') {
        await supabase
          .from('workspace_members')
          .update({ status: 'active' })
          .eq('workspace_id', membership.workspace_id)
          .eq('email', email);
      }
      const { data: memberWs } = await supabase
        .from('workspaces')
        .select('*')
        .eq('id', membership.workspace_id)
        .single();
      if (memberWs) return memberWs;
    }
  }

  const metaName = user.user_metadata && (user.user_metadata.product_name || user.user_metadata.full_name);
  const name = metaName || (email ? `${email.split('@')[0]}'s workspace` : 'My workspace');
  const { data: created, error } = await supabase
    .from('workspaces')
    .insert({ owner_id: user.id, name })
    .select()
    .single();
  if (error) throw new Error('workspace creation failed');
  return created;
}

// Auth: Bearer <Supabase JWT> (dashboard) or Bearer vouch_<secret> (API keys).
// Sets req.workspace. Rejects with 401 otherwise.
async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) return res.status(401).json({ error: 'missing bearer token' });

    if (token.startsWith('vouch_')) {
      const { data: key } = await supabase
        .from('api_keys')
        .select('id, workspace_id, revoked_at')
        .eq('key_hash', hashKey(token))
        .single();
      if (!key || key.revoked_at) return res.status(401).json({ error: 'invalid api key' });
      await supabase.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', key.id);
      const { data: ws } = await supabase.from('workspaces').select('*').eq('id', key.workspace_id).single();
      if (!ws) return res.status(401).json({ error: 'workspace not found' });
      req.workspace = ws;
      req.authType = 'api_key';
      return next();
    }

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: 'invalid or expired token' });
    req.workspace = await getOrCreateWorkspace(data.user);
    req.user = data.user;
    req.authType = 'jwt';
    return next();
  } catch (err) {
    console.error('[auth]', err.message);
    return res.status(500).json({ error: 'auth failed' });
  }
}

// Fetch a program only if it belongs to the caller's workspace.
async function scopedProgram(id, workspaceId) {
  const { data } = await supabase
    .from('programs')
    .select('*')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .single();
  return data || null;
}

module.exports = { auth, hashKey, getOrCreateWorkspace, scopedProgram };
