-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "clientId" TEXT;

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "clientId" TEXT,
ADD COLUMN     "deviceId" TEXT,
ADD COLUMN     "offlineRef" TEXT,
ADD COLUMN     "syncedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Shift" ADD COLUMN     "clientId" TEXT;

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "tokenHash" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfflineOp" (
    "opId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "refClientId" TEXT,
    "refId" TEXT,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfflineOp_pkey" PRIMARY KEY ("opId")
);

-- CreateTable
CREATE TABLE "OfflineIssue" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "deviceId" TEXT,
    "saleId" TEXT,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolveNote" TEXT,

    CONSTRAINT "OfflineIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Device_tokenHash_key" ON "Device"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Device_businessId_code_key" ON "Device"("businessId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "OfflineOp_refClientId_key" ON "OfflineOp"("refClientId");

-- CreateIndex
CREATE INDEX "OfflineOp_deviceId_createdAt_idx" ON "OfflineOp"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "OfflineIssue_branchId_resolvedAt_createdAt_idx" ON "OfflineIssue"("branchId", "resolvedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_clientId_key" ON "Payment"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_clientId_key" ON "Sale"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_deviceId_offlineRef_key" ON "Sale"("deviceId", "offlineRef");

-- CreateIndex
CREATE UNIQUE INDEX "Shift_clientId_key" ON "Shift"("clientId");

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
