import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const keyLength = 64;

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}

export async function hashPortalPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = await derive(password, salt);
  return `${salt}:${key.toString("hex")}`;
}

export async function verifyPortalPassword(password: string, storedHash: string): Promise<boolean> {
  const [salt, savedKey] = storedHash.split(":");
  if (!salt || !savedKey) return false;
  const derivedKey = await derive(password, salt);
  const savedBuffer = Buffer.from(savedKey, "hex");
  return savedBuffer.length === derivedKey.length && timingSafeEqual(savedBuffer, derivedKey);
}
