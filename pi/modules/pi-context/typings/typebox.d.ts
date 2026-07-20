declare module "typebox" {
  export const Type: {
    Object(properties: Record<string, unknown>, options?: unknown): unknown;
    String(options?: unknown): unknown;
    Optional(schema: unknown): unknown;
    Union(schemas: unknown[], options?: unknown): unknown;
    Literal(value: string): unknown;
  };
}
