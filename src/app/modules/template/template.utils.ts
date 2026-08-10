// Second param is the org anchor account id (ctx.organizationId from
// resolveCallerOrgContext), NOT the caller's own accountId — every real
// caller (template.service.ts, ai.service.ts) passes the resolved org
// context, not user.accountId. Named explicitly (not `userId`) so a future
// caller doesn't reasonably-but-wrongly pass the caller's own account id,
// silently reintroducing the org-anchor-scoping bug fixed at every existing
// call site. Found by independent review.
export const mapTemplateData = (body: any, orgAnchorAccountId: string) => ({
  orgAccountId: orgAnchorAccountId,
  templateLogo: body.templateLogo,
  templateName: body.templateName,
  templateDisc: body.templateDisc,
  category: body.category,

  pages: {
    create: body.pages.map((page: any) => ({
      pageIndex: page.pageIndex,
      title: page.title,
      questions: {
        create: page.questions?.map((q: any) => ({
          index: q.index,
          question: q.question,
          isRequired: q.isRequired,
          answerType: q.answerType?.answerType,
          value: q.answerType?.value,
        })),
      },
    })),
  },

  access: {
    create: body.access?.map((a: any) => ({
      userId: a.userId,
    })),
  },
});
