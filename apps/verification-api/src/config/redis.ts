import type { RedisOptions } from "ioredis";

export function redisConnectionOptions(): RedisOptions {
  const host = process.env.REDIS_HOST || "127.0.0.1";
  const tlsEnabled = process.env.REDIS_TLS === "true";

  return {
    host,
    port: Number(process.env.REDIS_PORT || 6380),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
    tls: tlsEnabled ? { servername: host } : undefined
  };
}
