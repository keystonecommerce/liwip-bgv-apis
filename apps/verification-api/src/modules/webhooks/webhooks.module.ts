import { Module } from "@nestjs/common";
import { WebhookDispatcher } from "./webhook-dispatcher.service";
import { WebhooksController } from "./webhooks.controller";
import { WebhooksService } from "./webhooks.service";

@Module({
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookDispatcher],
  exports: [WebhookDispatcher]
})
export class WebhooksModule {}
