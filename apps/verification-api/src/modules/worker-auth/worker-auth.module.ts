import { Module } from "@nestjs/common";
import { AuthModule } from "../../common/auth/auth.module";
import { Msg91OtpProvider } from "../../integrations/msg91/msg91-otp.provider";
import { WorkerOtpController } from "./worker-otp.controller";
import { WorkerOtpService } from "./worker-otp.service";

@Module({
  imports: [AuthModule],
  controllers: [WorkerOtpController],
  providers: [Msg91OtpProvider, WorkerOtpService]
})
export class WorkerAuthModule {}
