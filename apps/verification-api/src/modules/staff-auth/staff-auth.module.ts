import { Module } from "@nestjs/common";
import { StaffLoginController, StaffSessionController } from "./staff-auth.controller";
import { StaffOtpService } from "./staff-otp.service";
import { StaffPasskeyService } from "./staff-passkey.service";

@Module({
  controllers: [StaffLoginController, StaffSessionController],
  providers: [StaffOtpService, StaffPasskeyService]
})
export class StaffAuthModule {}
