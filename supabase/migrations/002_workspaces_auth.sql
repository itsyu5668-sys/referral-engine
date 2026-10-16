-- Referral Engine migration 002: workspaces, auth, API keys, team
-- Run in the Supabase SQL editor (same as 001). Safe to re-run.

-- Workspaces: one per founder account (Supabase Auth user id)
CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT 'My workspace',
  plan TEXT NOT NULL DEFAULT 'free',
  notification_prefs JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Programs now belong to a workspace and carry dashboard fields
ALTER TABLE programs ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE programs ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'paused', 'archived'));
ALTER TABLE programs ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE programs ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE programs ADD COLUMN IF NOT EXISTS redirect_url TEXT;

-- Backfill: one workspace per pre-existing owner_id (test data from initial deploy)
INSERT INTO workspaces (owner_id, name)
SELECT DISTINCT owner_id, 'Workspace' FROM programs
ON CONFLICT (owner_id) DO NOTHING;

UPDATE programs p
SET workspace_id = w.id
FROM workspaces w
WHERE w.owner_id = p.owner_id AND p.workspace_id IS NULL;

ALTER TABLE programs ALTER COLUMN workspace_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_programs_workspace_slug ON programs(workspace_id, slug) WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_programs_workspace ON programs(workspace_id);

-- API keys: server-to-server access, stored as SHA-256 hashes
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_workspace ON api_keys(workspace_id);

-- Team members: invited by email, activated on first login
CREATE TABLE IF NOT EXISTS workspace_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner', 'admin', 'viewer')),
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, email)
);
CREATE INDEX IF NOT EXISTS idx_workspace_members_email ON workspace_members(email);

-- Referral link campaign labels (dashboard "Generate link" dialog)
ALTER TABLE referral_links ADD COLUMN IF NOT EXISTS label TEXT;
