import { Module } from "@nestjs/common";
import { VerificationModule } from "../verifications/verification.module";
import { DigiLockerController } from "./digilocker.controller";
import { DigiLockerService } from "./digilocker.service";

@Module({
  imports: [VerificationModule],
  controllers: [DigiLockerController],
  providers: [DigiLockerService]
})
export class DigiLockerModule {}
