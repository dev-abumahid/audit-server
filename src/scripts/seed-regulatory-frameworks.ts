/**
 * Seeds the curated RegulatoryFramework table for the AI risk-register
 * generation feature (design-docs/site-ai-risk-register-generation.md §5).
 *
 * All 18 entries below were verified via live web research (August 2026)
 * against the CEO's original mockup prompt, which cited several of these
 * incorrectly or missed two entirely -- see the design doc's §5 table for
 * the full correction rationale per framework. Do not add a framework here
 * without the same standard of verification: this table is what the AI
 * generation prompt cites FROM (design doc §4), so an error here becomes
 * an error in every risk register Qiyrix ever generates.
 *
 * Idempotent: upserts by `official_reference` (the @@unique constraint
 * added after PR #369's review — see risk.prisma's own comment on why a
 * duplicate here is worse than a duplicate row in most tables, since
 * Phase 2 embeds the entire table verbatim into every generation prompt).
 * Safe to re-run after editing an entry below to push a correction.
 *
 * Run with:
 *   npm run seed:regulatory-frameworks
 */
import { fileURLToPath } from 'node:url';
import { prisma } from '../app/lib/prisma.js';
import type { Prisma } from '@prisma/client';

type FrameworkSeed = Omit<
  Prisma.RegulatoryFrameworkCreateInput,
  'createdAt' | 'updatedAt' | 'risks'
>;

// last_verified_at is fixed to the date this list was actually researched
// (not "now" at seed-run time) -- it needs to reflect when the CITED FACTS
// were checked, not when this script happened to run.
const VERIFIED_AT = new Date('2026-08-20T00:00:00.000Z');

const FRAMEWORKS: FrameworkSeed[] = [
  {
    name: "DUERP (Document unique d'évaluation des risques professionnels)",
    official_reference: 'Code du travail R.4121-1 to R.4121-4',
    jurisdiction: 'France',
    domain: 'health_safety',
    legal_status: 'active_statutory',
    applicability_threshold: undefined,
    summary:
      'Employer must identify and assess occupational risks and record them in a single written document. Mandatory from the first employee hired; must be updated at least annually for companies with 11 or more employees.',
    source_url:
      'https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000006072050/LEGISCTA000023793886/',
    last_verified_at: VERIFIED_AT,
  },
  {
    name: 'Pénibilité / Compte Professionnel de Prévention (C2P)',
    official_reference: 'Code du travail (ordonnance du 22 septembre 2017)',
    jurisdiction: 'France',
    domain: 'health_safety',
    legal_status: 'active_statutory',
    applicability_threshold: {
      note: 'Sector-specific: applies when employees are exposed above regulatory thresholds to one of 6 factors (night work, alternating shifts, repetitive work, noise, extreme temperatures, hyperbaric work). Not universal -- relevant mainly to shift/industrial work, not office sites.',
    },
    summary:
      'Employer must declare employee exposure to 6 occupational-risk factors above regulatory thresholds; workers accrue points redeemable for training, part-time work, or early retirement.',
    source_url:
      'https://www.legisocial.fr/dossiers-synthese/penibilite-compte-professionnel-prevention-c2p.html',
    last_verified_at: VERIFIED_AT,
  },
  {
    name: "ICPE (Installations Classées pour la Protection de l'Environnement)",
    official_reference: "Code de l'environnement R.511-9, Annexes 1-5",
    jurisdiction: 'France',
    domain: 'environmental',
    legal_status: 'active_statutory',
    applicability_threshold: {
      note: 'Site-specific nomenclature lookup required -- regime (Déclaration/Enregistrement/Autorisation) depends on the exact activity and threshold quantities involved, not a simple employee/revenue number.',
    },
    summary:
      'Classified installations (factories, depots, workshops, waste storage, quarries) fall under one of 3 regulatory regimes based on their pollution/risk potential.',
    source_url:
      'https://www.ecologie.gouv.fr/politiques-publiques/savoir-icpe-nomenclature-gestion-declaration',
    last_verified_at: VERIFIED_AT,
  },
  {
    name: 'ATEX (Atmosphères Explosibles) -- equipment + workplace directives',
    official_reference: 'Directive 2014/34/UE + Directive 1999/92/CE',
    jurisdiction: 'European Union / France',
    domain: 'health_safety',
    legal_status: 'active_statutory',
    applicability_threshold: {
      note: 'Narrow: only sites handling flammable dusts, gases, or solvents where an explosive atmosphere can occur. Do not apply based on generic industrial-site language.',
    },
    summary:
      'Employers must classify zones where explosive atmospheres may occur and ensure equipment used matches the required protection category.',
    source_url: 'https://www.inrs.fr/risques/explosion/reglementation-textes-reference.html',
    last_verified_at: VERIFIED_AT,
  },
  {
    name: 'RGPD (Règlement Général sur la Protection des Données) / GDPR',
    official_reference: 'Règlement (UE) 2016/679',
    jurisdiction: 'European Union',
    domain: 'data_protection',
    legal_status: 'active_statutory',
    applicability_threshold: undefined,
    summary:
      'Personal data processing rules, applying to essentially any employer processing employee, customer, or visitor personal data (badge logs, CCTV, HR files all count).',
    source_url: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj?locale=fr',
    last_verified_at: VERIFIED_AT,
  },
  {
    name: 'NIS 2 (Network and Information Security Directive)',
    official_reference: 'Directive (UE) 2022/2555',
    jurisdiction: 'European Union',
    // Review finding: was mistakenly 'financial'. This is a cybersecurity
    // directive -- 'industry_specific' is the closest fit among the
    // existing domain vocabulary (mirrors regulatory_coverage_schema.py's
    // COMPLIANCE_DOMAINS on the aexa-ai side, which has no dedicated
    // cybersecurity value either).
    domain: 'industry_specific',
    legal_status: 'pending_statutory',
    applicability_threshold: {
      note: 'NOT YET transposed into French law as of August 2026 -- the EU referred France to the CJEU on 8 July 2026 for failure to transpose. Once transposed, only sector-designated "essential/important" entities are in scope (roughly 15,000 French entities), not a general obligation. Never cite as a current binding obligation.',
    },
    summary:
      'EU cybersecurity risk-management and incident-notification directive for essential/important-sector entities. France has not yet passed the domestic law that would make this a live obligation for French sites.',
    source_url:
      'https://cyber.gouv.fr/reglementation/cybersecurite-systemes-dinformation/directives-nis-nis2-et-dispositif-saiv/directive-nis-2/',
    last_verified_at: VERIFIED_AT,
  },
  {
    name: 'Loi Sapin II (anti-corruption)',
    official_reference: 'Loi n°2016-1691 du 9 décembre 2016, Article 17',
    jurisdiction: 'France',
    domain: 'anti_corruption',
    legal_status: 'conditional_statutory',
    applicability_threshold: { min_employees: 500, min_revenue_eur: 100_000_000 },
    summary:
      '8-pillar anti-corruption compliance program requirement, monitored by AFA (Agence Française Anticorruption). Applies only to companies/groups with 500+ employees AND more than €100M revenue -- a hard, cumulative threshold, not either/or.',
    source_url: 'https://www.leto.legal/guides/loi-sapin-2-entreprises-concernees',
    last_verified_at: VERIFIED_AT,
  },
  {
    name: 'EU Machinery Regulation',
    official_reference: 'Règlement (UE) 2023/1230',
    jurisdiction: 'European Union',
    domain: 'industry_specific',
    legal_status: 'pending_statutory',
    applicability_threshold: {
      note: 'Full application date is 20 January 2027 -- not yet fully in force. No CE declarations under this regulation exist before that date (there is no transition period). Applies to manufacturers/integrators of machinery.',
    },
    summary:
      'Replaces Directive 2006/42/CE (Machinery Directive) with updated conformity/safety requirements for machinery placed on the EU market, including new provisions for AI-driven/autonomous machinery and cybersecurity.',
    source_url: 'https://eur-lex.europa.eu/legal-content/FR/ALL/?uri=CELEX:32023R1230',
    last_verified_at: VERIFIED_AT,
  },
  {
    name: "CBAM / MACF (Mécanisme d'Ajustement Carbone aux Frontières)",
    official_reference: 'Règlement (UE) 2023/956',
    jurisdiction: 'European Union',
    domain: 'environmental',
    legal_status: 'active_statutory',
    applicability_threshold: {
      note: 'ONLY applies to importers of specific carbon-intensive goods (steel, aluminum, cement, fertilizers, hydrogen, electricity) from outside the EU. Do not apply based on generic "international supply chain" language -- requires a confirmed specific import activity.',
    },
    summary:
      'Importers of specific carbon-intensive goods must declare embedded carbon emissions. Full financial obligations (not just declaration) began 1 January 2026.',
    source_url:
      'https://www.douane.gouv.fr/fiche/comprendre-le-mecanisme-dajustement-carbone-aux-frontieres',
    last_verified_at: VERIFIED_AT,
  },
  {
    name: 'Dual-Use export controls',
    official_reference: 'Règlement (UE) 2021/821',
    jurisdiction: 'European Union',
    domain: 'export_control',
    legal_status: 'active_statutory',
    applicability_threshold: {
      note: 'Narrow: only defense-adjacent, advanced electronics, or specialized dual-civil-military-use exports. Do not apply based on generic "Technology" or "AI & Emerging" category pattern-matching -- requires a confirmed specific export activity.',
    },
    summary:
      'Requires export/brokerage/transit authorization for goods, software, or technology with both civil and military application.',
    source_url:
      'https://www.entreprises.gouv.fr/espace-entreprises/s-informer-sur-la-reglementation/le-reglement-europeen-sur-les-biens-double',
    last_verified_at: VERIFIED_AT,
  },
  {
    name: 'CSRD (Corporate Sustainability Reporting Directive)',
    official_reference: 'Directive (UE) 2022/2464',
    jurisdiction: 'European Union',
    domain: 'environmental',
    legal_status: 'conditional_statutory',
    applicability_threshold: {
      min_employees: 250,
      min_revenue_eur: 50_000_000,
      min_balance_sheet_eur: 25_000_000,
      note: 'Must exceed 2 of these 3 thresholds. Timeline delayed by the EU "Stop the Clock" mechanism -- most mid-sized companies now report starting FY2027-2029, not immediately.',
    },
    summary:
      'Sustainability reporting per ESRS standards for large companies. Near-term applicability is narrower than the raw thresholds suggest due to the delayed rollout timeline.',
    source_url: 'https://www.sami.eco/blog/fiche-csrd',
    last_verified_at: VERIFIED_AT,
  },
  {
    name: 'EU AI Act',
    official_reference: 'Règlement (UE) 2024/1689',
    jurisdiction: 'European Union',
    domain: 'industry_specific',
    legal_status: 'active_statutory',
    applicability_threshold: {
      note: 'Applies to any site deploying AI systems in HR, security/surveillance, or industrial process control. Calendar shifted again in July 2026 (Règlement (UE) 2026/1744) -- verify current milestone dates before citing a specific deadline.',
    },
    summary:
      'Risk-based obligations for AI system providers/deployers. Major transparency obligations became applicable 2 August 2026.',
    source_url:
      'https://www.dastra.eu/fr/blog/calendrier-ai-act-toutes-les-echeances-a-connaitre-pour-rester-conforme-au-regl/60277',
    last_verified_at: VERIFIED_AT,
  },
  {
    name: 'Devoir de Vigilance (duty of vigilance)',
    official_reference: 'Loi n°2017-399 du 27 mars 2017',
    jurisdiction: 'France',
    domain: 'anti_corruption',
    legal_status: 'conditional_statutory',
    applicability_threshold: { min_employees_france: 5000, min_employees_worldwide: 10000 },
    summary:
      'Requires a vigilance plan (risk mapping, subsidiary/supplier evaluation, mitigation actions, alert mechanism) covering human rights, health/safety, and environmental risks across the supply chain. Applies only to very large groups -- joint-stock companies with 5,000+ employees in France or 10,000+ worldwide.',
    source_url: 'https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000034290626/',
    last_verified_at: VERIFIED_AT,
  },
  {
    name: 'Habilitation électrique (electrical work safety)',
    official_reference: 'Code du travail R.4544-1 to R.4544-11',
    jurisdiction: 'France',
    domain: 'health_safety',
    legal_status: 'active_statutory',
    applicability_threshold: undefined,
    summary:
      'The binding legal obligation for electrical risk prevention and personnel habilitation for work on or near electrical installations. NF C 18-510 is the recognized technical standard used to satisfy this obligation, but is itself a non-mandatory private standard, not the law -- see the recognized_standard entry below for that distinction.',
    source_url: null,
    last_verified_at: VERIFIED_AT,
  },
  {
    name: 'NF C 18-510 (electrical work -- recognized standard, not law)',
    official_reference: 'NF C 18-510',
    jurisdiction: 'France',
    domain: 'health_safety',
    legal_status: 'recognized_standard',
    applicability_threshold: undefined,
    summary:
      'Since the décret of 10 February 2016, application of this norme itself is not mandatory -- it is the recognized MEANS of complying with the actual legal obligation (Code du travail R.4544-x, above), not a legal requirement in its own right. Cite the Code du travail articles as the binding obligation; cite this only as the recognized compliance method.',
    source_url: 'https://www.cnfce.com/faq/habilitation-electrique/nfc18510-norme-electrique',
    last_verified_at: VERIFIED_AT,
  },
  {
    name: 'Sécurité incendie (fire safety -- statutory base)',
    official_reference: 'Code du travail R.4227-1 to R.4227-41',
    jurisdiction: 'France',
    domain: 'health_safety',
    legal_status: 'active_statutory',
    applicability_threshold: undefined,
    summary:
      'Binding workplace fire-prevention, evacuation, extinguisher-provision, and registre-de-sécurité obligations. APSAD referentials (R4, R81, etc.) are private insurer standards used to satisfy insurance requirements, not the legal obligation itself -- see the recognized_standard entry below.',
    source_url: null,
    last_verified_at: VERIFIED_AT,
  },
  {
    name: 'Référentiels APSAD (fire safety -- recognized standard, not law)',
    official_reference: 'APSAD R4/R81 (CNPP/FFA)',
    jurisdiction: 'France',
    domain: 'health_safety',
    legal_status: 'recognized_standard',
    applicability_threshold: undefined,
    summary:
      'Private insurer/technical standards (published by CNPP/FFA) that most insurers effectively require to avoid premium loading, but there is no French statute making APSAD compliance itself obligatory. Cite Code du travail R.4227-1+ as the binding legal obligation; cite this only as the recognized, insurer-driven compliance method.',
    source_url:
      'https://protect-france-incendie.fr/reglementation/regle-apsad-r4-extincteurs-portatifs-mobiles',
    last_verified_at: VERIFIED_AT,
  },
  {
    name: 'VGP (Vérifications Générales Périodiques)',
    official_reference: 'Code du travail R.4323-23 to R.4323-28',
    jurisdiction: 'France',
    domain: 'health_safety',
    legal_status: 'active_statutory',
    applicability_threshold: {
      note: 'Universal for any site with lifting/handling equipment (cranes, forklifts, etc.) -- not threshold-gated by company size, gated by equipment presence.',
    },
    summary:
      'Periodic inspection requirement for work equipment with mechanical/electrical/hydraulic/pressure risk, performed by a competent verifier.',
    source_url:
      'https://www.adec-expertise.fr/reglementation-vgp-articles-code-travail-arrete-reference-i29.html',
    last_verified_at: VERIFIED_AT,
  },
  {
    name: 'Trackdéchets (hazardous waste digital tracking)',
    official_reference: 'Arrêté du 23 février 2026',
    jurisdiction: 'France',
    domain: 'environmental',
    legal_status: 'active_statutory',
    applicability_threshold: {
      note: "Universal for any industrial site generating hazardous waste (oils, solvents, contaminated materials). Mandatory for ALL hazardous-waste producers from 1 September 2026 -- the prior small-producer paper-BSD exemption is eliminated. This deadline is imminent as of the design doc's writing.",
    },
    summary:
      "Mandatory digital hazardous-waste tracking platform (Ministère de la Transition Écologique). Was missing entirely from the CEO's original mockup despite being one of the most time-sensitive obligations in this list.",
    source_url:
      'https://reglementation-environnement.com/arrete-23-fevrier-2026-dechets-dangereux-nouvelles-obligations/',
    last_verified_at: VERIFIED_AT,
  },
  {
    name: 'Loi Waserman (whistleblower protection)',
    official_reference: 'Loi n°2022-401 du 21 mars 2022',
    jurisdiction: 'France',
    domain: 'labor_employment',
    legal_status: 'active_statutory',
    applicability_threshold: { min_employees: 50 },
    summary:
      'Transposes EU Directive 2019/1937 -- requires private employers with 50+ employees to establish an internal alert/reporting procedure, and extends protection to "facilitators." Was missing entirely from the CEO\'s original mockup despite squarely fitting the target customer size range.',
    source_url: 'https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000045388745',
    last_verified_at: VERIFIED_AT,
  },
];

export async function seedRegulatoryFrameworks() {
  let created = 0;
  let updated = 0;
  let failed = 0;

  for (const framework of FRAMEWORKS) {
    try {
      const result = await prisma.regulatoryFramework.upsert({
        where: { official_reference: framework.official_reference as string },
        create: framework,
        update: framework,
      });
      // upsert doesn't tell us which branch it took -- a second query would
      // add a network round trip per row for a script that only runs a
      // handful of times total, so approximate via createdAt === updatedAt
      // (true only on first insert) instead.
      if (result.createdAt.getTime() === result.updatedAt.getTime()) {
        created += 1;
      } else {
        updated += 1;
      }
    } catch (err) {
      failed += 1;
      console.error(`[seed-regulatory-frameworks] failed for "${framework.name}":`, err);
    }
  }

  console.log(
    `[seed-regulatory-frameworks] done. created: ${created}, updated: ${updated}, failed: ${failed}, total: ${FRAMEWORKS.length}`,
  );

  if (failed > 0) {
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  seedRegulatoryFrameworks()
    .catch((err) => {
      console.error('[seed-regulatory-frameworks] failed:', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
