export const mapTemplateData = (body: any, userId: string) => ({
  orgAccountId: userId,
  templateLogo: body.templateLogo,
  templateName: body.templateName,
  templateDisc: body.templateDisc,

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
