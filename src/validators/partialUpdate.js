const { z } = require('zod');

// Zod 4 can default omitted optional keys. PATCH-style contracts preserve omissions.
module.exports = (schema) => {
  const partial = schema.partial();
  return z.unknown().transform((input, context) => {
    const result = partial.safeParse(input);
    if (!result.success) {
      for (const issue of result.error.issues) context.addIssue(issue);
      return z.NEVER;
    }
    return Object.fromEntries(Object.entries(result.data).filter(([field]) => Object.hasOwn(input, field)));
  });
};
