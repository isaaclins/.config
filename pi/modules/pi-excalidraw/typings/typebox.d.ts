declare module "typebox" {
  export const Type: {
    Object(properties: Record<string, unknown>, options?: unknown): unknown;
    String(options?: unknown): unknown;
    Number(options?: unknown): unknown;
    Integer(options?: unknown): unknown;
    Boolean(options?: unknown): unknown;
    Array(schema: unknown, options?: unknown): unknown;
    Any(options?: unknown): unknown;
    Unknown(options?: unknown): unknown;
    Optional(schema: unknown): unknown;
    Union(schemas: unknown[], options?: unknown): unknown;
    Literal(value: string): unknown;
  };
}
