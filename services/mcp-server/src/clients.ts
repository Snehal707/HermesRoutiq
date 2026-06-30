import { Redis } from "ioredis";
import { createClient, type RealtimeClientOptions, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import { getEnv } from "./env.js";

type RedisSetArg = string | number;

interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: RedisSetArg[]): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  quit(): Promise<"OK">;
}

class InMemoryRedis implements RedisLike {
  private store = new Map<string, { value: string; expiresAt: number | null }>();

  private readEntry(key: string): { value: string; expiresAt: number | null } | null {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }

    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.readEntry(key)?.value ?? null;
  }

  async set(key: string, value: string, ...args: RedisSetArg[]): Promise<string | null> {
    let expiresAt: number | null = null;
    let onlyIfMissing = false;

    for (let index = 0; index < args.length; index += 1) {
      const option = String(args[index]).toUpperCase();
      if (option === "EX") {
        const seconds = Number(args[index + 1]);
        if (Number.isFinite(seconds) && seconds > 0) {
          expiresAt = Date.now() + seconds * 1_000;
        }
        index += 1;
        continue;
      }

      if (option === "NX") {
        onlyIfMissing = true;
      }
    }

    if (onlyIfMissing && this.readEntry(key)) {
      return null;
    }

    this.store.set(key, { value, expiresAt });
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.store.delete(key)) {
        deleted += 1;
      }
    }
    return deleted;
  }

  async quit(): Promise<"OK"> {
    return "OK";
  }
}

class RemoteRedisAdapter implements RedisLike {
  constructor(private readonly client: Redis) {}

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ...args: RedisSetArg[]): Promise<string | null> {
    return (this.client.set as unknown as RedisLike["set"])(key, value, ...args);
  }

  async del(...keys: string[]): Promise<number> {
    return this.client.del(...keys);
  }

  async quit(): Promise<"OK"> {
    return this.client.quit();
  }
}

class ResilientRedis implements RedisLike {
  private remoteClient: Redis | null = null;
  private remoteAdapter: RemoteRedisAdapter | null = null;
  private fallbackClient = new InMemoryRedis();
  private mode: "unknown" | "remote" | "fallback" = "unknown";
  private connectAttempt: Promise<RedisLike> | null = null;
  private lastFallbackAt = 0;
  private readonly retryAfterMs = 5_000;

  private markFallback(): void {
    this.mode = "fallback";
    this.lastFallbackAt = Date.now();
  }

  private getRemoteClient(): Redis {
    if (!this.remoteClient) {
      const env = getEnv();
      this.remoteClient = new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: 1,
        lazyConnect: true,
        connectTimeout: 3_000,
        enableOfflineQueue: false,
      });
      this.remoteAdapter = new RemoteRedisAdapter(this.remoteClient);
      this.remoteClient.on("error", () => {
        this.markFallback();
      });
    }

    return this.remoteClient;
  }

  private async resolveClient(): Promise<RedisLike> {
    if (this.mode === "remote") {
      this.getRemoteClient();
      return this.remoteAdapter ?? this.fallbackClient;
    }

    if (this.mode === "fallback") {
      if (Date.now() - this.lastFallbackAt < this.retryAfterMs) {
        return this.fallbackClient;
      }
      this.mode = "unknown";
    }

    if (!this.connectAttempt) {
      this.connectAttempt = (async () => {
        try {
          const client = this.getRemoteClient();
          await client.connect();
          await client.ping();
          this.mode = "remote";
          this.lastFallbackAt = 0;
          return this.remoteAdapter ?? this.fallbackClient;
        } catch {
          this.markFallback();
          if (this.remoteClient) {
            await this.remoteClient.quit().catch(() => {});
            this.remoteClient = null;
            this.remoteAdapter = null;
          }
          return this.fallbackClient;
        } finally {
          this.connectAttempt = null;
        }
      })();
    }

    return this.connectAttempt;
  }

  async get(key: string): Promise<string | null> {
    const client = await this.resolveClient();
    return client.get(key);
  }

  async set(key: string, value: string, ...args: RedisSetArg[]): Promise<string | null> {
    const client = await this.resolveClient();
    return client.set(key, value, ...args);
  }

  async del(...keys: string[]): Promise<number> {
    const client = await this.resolveClient();
    return client.del(...keys);
  }

  async quit(): Promise<"OK"> {
    if (this.remoteClient) {
      await this.remoteClient.quit().catch(() => {});
      this.remoteClient = null;
      this.remoteAdapter = null;
    }
    this.mode = "unknown";
    return this.fallbackClient.quit();
  }
}

let redisClient: RedisLike | null = null;
let supabaseClient: SupabaseClient | null = null;
const realtimeTransport = WebSocket as unknown as NonNullable<RealtimeClientOptions["transport"]>;

export function getRedisClient(): RedisLike {
  if (!redisClient) {
    redisClient = new ResilientRedis();
  }

  return redisClient ?? new ResilientRedis();
}

export async function getFreshRedisClient(): Promise<RedisLike> {
  const env = getEnv();
  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    connectTimeout: 3_000,
    enableOfflineQueue: false,
  });

  try {
    await client.connect();
    await client.ping();
    return new RemoteRedisAdapter(client);
  } catch {
    await client.quit().catch(() => {});
    return new InMemoryRedis();
  }
}

export function getSupabaseAdminClient(): SupabaseClient {
  if (!supabaseClient) {
    const env = getEnv();
    supabaseClient = createClient(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
        realtime: {
          transport: realtimeTransport,
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

  return supabaseClient;
}

export async function closeSharedClients(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }

  supabaseClient = null;
}
