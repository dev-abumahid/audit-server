-- AlterTable
-- gen_random_uuid() is built into Postgres core since v13 (no pgcrypto
-- extension needed) -- used here purely to backfill a distinct value per
-- existing row; new rows get their value from Prisma's own uuid() default
-- client-side (see account.schema.prisma), same as every future create.
ALTER TABLE "Account" ADD COLUMN "security_stamp" TEXT NOT NULL DEFAULT gen_random_uuid()::text;
ALTER TABLE "Account" ADD COLUMN "reset_token_stamp" TEXT NOT NULL DEFAULT gen_random_uuid()::text;

-- Drop the DB-level default after backfill -- Prisma always sends an
-- explicit value on create (client-side uuid()), so the default is
-- unnecessary going forward and would otherwise silently paper over a
-- forgotten explicit value in a raw SQL insert.
ALTER TABLE "Account" ALTER COLUMN "security_stamp" DROP DEFAULT;
ALTER TABLE "Account" ALTER COLUMN "reset_token_stamp" DROP DEFAULT;
