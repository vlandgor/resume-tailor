// Supabase client. URL and publishable key are injected at build time (see build.mjs).
// Both are public by design: what protects your data is sign-in plus row-level security (supabase/schema.sql).
import { createClient } from '@supabase/supabase-js';

/* global __SUPABASE_URL__, __SUPABASE_KEY__ */
export const configured = !!(__SUPABASE_URL__ && __SUPABASE_KEY__);

export const sb = configured
  ? createClient(__SUPABASE_URL__, __SUPABASE_KEY__, {
    // PKCE: sign-in redirects come back as ?code=… (query), which doesn't clash with the app's #/hash routes.
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce', storageKey: 'rt.auth' },
  })
  : null;
