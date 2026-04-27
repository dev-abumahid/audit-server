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

export const paginationHelper = (options: TPaginationInput): TPaginationMeta => {
  const page = Math.max(1, Number(options.page) || 1);
  const limit = Math.max(1, Number(options.limit) || 10);

  const skip = (page - 1) * limit;

  return {
    page,
    limit,
    skip,
  };
};

export const buildPaginationMeta = (base: TPaginationMeta, total: number) => {
  return {
    ...base,
    total,
  };
};
