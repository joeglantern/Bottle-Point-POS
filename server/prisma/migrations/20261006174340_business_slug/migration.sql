-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "slug" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Business_slug_key" ON "Business"("slug");


-- lowercase letters, digits and inner dashes, 3 to 40 characters
ALTER TABLE "Business" ADD CONSTRAINT business_slug_format CHECK ("slug" IS NULL OR "slug" ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$');
