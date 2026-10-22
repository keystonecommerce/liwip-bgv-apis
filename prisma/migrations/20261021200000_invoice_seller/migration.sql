-- Keystone's registration on each invoice, as it stood when issued.
ALTER TABLE "Invoice" ADD COLUMN "sellerName" TEXT NOT NULL DEFAULT 'Keystone Commerce Private Limited',
ADD COLUMN "sellerGstin" TEXT NOT NULL DEFAULT '29AAMCK2232K1Z9';
