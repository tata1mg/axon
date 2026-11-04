import { z } from "zod";

// Deliberately not arbitrary hosts: a general HTTPS tunnel could also carry Git.
export const PACKAGE_REGISTRY_HOSTS = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
] as const;

export const axonSafehousePolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  required: z.literal(true),
  engine: z.literal("safehouse"),
  policyId: z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/),
  maxSessionSeconds: z.number().int().min(60).max(86_400),
  network: z.literal("relay-and-package-proxy"),
  remoteGit: z.boolean(),
  // Missing host permissions grant no SSH access, even when remoteGit is enabled.
  remoteGitHosts: z
    .array(z.enum(["github.com", "bitbucket.org"]))
    .max(2)
    .default([]),
  localGit: z.enum(["deny", "read-only", "read-write"]),
  allowAdditionalReadPaths: z.boolean(),
  allowAdditionalWritePaths: z.boolean(),
  packageRegistryHosts: z.array(z.enum(PACKAGE_REGISTRY_HOSTS)).max(4),
  // HTTPS Git package access is separate from session/SSH access and fails closed when absent.
  packageGitHosts: z
    .array(z.enum(["github.com", "bitbucket.org"]))
    .max(2)
    .default([]),
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
