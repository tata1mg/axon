import { z } from "zod";

/** Absolute or home-relative; the CLI expands "~/" and resolves symlinks before use. */
const policyPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^(?:\/|~\/)/)
  .refine(
    (path) =>
      !Array.from(path).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ),
  );

export const axonSafehousePolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  required: z.boolean(),
  engine: z.literal("safehouse"),
  policyId: z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/),
  allowAdditionalReadPaths: z.boolean(),
  allowAdditionalWritePaths: z.boolean(),
  protectedPaths: z.array(policyPathSchema).max(64),
  /** Backend-managed grants. Plain allows: denials and user blocks still win. */
  readPaths: z.array(policyPathSchema).max(64),
  writePaths: z.array(policyPathSchema).max(64),
  /** Absent means --no-safehouse and AXON_DISABLE_SAFEHOUSE cannot skip a required sandbox. */
  allowLocalOptOut: z.literal(true).optional(),
});

export type AxonSafehousePolicy = z.infer<typeof axonSafehousePolicySchema>;
