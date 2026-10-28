import { Hono } from "hono";
import crypto from "node:crypto";
import { redis } from "../services/redis";
import { openRouter } from "../services/openrouter";
import { getAuthAddress } from "../services/session";
import { dbService } from "../services/db";
import { csrfProtection } from "../middleware/security";
import { geoGate, extractCountry } from "../middleware/geo";
import { encryptSecret, decryptSecret } from "../services/crypto";

export const keysRouter = new Hono();

// Enforce CSRF Origin verification and geo-fencing on API key operations (BE-AUTH-004, BE-AUTH-007)
keysRouter.use("*", csrfProtection);
keysRouter.use("*", geoGate);

interface StoredUserKey {
  id: string;
  name: string;
  keyPrefix: string;
  keyHash?: string;
  createdAt: string;
  isRevoked?: boolean;
  revokedAt?: string;
  rotatedAt?: string;
}

interface StoredKeyRecord {
  id: string;
  name: string;
  keyPrefix: string;
  userAddress: string;
  subKey: string;
  isRevoked: boolean;
  createdAt: string;
  revokedAt?: string;
  rotatedAt?: string;
}

function createRawKey(): string {
  return `tyr_live_${crypto.randomBytes(24).toString("hex")}`;
}

function hashKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

function keyPrefix(rawKey: string): string {
  return `tyr_live_••••${rawKey.slice(-4)}`;
}

async function readUserKeys(address: string): Promise<StoredUserKey[]> {
  const raw = await redis.get(`tyrian:user_keys:${address}`);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeUserKeys(address: string, keys: StoredUserKey[]): Promise<void> {
  await redis.set(`tyrian:user_keys:${address}`, JSON.stringify(keys));
}

function toPublicKey(key: StoredUserKey) {
  return {
    id: key.id,
    name: key.name,
    keyPrefix: key.keyPrefix,
    createdAt: key.createdAt,
    isRevoked: Boolean(key.isRevoked),
    rotatedAt: key.rotatedAt ?? null,
  };
}

async function revokeStoredKey(keyHash: string, revokedAt: string): Promise<void> {
  const cacheKey = `tyrian:key:${keyHash}`;
  const raw = await redis.get(cacheKey);
  if (!raw) return;

  try {
    const record = JSON.parse(raw) as StoredKeyRecord;
    record.isRevoked = true;
    record.revokedAt = revokedAt;
    await redis.set(cacheKey, JSON.stringify(record));
  } catch {
    // Leave an unreadable record in place; it will fail closed in the gateway.
  }
}

/**
 * 1. POST /api/keys
 * Create a new API key (tyr_live_...)
 */
keysRouter.post("/", async (c) => {
  const address = await getAuthAddress(c);
  if (!address) {
    return c.json({ error: "Unauthorized. Please sign in with wallet." }, 401);
  }

  const body = await c.req.json().catch(() => ({})) as { name?: string };
  const keyName = body.name?.trim() || "Default Key";
  if (keyName.length > 40) {
    return c.json({ error: "Key name must be 40 characters or fewer." }, 400);
  }

  const rawKey = createRawKey();
  const hash = hashKey(rawKey);
  const prefix = keyPrefix(rawKey);
  const keyId = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  // Get current quota to seed the sub-key limit. Zero quota stays zero: the
  // sub-key must not invent spending capacity the ledger does not have.
  const quota = await redis.getQuota(address);
  let rawSubKey: string;
  try {
    rawSubKey = await openRouter.createOrUpdateSubKey(address, quota.allocatedUsd);
  } catch (err) {
    console.error("[Keys] Failed to create OpenRouter sub-key:", err);
    return c.json(
      {
        error: "Provider key service unavailable. No API key was created.",
        code: "provider_key_unavailable",
      },
      503,
    );
  }
  const encryptedSubKey = encryptSecret(rawSubKey);

  const keyRecord: StoredKeyRecord = {
    id: keyId,
    name: keyName,
    keyPrefix: prefix,
    userAddress: address,
    subKey: encryptedSubKey,
    isRevoked: false,
    createdAt,
  };

  await redis.set(`tyrian:key:${hash}`, JSON.stringify(keyRecord));

  // Persist to Postgres database (BE-KEY-006: encrypted with AES-256-GCM)
  await dbService.createApiKey({
    id: keyId,
    userAddress: address,
    name: keyName,
    keyHash: hash,
    keyPrefix: prefix,
    orKeyHash: encryptedSubKey,
  });

  const userKeys = await readUserKeys(address);
  userKeys.push({
    id: keyId,
    name: keyName,
    keyPrefix: prefix,
    keyHash: hash,
    createdAt,
    isRevoked: false,
  });
  await writeUserKeys(address, userKeys);

  // Persistent audit log (BE-AUTH-009)
  const ipCountry = extractCountry(c);
  const userAgent = c.req.header("user-agent");
  void dbService.logAudit({
    userAddress: address,
    action: "KEY_CREATE",
    ipCountry,
    userAgent,
    metadata: {
      keyId,
      name: keyName,
      keyPrefix: prefix,
    },
  });

  return c.json({
    id: keyId,
    name: keyName,
    keyPrefix: prefix,
    apiKey: rawKey, // Displayed ONLY ONCE
    createdAt,
  });
});

/**
 * 2. GET /api/keys
 * List active keys for authenticated wallet
 */
keysRouter.get("/", async (c) => {
  const address = await getAuthAddress(c);
  if (!address) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Check persistent Postgres storage first
  const dbKeys = await dbService.getUserApiKeys(address);
  if (dbKeys.length > 0) {
    return c.json({
      keys: dbKeys.map((k) => ({
        id: k.id,
        name: k.name,
        keyPrefix: k.keyPrefix,
        createdAt: k.createdAt.toISOString(),
        isRevoked: k.isRevoked,
        rotatedAt: null,
      })),
    });
  }

  // Fallback to Redis cache
  const userKeys = await readUserKeys(address);
  return c.json({
    keys: userKeys.filter((key) => !key.isRevoked).map(toPublicKey),
  });
});

/**
 * 3. DELETE /api/keys/:id
 * Revoke an API key. The gateway rejects the old hash immediately.
 */
keysRouter.delete("/:id", async (c) => {
  const address = await getAuthAddress(c);
  if (!address) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const keyId = c.req.param("id");
  const userKeys = await readUserKeys(address);
  const item = userKeys.find((key) => key.id === keyId && !key.isRevoked);

  if (!item) {
    return c.json({ error: "API key not found." }, 404);
  }

  if (!item.keyHash) {
    return c.json(
      {
        error:
          "This key predates the revocable key index. Create a new key and revoke it there.",
      },
      409,
    );
  }

  const revokedAt = new Date().toISOString();
  await revokeStoredKey(item.keyHash, revokedAt);
  await dbService.revokeApiKey(item.id, address);

  item.isRevoked = true;
  item.revokedAt = revokedAt;
  await writeUserKeys(address, userKeys);

  // Persistent audit log (BE-AUTH-009)
  const ipCountry = extractCountry(c);
  const userAgent = c.req.header("user-agent");
  void dbService.logAudit({
    userAddress: address,
    action: "KEY_REVOKE",
    ipCountry,
    userAgent,
    metadata: {
      keyId: item.id,
      keyPrefix: item.keyPrefix,
    },
  });

  return c.json({ success: true, id: item.id, revokedAt });
});

/**
 * 4. POST /api/keys/:id/rotate
 * Issue a new secret for an existing key name and revoke the old secret.
 */
keysRouter.post("/:id/rotate", async (c) => {
  const address = await getAuthAddress(c);
  if (!address) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const keyId = c.req.param("id");
  const userKeys = await readUserKeys(address);
  const item = userKeys.find((key) => key.id === keyId && !key.isRevoked);

  if (!item) {
    return c.json({ error: "API key not found." }, 404);
  }

  if (!item.keyHash) {
    return c.json(
      {
        error:
          "This key predates the revocable key index. Create a new key and rotate it there.",
      },
      409,
    );
  }

  const oldRecordRaw = await redis.get(`tyrian:key:${item.keyHash}`);
  let oldRecord: StoredKeyRecord | null = null;
  if (oldRecordRaw) {
    try {
      oldRecord = JSON.parse(oldRecordRaw) as StoredKeyRecord;
    } catch {
      oldRecord = null;
    }
  }

  const rawKey = createRawKey();
  const newHash = hashKey(rawKey);
  const newPrefix = keyPrefix(rawKey);
  const rotatedAt = new Date().toISOString();

  const quota = await redis.getQuota(address);
  let rawSubKey: string;
  try {
    rawSubKey =
      oldRecord?.subKey ||
      (await openRouter.createOrUpdateSubKey(address, quota.allocatedUsd));
  } catch (err) {
    console.error("[Keys] Failed to rotate OpenRouter sub-key:", err);
    return c.json(
      {
        error: "Provider key service unavailable. The existing key was left untouched.",
        code: "provider_key_unavailable",
      },
      503,
    );
  }
  const encryptedSubKey = encryptSecret(rawSubKey);

  // Only revoke the old secret once the replacement sub-key exists.
  await revokeStoredKey(item.keyHash, rotatedAt);

  const newRecord: StoredKeyRecord = {
    id: item.id,
    name: item.name,
    keyPrefix: newPrefix,
    userAddress: address,
    subKey: encryptedSubKey,
    isRevoked: false,
    createdAt: item.createdAt,
    rotatedAt,
  };

  await redis.set(`tyrian:key:${newHash}`, JSON.stringify(newRecord));

  // Update in persistent Postgres storage
  await dbService.rotateApiKey({
    oldKeyId: item.id,
    newId: crypto.randomUUID(),
    userAddress: address,
    name: item.name,
    newKeyHash: newHash,
    newKeyPrefix: newPrefix,
  });

  item.keyHash = newHash;
  item.keyPrefix = newPrefix;
  item.isRevoked = false;
  item.rotatedAt = rotatedAt;
  delete item.revokedAt;
  await writeUserKeys(address, userKeys);

  // Persistent audit log (BE-AUTH-009)
  const ipCountry = extractCountry(c);
  const userAgent = c.req.header("user-agent");
  void dbService.logAudit({
    userAddress: address,
    action: "KEY_ROTATE",
    ipCountry,
    userAgent,
    metadata: {
      keyId: item.id,
      newPrefix,
    },
  });

  return c.json({
    id: item.id,
    name: item.name,
    keyPrefix: newPrefix,
    apiKey: rawKey, // Displayed ONLY ONCE
    createdAt: item.createdAt,
    rotatedAt,
  });
});
