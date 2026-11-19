ALTER TABLE "IntegrationSource"
  ADD COLUMN "allowedIpAddresses" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "rateLimitPerMinute" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "rateWindowStartedAt" TIMESTAMPTZ(6),
  ADD COLUMN "rateWindowCount" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "IntegrationSource_rate_limit_check" CHECK ("rateLimitPerMinute" BETWEEN 1 AND 6000),
  ADD CONSTRAINT "IntegrationSource_rate_count_check" CHECK ("rateWindowCount" >= 0);
