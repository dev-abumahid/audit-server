import { describe, expect, it } from 'vitest';
import { buildReportHtml, type ReportContent } from '../../app/utils/report_pdf.js';

// aexa-frontend#164: every included risk in a Board Report carries a visible
// approval badge so the board document is honest about review status. REJECTED
// never reaches the template (filtered upstream in report.service), so the
// template only needs to render APPROVED / PENDING_APPROVAL / NOT_SUBMITTED,
// plus the graceful no-badge case for an unmapped risk.

const baseContent = (topRisks: ReportContent['top_risks']): ReportContent => ({
  title: 'Board Risk Report',
  subtitle: 'Q3 2026',
  reference: 'BOARD-2026-Q3',
  classification: 'Confidential',
  executive_summary: 'Summary.',
  organization_summary: {
    name: 'Acme',
    site_count: 1,
    risk_count: topRisks.length,
    kri_count: 0,
    open_action_count: 0,
    narrative: 'Narrative.',
  },
  top_risks: topRisks,
  kri_dashboard: [],
  open_actions: [],
  outlook: 'Outlook.',
});

const risk = (
  ref: string,
  approval_status?: ReportContent['top_risks'][number]['approval_status'],
): ReportContent['top_risks'][number] => ({
  ref,
  title: `Risk ${ref}`,
  category: 'OPERATIONAL',
  site: 'HQ',
  inherent_score: 12,
  residual_score: 8,
  trend: 'STABLE',
  commentary: '',
  approval_status,
});

describe('report_pdf — per-risk approval badge (#164)', () => {
  it('renders the correct label + class for each approval state', () => {
    const html = buildReportHtml(
      baseContent([
        risk('r-approved', 'APPROVED'),
        risk('r-pending', 'PENDING_APPROVAL'),
        risk('r-unsub', 'NOT_SUBMITTED'),
      ]),
    );

    expect(html).toContain('class="approval approval-APPROVED">Approved<');
    expect(html).toContain('class="approval approval-PENDING_APPROVAL">Pending Review<');
    expect(html).toContain('class="approval approval-NOT_SUBMITTED">Not Reviewed<');
  });

  it('renders no badge for a risk with no approval_status (unmapped ref)', () => {
    const html = buildReportHtml(baseContent([risk('r-nolabel', undefined)]));

    // The risk row still renders, but with no approval span.
    expect(html).toContain('Risk r-nolabel');
    expect(html).not.toContain('class="approval');
  });

  it('defines the badge styles for all three states', () => {
    const html = buildReportHtml(baseContent([]));

    expect(html).toContain('.approval-APPROVED');
    expect(html).toContain('.approval-PENDING_APPROVAL');
    expect(html).toContain('.approval-NOT_SUBMITTED');
  });
});
