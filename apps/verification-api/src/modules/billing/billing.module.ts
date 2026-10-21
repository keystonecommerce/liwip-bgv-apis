import { BundleRequestsController } from "./bundle-requests.controller";
import { BundleRequestsService } from "./bundle-requests.service";
import { Module } from "@nestjs/common";
import { BillingAdminController, BillingPartnerController, BillingPublicController, WorkerBillingController, WorkerInvitesController } from "./billing.controller";
import { CashfreeGateway, PAYMENT_GATEWAY } from "./cashfree.client";
import { CatalogService } from "./catalog.service";
import { CheckRatesService } from "./check-rates.service";
import { InviteRedemptionService } from "./invite-redemption.service";
import { INVITE_SENDER, inviteSenderFromEnv } from "./invite-sender";
import { InvitesService } from "./invites.service";
import { OrdersService } from "./orders.service";
import { QuoteService } from "./quote.service";
import { RevenueService } from "./revenue.service";
import { SeatsService } from "./seats.service";
import { UsageBillingService } from "./usage-billing.service";

/** Packages and check prices, quotes, Cashfree orders, seats, invites, API usage statements and revenue. See docs/PRICING-AND-PAYMENTS.md. */
@Module({
  controllers: [BillingAdminController, BundleRequestsController, BillingPartnerController, WorkerBillingController, WorkerInvitesController, BillingPublicController],
  providers: [
    CatalogService, CheckRatesService, BundleRequestsService, QuoteService, SeatsService, OrdersService, InvitesService, InviteRedemptionService, UsageBillingService, RevenueService,
    { provide: PAYMENT_GATEWAY, useClass: CashfreeGateway },
    { provide: INVITE_SENDER, useFactory: inviteSenderFromEnv }
  ],
  exports: [CatalogService, SeatsService, OrdersService, InvitesService, UsageBillingService]
})
export class BillingModule {}
