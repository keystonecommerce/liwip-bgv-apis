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

  // CORS_ORIGINS plus the admin panel's origins (ADMIN_PANEL_ORIGINS). The admin panel sends
  // its session cookie, so only these exact origins may make credentialed requests.
  const allowedOrigins = [...new Set([process.env.CORS_ORIGINS, process.env.ADMIN_PANEL_ORIGINS]
    .flatMap((value) => String(value || "").split(","))
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean))];

  // Fail CLOSED: an unset CORS_ORIGINS must NOT open the API to every origin in
  // production. Explicit origins are always honoured; dev stays permissive.
  if (allowedOrigins.length) {
    app.enableCors({ origin: allowedOrigins, credentials: true });
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

