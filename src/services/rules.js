const supabase = require('../db');

function checkCondition(cond, ctx) {
  const { field, operator, value } = cond;
  const actual = field.split('.').reduce((o, k) => (o ? o[k] : undefined), ctx);
  switch (operator) {
    case 'eq': return actual === value;
    case 'neq': return actual !== value;
    case 'in': return Array.isArray(value) && value.includes(actual);
    case 'gte': return actual >= value;
    case 'lte': return actual <= value;
    case 'gt': return actual > value;
    case 'lt': return actual < value;
    default: return false;
  }
}

// Evaluate all active rules for a program against an event context.
// Returns the list of pending reward rows created.
async function evaluateRules({ program_id, trigger, context }) {
  const { data: rules } = await supabase
    .from('reward_rules')
    .select('*')
    .eq('program_id', program_id)
    .eq('active', true)
    .eq('trigger', trigger)
    .order('priority', { ascending: true });

  const created = [];
  for (const rule of rules || []) {
    const conditions = rule.conditions || [];
    if (!conditions.every((c) => checkCondition(c, context))) continue;

    // Reward cap per referrer per calendar month (liability guard)
    const cap = (rule.trigger_config && rule.trigger_config.monthly_cap_per_referrer) || null;
    if (cap) {
      const monthStart = new Date();
      monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
      const { count } = await supabase
        .from('rewards')
        .select('id', { count: 'exact', head: true })
        .eq('program_id', program_id)
        .eq('rule_id', rule.id)
        .eq('recipient_customer_id', context.referrer.customer_id)
        .gte('created_at', monthStart.toISOString());
      if ((count || 0) >= cap) continue;
    }

    const delayMs = ((rule.trigger_config && rule.trigger_config.delay_days) || 0) * 86400000;
    const issueAt = new Date(Date.now() + delayMs);

    for (const action of rule.actions || []) {
      const { data, error } = await supabase
        .from('rewards')
        .insert({
          program_id,
          conversion_id: context.conversion_id || null,
          rule_id: rule.id,
          recipient_type: action.recipient || 'referrer',
          recipient_customer_id:
            (action.recipient || 'referrer') === 'referrer'
              ? context.referrer.customer_id
              : context.referee.customer_id,
          type: action.type,
          amount_cents: action.amount_cents || null,
          metadata: action,
          status: 'pending',
          issue_at: issueAt.toISOString(),
        })
        .select()
        .single();
      if (!error) created.push(data);
    }
  }
  return created;
}

module.exports = { evaluateRules, checkCondition };
