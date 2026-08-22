import { Module } from "@nestjs/common";
import { VerificationModule } from "./verification/module";

@Module({ imports: [VerificationModule] })
export class AppModule {}
