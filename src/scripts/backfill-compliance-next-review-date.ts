import { fileURLToPath } from 'node:url';
import { prisma } from '../app/lib/prisma.js';
import { RECURRENCE_INTERVAL_DAYS } from '../app/modules/compliance/compliance.service.js';

const PAGE_SIZE = 500;
const CONCURRENCY = 10;

function shouldClearNextReviewDate(recurrence: string | null | undefined): boolean {
  if (!recurrence) {
    return true;
  }

  const normalized = recurrence.trim().toLowerCase();

  if (!normalized || normalized === 'one_time') {
    return true;
  }

  return !Object.hasOwn(RECURRENCE_INTERVAL_DAYS, normalized);
}

async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let cursor = 0;

  const worker = async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await fn(item);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function backfillComplianceNextReviewDate() {
  const dryRun = process.argv.includes('--dry-run');

  let scanned = 0;
  let processed = 0;
  let skipped = 0;
  let failed = 0;

  let cursor: string | undefined;

  for (;;) {
    const obligations = await prisma.complianceObligation.findMany({
      take: PAGE_SIZE,
      orderBy: {
        id: 'asc',
      },
      ...(cursor && {
        cursor: { id: cursor },
        skip: 1,
      }),
    });

    if (obligations.length === 0) {
      break;
    }

    scanned += obligations.length;
    cursor = obligations[obligations.length - 1]!.id;

    await mapWithConcurrency(obligations, CONCURRENCY, async (obligation) => {
      if (
        obligation.next_review_date === null ||
        !shouldClearNextReviewDate(obligation.recurrence)
      ) {
        skipped += 1;
        return;
      }

      if (dryRun) {
        console.log(
          `[backfill-compliance-next-review-date] (dry-run) would clear next_review_date for obligation ${obligation.id}`,
        );
        processed += 1;
        return;
      }

      try {
        await prisma.complianceObligation.update({
          where: {
            id: obligation.id,
          },
          data: {
            next_review_date: null,
          },
        });

        processed += 1;
      } catch (err) {
        failed += 1;
        console.error(
          `[backfill-compliance-next-review-date] failed for obligation ${obligation.id}:`,
          err,
        );
      }
    });

    if (obligations.length < PAGE_SIZE) {
      break;
    }
  }

  console.log(
    `[backfill-compliance-next-review-date]${
      dryRun ? ' (dry-run)' : ''
    } done. obligations updated: ${processed}, obligations skipped: ${skipped}, obligations failed: ${failed}, total obligations scanned: ${scanned}`,
  );

  if (failed > 0) {
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  backfillComplianceNextReviewDate()
    .catch((err) => {
      console.error('[backfill-compliance-next-review-date] failed:', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
