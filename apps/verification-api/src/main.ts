import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadEnv } from "./config/env";

loadEnv();

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const allowedOrigins = String(process.env.CORS_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  app.enableCors(allowedOrigins.length ? { origin: allowedOrigins, credentials: true } : undefined);
  app.enableShutdownHooks();
  const port = Number(process.env.PORT || 3000);
  await app.listen(port, "0.0.0.0");
  console.log(`Verification API listening on http://localhost:${port}`);
}

bootstrap();
