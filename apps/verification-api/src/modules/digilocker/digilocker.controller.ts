import { Body, Controller, Inject, Post, UseGuards } from "@nestjs/common";
import { ApiKeyGuard } from "../../common/auth/api-key.guard";
import { ClientContext, CurrentClient } from "../../common/auth/client-context";
import { ScopeGuard } from "../../common/auth/scope.guard";
import { RequireScopes } from "../../common/auth/scopes";
import type { DigiLockerInitializeData } from "../../integrations/document-session.types";
import { DigiLockerService } from "./digilocker.service";

@Controller("v1/digilocker")
@UseGuards(ApiKeyGuard, ScopeGuard)
export class DigiLockerController {
  constructor(@Inject(DigiLockerService) private readonly digilocker: DigiLockerService) {}

  @Post("initialize")
  @RequireScopes("digilocker:write")
  initialize(
    @Body() payload: { data?: Partial<DigiLockerInitializeData> },
    @CurrentClient() client: ClientContext
  ) {
    return this.digilocker.initialize(payload, client);
  }
}
