-- AlterTable
ALTER TABLE "Branch" ADD COLUMN     "formerIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

