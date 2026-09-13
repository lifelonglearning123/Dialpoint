import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "@/env";

/**
 * AES-256-GCM at-rest encryption, wire-compatible with Signal's
 * src/lib/crypto/credentials.ts (same CREDENTIALS_ENCRYPTION_KEY), so this app
 * can read agencies.*_enc and Signal could read tb.twilio_accounts.auth_token_enc.
 * Format: v1:<iv b64>:<tag b64>:<ciphertext b64>
 */
const PREFIX = "v1";

function key(): Buffer {
  const hex = env.CREDENTIALS_ENCRYPTION_KEY;
  if (!hex) throw new Error("CREDENTIALS_ENCRYPTION_KEY is not set");
  return Buffer.from(hex, "hex");
}

export function encryptCredential(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [PREFIX, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

export function decryptCredential(stored: string): string {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== PREFIX) throw new Error("Unrecognised credential ciphertext format");
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

export function decryptCredentialOrNull(stored: string | null | undefined): string | null {
  return stored ? decryptCredential(stored) : null;
}
