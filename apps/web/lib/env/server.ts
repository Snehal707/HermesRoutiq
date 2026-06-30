// SERVER ONLY — validate env at API route startup.

const REQUIRED_SERVER_ENV = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "REDIS_URL",
  "STRIPE_SECRET_KEY",
  "STRIPE_CONNECT_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
] as const;

export type ServerEnvKey = (typeof REQUIRED_SERVER_ENV)[number];

export interface ServerEnv {
  NEXT_PUBLIC_SUPABASE_URL: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  REDIS_URL: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_CONNECT_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
}

export function requireServerEnv(): ServerEnv {
  const missing: string[] = [];

  for (const key of REQUIRED_SERVER_ENV) {
    const value = process.env[key];
    if (!value || value.trim() === "") {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required server environment variables: ${missing.join(", ")}`,
    );
  }

  return {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,
    REDIS_URL: process.env.REDIS_URL!,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY!,
    STRIPE_CONNECT_SECRET_KEY: process.env.STRIPE_CONNECT_SECRET_KEY!,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET!,
  };
}
