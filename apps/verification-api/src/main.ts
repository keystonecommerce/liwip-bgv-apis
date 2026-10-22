import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import helmet from "helmet";
import type { Request, Response, NextFunction } from "express";
import { AppModule } from "./app.module";
import { loadEnv } from "./config/env";

loadEnv();

async function bootstrap() {
  // rawBody: Cashfree webhook signatures are checked against the exact bytes received.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const isProduction = process.env.NODE_ENV === "production";

  // Trust the reverse proxy so req.ip / rate-limit tracking reflect the real
  // client, not the load balancer. TRUST_PROXY_HOPS controls how many hops.
  app.getHttpAdapter().getInstance().set("trust proxy", Number(process.env.TRUST_PROXY_HOPS || 0));

  // Security headers on every response.
  app.use(helmet());
  app.use((_req: Request, res: Response, next: NextFunction) => { res.setHeader("Cache-Control", "no-store"); next(); });

  // Strip unknown properties from validated DTOs and coerce types.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // CORS_ORIGINS plus the admin apps' origins (ADMIN_PANEL_ORIGINS). Only the admin apps send the
  // staff session cookie, so only they get credentialed CORS; other origins get plain CORS.
  const originsOf = (value: string | undefined) => String(value || "").split(",").map((item) => item.trim().replace(/\/+$/, "")).filter(Boolean);
  const adminOrigins = new Set(originsOf(process.env.ADMIN_PANEL_ORIGINS));
  const allowedOrigins = new Set([...originsOf(process.env.CORS_ORIGINS), ...adminOrigins]);

  // Fail CLOSED: an unset CORS_ORIGINS must NOT open the API to every origin in
  // production. Explicit origins are always honoured; dev stays permissive.
  if (allowedOrigins.size) {
    app.enableCors((req: Request, callback: (error: Error | null, options: { origin: boolean; credentials: boolean }) => void) => {
      const origin = String(req.header("origin") ?? "");
      callback(null, { origin: allowedOrigins.has(origin), credentials: adminOrigins.has(origin) });
    });
  } else if (isProduction) {
    app.enableCors({ origin: false });
  } else {
    app.enableCors({ origin: true, credentials: true });
  }

  app.enableShutdownHooks();
  const port = Number(process.env.PORT || 3000);
  await app.listen(port, "0.0.0.0");
  console.log(`Verification API listening on http://localhost:${port}`);
}

bootstrap();

