import type { ClientConfig } from "../cli/client-config.ts";
import type { AxonPaths } from "../product/paths.ts";

export type StableHarnessId = "pi";

export interface LaunchContext {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly paths: AxonPaths;
  /** Owned by Axon for the entire invocation, before any Pi executable runs. */
  readonly sandbox?: SandboxSession;
  /** Global RPC discovery has no project and must never execute project operations. */
  readonly catalogOnly?: boolean;
}

export interface SandboxResumeSession {
  readonly sessionId: string;
  readonly sessionFile?: string;
}

export interface HarnessLaunchContext extends LaunchContext {
  readonly registration: HarnessRegistration;
  readonly executable: string;
  /** Register a validated resume target while the parent owns the sandbox editor. */
  readonly prepareSandboxRestart?: (session: SandboxResumeSession) => () => void;
  /** The launch has no usable login yet; the harness must offer sign-in itself. */
  readonly authenticationDeferred?: boolean;
}

export interface LaunchSpec {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  /** Explicit invocation offline state, not a telemetry environment preference. */
  readonly offline?: boolean;
  /** Backend-authorized session lease; no local setting may extend it. */
  readonly expiresAt?: number;
  /** Revocation of a compiled filesystem profile requires terminating its process group. */
  readonly revoked?: AbortSignal;
  /** Preserve invocation-owned resources only while replacing a revoked child. */
  readonly dispose?: (options?: { readonly restarting: boolean }) => void;
}

export interface SandboxCommandOptions {
  readonly purpose: "probe" | "provision" | "operation";
  readonly signal?: AbortSignal;
  readonly stdin?: string;
  readonly writePaths?: readonly string[];
  readonly inheritOutput?: boolean;
  readonly timeoutMs?: number;
}

export interface SandboxCommandResult {
  readonly exitCode: number;
  readonly signalCode: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SandboxSession {
  /** Reuse startup configuration only while the verified credential is unchanged. */
  clientConfig(session: string): ClientConfig | undefined;
  wrap(
    specification: LaunchSpec,
    options?: {
      readonly packageAdministration: boolean;
      readonly runtimeReadPaths?: readonly string[];
    },
  ): Promise<LaunchSpec>;
  run(specification: LaunchSpec, options: SandboxCommandOptions): Promise<SandboxCommandResult>;
  dispose(): void;
}

export interface DoctorFinding {
  readonly level: "info" | "warning" | "error";
  readonly message: string;
  readonly remediation?: string;
}

export interface ExecutableResolutionOptions {
  /** Forwarded harness arguments; lets an adapter skip provisioning for administration. */
  readonly userArguments: readonly string[];
  /** False for diagnostics: locate an executable but never download one. */
  readonly allowInstall: boolean;
}

export interface HarnessAdapter {
  readonly id: StableHarnessId;
  /** Optional adapter-owned resolution (bootstrap installs, managed runtimes). */
  resolveExecutable?(
    context: LaunchContext,
    registration: HarnessRegistration,
    options: ExecutableResolutionOptions,
  ): Promise<string>;
  /** Optional harness-specific version probe used by doctor. */
  probeVersion?(context: LaunchContext, executable: string): Promise<string | undefined>;
  /** Exact harness version for this launch; source development may override the embedded pin. */
  exactVersion?(context: LaunchContext): string;
  /** Oldest harness version the embedded resources are known to work with. */
  readonly minimumVersion?: string;
  prepare(context: HarnessLaunchContext, userArguments: readonly string[]): Promise<void>;
  buildLaunchSpec(
    context: HarnessLaunchContext,
    userArguments: readonly string[],
  ): Promise<LaunchSpec>;
  doctor(context: LaunchContext): Promise<readonly DoctorFinding[]>;
}

export interface HarnessRegistration {
  readonly id: StableHarnessId;
  readonly executableCandidates: readonly string[];
  readonly executableOverrideVariable: string;
}
