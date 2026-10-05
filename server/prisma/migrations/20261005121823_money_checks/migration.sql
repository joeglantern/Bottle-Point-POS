-- Rules the database enforces even if application code has a bug.
ALTER TABLE "Payment"      ADD CONSTRAINT payment_amount_positive   CHECK ("amountCents" > 0);
ALTER TABLE "Payment"      ADD CONSTRAINT payment_tendered_covers    CHECK ("tenderedCents" IS NULL OR "tenderedCents" >= "amountCents");
ALTER TABLE "Payment"      ADD CONSTRAINT payment_mpesa_has_ref      CHECK ("method" <> 'MPESA' OR "mpesaRef" IS NOT NULL);
ALTER TABLE "SaleLine"     ADD CONSTRAINT saleline_qty_positive      CHECK ("qty" > 0);
ALTER TABLE "SaleLine"     ADD CONSTRAINT saleline_price_nonneg      CHECK ("unitCents" >= 0);
ALTER TABLE "Sale"         ADD CONSTRAINT sale_totals_valid          CHECK ("subtotalCents" >= 0 AND "discountCents" >= 0 AND "discountCents" <= "subtotalCents" AND "totalCents" = "subtotalCents" - "discountCents");
ALTER TABLE "Product"      ADD CONSTRAINT product_price_nonneg       CHECK ("priceCents" >= 0);
ALTER TABLE "Shift"        ADD CONSTRAINT shift_float_nonneg         CHECK ("openingFloatCents" >= 0);
ALTER TABLE "MpesaRequest" ADD CONSTRAINT mpesa_amount_positive      CHECK ("amountCents" > 0);
ALTER TABLE "Refund"       ADD CONSTRAINT refund_amount_positive     CHECK ("amountCents" > 0);

-- A cashier can only have one open shift per branch at a time.
CREATE UNIQUE INDEX shift_one_open_per_user ON "Shift" ("userId", "branchId") WHERE "closedAt" IS NULL;

-- Audit log is append only.
CREATE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
