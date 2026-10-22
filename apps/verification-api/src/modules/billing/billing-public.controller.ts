import { Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { InvitesService } from "./invites.service";
import { OrdersService } from "./orders.service";

/** Public: Cashfree's webhook (signature checked against the raw body) and invite links. */
@Controller()
export class BillingPublicController {
  constructor(@Inject(OrdersService) private readonly orders: OrdersService, @Inject(InvitesService) private readonly invites: InvitesService) {}

  @Post("v1/payments/cashfree/webhook")
  @HttpCode(200)
  webhook(@Req() request: Request & { rawBody?: Buffer }) {
    return this.orders.handleWebhook(request.rawBody, request.headers);
  }

  @Get("v/:token")
  async invite(@Param("token") token: string, @Res() response: Response) {
    response.redirect(302, await this.invites.landing(String(token)));
  }
}
