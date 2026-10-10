import { Module } from "@nestjs/common";
import { AuthModule } from "../../common/auth/auth.module";
import { Msg91OtpProvider } from "../../integrations/msg91/msg91-otp.provider";
import { WorkerOtpController } from "./worker-otp.controller";
import { WorkerOtpService } from "./worker-otp.service";
import { WorkerPasskeyController } from "./worker-passkey.controller";
import { WorkerPasskeyService } from "./worker-passkey.service";

@Module({
  imports: [AuthModule],
  controllers: [WorkerOtpController, WorkerPasskeyController],
  providers: [Msg91OtpProvider, WorkerOtpService, WorkerPasskeyService]
})
export class WorkerAuthModule {}
