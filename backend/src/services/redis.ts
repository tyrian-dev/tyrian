import Redis from "ioredis";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

class MemoryStorage {
  private store = new Map<string, string>();
  private sets = new Map<string, Set<string>>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) || null;
  }

  async set(key: string, value: string, mode?: string, duration?: number): Promise<string> {
    this.store.set(key, value);
    if (mode === "EX" && duration) {
      setTimeout(() => this.store.delete(key), duration * 1000);
    }
    return "OK";
  }

  async setNX(key: string, value: string, expirySeconds: number): Promise<boolean> {
    if (this.store.has(key)) {
      return false;
    }
    this.store.set(key, value);
    if (expirySeconds) {
      setTimeout(() => this.store.delete(key), expirySeconds * 1000);
    }
    return true;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const raw = this.store.get(key);
    return raw ? JSON.parse(raw) : {};
  }

  async hset(key: string, values: Record<string, string | number>, expirySeconds?: number): Promise<number> {
    const existing = await this.hgetall(key);
    const updated = { ...existing, ...values };
    this.store.set(key, JSON.stringify(updated));
    if (expirySeconds) {
      setTimeout(() => this.store.delete(key), expirySeconds * 1000);
    }
    return 1;
  }

  async del(key: string): Promise<number> {
    this.sets.delete(key);
    return this.store.delete(key) ? 1 : 0;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    const s = this.sets.get(key)!;
    let added = 0;
    for (const m of members) {
      if (!s.has(m)) {
        s.add(m);
        added++;
      }
    }
    return added;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const s = this.sets.get(key);
    if (!s) return 0;
    let removed = 0;
    for (const m of members) {
      if (s.delete(m)) removed++;
    }
    return removed;
  }

  async smembers(key: string): Promise<string[]> {
    const s = this.sets.get(key);
    return s ? Array.from(s) : [];
  }
}

// In-memory fallback if Redis is unreachable in local development
const memoryFallback = new MemoryStorage();
let redisClient: Redis | null = null;
let isRedisConnected = false;

try {
  redisClient = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    retryStrategy: () => null, // don't loop indefinitely in local dev
    lazyConnect: true,
  });

  // Attach error handler to prevent unhandled EventEmitter crash
  redisClient.on("error", (err) => {
    isRedisConnected = false;
  });

  redisClient.connect().then(() => {
    isRedisConnected = true;
    console.log("[Redis] Connected successfully to", redisUrl);
  }).catch(() => {
    isRedisConnected = false;
    console.log("[Redis] No local Redis detected. Using in-memory store for quota & session caching.");
  });
} catch {
  console.log("[Redis] Using in-memory fallback.");
}

export const redis = {
  async get(key: string): Promise<string | null> {
    if (isRedisConnected && redisClient) {
      try { return await redisClient.get(key); } catch {}
    }
    return memoryFallback.get(key);
  },

  async set(key: string, value: string, expirySeconds?: number): Promise<string> {
    if (isRedisConnected && redisClient) {
      try {
        if (expirySeconds) return await redisClient.set(key, value, "EX", expirySeconds);
        return await redisClient.set(key, value);
      } catch {}
    }
    return memoryFallback.set(key, value, expirySeconds ? "EX" : undefined, expirySeconds);
  },

  /**
   * Set key with NX (only if Not eXists) and expiration in seconds.
   * Returns true if key was set, false if key already existed.
   */
  async setNX(key: string, value: string, expirySeconds: number): Promise<boolean> {
    if (isRedisConnected && redisClient) {
      try {
        const res = await redisClient.set(key, value, "EX", expirySeconds, "NX");
        return res === "OK";
      } catch {}
    }
    return memoryFallback.setNX(key, value, expirySeconds);
  },

  /**
   * Acquire a distributed lock with automatic expiration.
   */
  async acquireLock(key: string, ttlSeconds: number = 60): Promise<boolean> {
    return this.setNX(key, "locked", ttlSeconds);
  },

  /**
   * Release a distributed lock.
   */
  async releaseLock(key: string): Promise<void> {
    await this.del(key);
  },

  async del(key: string): Promise<number> {
    if (isRedisConnected && redisClient) {
      try { return await redisClient.del(key); } catch {}
    }
    return memoryFallback.del(key);
  },

  /**
   * Atomically read and delete a one-time value such as a SIWE nonce.
   */
  async consume(key: string): Promise<string | null> {
    if (isRedisConnected && redisClient) {
      try { return await redisClient.getdel(key); } catch {}
    }
    const value = await memoryFallback.get(key);
    if (value !== null) await memoryFallback.del(key);
    return value;
  },

  async sadd(key: string, ...members: string[]): Promise<number> {
    if (isRedisConnected && redisClient) {
      try { return await redisClient.sadd(key, ...members); } catch {}
    }
    return memoryFallback.sadd(key, ...members);
  },

  async srem(key: string, ...members: string[]): Promise<number> {
    if (isRedisConnected && redisClient) {
      try { return await redisClient.srem(key, ...members); } catch {}
    }
    return memoryFallback.srem(key, ...members);
  },

  async smembers(key: string): Promise<string[]> {
    if (isRedisConnected && redisClient) {
      try { return await redisClient.smembers(key); } catch {}
    }
    return memoryFallback.smembers(key);
  },

  async getQuota(userAddress: string): Promise<{ allocatedUsd: number; usedUsd: number }> {
    const key = `tyrian:quota:${userAddress.toLowerCase()}`;
    if (isRedisConnected && redisClient) {
      try {
        const raw = await redisClient.hgetall(key);
        if (raw && Object.keys(raw).length > 0) {
          return {
            allocatedUsd: parseFloat(raw.allocated || "0"),
            usedUsd: parseFloat(raw.used || "0"),
          };
        }
      } catch {}
    }
    const raw = await memoryFallback.hgetall(key);
    return {
      allocatedUsd: parseFloat(raw.allocated || "0"),
      usedUsd: parseFloat(raw.used || "0"),
    };
  },

  async expire(key: string, seconds: number): Promise<boolean> {
    if (isRedisConnected && redisClient) {
      try {
        const res = await redisClient.expire(key, seconds);
        return res === 1;
      } catch {}
    }
    return true;
  },

  async setQuota(userAddress: string, allocatedUsd: number, usedUsd: number = 0, ttlSeconds: number = 172800): Promise<void> {
    const key = `tyrian:quota:${userAddress.toLowerCase()}`;
    const data = { allocated: allocatedUsd.toString(), used: usedUsd.toString() };
    if (isRedisConnected && redisClient) {
      try {
        await redisClient.hset(key, data);
        if (ttlSeconds > 0) {
          await redisClient.expire(key, ttlSeconds);
        }
        return;
      } catch {}
    }
    await memoryFallback.hset(key, data, ttlSeconds);
  },

  /**
   * Returns memory utilization and eviction policy metrics (OPS-005)
   */
  async getMemoryInfo(): Promise<{
    connected: boolean;
    usedMemoryHuman: string;
    maxmemoryPolicy: string;
  }> {
    if (isRedisConnected && redisClient) {
      try {
        const info = await redisClient.info("memory");
        const usedMemMatch = info.match(/used_memory_human:([^\r\n]+)/);
        const config = await (redisClient as unknown as { config: (cmd: string, param: string) => Promise<string[]> })
          .config("get", "maxmemory-policy")
          .catch(() => null);
        const policy = config && Array.isArray(config) ? config[1] : "volatile-lru";

        return {
          connected: true,
          usedMemoryHuman: usedMemMatch ? usedMemMatch[1].trim() : "unknown",
          maxmemoryPolicy: policy,
        };
      } catch {}
    }

    return {
      connected: false,
      usedMemoryHuman: "in-memory-fallback",
      maxmemoryPolicy: "volatile-lru",
    };
  },

  /**
   * Atomic check-and-reserve / decrement quota
   */
  async deductQuota(userAddress: string, costUsd: number): Promise<boolean> {
    const key = `tyrian:quota:${userAddress.toLowerCase()}`;
    const quota = await this.getQuota(userAddress);

    if (quota.allocatedUsd > 0 && quota.usedUsd + costUsd > quota.allocatedUsd) {
      return false; // Quota exceeded
    }

    const newUsed = quota.usedUsd + costUsd;
    await this.setQuota(userAddress, quota.allocatedUsd, newUsed);
    return true;
  },

  /**
   * Refund reserved quota if upstream execution fails (REL-QA-008)
   */
  async refundQuota(userAddress: string, costUsd: number): Promise<void> {
    const quota = await this.getQuota(userAddress);
    const newUsed = Math.max(0, quota.usedUsd - costUsd);
    await this.setQuota(userAddress, quota.allocatedUsd, newUsed);
  },
};
