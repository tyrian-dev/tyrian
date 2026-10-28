import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits for GCM
const PREFIX = "enc:v1:";

/**
 * Derives a deterministic 32-byte key from OR_KEY_ENC_KEY or fallback secret.
 */
function getEncryptionKey(): Buffer {
  const rawSecret =
    process.env.OR_KEY_ENC_KEY ||
    process.env.SESSION_SECRET ||
    "tyrian_default_dev_sub_key_encryption_key_32_bytes";

  return crypto.createHash("sha256").update(rawSecret).digest();
}

/**
 * Encrypts a plaintext secret (such as an OpenRouter sub-key) using AES-256-GCM.
 * Formats output as: enc:v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>
 */
export function encryptSecret(plaintext: string): string {
  if (!plaintext) return "";
  // Do not double-encrypt
  if (plaintext.startsWith(PREFIX)) return plaintext;

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypts an AES-256-GCM payload formatted with enc:v1:...
 * If string is not in encrypted format (e.g. legacy/mock token), returns as-is.
 */
export function decryptSecret(payload: string): string {
  if (!payload || !payload.startsWith(PREFIX)) {
    return payload;
  }

  const parts = payload.slice(PREFIX.length).split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted payload structure");
  }

  const [ivHex, authTagHex, cipherHex] = parts;
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(cipherHex, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}
