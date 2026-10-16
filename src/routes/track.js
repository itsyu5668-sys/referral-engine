const express = require('express');
const crypto = require('crypto');
const supabase = require('../db');
const config = require('../config');

const router = express.Router();

function hashIp(ip) {
  if (!ip) return null;
  return crypto.createHash('sha256').update(ip + (process.env.IP_SALT || 'referral-engine')).digest('hex').slice(0, 32);
}

// GET /r/:code -> log click, 302 to founder's landing page.
// The founder configures their landing URL per program via ?to= or a stored default.
// For MVP: redirect target comes from the `to` query param (validated as http/https).
router.get('/:code', async (req, res) => {
  const { code } = req.params;
  const to = req.query.to;

  const { data: link } = await supabase
    .from('referral_links')
    .select('id, program_id')
    .eq('code', code)
    .single();

  if (link) {
    await supabase.from('clicks').insert({
      link_id: link.id,
      ip_hash: hashIp(req.ip || req.headers['x-forwarded-for']),
      user_agent: (req.headers['user-agent'] || '').slice(0, 512),
      fingerprint: (req.query.fp || '').slice(0, 128) || null,
    });
  }

  let target = '/';
  if (typeof to === 'string' && /^https?:\/\//i.test(to)) {
    const sep = to.includes('?') ? '&' : '?';
    target = `${to}${sep}ref=${encodeURIComponent(code)}`;
  }
  res.redirect(302, target);
});

module.exports = router;
