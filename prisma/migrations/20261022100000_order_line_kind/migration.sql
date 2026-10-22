-- PACKAGE: a package bought (seats, or an individual's own case). EXTRAS: checks a person buys for a case under way.
ALTER TABLE "OrderLine" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'PACKAGE';
