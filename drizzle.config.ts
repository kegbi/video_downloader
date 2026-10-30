export default {
  dialect: "postgresql",
  schema: "./packages/db/schema.ts",
  out: "./drizzle",
  casing: "snake_case",
  breakpoints: true,
};
