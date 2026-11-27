import { expect, mock, test } from "bun:test";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ToolDefinition,
  ToolLoadout,
} from "@earendil-works/pi-coding-agent";
import t3CodemodeExposure from "../src/harnesses/pi/resources/extensions/t3-codemode-exposure.ts";

const PROJECTION = "axon_t3_codemode_exposure";
const T3_TOOLS = ["mcp__t3-code__preview_open", "mcp__t3_code__preview_open"];

function loadoutTool(name: string): ToolLoadout["registered"][number] {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [], details: {} };
    },
  };
}

function harness({
  t3 = true,
  active = [PROJECTION, "bash", "codemode"],
  registered = [...active, ...T3_TOOLS, "mcp__sentry__search"],
  filterCodemode = false,
  defaultTools,
}: {
  t3?: boolean;
  active?: string[];
  registered?: string[];
  filterCodemode?: boolean;
  defaultTools?: string[];
} = {}) {
  let projection: ToolDefinition | undefined;
  let onStart: ((event: BeforeAgentStartEvent) => void) | undefined;
  const setActiveTools = mock((tools: string[]) => {
    active = filterCodemode ? tools.filter((name) => name !== "codemode") : tools;
  });
  const previous = process.env["T3_PI_MCP_EXTENSION_PATH"];
  try {
    if (t3) process.env["T3_PI_MCP_EXTENSION_PATH"] = "/path/to/t3-bridge.ts";
    else delete process.env["T3_PI_MCP_EXTENSION_PATH"];
    t3CodemodeExposure({
      registerTool: (tool: ToolDefinition) => {
        projection = tool;
      },
      on: (_name: string, handler: typeof onStart) => {
        onStart = handler;
      },
      getActiveTools: () => active,
      getAllTools: () => registered.map((name) => ({ name })),
      setActiveTools,
      getSettings: () => ({ defaultTools }),
    } as unknown as ExtensionAPI);
  } finally {
    if (previous === undefined) delete process.env["T3_PI_MCP_EXTENSION_PATH"];
    else process.env["T3_PI_MCP_EXTENSION_PATH"] = previous;
  }

  return {
    projection,
    setActiveTools,
    deactivate: (name: string) => {
      active = active.filter((tool) => tool !== name);
    },
    hidden: () =>
      projection?.prepareLoadout?.({
        declared: active.map(loadoutTool),
        registered: registered.map(loadoutTool),
        callable: [],
        getExposure: () => "direct",
        getNamespace: () => undefined,
        getPromptGuidelines: () => [],
      })?.hiddenDeclarations,
    start: () => {
      const sections: Record<string, string> = {};
      onStart?.({ systemPromptOptions: { sections } } as BeforeAgentStartEvent);
      return sections["axon_t3_codemode"];
    },
  };
}

test("does not change exposure outside T3 Code", () => {
  const session = harness({ t3: false });
  expect(session.projection).toBeUndefined();
  expect(session.start()).toBeUndefined();
});

test("hides only T3 tool declarations, including both bridge name variants", () => {
  const session = harness();
  expect(session.projection?.exposure).toBe("model-only");
  expect(session.hidden()).toEqual([PROJECTION, ...T3_TOOLS]);
  expect(session.start()).toContain("mcp__t3_code__");
  expect(session.setActiveTools).not.toHaveBeenCalled();
});

test("activates codemode even when there is no other MCP server", () => {
  const active = [PROJECTION, "bash"];
  const session = harness({ active, registered: [...active, "codemode", ...T3_TOOLS] });
  expect(session.hidden()).toEqual([PROJECTION]);
  expect(session.start()).toContain("codemode");
  expect(session.setActiveTools).toHaveBeenCalledWith([...active, "codemode"]);
  expect(session.hidden()).toEqual([PROJECTION, ...T3_TOOLS]);
});

test("leaves T3 tools visible when Pi filters out codemode", () => {
  const active = [PROJECTION, "bash"];
  const session = harness({
    active,
    registered: [...active, "codemode", ...T3_TOOLS],
    filterCodemode: true,
  });
  expect(session.start()).toBeUndefined();
  expect(session.hidden()).toEqual([PROJECTION]);
});

test("does not activate codemode if either codemode or the T3 catalog is absent", () => {
  const active = [PROJECTION, "bash"];
  for (const registered of [
    [...active, ...T3_TOOLS],
    [...active, "codemode"],
  ]) {
    const session = harness({ active, registered });
    expect(session.start()).toBeUndefined();
    expect(session.setActiveTools).not.toHaveBeenCalled();
    expect(session.hidden()).toEqual([PROJECTION]);
  }
});

test("does not activate codemode when defaultTools turns it off", () => {
  const active = [PROJECTION, "bash"];
  const session = harness({
    active,
    registered: [...active, "codemode", ...T3_TOOLS],
    defaultTools: ["read", "bash", "-codemode"],
  });
  expect(session.start()).toBeUndefined();
  expect(session.setActiveTools).not.toHaveBeenCalled();
  expect(session.hidden()).toEqual([PROJECTION]);
});

test("does not reactivate codemode after the user turns it off", () => {
  const active = [PROJECTION, "bash"];
  const session = harness({ active, registered: [...active, "codemode", ...T3_TOOLS] });
  expect(session.start()).toContain("codemode");
  session.deactivate("codemode");
  expect(session.start()).toBeUndefined();
  expect(session.setActiveTools).toHaveBeenCalledTimes(1);
  expect(session.hidden()).toEqual([PROJECTION]);
});
