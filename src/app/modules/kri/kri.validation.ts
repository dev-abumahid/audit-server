import { z } from 'zod';

// #97: Three Lines of Defense classification. Not required on create — Kri
// has a sensible schema-level default (SECOND, see kri.prisma). Reassignment
// is gated in kri.service.ts: ADMIN/LEAD_AUDITOR via assertCanWriteOrgResource
// for the whole payload, plus (aexa-frontend#208) a stricter ADMIN-only
// check specifically when line_of_defense itself is being changed — see
// risk.validation.ts's identical comment for the third-line-independence
// reasoning. GOVERNING_BODY (aexa-frontend#208) added as a 4th selectable
// value.
const LINE_OF_DEFENSE_ENUM = z.enum(['FIRST', 'SECOND', 'THIRD', 'GOVERNING_BODY']);

const create_kri = z
  .object({
    risk_id: z.string().min(1, 'risk_id is required'),
    name: z.string().min(1, 'Name is required'),
    unit: z.string().min(1, 'Unit is required'),
    current_value: z.number(),
    alert_threshold: z.number(),
    target_value: z.number(),
    frequency: z.string().optional(),
    line_of_defense: LINE_OF_DEFENSE_ENUM.optional(),
  })
  // target_value and alert_threshold must differ so status computation can
  // infer which direction is "better" (see kri.service.ts's compute_kri_status).
  .refine((data) => data.target_value !== data.alert_threshold, {
    message: 'target_value and alert_threshold must be different',
    path: ['target_value'],
  });

const update_kri = z
  .object({
    name: z.string().min(1).optional(),
    unit: z.string().min(1).optional(),
    alert_threshold: z.number().optional(),
    target_value: z.number().optional(),
    frequency: z.string().optional(),
    line_of_defense: LINE_OF_DEFENSE_ENUM.optional(),
  })
  .refine(
    (data) =>
      data.target_value === undefined ||
      data.alert_threshold === undefined ||
      data.target_value !== data.alert_threshold,
    {
      message: 'target_value and alert_threshold must be different',
      path: ['target_value'],
    },
  );

const submit_value = z.object({
  current_value: z.number(),
});

export const kri_validations = {
  create_kri,
  update_kri,
  submit_value,
};
