import { Global, Module } from "@nestjs/common";
import { EMAIL_SENDER, emailSenderFromEnv } from "../staff-auth/email-sender";
import { AdminAccessGuard } from "./admin-access.guard";
import { StaffSessionService } from "./staff-session.service";

/** Admin panel access: sessions, the one access guard and the email sender, for every admin module. */
@Global()
@Module({
  providers: [StaffSessionService, AdminAccessGuard, { provide: EMAIL_SENDER, useFactory: emailSenderFromEnv }],
  exports: [StaffSessionService, AdminAccessGuard, EMAIL_SENDER]
})
export class AdminAccessModule {}
