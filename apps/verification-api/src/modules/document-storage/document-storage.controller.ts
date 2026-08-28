import { Body, Controller, Delete, Get, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { ApiKeyGuard } from "../../common/auth/api-key.guard";
import { ClientContext, CurrentClient } from "../../common/auth/client-context";
import { ScopeGuard } from "../../common/auth/scope.guard";
import { RequireScopes } from "../../common/auth/scopes";
import { DocumentStorageService } from "./document-storage.service";
import type { CreateDocumentUploadRequest } from "./document-storage.types";

@Controller("v1/applications/:applicationId/documents")
@UseGuards(ApiKeyGuard, ScopeGuard)
export class DocumentStorageController {
  constructor(@Inject(DocumentStorageService) private readonly documents: DocumentStorageService) {}

  @Post("upload-url")
  @RequireScopes("documents:write")
  createUploadUrl(
    @Param("applicationId") applicationId: string,
    @Body() payload: CreateDocumentUploadRequest,
    @CurrentClient() client: ClientContext
  ) {
    return this.documents.createUploadUrl(applicationId, payload, client);
  }

  @Post(":documentId/complete")
  @RequireScopes("documents:write")
  confirmUpload(
    @Param("applicationId") applicationId: string,
    @Param("documentId") documentId: string,
    @CurrentClient() client: ClientContext
  ) {
    return this.documents.confirmUpload(applicationId, documentId, client);
  }

  @Get()
  @RequireScopes("documents:read")
  list(
    @Param("applicationId") applicationId: string,
    @CurrentClient() client: ClientContext
  ) {
    return this.documents.list(applicationId, client);
  }

  @Get(":documentId/download-url")
  @RequireScopes("documents:read")
  createDownloadUrl(
    @Param("applicationId") applicationId: string,
    @Param("documentId") documentId: string,
    @CurrentClient() client: ClientContext
  ) {
    return this.documents.createDownloadUrl(applicationId, documentId, client);
  }

  @Delete(":documentId")
  @RequireScopes("documents:write")
  remove(
    @Param("applicationId") applicationId: string,
    @Param("documentId") documentId: string,
    @CurrentClient() client: ClientContext
  ) {
    return this.documents.remove(applicationId, documentId, client);
  }
}
