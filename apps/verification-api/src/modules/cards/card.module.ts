import { Module } from "@nestjs/common";
import { CardController } from "./card.controller";
import { CardService } from "./card.service";
import { PublicCardController } from "./public-card.controller";

@Module({
  controllers: [CardController, PublicCardController],
  providers: [CardService]
})
export class CardModule {}
