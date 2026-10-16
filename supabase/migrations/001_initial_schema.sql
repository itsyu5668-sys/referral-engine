-- Referral Engine initial schema
-- Run in Supabase SQL editor or via migration tooling.

-- Programs: one per SaaS founder / product
CREATE TABLE IF NOT EXISTS programs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  attribution_window_days INT NOT NULL DEFAULT 30,
  attribution_model TEXT NOT NULL DEFAULT 'last_touch' CHECK (attribution_model IN ('first_touch', 'last_touch')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reward rules: trigger + conditions + actions (JSONB for flexibility)
CREATE TABLE IF NOT EXISTS reward_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('referee.signup', 'referee.first_payment', 'referee.retained_days', 'referee.upgraded')),
  trigger_config JSONB NOT NULL DEFAULT '{}',
  conditions JSONB NOT NULL DEFAULT '[]',
  actions JSONB NOT NULL DEFAULT '[]',
  clawback_days INT NOT NULL DEFAULT 0,
  priority INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reward_rules_program ON reward_rules(program_id);

-- Referral links: unique per referrer per program
CREATE TABLE IF NOT EXISTS referral_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  referrer_customer_id TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(program_id, referrer_customer_id)
);
CREATE INDEX IF NOT EXISTS idx_referral_links_code ON referral_links(code);

-- Clicks: raw click events for analytics + fraud signals
CREATE TABLE IF NOT EXISTS clicks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id UUID NOT NULL REFERENCES referral_links(id) ON DELETE CASCADE,
  ip_hash TEXT,
  user_agent TEXT,
  fingerprint TEXT,
  clicked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_clicks_link ON clicks(link_id);

-- Attributions: signup linked to a referrer
CREATE TABLE IF NOT EXISTS attributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  link_id UUID NOT NULL REFERENCES referral_links(id) ON DELETE CASCADE,
  referrer_customer_id TEXT NOT NULL,
  referred_customer_id TEXT NOT NULL,
  referred_email TEXT,
  clicked_at TIMESTAMPTZ,
  attributed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'converted', 'invalidated')),
  fraud_flags JSONB NOT NULL DEFAULT '[]',
  UNIQUE(program_id, referred_customer_id)
);
CREATE INDEX IF NOT EXISTS idx_attributions_referred ON attributions(program_id, referred_customer_id);
CREATE INDEX IF NOT EXISTS idx_attributions_referrer ON attributions(program_id, referrer_customer_id);

-- Conversions: paid conversion events
CREATE TABLE IF NOT EXISTS conversions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attribution_id UUID NOT NULL REFERENCES attributions(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL,
  first_paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  mrr_cents INT NOT NULL DEFAULT 0,
  plan_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'churned'))
);
CREATE INDEX IF NOT EXISTS idx_conversions_attribution ON conversions(attribution_id);

-- Rewards: issued (or pending) rewards from rule evaluation
CREATE TABLE IF NOT EXISTS rewards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  conversion_id UUID REFERENCES conversions(id) ON DELETE SET NULL,
  rule_id UUID REFERENCES reward_rules(id) ON DELETE SET NULL,
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('referrer', 'referee')),
  recipient_customer_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('credit', 'discount_percent', 'trial_extension', 'feature_unlock', 'cash', 'webhook')),
  amount_cents INT,
  metadata JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'issued', 'failed', 'cancelled')),
  issue_at TIMESTAMPTZ NOT NULL,
  issued_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rewards_due ON rewards(status, issue_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_rewards_program ON rewards(program_id);
