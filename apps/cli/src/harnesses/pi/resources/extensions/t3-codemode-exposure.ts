import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROJECTION_TOOL = "axon_t3_codemode_exposure";
const isT3Tool = (name: string): boolean => /^mcp__t3[-_]code__/.test(name);

/** `-codemode` in defaultTools, e.g. written by Axon when the organization sets CODEMODE_ENABLED to false. */
function codemodeTurnedOff(pi: ExtensionAPI): boolean {
  const tools = pi.getSettings().defaultTools;
  return Array.isArray(tools) && tools.includes("-codemode");
}

export default function t3CodemodeExposure(pi: ExtensionAPI): void {
  if (!process.env["T3_PI_MCP_EXTENSION_PATH"]) return;

  // T3's injected extension owns the MCP connection and registers the tools itself.
  // Hide their declarations, not their implementations, so codemode keeps using
  // the original schemas, handlers and approval checks.
  pi.registerTool({
    name: PROJECTION_TOOL,
    label: "Axon T3 Code tool exposure",
    description: "Keep T3 Code tools behind codemode.",
    parameters: { type: "object", properties: {} },
    exposure: "model-only",
    prepareLoadout({ declared, registered }) {
      const t3Names = declared.some(({ name }) => name === "codemode")
        ? registered.filter(({ name }) => isT3Tool(name)).map(({ name }) => name)
        : [];
      return { hiddenDeclarations: [PROJECTION_TOOL, ...t3Names] };
    },
    async execute() {
      return { content: [], details: {} };
    },
  });

  // Codemode is switched on at most once per session, so turning it off with /tools sticks.
  let activationTried = false;

  pi.on("before_agent_start", ({ systemPromptOptions }) => {
    const active = pi.getActiveTools();
    if (!active.includes(PROJECTION_TOOL)) return;
    const registered = pi.getAllTools();
    if (!registered.some(({ name }) => isT3Tool(name))) return;

    // The bridge isn't a native Pi MCP registration, so it doesn't activate
    // codemode by itself (e.g. when no other MCP server is configured).
    if (!active.includes("codemode")) {
      if (activationTried || codemodeTurnedOff(pi)) return;
      if (!registered.some(({ name }) => name === "codemode")) return;
      activationTried = true;
      pi.setActiveTools([...active, "codemode"]);
      // Respect Pi's tool filters; if codemode is unavailable, leave T3 visible.
      if (!pi.getActiveTools().includes("codemode")) return;
    }

    systemPromptOptions.sections["axon_t3_codemode"] =
      "Call T3 Code MCP tools through codemode, not as standalone calls. " +
      "Discover them in a script with `ALL_TOOLS.filter(({name}) => name.startsWith('mcp__t3_code__'))`, " +
      "then use `tools.mcp__t3_code__<tool>(args)`.";
  });
}
