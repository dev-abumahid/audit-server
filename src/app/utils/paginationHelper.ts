type TPaginationInput = {
  page?: string | number;
  limit?: string | number;
};

type TPaginationMeta = {
  page: number;
  limit: number;
  skip: number;
  total?: number;
};

// Ceiling on page size. No caller in this repo currently requests more than
// 100 (checked recommendation, template, and note list endpoints) — but that
// hasn't been verified against every frontend consumer (e.g. aexa-frontend),
// so treat 100 as a starting point, not a permanently settled number. Without
// a ceiling, a caller could request an arbitrarily large `limit` and force an
// unbounded DB fetch (issue #117).
const MAX_LIMIT = 100;

export const paginationHelper = (options: TPaginationInput): TPaginationMeta => {
  // Math.floor guards against a fractional page/limit (e.g. `?page=2.5` or
  // `?limit=100.5`) flowing through into a non-integer `skip`/`take` passed
  // to Prisma.
  const page = Math.floor(Math.max(1, Number(options.page) || 1));
  const limit = Math.floor(Math.min(MAX_LIMIT, Math.max(1, Number(options.limit) || 10)));

  const skip = (page - 1) * limit;

  return {
    page,
    limit,
    skip,
  };
};

// Single shared source of truth for list-endpoint pagination meta. Every
// list endpoint (site/template/note/recommendation and any future ones)
// should build its `meta` via paginationHelper() + buildPaginationMeta()
// so `totalPage` is always present and always computed the same way,
// instead of each service re-deriving it inline (Qiyrix/aexa-server#115,
// #116, #125).
export const buildPaginationMeta = (base: TPaginationMeta, total: number) => {
  return {
    ...base,
    total,
    totalPage: Math.ceil(total / base.limit),
  };
};
