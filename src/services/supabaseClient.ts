import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = (import.meta as any).env?.VITE_SUPABASE_URL || '';
const supabaseAnonKey = (import.meta as any).env?.VITE_SUPABASE_ANON_KEY || '';

let clientInstance: SupabaseClient | null = null;

/**
 * Returns the client-side Supabase client instance configured with
 * safe, non-mutating native fetch wrapper.
 */
export function getSupabaseClient(): SupabaseClient | null {
  if (clientInstance) return clientInstance;

  if (supabaseUrl && supabaseAnonKey && !supabaseUrl.includes('xyzcompany')) {
    try {
      clientInstance = createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
        },
        global: {
          // Native browser fetch wrapper - never mutates window.fetch or global properties
          fetch: (input: RequestInfo | URL, init?: RequestInit) => {
            const fetchFn = typeof window !== 'undefined' && window.fetch ? window.fetch.bind(window) : globalThis.fetch;
            return fetchFn(input, init);
          },
        },
      });
    } catch (err) {
      console.warn('Supabase client initialization warning:', err);
      clientInstance = null;
    }
  }

  return clientInstance;
}
