// Type declaration for canonical-json (no @types package available).
// stringify produces a deterministic JSON string with keys sorted alphabetically.
declare module "canonical-json" {
  function stringify(value: unknown): string;
  export = stringify;
}
