// SERVER ONLY — never import this file in a Client Component or anything bundled to the browser.

import Redis from "ioredis";
import { requireServerEnv } from "@/lib/env/server";

type RedisSetArg = string | number;
const REMOTE_REDIS_OPERATION_TIMEOUT_MS = 450;

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

  private async resetRemoteClient(): Promise<void> {
    this.markFallback();
    if (this.remoteClient) {
      this.remoteClient.disconnect();
      this.remoteClient = null;
      this.remoteAdapter = null;
    }
  }

  private getRemoteClient(): Redis {
    if (!this.remoteClient) {
      const env = requireServerEnv();
      this.remoteClient = new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: 1,
        lazyConnect: true,
        connectTimeout: 3_000,
        commandTimeout: 2_500,
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
            this.remoteClient.disconnect();
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

  private async withRemoteTimeout<T>(
    work: Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Remote Redis operation timed out"));
      }, REMOTE_REDIS_OPERATION_TIMEOUT_MS);

      void work.then(
        (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      );
    });
  }

  async get(key: string): Promise<string | null> {
    const client = await this.resolveClient();
    if (client === this.fallbackClient) {
      return client.get(key);
    }

    try {
      const value = await this.withRemoteTimeout(client.get(key));
      if (value === null) {
        await this.fallbackClient.del(key);
      } else {
        await this.fallbackClient.set(key, value);
      }
      return value;
    } catch {
      await this.resetRemoteClient();
      return this.fallbackClient.get(key);
    }
  }

  async set(key: string, value: string, ...args: RedisSetArg[]): Promise<string | null> {
    await this.fallbackClient.set(key, value, ...args);
    const client = await this.resolveClient();
    if (client === this.fallbackClient) {
      return "OK";
    }

    try {
      return await this.withRemoteTimeout(client.set(key, value, ...args));
    } catch {
      await this.resetRemoteClient();
      return "OK";
    }
  }

  async del(...keys: string[]): Promise<number> {
    const localDeleted = await this.fallbackClient.del(...keys);
    const client = await this.resolveClient();
    if (client === this.fallbackClient) {
      return localDeleted;
    }

    try {
      return await this.withRemoteTimeout(client.del(...keys));
    } catch {
      await this.resetRemoteClient();
      return localDeleted;
    }
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

export function getRedis(): RedisLike {
  if (!redisClient) {
    redisClient = new ResilientRedis();
  }

  return redisClient ?? new ResilientRedis();
}

export async function disconnectRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}
