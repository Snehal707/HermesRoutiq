// SERVER ONLY — never import this file in a Client Component or anything bundled to the browser.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireServerEnv } from "@/lib/env/server";

// Tables are defined in migrations; full generated types come later.
type AdminClient = SupabaseClient;

let supabaseAdmin: AdminClient | null = null;

export function getSupabaseAdmin(): AdminClient {
  if (!supabaseAdmin) {
    const env = requireServerEnv();
    supabaseAdmin = createClient(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
        global: {
          fetch: (input, init) =>
            fetch(input, {
              ...init,
              cache: "no-store",
            }),
        },
      },
    );
  }

  return supabaseAdmin;
}
