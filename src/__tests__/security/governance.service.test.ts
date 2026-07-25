import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, ORG_B, makeReq } from '../helpers/makeReq.js';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    risk: { findMany: vi.fn() },
    action: { findMany: vi.fn() },
    kri: { findMany: vi.fn() },
    complianceObligation: { findMany: vi.fn() },
    auditEngagement: { findMany: vi.fn() },
    orgMember: { findUnique: vi.fn() },
    organization: { findUnique: vi.fn() },
    inspectionAssignment: { findMany: vi.fn() },
    findingAssignment: { findMany: vi.fn() },
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import { governance_service } from '../../app/modules/governance/governance.service.js';

const riskDb = prisma.risk as unknown as Record<string, ReturnType<typeof vi.fn>>;
const actionDb = prisma.action as unknown as Record<string, ReturnType<typeof vi.fn>>;
const kriDb = prisma.kri as unknown as Record<string, ReturnType<typeof vi.fn>>;
const complianceDb = prisma.complianceObligation as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const auditDb = prisma.auditEngagement as unknown as Record<string, ReturnType<typeof vi.fn>>;
const orgMemberDb = prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe('governance service — GET /governance/three-lines-of-defense (#97)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no OrgMember row — ADMIN-of-self fallback, same as every
    // other org-scoped service's test file in this repo.
    orgMemberDb.findUnique.mockResolvedValue(null);
    riskDb.findMany.mockResolvedValue([]);
    actionDb.findMany.mockResolvedValue([]);
    kriDb.findMany.mockResolvedValue([]);
    complianceDb.findMany.mockResolvedValue([]);
    auditDb.findMany.mockResolvedValue([]);
  });

  it('scopes every one of the 5 model queries to the caller org (ORG_A), never ORG_B', async () => {
    await governance_service.get_three_lines_of_defense_from_db(makeReq());

    expect(riskDb.findMany.mock.calls[0][0].where).toMatchObject({ org_account_id: ORG_A });
    expect(actionDb.findMany.mock.calls[0][0].where).toMatchObject({ orgAccountId: ORG_A });
    expect(kriDb.findMany.mock.calls[0][0].where).toMatchObject({ org_account_id: ORG_A });
    expect(complianceDb.findMany.mock.calls[0][0].where).toMatchObject({ org_account_id: ORG_A });
    expect(auditDb.findMany.mock.calls[0][0].where).toMatchObject({ org_account_id: ORG_A });

    for (const call of [
      riskDb.findMany.mock.calls[0][0],
      actionDb.findMany.mock.calls[0][0],
      kriDb.findMany.mock.calls[0][0],
      complianceDb.findMany.mock.calls[0][0],
      auditDb.findMany.mock.calls[0][0],
    ]) {
      expect(JSON.stringify(call.where)).not.toContain(ORG_B);
    }
  });

  it('shapes each entity type as {id, title, line_of_defense, ...secondary fields}', async () => {
    riskDb.findMany.mockResolvedValue([
      {
        id: 'r1',
        name: 'Vendor risk',
        category: 'Financial',
        status: 'open',
        line_of_defense: 'FIRST',
      },
    ]);
    actionDb.findMany.mockResolvedValue([
      {
        id: 'a1',
        actionTitle: 'Patch it',
        priority: 'High',
        status: 'TO_DO',
        line_of_defense: null,
      },
    ]);
    kriDb.findMany.mockResolvedValue([
      {
        id: 'k1',
        name: 'Lead time',
        unit: 'days',
        current_value: 42,
        alert_threshold: 30,
        target_value: 20,
        line_of_defense: 'SECOND',
      },
    ]);
    complianceDb.findMany.mockResolvedValue([
      {
        id: 'c1',
        title: 'SOX control',
        domain: 'Financial',
        status: 'compliant',
        line_of_defense: 'SECOND',
      },
    ]);
    auditDb.findMany.mockResolvedValue([
      {
        id: 'e1',
        title: 'Q1 Audit',
        status: 'planned',
        lead_auditor: 'Jane Doe',
        line_of_defense: 'THIRD',
      },
    ]);

    const result = await governance_service.get_three_lines_of_defense_from_db(makeReq());

    expect(result.risks).toEqual([
      {
        id: 'r1',
        title: 'Vendor risk',
        category: 'Financial',
        status: 'open',
        line_of_defense: 'FIRST',
      },
    ]);
    expect(result.actions).toEqual([
      { id: 'a1', title: 'Patch it', priority: 'High', status: 'TO_DO', line_of_defense: null },
    ]);
    expect(result.kris[0]).toMatchObject({
      id: 'k1',
      title: 'Lead time',
      unit: 'days',
      line_of_defense: 'SECOND',
    });
    // ALERT because current_value (42) is above alert_threshold (30) for a
    // lower-is-better KRI (target 20 < threshold 30) — see kri.service.ts's
    // compute_kri_status, reused here rather than re-derived.
    expect(result.kris[0].status).toBe('ALERT');
    expect(result.complianceObligations).toEqual([
      {
        id: 'c1',
        title: 'SOX control',
        domain: 'Financial',
        status: 'compliant',
        line_of_defense: 'SECOND',
      },
    ]);
    expect(result.auditEngagements).toEqual([
      {
        id: 'e1',
        title: 'Q1 Audit',
        status: 'planned',
        lead_auditor: 'Jane Doe',
        line_of_defense: 'THIRD',
      },
    ]);
  });

  it('surfaces an unclassified (null line_of_defense) Action as null, not defaulted to any line', async () => {
    actionDb.findMany.mockResolvedValue([
      {
        id: 'a-legacy',
        actionTitle: 'Pre-#97 finding',
        priority: 'Low',
        status: 'COMPLETE',
        line_of_defense: null,
      },
    ]);

    const result = await governance_service.get_three_lines_of_defense_from_db(makeReq());

    expect(result.actions[0].line_of_defense).toBeNull();
  });

  it('scopes the Action query through applyActionScope (LIGHT_USER sees only sub-assigned findings)', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      id: 'member-1',
      organizationId: 'org-00000000-0000-0000-0000-000000000097',
      accountId: ORG_A,
      role: 'LIGHT_USER',
      status: 'ACTIVE',
      expiresAt: null,
    });
    (prisma.organization as unknown as Record<string, ReturnType<typeof vi.fn>>).findUnique = vi
      .fn()
      .mockResolvedValue({
        id: 'org-00000000-0000-0000-0000-000000000097',
        anchorAccountId: ORG_A,
      });
    (prisma.findingAssignment as unknown as Record<string, ReturnType<typeof vi.fn>>).findMany = vi
      .fn()
      .mockResolvedValue([{ actionId: 'assigned-action-1' }]);

    await governance_service.get_three_lines_of_defense_from_db(makeReq());

    const actionWhere = actionDb.findMany.mock.calls[0][0].where;
    expect(actionWhere.id).toEqual({ in: ['assigned-action-1'] });
  });
});
