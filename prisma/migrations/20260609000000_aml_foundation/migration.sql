-- User: account status + freeze metadata
ALTER TABLE "User" ADD COLUMN "accountStatus" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "User" ADD COLUMN "complianceFreezeReason" TEXT;
ALTER TABLE "User" ADD COLUMN "complianceFrozenAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "complianceFrozenBy" TEXT;

-- Business: risk classification + account status (mirrors User but per-business)
ALTER TABLE "Business" ADD COLUMN "riskCategory" TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE "Business" ADD COLUMN "accountStatus" TEXT NOT NULL DEFAULT 'active';

-- Transaction: flag severity + compliance status
ALTER TABLE "Transaction" ADD COLUMN "flagSeverity" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "complianceStatus" TEXT NOT NULL DEFAULT 'clean';
CREATE INDEX "Transaction_complianceStatus_flagSeverity_idx"
  ON "Transaction"("complianceStatus", "flagSeverity");

-- AuditLog: append-only event record
CREATE TABLE "AuditLog" (
  "id"           TEXT NOT NULL,
  "actorType"    TEXT NOT NULL,
  "actorId"      TEXT,
  "action"       TEXT NOT NULL,
  "resourceType" TEXT,
  "resourceId"   TEXT,
  "ip"           TEXT,
  "userAgent"    TEXT,
  "metadata"     JSONB,
  "severity"     TEXT NOT NULL DEFAULT 'info',
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuditLog_actorId_idx"                ON "AuditLog"("actorId");
CREATE INDEX "AuditLog_resourceType_resourceId_idx" ON "AuditLog"("resourceType", "resourceId");
CREATE INDEX "AuditLog_severity_createdAt_idx"      ON "AuditLog"("severity", "createdAt");
CREATE INDEX "AuditLog_createdAt_idx"               ON "AuditLog"("createdAt");
CREATE INDEX "AuditLog_action_createdAt_idx"        ON "AuditLog"("action", "createdAt");

-- ComplianceFlag: open review queue
CREATE TABLE "ComplianceFlag" (
  "id"            TEXT NOT NULL,
  "userId"        TEXT NOT NULL,
  "businessId"    TEXT,
  "transactionId" TEXT,
  "ruleCode"      TEXT NOT NULL,
  "severity"      TEXT NOT NULL,
  "description"   TEXT NOT NULL,
  "metadata"      JSONB NOT NULL,
  "status"        TEXT NOT NULL DEFAULT 'open',
  "reviewedBy"    TEXT,
  "reviewedAt"    TIMESTAMP(3),
  "reviewerNote"  TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ComplianceFlag_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ComplianceFlag_status_severity_createdAt_idx"
  ON "ComplianceFlag"("status", "severity", "createdAt");
CREATE INDEX "ComplianceFlag_userId_idx"        ON "ComplianceFlag"("userId");
CREATE INDEX "ComplianceFlag_transactionId_idx" ON "ComplianceFlag"("transactionId");
