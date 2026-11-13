import { z } from "zod";

export const axonSafehousePolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  required: z.boolean(),
  engine: z.literal("safehouse"),
  policyId: z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/),
  allowAdditionalReadPaths: z.boolean(),
  allowAdditionalWritePaths: z.boolean(),
  protectedPaths: z
    .array(
      z
        .string()
        .min(1)
        .max(4096)
        .regex(/^(?:\/|~\/)/)
        .refine(
          (path) =>
            !Array.from(path).some(
              (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
            ),
        ),
    )
    .max(64),
});

export type AxonSafehousePolicy = z.infer<typeof axonSafehousePolicySchema>;
