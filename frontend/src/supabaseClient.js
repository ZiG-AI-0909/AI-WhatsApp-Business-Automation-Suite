import { createClient } from '@supabase/supabase-js';

const supabaseUrl     = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
  || import.meta.env.VITE_SUPABASE_ANON_KEY
  || '';

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

if (!isSupabaseConfigured) {
  console.warn(
    '[supabase] VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY is not set. ' +
    'Authentication will not work until these environment variables are configured.'
  );
}

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession:    true,   // persist session in localStorage
        autoRefreshToken:  true,   // auto-refresh before expiry
        detectSessionInUrl: true,  // handles OAuth callbacks and recovery links in URL hash
        storageKey: 'sb-session',  // explicit key for localStorage
      },
    })
  : null;
