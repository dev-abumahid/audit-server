import { z } from 'zod';

const create_site = z.object({
  name: z.string(),
  location: z.string().optional(),
  country: z.string().optional(),
  activity: z.string().optional(),
  revenue: z.number().int(),
  employees_count: z.number().int(),
  site_type: z.string(),
  lat: z.number().optional(),
  lng: z.number().optional(),
});
const update_site = create_site.partial();

export const site_validations = {
  create_site,
  update_site,
};
