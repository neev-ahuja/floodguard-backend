import { createClient } from '@supabase/supabase-js';
import { config } from './config';

// Admin client — uses service role key. NEVER expose to browser.
export const supabaseAdmin = createClient(config.supabaseUrl, config.supabaseSecretKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// Anon client — for operations that should respect RLS
export const supabaseAnon = createClient(config.supabaseUrl, config.supabaseAnonKey);
