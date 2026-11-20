import { z } from 'zod';

const isoDateTime = z.iso.datetime();

// Zod 3 accepted UTC timestamps with minute precision. Validate those as
// second-precision timestamps without changing the stored or signed value.
export const utcDateTimeSchema = z.string().refine((value) => {
  const fullValue = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(value)
    ? `${value.slice(0, -1)}:00Z`
    : value;
  return isoDateTime.safeParse(fullValue).success;
}, 'Invalid UTC datetime');
