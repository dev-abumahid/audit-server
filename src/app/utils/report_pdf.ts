import puppeteer from 'puppeteer';
import { configs } from '../configs/index.js';

// Brand teal — the frontend's --primary (hsl(168 60% 36%)). Hard-coded here
// rather than imported because this HTML is rendered by a headless Chromium in
// the server process, with no access to the frontend's Tailwind/CSS variables.
const BRAND_TEAL = '#25988a';
const BRAND_TEAL_DARK = '#1c7568';

// The structured content shape aexa-ai's /report_content returns (normalized
// server-side there). Kept as a local interface so the template is typed
// without coupling to Prisma's Json column type.
// A risk's live approval state as it appears in a report (aexa-frontend#164).
// REJECTED is deliberately absent: a risk with a live REJECTED approval is
// excluded from the report entirely upstream (report.service.fetchOrgData), so
// it can never reach the template. Every included risk carries one of these.
export type ReportRiskApprovalStatus = 'APPROVED' | 'PENDING_APPROVAL' | 'NOT_SUBMITTED';

export interface ReportTopRisk {
  ref: string;
  title: string;
  category: string;
  site: string;
  inherent_score: number;
  residual_score: number;
  trend: string;
  commentary: string;
  // Attached post-generation by report.service, joined to the AI's output by
  // `ref`. Optional so a stray/hallucinated ref the AI emits that we can't map
  // simply renders no badge rather than throwing.
  approval_status?: ReportRiskApprovalStatus;
}

export interface ReportKriSnapshot {
  name: string;
  unit: string;
  current_value: number;
  target_value: number;
  alert_threshold: number;
  status: string;
  commentary: string;
}

export interface ReportOpenAction {
  title: string;
  priority: string;
  status: string;
  due_date: string;
  commentary: string;
}

export interface ReportContent {
  title: string;
  subtitle: string;
  reference: string;
  classification: string;
  executive_summary: string;
  organization_summary: {
    name: string;
    site_count: number;
    risk_count: number;
    kri_count: number;
    open_action_count: number;
    narrative: string;
  };
  top_risks: ReportTopRisk[];
  kri_dashboard: ReportKriSnapshot[];
  open_actions: ReportOpenAction[];
  outlook: string;
}

// Minimal HTML-escape — every value below comes from the org's own data or the
// AI's output, but it's still interpolated into markup, so escape it rather
// than trust it. Prevents a stray `<`/`&` in a risk title from breaking the
// layout or injecting markup into the rendered PDF.
const esc = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const formatDate = (d: Date): string =>
  d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

const section = (title: string, body: string): string =>
  `<section class="section"><h2>${esc(title)}</h2>${body}</section>`;

const emptyRow = (cols: number, text: string): string =>
  `<tr><td colspan="${cols}" class="empty">${esc(text)}</td></tr>`;

// The per-risk approval badge (aexa-frontend#164). Every included risk gets a
// tag so the board document is honest about review status without hiding any
// content. APPROVED reads as a positive sign-off; PENDING_APPROVAL and
// NOT_SUBMITTED read as "not yet a signed-off figure". A missing status (a ref
// the service couldn't map) renders nothing rather than a misleading label.
const APPROVAL_BADGE_LABEL: Record<ReportRiskApprovalStatus, string> = {
  APPROVED: 'Approved',
  PENDING_APPROVAL: 'Pending Review',
  NOT_SUBMITTED: 'Not Reviewed',
};

const approvalBadge = (status: ReportTopRisk['approval_status']): string => {
  if (!status || !(status in APPROVAL_BADGE_LABEL)) return '';
  return `<span class="approval approval-${esc(status)}">${esc(APPROVAL_BADGE_LABEL[status])}</span>`;
};

const buildRiskRows = (risks: ReportTopRisk[]): string => {
  if (!risks.length) return emptyRow(6, 'No open risks recorded for this period.');
  return risks
    .map(
      (r) => `<tr>
        <td class="mono">${esc(r.ref)}</td>
        <td><strong>${esc(r.title)}</strong>${approvalBadge(r.approval_status)}<div class="muted">${esc(r.commentary)}</div></td>
        <td>${esc(r.category)}</td>
        <td>${esc(r.site)}</td>
        <td class="num">${esc(r.inherent_score)}</td>
        <td class="num">${esc(r.residual_score)}</td>
      </tr>`,
    )
    .join('');
};

const buildKriRows = (kris: ReportKriSnapshot[]): string => {
  if (!kris.length) return emptyRow(5, 'No key risk indicators recorded.');
  return kris
    .map(
      (k) => `<tr>
        <td><strong>${esc(k.name)}</strong><div class="muted">${esc(k.commentary)}</div></td>
        <td class="num">${esc(k.current_value)} ${esc(k.unit)}</td>
        <td class="num">${esc(k.target_value)} ${esc(k.unit)}</td>
        <td class="num">${esc(k.alert_threshold)} ${esc(k.unit)}</td>
        <td><span class="badge badge-${esc(k.status)}">${esc(k.status || 'n/a')}</span></td>
      </tr>`,
    )
    .join('');
};

const buildActionRows = (actions: ReportOpenAction[]): string => {
  if (!actions.length) return emptyRow(4, 'No open action items.');
  return actions
    .map(
      (a) => `<tr>
        <td><strong>${esc(a.title)}</strong><div class="muted">${esc(a.commentary)}</div></td>
        <td>${esc(a.priority)}</td>
        <td>${esc(a.status)}</td>
        <td>${esc(a.due_date)}</td>
      </tr>`,
    )
    .join('');
};

/**
 * Builds the self-contained HTML for a Board Report from aexa-ai's structured
 * content. Single-file, no external assets (Puppeteer renders it with no
 * network), so it's safe to run headless and offline.
 */
export const buildReportHtml = (content: ReportContent): string => {
  const now = new Date();
  const org = content.organization_summary;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1a1a1a; margin: 0; font-size: 12px; }
  .cover { height: 100vh; display: flex; flex-direction: column; justify-content: center;
    padding: 60px; background: linear-gradient(135deg, ${BRAND_TEAL} 0%, ${BRAND_TEAL_DARK} 100%); color: #fff; }
  .cover .classification { text-transform: uppercase; letter-spacing: 3px; font-size: 11px; opacity: 0.85; }
  .cover h1 { font-size: 34px; margin: 16px 0 8px; font-weight: 700; }
  .cover .subtitle { font-size: 16px; opacity: 0.9; }
  .cover .meta { margin-top: 48px; font-size: 12px; line-height: 1.9; opacity: 0.95; }
  .cover .meta strong { display: inline-block; width: 130px; opacity: 0.8; font-weight: 400; }
  .page { padding: 40px 48px; page-break-before: always; }
  h2 { color: ${BRAND_TEAL_DARK}; font-size: 18px; border-bottom: 2px solid ${BRAND_TEAL};
    padding-bottom: 6px; margin: 0 0 14px; }
  .section { margin-bottom: 28px; }
  p { line-height: 1.6; margin: 0 0 10px; }
  .stats { display: flex; gap: 12px; margin-bottom: 20px; }
  .stat { flex: 1; border: 1px solid #e2e8e6; border-radius: 8px; padding: 12px; text-align: center; }
  .stat .n { font-size: 24px; font-weight: 700; color: ${BRAND_TEAL_DARK}; }
  .stat .l { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #667; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th { background: ${BRAND_TEAL}; color: #fff; text-align: left; padding: 8px 10px; font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.5px; }
  td { padding: 8px 10px; border-bottom: 1px solid #eef2f1; vertical-align: top; }
  tr:nth-child(even) td { background: #f7faf9; }
  .mono { font-family: 'Courier New', monospace; font-weight: 700; color: ${BRAND_TEAL_DARK}; }
  .num { text-align: center; font-variant-numeric: tabular-nums; font-weight: 600; }
  .muted { color: #778; font-size: 10px; margin-top: 3px; line-height: 1.4; }
  .empty { text-align: center; color: #99a; font-style: italic; padding: 18px; }
  .badge { padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 700; text-transform: uppercase; }
  .badge-ALERT { background: #fde8e8; color: #c0392b; }
  .badge-WARNING { background: #fef3d7; color: #b7791f; }
  .badge-OK { background: #e3f5ef; color: ${BRAND_TEAL_DARK}; }
  .approval { display: inline-block; margin-left: 8px; padding: 1px 7px; border-radius: 10px;
    font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px;
    vertical-align: middle; }
  .approval-APPROVED { background: #e3f5ef; color: ${BRAND_TEAL_DARK}; }
  .approval-PENDING_APPROVAL { background: #fef3d7; color: #b7791f; }
  .approval-NOT_SUBMITTED { background: #eef1f4; color: #64748b; }
  .outlook { background: #f7faf9; border-left: 3px solid ${BRAND_TEAL}; padding: 14px 18px; border-radius: 4px; }
  .footer-note { margin-top: 40px; font-size: 10px; color: #99a; text-align: center; }
</style>
</head>
<body>
  <div class="cover">
    <div class="classification">${esc(content.classification || 'Confidential')}</div>
    <h1>${esc(content.title)}</h1>
    <div class="subtitle">${esc(content.subtitle)}</div>
    <div class="meta">
      <div><strong>Organization</strong> ${esc(org.name)}</div>
      <div><strong>Reference</strong> ${esc(content.reference || 'N/A')}</div>
      <div><strong>Generated</strong> ${esc(formatDate(now))}</div>
    </div>
  </div>

  <div class="page">
    ${section('Executive Summary', `<p>${esc(content.executive_summary)}</p>`)}
    ${section(
      'Organization Overview',
      `<div class="stats">
        <div class="stat"><div class="n">${esc(org.site_count)}</div><div class="l">Sites</div></div>
        <div class="stat"><div class="n">${esc(org.risk_count)}</div><div class="l">Risks</div></div>
        <div class="stat"><div class="n">${esc(org.kri_count)}</div><div class="l">KRIs</div></div>
        <div class="stat"><div class="n">${esc(org.open_action_count)}</div><div class="l">Open Actions</div></div>
      </div>
      <p>${esc(org.narrative)}</p>`,
    )}
    ${section(
      'Top Risks',
      `<table><thead><tr><th>Ref</th><th>Risk</th><th>Category</th><th>Site</th>
        <th class="num">Inherent</th><th class="num">Residual</th></tr></thead>
        <tbody>${buildRiskRows(content.top_risks)}</tbody></table>`,
    )}
    ${section(
      'KRI Dashboard',
      `<table><thead><tr><th>Indicator</th><th class="num">Current</th><th class="num">Target</th>
        <th class="num">Alert</th><th>Status</th></tr></thead>
        <tbody>${buildKriRows(content.kri_dashboard)}</tbody></table>`,
    )}
    ${section(
      'Open Action Items',
      `<table><thead><tr><th>Action</th><th>Priority</th><th>Status</th><th>Due</th></tr></thead>
        <tbody>${buildActionRows(content.open_actions)}</tbody></table>`,
    )}
    ${section('Outlook', `<div class="outlook"><p>${esc(content.outlook)}</p></div>`)}
    <div class="footer-note">
      ${esc(content.classification || 'Confidential')} — generated by Qiyrix on ${esc(formatDate(now))}.
      This report reflects data at time of generation.
    </div>
  </div>
</body>
</html>`;
};

/**
 * Renders the Board Report HTML to a PDF buffer via headless Chromium.
 *
 * In production (Alpine container) Puppeteer's bundled Chromium can't run, so
 * PUPPETEER_EXECUTABLE_PATH points at the apk-installed system Chromium (see
 * Dockerfile). --no-sandbox/--disable-setuid-sandbox are required to run
 * Chromium as a non-root-capable process inside a container; --disable-dev-shm-usage
 * avoids the small default /dev/shm crashing Chromium under memory pressure.
 *
 * The browser is always closed in finally so a render failure can't leak a
 * Chromium process.
 */
export const renderReportPdf = async (content: ReportContent): Promise<Buffer> => {
  const html = buildReportHtml(content);
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: configs.puppeteer_executable_path || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    // 'load' (not 'networkidle0') — the HTML is fully self-contained with no
    // external requests, so there's no network to wait to go idle.
    await page.setContent(html, { waitUntil: 'load' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
};
