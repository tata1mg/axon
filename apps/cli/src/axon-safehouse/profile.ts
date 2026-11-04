/**
 * Exclude protected/denied paths from every grant, not just with a final deny.
 * Seatbelt can prefer a specific allow over a broader deny, regardless of order.
 * Read-only children must also stay read-only inside a read/write parent grant.
 */
export function restrictFilesystemGrants(
  rules: readonly string[],
  deniedReadPaths: readonly string[],
  deniedWritePaths: readonly string[],
  deniedReadFilters: readonly string[] = [],
  deniedWriteFilters: readonly string[] = [],
): string[] {
  return rules.flatMap((rule) => {
    const grant = /^\(allow ((?:file-[a-zA-Z0-9*_-]+\s+)+)([\s\S]+)\)$/.exec(rule);
    if (!grant?.[1] || !grant[2]) return [rule];
    const operations = grant[1].trim().split(/\s+/);
    return ["file-read", "file-write"].flatMap((prefix) => {
      const selected = operations.filter((operation) => operation.startsWith(prefix));
      if (!selected.length) return [];
      const denied = prefix === "file-read" ? deniedReadPaths : deniedWritePaths;
      const filters = prefix === "file-read" ? deniedReadFilters : deniedWriteFilters;
      const exclusions = [
        ...[...new Set(denied)].map((path) => `(subpath ${JSON.stringify(path)})`),
        ...filters,
      ].map((filter) => `(require-not ${filter})`);
      if (!exclusions.length) return [`(allow ${selected.join(" ")} ${grant[2]})`];
      return [
        `(allow ${selected.join(" ")} (require-all (require-any ${grant[2]}) ${exclusions.join(" ")}))`,
      ];
    });
  });
}

/**
 * Remove Safehouse's convenience grants before adding Axon's explicit filesystem
 * and egress rules. A broad appended deny does not reliably defeat more-specific
 * Seatbelt grants, so preserving upstream allow rules is not an option here.
 */
export function restrictSafehouseBaseline(policy: string): string {
  let output = "";
  let cursor = 0;
  while (cursor < policy.length) {
    const character = policy[cursor];
    if (character === ";") {
      const end = policy.indexOf("\n", cursor);
      const next = end === -1 ? policy.length : end + 1;
      output += policy.slice(cursor, next);
      cursor = next;
      continue;
    }
    if (character !== "(") {
      output += character;
      cursor++;
      continue;
    }
    const start = cursor;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let inComment = false;
    do {
      const current = policy[cursor++];
      if (inComment) {
        if (current === "\n") inComment = false;
      } else if (inString) {
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === '"') inString = false;
      } else if (current === ";") inComment = true;
      else if (current === '"') inString = true;
      else if (current === "(") depth++;
      else if (current === ")") depth--;
    } while (cursor < policy.length && depth > 0);
    if (depth !== 0 || inString) throw new Error("Malformed Safehouse policy");
    const form = policy.slice(start, cursor);
    const header = /^\(\s*allow\s+((?:[a-zA-Z0-9_*+-]+\s*)+)/.exec(form);
    if (!header) {
      // No executable policy macros may hide grants from this top-level filter.
      if (/\(\s*allow\s/.test(form)) throw new Error("Unsupported nested Safehouse grant");
      output += form;
      continue;
    }
    const operations = header[1]?.trim().split(/\s+/) ?? [];
    if (operations.includes("default") || operations.includes("*")) {
      throw new Error("Unsafe Safehouse default grant");
    }
    const retained = operations.filter(
      (operation) =>
        !operation.startsWith("file-read") &&
        !operation.startsWith("file-write") &&
        !operation.startsWith("network") &&
        operation !== "system-socket" &&
        operation !== "lsopen",
    );
    if (retained.length > 0) {
      output += `(allow ${retained.join(" ")} ${form.slice(header[0].length)}`;
    }
  }
  return output;
}
