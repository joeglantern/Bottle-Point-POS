-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "brandColor" TEXT,
ADD COLUMN     "logo" BYTEA,
ADD COLUMN     "logoType" TEXT,
ADD COLUMN     "logoUpdatedAt" TIMESTAMP(3);


ALTER TABLE "Business" ADD CONSTRAINT business_brand_color_format CHECK ("brandColor" IS NULL OR "brandColor" ~ '^#[0-9a-f]{6}$');
ALTER TABLE "Business" ADD CONSTRAINT business_logo_size CHECK ("logo" IS NULL OR octet_length("logo") <= 70000);
