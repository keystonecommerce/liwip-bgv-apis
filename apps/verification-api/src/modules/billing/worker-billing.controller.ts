import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { ApiKeyGuard } from "../../common/auth/api-key.guard";
import { ClientContext, CurrentClient } from "../../common/auth/client-context";
import { ScopeGuard } from "../../common/auth/scope.guard";
import { RequireScopes } from "../../common/auth/scopes";
import { CurrentWorker, WorkerGuard } from "../../common/auth/worker.guard";
import type { WorkerIdentity } from "../../common/auth/worker-token";
import { PrismaService } from "../../common/database/prisma.service";
import { id } from "../admin-panel/input";
import { billingConfig } from "./billing-config";
import { CatalogService, packageCode } from "./catalog.service";
import { CheckRatesService, pickRate } from "./check-rates.service";
import { isSelectableAvailable } from "../worker-cases/worker-case.service";
import { isSelectableCheck, SELECTABLE_CHECKS, type SelectableCheck } from "../worker-cases/worker-case.inputs";
import type { ApplicationSchema } from "../../domain/verification.types";
import { OrdersService } from "./orders.service";
import { QuoteService } from "./quote.service";

/** The Liwip app: an individual buys their own package. Same protection as their case. */
@Controller("v1/worker/billing")
@UseGuards(ApiKeyGuard, ScopeGuard, WorkerGuard)
@RequireScopes("worker:cases")
export class WorkerBillingController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(QuoteService) private readonly quotes: QuoteService,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(CheckRatesService) private readonly rates: CheckRatesService
  ) {}

  private async workerCase(worker: WorkerIdentity) {
    const application = await this.prisma.application.findFirst({ where: { tenantId: worker.tenantId, clientId: worker.clientId, workerPhone: worker.phone }, select: { id: true, status: true, packageId: true, data: true } });
    if (!application) throw new BadRequestException("Open your case first");
    return application;
  }

  /** The case's checks, and the types already paid for on it (its bundle or seat, and extras bought). */
  private async caseChecks(application: { id: string; data: unknown }) {
    const prepaid = await this.prisma.prepaidCase.findUnique({ where: { applicationId: application.id }, select: { coveredChecks: true } });
    return { selected: new Set<string>((application.data as ApplicationSchema).selectedChecks ?? []), paid: new Set<string>(Array.isArray(prepaid?.coveredChecks) ? (prepaid.coveredChecks as string[]) : []) };
  }

  /** Checks the person can buy for their case under way, each at the sum of its check prices. */
  @Get("extras")
  async extras(@CurrentWorker() worker: WorkerIdentity) {
    const application = await this.workerCase(worker);
    const { selected, paid } = await this.caseChecks(application);
    const rows = await this.rates.rowsFor(null);
    const now = new Date();
    const items = (Object.keys(SELECTABLE_CHECKS) as SelectableCheck[]).filter((check) => !selected.has(check) && isSelectableAvailable(check)).flatMap((check) => {
      const owed = SELECTABLE_CHECKS[check].types.filter((type) => !paid.has(type));
      const prices = owed.map((type) => pickRate(rows, null, type, now)?.unitPricePaise);
      if (prices.some((value) => value === undefined)) return [];
      return [{ check, unitPricePaise: (prices as number[]).reduce((sum, value) => sum + value, 0), paid: !owed.length }];
    });
    return { items };
  }

  /** Prices extra checks for the case. Pay with POST orders; then add them (POST /v1/worker/case/checks/add). */
  @Post("extras/quotes")
  async extrasQuote(@CurrentWorker() worker: WorkerIdentity, @Body() body: { checks?: string[] }) {
    const application = await this.workerCase(worker);
    if (application.status === "DRAFT") throw new BadRequestException("Approve your checks first");
    if (!application.packageId) throw new BadRequestException("Choose a bundle first");
    const pkg = await this.prisma.verificationPackage.findUniqueOrThrow({ where: { id: application.packageId }, select: { id: true, code: true, version: true, name: true } });
    const { selected, paid } = await this.caseChecks(application);
    const checks = [...new Set((Array.isArray(body?.checks) ? body.checks : []).map((item) => String(item).toUpperCase()))];
    if (!checks.length) throw new BadRequestException("Choose at least one check");
    for (const check of checks) {
      if (!isSelectableCheck(check) || !isSelectableAvailable(check)) throw new BadRequestException(`${check} is not available`);
      if (selected.has(check)) throw new BadRequestException(`${check} is already on your case`);
      const requires = SELECTABLE_CHECKS[check].requires;
      if (requires && !selected.has(requires) && !checks.includes(requires)) throw new BadRequestException(`${check} needs ${requires} as well`);
    }
    const types = [...new Set(checks.flatMap((check) => SELECTABLE_CHECKS[check as SelectableCheck].types))].filter((type) => !paid.has(type));
    if (!types.length) throw new BadRequestException("Already paid for. Add them to your case.");
    return this.quotes.createExtras({ type: "INDIVIDUAL", tenantId: worker.tenantId, clientId: worker.clientId, applicationId: application.id }, pkg, types);
  }

  @Get("catalog")
  catalogue() {
    return this.catalog.catalogFor(null);
  }

  @Post("quotes")
  async quote(@CurrentWorker() worker: WorkerIdentity, @Body() body: { packageCode?: string; addOns?: string[] }) {
    const application = await this.workerCase(worker);
    const sponsor = (application.data as unknown as ApplicationSchema).sponsor;
    if (sponsor) throw new BadRequestException(`${sponsor.partnerName} already paid for your bundle. Buy extra checks instead.`);
    return this.quotes.create({ type: "INDIVIDUAL", tenantId: worker.tenantId, clientId: worker.clientId, applicationId: application.id }, [{ packageCode: body?.packageCode, quantity: 1, addOns: body?.addOns }]);
  }

  @Post("orders")
  @HttpCode(200)
  async checkout(@CurrentWorker() worker: WorkerIdentity, @CurrentClient() _client: ClientContext, @Body() body: { quoteId?: string }, @Headers("idempotency-key") key?: string) {
    const application = await this.workerCase(worker);
    const name = String((application.data as { personal?: { nameAsAadhaar?: string } })?.personal?.nameAsAadhaar ?? "").slice(0, 100) || undefined;
    return this.orders.checkout(
      { type: "INDIVIDUAL", tenantId: worker.tenantId, clientId: worker.clientId, applicationId: application.id },
      body?.quoteId, key, { id: application.id, phone: worker.phone.slice(2), name }, `${billingConfig().workerAppUrl}/?order={order_id}`
    );
  }

  @Get("orders/:orderId")
  async order(@CurrentWorker() worker: WorkerIdentity, @Param("orderId") orderId: string) {
    const application = await this.workerCase(worker);
    return this.orders.get(String(orderId), { tenantId: worker.tenantId, clientId: worker.clientId, applicationId: application.id });
  }
}
