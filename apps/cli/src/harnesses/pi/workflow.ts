/** Environment variable a calling workflow sets to tag every Axon/Pi signal it produces. */
export const WORKFLOW_ENV = "AXON_WORKFLOW";

const WORKFLOW_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Workflow names become telemetry labels and request tags, so only short, stable identifiers
 * are accepted. Trim and lowercase; drop invalid values rather than silently merging workflows.
 */
export function normalizeWorkflowName(value: string | undefined): string | undefined {
  const name = value?.trim().toLowerCase();
  return name && WORKFLOW_NAME.test(name) ? name : undefined;
}
