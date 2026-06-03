-- CreateIndex
CREATE INDEX "AppNotification_userId_createdAt_idx" ON "AppNotification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AppNotification_userId_read_idx" ON "AppNotification"("userId", "read");

-- CreateIndex
CREATE INDEX "Business_userId_idx" ON "Business"("userId");

-- CreateIndex
CREATE INDEX "Business_virtualAccountRef_idx" ON "Business"("virtualAccountRef");

-- CreateIndex
CREATE INDEX "BusinessDebt_userId_businessId_idx" ON "BusinessDebt"("userId", "businessId");

-- CreateIndex
CREATE INDEX "BusinessDebt_userId_status_idx" ON "BusinessDebt"("userId", "status");

-- CreateIndex
CREATE INDEX "Customer_userId_businessId_idx" ON "Customer"("userId", "businessId");

-- CreateIndex
CREATE INDEX "Debt_customerId_paid_idx" ON "Debt"("customerId", "paid");

-- CreateIndex
CREATE INDEX "Expense_userId_businessId_idx" ON "Expense"("userId", "businessId");

-- CreateIndex
CREATE INDEX "Expense_businessId_date_idx" ON "Expense"("businessId", "date");

-- CreateIndex
CREATE INDEX "InventoryItem_userId_businessId_idx" ON "InventoryItem"("userId", "businessId");

-- CreateIndex
CREATE INDEX "Invoice_businessId_userId_idx" ON "Invoice"("businessId", "userId");

-- CreateIndex
CREATE INDEX "Invoice_businessId_status_idx" ON "Invoice"("businessId", "status");

-- CreateIndex
CREATE INDEX "OtpCode_identifier_type_idx" ON "OtpCode"("identifier", "type");

-- CreateIndex
CREATE INDEX "Payable_businessId_paid_idx" ON "Payable"("businessId", "paid");

-- CreateIndex
CREATE INDEX "Reminder_status_scheduledFor_idx" ON "Reminder"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "Reminder_userId_idx" ON "Reminder"("userId");

-- CreateIndex
CREATE INDEX "Sales_userId_businessId_idx" ON "Sales"("userId", "businessId");

-- CreateIndex
CREATE INDEX "Sales_businessId_date_idx" ON "Sales"("businessId", "date");

-- CreateIndex
CREATE INDEX "Transaction_businessId_date_idx" ON "Transaction"("businessId", "date");

-- CreateIndex
CREATE INDEX "Transaction_userId_idx" ON "Transaction"("userId");
