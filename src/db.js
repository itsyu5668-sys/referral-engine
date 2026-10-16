const { createClient } = require('@supabase/supabase-js');
const config = require('./config');

const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey, {
  auth: { persistSession: false },
});

module.exports = supabase;
