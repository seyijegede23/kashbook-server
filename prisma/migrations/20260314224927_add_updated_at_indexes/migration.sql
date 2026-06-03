-- CreateIndex
CREATE INDEX "BusinessDebt_businessId_updatedAt_idx" ON "BusinessDebt"("businessId", "updatedAt");

-- CreateIndex
CREATE INDEX "Customer_businessId_updatedAt_idx" ON "Customer"("businessId", "updatedAt");

-- CreateIndex
CREATE INDEX "Expense_businessId_updatedAt_idx" ON "Expense"("businessId", "updatedAt");

-- CreateIndex
CREATE INDEX "InventoryItem_businessId_updatedAt_idx" ON "InventoryItem"("businessId", "updatedAt");

-- CreateIndex
CREATE INDEX "Invoice_businessId_updatedAt_idx" ON "Invoice"("businessId", "updatedAt");

-- CreateIndex
CREATE INDEX "Sales_businessId_updatedAt_idx" ON "Sales"("businessId", "updatedAt");

-- CreateIndex
CREATE INDEX "Transaction_businessId_updatedAt_idx" ON "Transaction"("businessId", "updatedAt");
