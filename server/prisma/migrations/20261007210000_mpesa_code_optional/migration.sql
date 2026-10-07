-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "requireMpesaCode" BOOLEAN NOT NULL DEFAULT true;


-- An M-Pesa payment may now be recorded without its code (shops that do not
-- require one). A code, when given, is still unique (Payment_mpesaRef_key).
ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS payment_mpesa_has_ref;
