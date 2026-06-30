import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";

const currentDir = dirname(fileURLToPath(import.meta.url));
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
);
const envBoolean = z.preprocess((value) => {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off", ""].includes(normalized)) {
      return false;
    }
  }

  return value;
}, z.boolean());

function collectCandidateRoots(): string[] {
  const candidates = [
    process.cwd(),
    resolve(process.cwd(), ".."),
    resolve(process.cwd(), "..", ".."),
    resolve(currentDir, ".."),
    resolve(currentDir, "..", ".."),
    resolve(currentDir, "..", "..", ".."),
    resolve(currentDir, "..", "..", "..", ".."),
  ];

  return [...new Set(candidates)];
}

function loadEnvFiles(): void {
  const candidateFiles: string[] = [];

  for (const root of collectCandidateRoots()) {
    const serviceEnv = resolve(root, "services", "mcp-server", ".env");
    const rootEnv = resolve(root, ".env");
    const webEnv = resolve(root, "apps", "web", ".env.local");

    if (existsSync(serviceEnv)) {
      candidateFiles.push(serviceEnv);
    }
    if (existsSync(rootEnv)) {
      candidateFiles.push(rootEnv);
    }
    if (existsSync(webEnv)) {
      candidateFiles.push(webEnv);
    }
  }

  for (const path of [...new Set(candidateFiles)]) {
    config({ path, override: true });
  }

  // Preserve explicit per-process overrides such as proof-script HTTP ports.
  Object.assign(process.env, inheritedEnv);
}

loadEnvFiles();

const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  REDIS_URL: z.string().min(1),
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_CONNECT_SECRET_KEY: z.string().min(1),
  ROUTING_SERVICE_URL: z.string().url().default("http://127.0.0.1:8001"),
  MAX_AUTOMATIC_INCIDENT_SPEND: z.coerce.number().int().positive().default(20),
  MCP_HTTP_ENABLED: envBoolean.default(true),
  MCP_HTTP_HOST: z.string().min(1).default("0.0.0.0"),
  MCP_HTTP_PORT: z.coerce.number().int().positive().default(8644),
  MCP_HTTP_PATH: z.string().min(1).default("/mcp"),
  MCP_SSE_PATH: z.string().min(1).default("/sse"),
  MCP_SSE_MESSAGES_PATH: z.string().min(1).default("/messages"),
  MCP_ALLOWED_HOSTS: z.string().optional(),
});

const reasoningModelEnvSchema = z.object({
  LLM_PROVIDER: z.enum(["nous", "openrouter", "hermes_local"]).optional(),
  NOUS_API_KEY: z.string().min(1).optional(),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  NOUS_BASE_URL: z.string().url().default("https://inference-api.nousresearch.com/v1"),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  HERMES_BASE_URL: z.string().url().optional(),
  HERMES_BRIDGE_URL: z.string().url().default("http://127.0.0.1:8650/v1"),
  HERMES_WSL_DISTRO: z.string().min(1).default("Ubuntu-24.04"),
  HERMES_SANDBOX_NAME: z.string().min(1).default("hermes-runway"),
  NEMOTRON_MODEL_ID: z.string().min(1).default("nvidia/nemotron-3-ultra"),
});

export type McpServerEnv = z.infer<typeof envSchema>;
export type ReasoningModelEnv = z.infer<typeof reasoningModelEnvSchema> & {
  provider: "nous" | "openrouter" | "hermes_local";
  apiKey: string | null;
  baseUrl: string | null;
  model: string;
};

let cachedEnv: McpServerEnv | null = null;

export function getEnv(): McpServerEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  cachedEnv = envSchema.parse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    REDIS_URL: process.env.REDIS_URL,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_CONNECT_SECRET_KEY: process.env.STRIPE_CONNECT_SECRET_KEY,
    ROUTING_SERVICE_URL: process.env.ROUTING_SERVICE_URL,
    MAX_AUTOMATIC_INCIDENT_SPEND: process.env.MAX_AUTOMATIC_INCIDENT_SPEND,
    MCP_HTTP_ENABLED: process.env.MCP_HTTP_ENABLED,
    MCP_HTTP_HOST: process.env.MCP_HTTP_HOST,
    MCP_HTTP_PORT: process.env.MCP_HTTP_PORT,
    MCP_HTTP_PATH: process.env.MCP_HTTP_PATH,
    MCP_SSE_PATH: process.env.MCP_SSE_PATH,
    MCP_SSE_MESSAGES_PATH: process.env.MCP_SSE_MESSAGES_PATH,
    MCP_ALLOWED_HOSTS: process.env.MCP_ALLOWED_HOSTS,
  });

  return cachedEnv;
}

export function getReasoningModelEnv(): ReasoningModelEnv {
  const parsed = reasoningModelEnvSchema.parse({
    LLM_PROVIDER: process.env.LLM_PROVIDER,
    NOUS_API_KEY: process.env.NOUS_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    NOUS_BASE_URL: process.env.NOUS_BASE_URL,
    OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
    HERMES_BASE_URL: process.env.HERMES_BASE_URL,
    HERMES_BRIDGE_URL: process.env.HERMES_BRIDGE_URL,
    HERMES_WSL_DISTRO: process.env.HERMES_WSL_DISTRO,
    HERMES_SANDBOX_NAME: process.env.HERMES_SANDBOX_NAME,
    NEMOTRON_MODEL_ID: process.env.NEMOTRON_MODEL_ID,
  });

  const provider =
    parsed.LLM_PROVIDER ??
    (parsed.NOUS_API_KEY
      ? "nous"
      : parsed.OPENROUTER_API_KEY
        ? "openrouter"
        : "hermes_local");

  if (provider === "nous" && !parsed.NOUS_API_KEY) {
    throw new Error("LLM_PROVIDER is set to 'nous' but NOUS_API_KEY is missing.");
  }

  if (provider === "openrouter" && !parsed.OPENROUTER_API_KEY) {
    throw new Error("LLM_PROVIDER is set to 'openrouter' but OPENROUTER_API_KEY is missing.");
  }

  const apiKey = provider === "nous" ? parsed.NOUS_API_KEY! : provider === "openrouter" ? parsed.OPENROUTER_API_KEY! : null;

  return {
    ...parsed,
    provider,
    apiKey,
    baseUrl:
      provider === "nous"
        ? parsed.NOUS_BASE_URL
        : provider === "openrouter"
          ? parsed.OPENROUTER_BASE_URL
          : parsed.HERMES_BASE_URL ?? parsed.HERMES_BRIDGE_URL,
    model: provider === "hermes_local" ? "hermes-agent" : parsed.NEMOTRON_MODEL_ID,
  };
}
