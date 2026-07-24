import { z } from 'zod';

// Generation takes almost nothing from the client — the report's content is
// derived server-side from the org's own Risk/KRI/Site/Action data. `type` is
// optional and only BOARD is supported for MVP (the service rejects anything
// else); `title` is an optional human override of the AI-generated title.
const generate_report = z.object({
  type: z.string().optional(),
  title: z.string().optional(),
});

export const report_validations = {
  generate_report,
};
