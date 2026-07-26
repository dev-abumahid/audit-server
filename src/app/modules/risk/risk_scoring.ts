/**
 * aexa-server#241 — derives `residual_score` from `inherent_score` and the
 * two COSO control-effectiveness dimensions instead of leaving it a
 * free-typed number nobody actually computes.
 *
 * Formula (ISO 31000 / COSO ERM, confirmed via industry research done for
 * this ticket): Residual = Inherent x (1 - ControlEffectiveness), where
 * ControlEffectiveness = designEff x operatingEff (design and operating
 * effectiveness are sequential gates, not averaged — a badly-designed
 * control can't be "operating effectively" no matter how consistently it's
 * executed, so multiplying is correct where a weighted average or min()
 * would understate a design gap). Capped at 0.90: no realistic control set
 * eliminates residual risk entirely.
 *
 * Scope note (ticket #241 decision 3): a real `impact` field was added
 * (risk.prisma) so the risk matrix's likelihood x impact axes are
 * independent instead of faking impact from inherent_score (#202). This
 * file deliberately does NOT redefine inherent_score as
 * probability x impact — inherent_score is fed by several existing
 * producers (manual entry, AI onboarding generation, intelligence-item
 * promotion) that each have their own established semantics for it, and
 * retroactively changing what it means is a larger, separate change than
 * "wire up the control-effectiveness fields that already exist." Deferred
 * as a fast-follow rather than bundled in silently.
 */

const MAX_CONTROL_EFFECTIVENESS = 0.9;

/** Clamps a raw 0-100 percentage input to the valid [0, 100] range. */
function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * Combines design and operating effectiveness (each 0-100) into a single
 * 0-0.90 control-effectiveness fraction. Returns null if either input is
 * missing — "no controls assessed yet" is not the same as "controls
 * assessed and found to be 0% effective".
 */
export function computeControlEffectiveness(
  designEff: number | null | undefined,
  operatingEff: number | null | undefined,
): number | null {
  if (designEff == null || operatingEff == null) return null;
  const combined = (clampPercent(designEff) / 100) * (clampPercent(operatingEff) / 100);
  return Math.min(combined, MAX_CONTROL_EFFECTIVENESS);
}

/**
 * Computes the derived residual score for a risk. Returns null when
 * inherent_score itself is unknown (nothing to discount from). When control
 * effectiveness hasn't been assessed yet (either eff field is null), the
 * residual score defaults to the full inherent score — matching the
 * pre-existing behavior of the risk-creation paths that set
 * residual_score = inherent_score before any control had been evaluated
 * (onboarding.service.ts, intelligence.service.ts).
 */
export function computeResidualScore(
  inherentScore: number | null | undefined,
  designEff: number | null | undefined,
  operatingEff: number | null | undefined,
): number | null {
  if (inherentScore == null) return null;
  const controlEff = computeControlEffectiveness(designEff, operatingEff);
  if (controlEff == null) return Math.round(clampPercent(inherentScore));
  return Math.round(clampPercent(inherentScore) * (1 - controlEff));
}

export type ResidualInputs = {
  inherent_score: number | null | undefined;
  control_design_eff: number | null | undefined;
  control_operating_eff: number | null | undefined;
};

export type ResidualOverrideRequest = {
  residual_override?: boolean;
  residual_score?: number | null;
  residual_override_reason?: string | null;
};

export type ResidualExistingState = ResidualInputs & {
  residual_score: number | null;
  residual_is_override: boolean;
  residual_override_reason: string | null;
  residual_overridden_by: string | null;
  residual_overridden_at: Date | null;
  residual_override_stale: boolean;
};

export type ResidualFields = {
  residual_score: number | null;
  residual_is_override: boolean;
  residual_override_reason: string | null;
  residual_overridden_by: string | null;
  residual_overridden_at: Date | null;
  residual_override_stale: boolean;
};

const autoResidualFields = (residual_score: number | null): ResidualFields => ({
  residual_score,
  residual_is_override: false,
  residual_override_reason: null,
  residual_overridden_by: null,
  residual_overridden_at: null,
  residual_override_stale: false,
});

/**
 * Resolves the full set of residual-score fields to persist on a create or
 * an update, given the effective inputs (already merged with any existing
 * row for an update), an optional override request from the caller, the
 * acting user, and (for updates only) the risk's existing override state.
 *
 * Throws an AppError-shaped object via the caller's own validation instead
 * of here — this function is pure and just returns `{ ok: false, message }`
 * on an invalid override request, letting call sites raise their own
 * consistent 400.
 */
export function resolveResidualFields(
  effectiveInputs: ResidualInputs,
  overrideRequest: ResidualOverrideRequest,
  actorId: string,
  existing: ResidualExistingState | null,
): { ok: true; fields: ResidualFields } | { ok: false; message: string } {
  const computed = computeResidualScore(
    effectiveInputs.inherent_score,
    effectiveInputs.control_design_eff,
    effectiveInputs.control_operating_eff,
  );

  if (overrideRequest.residual_override === true) {
    if (overrideRequest.residual_score == null) {
      return { ok: false, message: 'residual_score is required when residual_override is true.' };
    }
    if (!overrideRequest.residual_override_reason?.trim()) {
      return {
        ok: false,
        message: 'residual_override_reason is required when residual_override is true.',
      };
    }
    return {
      ok: true,
      fields: {
        residual_score: overrideRequest.residual_score,
        residual_is_override: true,
        residual_override_reason: overrideRequest.residual_override_reason.trim(),
        residual_overridden_by: actorId,
        residual_overridden_at: new Date(),
        residual_override_stale: false,
      },
    };
  }

  if (overrideRequest.residual_override === false) {
    return { ok: true, fields: autoResidualFields(computed) };
  }

  // No explicit override instruction in this request.
  if (!existing) {
    // Create path with no override requested: always auto-compute.
    return { ok: true, fields: autoResidualFields(computed) };
  }

  if (!existing.residual_is_override) {
    // Not currently overridden: keep tracking the live computed value.
    return { ok: true, fields: autoResidualFields(computed) };
  }

  // Existing override in place, and this request didn't touch it: keep the
  // overridden value, but flag it stale if the inputs feeding the formula
  // changed underneath it (derived-with-override pattern — see risk.prisma's
  // comment). Once stale, it STAYS stale until a request explicitly
  // re-confirms or replaces the override (the branches above) — an
  // unrelated field edit that happens to leave inherent_score/control_*_eff
  // unchanged from their already-stale-triggering values must not silently
  // clear the flag, so this ORs in the row's current staleness rather than
  // recomputing it fresh from just this request's delta.
  const inputsChanged =
    effectiveInputs.inherent_score !== existing.inherent_score ||
    effectiveInputs.control_design_eff !== existing.control_design_eff ||
    effectiveInputs.control_operating_eff !== existing.control_operating_eff;

  return {
    ok: true,
    fields: {
      residual_score: existing.residual_score,
      residual_is_override: true,
      residual_override_reason: existing.residual_override_reason,
      residual_overridden_by: existing.residual_overridden_by,
      residual_overridden_at: existing.residual_overridden_at,
      residual_override_stale: existing.residual_override_stale || inputsChanged,
    },
  };
}
