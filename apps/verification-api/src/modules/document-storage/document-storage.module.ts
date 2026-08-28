import { Module } from "@nestjs/common";
import { DocumentStorageController } from "./document-storage.controller";
import { DocumentStorageService } from "./document-storage.service";

@Module({
  controllers: [DocumentStorageController],
  providers: [DocumentStorageService],
  exports: [DocumentStorageService]
})
export class DocumentStorageModule {}
