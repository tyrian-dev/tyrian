import { describe, it, expect } from "bun:test";
import { encryptSecret, decryptSecret } from "../src/services/crypto";

describe("Tyrian KMS & AES-256-GCM Secret Encryption Suite (BE-KEY-006)", () => {
  it("encrypts plaintext and decrypts back to original value", () => {
    const rawSubKey = "sk-or-v1-abcdef1234567890_mock_token_secret_key";
    const encrypted = encryptSecret(rawSubKey);

    expect(encrypted.startsWith("enc:v1:")).toBe(true);
    expect(encrypted).not.toContain(rawSubKey);

    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(rawSubKey);
  });

  it("produces unique ciphertexts for identical plaintext due to random IV", () => {
    const secret = "my_sensitive_openrouter_sub_key";
    const enc1 = encryptSecret(secret);
    const enc2 = encryptSecret(secret);

    expect(enc1).not.toBe(enc2);
    expect(decryptSecret(enc1)).toBe(secret);
    expect(decryptSecret(enc2)).toBe(secret);
  });

  it("handles legacy/mock token gracefully when not prefixed", () => {
    const legacyKey = "mock_sub_key_0x1234";
    expect(decryptSecret(legacyKey)).toBe(legacyKey);
  });

  it("fails closed and throws error when auth tag or ciphertext is tampered", () => {
    const encrypted = encryptSecret("sensitive_payload");
    const parts = encrypted.split(":");
    // Tamper the ciphertext portion deterministically
    const firstChar = parts[3][0];
    parts[3] = (firstChar === "a" ? "b" : "a") + parts[3].slice(1);
    const tampered = parts.join(":");

    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("does not double-encrypt an already encrypted string", () => {
    const original = "sk-live-123456";
    const enc = encryptSecret(original);
    const doubleEnc = encryptSecret(enc);

    expect(doubleEnc).toBe(enc);
    expect(decryptSecret(doubleEnc)).toBe(original);
  });
});
