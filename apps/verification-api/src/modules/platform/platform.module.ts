import { Module } from "@nestjs/common";
import { VerificationModule } from "../verifications/verification.module";
import { PlatformController } from "./platform.controller";

@Module({ imports: [VerificationModule], controllers: [PlatformController] })
export class PlatformModule {}
