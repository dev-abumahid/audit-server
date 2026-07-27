import { z } from 'zod';

// z.string().url() alone accepts any URL the WHATWG URL constructor parses,
// which includes javascript:/data: schemes — not just http(s). Attachment
// URLs are rendered as links/images, so the scheme itself must be checked,
// not just "is this URL-shaped".
const httpUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => /^https?:\/\//i.test(value), {
    message: 'Attachment URL must be http(s)',
  });

const PRIORITY_ENUM = z.enum(['Low', 'Medium', 'High']);

const STATUS_ENUM = z.enum(['TO_DO', 'IN_PROGRESS', 'COMPLETE', 'CANT_DO']);

// #97 (Three Lines of Defense): unlike Risk/Kri/ComplianceObligation/
// AuditEngagement, Action has NO schema-level default (see action.prisma's
// line_of_defense comment) — it covers both remediation work (1st-line-like)
// and audit findings (3rd-line-like), so guessing a default would misclassify
// roughly half of them. Required (not optional) on create so every NEW Action
// going forward is explicitly classified; existing rows stay NULL
// ("Unclassified" in the UI) and are never forced through this requirement
// via update_action, which keeps it optional (see below).
const LINE_OF_DEFENSE_ENUM = z.enum(['FIRST', 'SECOND', 'THIRD']);

// Message Schema
const actionMessageSchema = z.object({
  actionId: z.string().optional(),
  senderAccountId: z.string().optional(),
  message: z.string().min(1),
});

// Create Action
const create_action = z.object({
  inspectionId: z.string().min(1),

  siteId: z.string().optional(),
  questionId: z.string().optional(),

  // Optional back-link to the ComplianceObligation this action remediates
  // (aexa-frontend#166). Same "sparse optional FK, id string only" shape as
  // questionId above; ownership is verified org-side in create_action_into_db
  // (a bare id here is not proof the caller owns that obligation).
  complianceObligationId: z.string().optional(),

  // aexa-server#244: formal engagement<->finding link, same "sparse optional
  // FK, id string only, ownership verified org-side" shape as
  // complianceObligationId above. Accepted here for both create and update
  // (update_action is this schema's `.partial()`), but — like
  // complianceObligationId — deliberately NOT part of
  // update_action_into_db's writable field set; see action.prisma's
  // auditEngagementId comment for why it's set-once-at-creation only.
  auditEngagementId: z.string().optional(),

  actionTitle: z.string().min(1).max(255),
  // Deliberately optional -- aexa-frontend's CreateNewFindingModal.tsx labels
  // this "Description (Optional)" and sends `undefined` (not "") when left
  // blank. Matches templateDisc's String?/optional() convention (same
  // "-Disc" naming, same "genuinely optional description" shape).
  actionDisc: z.string().optional(),

  // aexa-server#244: IIA's "Five Cs" minus Corrective Action (already
  // covered by actionTitle/actionDisc/priority/dueDate above). All optional
  // — see action.prisma's own comment for why this stays a product-level
  // "not required" rather than mirroring line_of_defense's
  // required-on-create treatment.
  criteria: z.string().max(5000).optional(),
  condition: z.string().max(5000).optional(),
  cause: z.string().max(5000).optional(),
  effect: z.string().max(5000).optional(),

  priority: PRIORITY_ENUM,

  dueDate: z.coerce.date(),

  status: STATUS_ENUM.optional().default('TO_DO'),

  // Required on create — see LINE_OF_DEFENSE_ENUM's comment above for why
  // this is the one field, among the 5 models #97 touches, that's mandatory
  // at the application-validation layer despite being DB-nullable.
  line_of_defense: LINE_OF_DEFENSE_ENUM,

  // File URLs returned by POST /action/attachment (uploaded separately,
  // then attached to the action by URL — same two-step pattern as
  // inspection's upload-file-aws flow). Restricted to http(s) URLs and
  // capped in count/length: this field is set directly by the client, not
  // just via the upload endpoint, so it's a real input-validation boundary —
  // an unrestricted array of unrestricted strings would allow a
  // javascript:/data: URI stored wherever attachments are later rendered as
  // links or images, plus an unbounded per-row storage footprint. Found by
  // independent review.
  attachments: z.array(httpUrl).max(10).optional(),

  // "Assigned Responsible" — a plain informational tag, not access control
  // (see ActionResponsible's own schema comment for why this is a separate
  // model from FindingAssignment). OrgMember ids, not Account ids —
  // confirmed against what aexa-frontend's CreateNewFindingModal.tsx
  // actually submits. Capped in count for the same reason attachments is:
  // client-set field, real input-validation boundary. Rejected here (not
  // silently deduped) if the same id appears twice — ActionResponsible has
  // a DB-level @@unique([actionId, orgMemberId]), so a duplicate would
  // otherwise reach Prisma as an unhandled unique-constraint error instead
  // of a clean 4xx. Found by independent review.
  assignBy: z
    .array(z.string().min(1))
    .max(20)
    .optional()
    .refine((ids) => !ids || new Set(ids).size === ids.length, {
      message: 'assignBy contains duplicate ids',
    }),

  // relation
  messages: z.array(actionMessageSchema).optional(),
});

// Update Action
const update_action = create_action.partial();

// Slice 4 (#55): sub-assign a finding to an internal Light User member.
// Slice 5 extends this to an external Light User via externalOrgMemberId —
// exactly one of the two must be present, never both/neither, since a
// FindingAssignment row is one or the other (see the model's own schema
// comment on its two partial unique indexes).
const assign_light_user = z
  .object({
    orgMemberId: z.string().min(1).optional(),
    externalOrgMemberId: z.string().min(1).optional(),
  })
  .refine((data) => Boolean(data.orgMemberId) !== Boolean(data.externalOrgMemberId), {
    message: 'Provide exactly one of orgMemberId or externalOrgMemberId.',
  });

// Types
export type ActionInput = z.infer<typeof create_action>;
export type ActionMessageInput = z.infer<typeof actionMessageSchema>;

const update_action_messages = z.object({
  // .min(1) to match actionMessageSchema's convention for the same
  // conceptual field -- without it an empty string passes validation and
  // creates an empty message row. Found by independent review.
  message: z.string('Message text is required!').min(1),
});

// Export
export const action_validations = {
  create_action,
  update_action,
  actionMessageSchema,
  assign_light_user,
  update_action_messages,
};
