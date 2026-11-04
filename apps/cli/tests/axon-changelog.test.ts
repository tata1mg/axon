import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  initTheme,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  KeybindingsManager,
  type KeyId,
  setKeybindings,
  visibleWidth,
} from "@earendil-works/pi-tui";
import axonChangelog, {
  AXON_RELEASES,
  compareVersions,
  newReleaseNotes,
} from "../src/harnesses/pi/resources/extensions/axon-changelog.ts";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type EntryRenderer = Parameters<ExtensionAPI["registerEntryRenderer"]>[1];
const environmentKeys = ["PI_CODING_AGENT_DIR", "PI_AXON_CLI_VERSION"] as const;
let root: string;
let directory: string;
let statePath: string;
let savedEnvironment: Record<string, string | undefined>;
let savedKeybindings: ReturnType<typeof getKeybindings>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "axon-changelog-"));
  directory = join(root, "pi");
  statePath = join(directory, "axon-changelog.json");
  savedEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  process.env["PI_CODING_AGENT_DIR"] = directory;
  process.env["PI_AXON_CLI_VERSION"] = "1.0.3";
  savedKeybindings = getKeybindings();
  initTheme("dark", false);
});

afterEach(async () => {
  setKeybindings(savedKeybindings);
  for (const key of environmentKeys) {
    const value = savedEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a registered changelog integration");
  return value;
}

async function writeState(version: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await Bun.write(statePath, JSON.stringify({ schemaVersion: 1, lastSeenAxonVersion: version }));
}

function setup(options: { previous?: EditorFactory; resumed?: boolean; submitKey?: KeyId } = {}) {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const renderers = new Map<string, EntryRenderer>();
  const commands = new Map<string, { handler: () => Promise<void> }>();
  const appendEntry = mock((_type: string, _data: { markdown: string }) => "entry-id");
  const notify = mock((_message: string, _type: string) => {});
  const delegated = mock((_text: string) => {});
  let factory = options.previous;
  let editor: ReturnType<EditorFactory> | undefined;
  const keybindings = new KeybindingsManager({
    "tui.input.submit": { defaultKeys: options.submitKey ?? "enter" },
    "tui.editor.newLine": { defaultKeys: "shift+enter" },
  });
  setKeybindings(keybindings);
  const setEditorComponent = mock((next: EditorFactory | undefined) => {
    factory = next;
    if (next) {
      editor = next(
        { requestRender() {} } as Parameters<EditorFactory>[0],
        { borderColor: (text) => text, selectList: {} } as Parameters<EditorFactory>[1],
        keybindings as unknown as Parameters<EditorFactory>[2],
      );
      // Pi sets this AFTER invoking an extension's editor factory.
      editor.onSubmit = delegated;
    }
  });
  const ctx = {
    mode: "tui",
    sessionManager: {
      getBranch: () => (options.resumed ? [{ type: "message", message: { role: "user" } }] : []),
    },
    ui: {
      getEditorComponent: () => factory,
      setEditorComponent,
      notify,
    },
  } as unknown as ExtensionContext;
  axonChangelog({
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      handlers.set(name, handler);
    },
    registerEntryRenderer(name: string, renderer: EntryRenderer) {
      renderers.set(name, renderer);
    },
    registerCommand(name: string, command: { handler: () => Promise<void> }) {
      commands.set(name, command);
    },
    appendEntry,
  } as unknown as ExtensionAPI);
  return {
    appendEntry,
    delegated,
    notify,
    commands,
    renderers,
    setEditorComponent,
    editor: () => required(editor),
    factory: () => factory,
    replaceFactory: (next: EditorFactory) => {
      factory = next;
    },
    start: (mode: ExtensionContext["mode"] = "tui") =>
      handlers.get("session_start")?.({}, { ...ctx, mode }),
    shutdown: () => handlers.get("session_shutdown")?.({}, ctx),
  };
}

describe("Axon changelog editor integration", () => {
  test("intercepts /changelog before Pi and delegates other input unchanged", async () => {
    const harness = setup();
    await harness.start();
    expect(harness.editor()).toBeInstanceOf(CustomEditor);
    harness.editor().setText("  /changelog  ");
    harness.editor().handleInput?.("\r");
    expect(harness.delegated).not.toHaveBeenCalled();
    expect(harness.editor().getText()).toBe("");
    expect(harness.appendEntry).toHaveBeenCalledTimes(1);
    expect(harness.appendEntry.mock.calls[0]?.[1].markdown).toContain("## 1.0.2");
    expect(harness.appendEntry.mock.calls[0]?.[1].markdown).toContain("## 1.0.1");

    for (const text of [
      "hello",
      "/settings",
      "!echo /changelog",
      "/changelog please",
      "text\n/changelog",
    ]) {
      harness.editor().onSubmit?.(text);
      expect(harness.delegated).toHaveBeenLastCalledWith(text);
    }
    expect(harness.appendEntry).toHaveBeenCalledTimes(1);
  });

  test("respects remapped submission and does not intercept newline or pasted content", async () => {
    const harness = setup({ submitKey: "ctrl+s" });
    await harness.start();
    harness.editor().handleInput?.("\x1b[200~/changelog\x1b[201~");
    harness.editor().handleInput?.("\x1b[13;2u");
    expect(harness.appendEntry).not.toHaveBeenCalled();
    harness.editor().handleInput?.("\x13");
    expect(harness.appendEntry).toHaveBeenCalledTimes(1);
    expect(harness.delegated).not.toHaveBeenCalled();
  });

  test("wraps an existing editor factory, handles callback rebinding, and restores it", async () => {
    const history = mock((_text: string) => {});
    const previous = mock(() => ({
      render: () => [],
      invalidate() {},
      getText: () => "",
      setText() {},
      addToHistory: history,
    })) as unknown as EditorFactory;
    const harness = setup({ previous });
    await harness.start();
    expect(previous).toHaveBeenCalledTimes(1);
    const rebound = mock((_text: string) => {});
    harness.editor().onSubmit = rebound;
    harness.editor().onSubmit?.("/changelog");
    expect(history).toHaveBeenCalledWith("/changelog");
    expect(rebound).not.toHaveBeenCalled();
    harness.editor().onSubmit?.("normal prompt");
    expect(rebound).toHaveBeenCalledWith("normal prompt");
    await harness.shutdown();
    expect(harness.factory()).toBe(previous);
  });

  test("shutdown does not replace an editor installed by a later extension", async () => {
    const harness = setup();
    await harness.start();
    const later = mock(() => ({})) as unknown as EditorFactory;
    harness.replaceFactory(later);
    await harness.shutdown();
    expect(harness.factory()).toBe(later);
  });

  test("exposes a standard alias and renders only Axon notes within narrow terminal widths", async () => {
    const harness = setup();
    await harness.commands.get("axon-changelog")?.handler();
    expect(harness.commands.has("changelog")).toBe(false);
    const [type, data] = required(harness.appendEntry.mock.calls[0]);
    const renderer = required(harness.renderers.get(type));
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const component = renderer(
      { data } as Parameters<EntryRenderer>[0],
      {} as Parameters<EntryRenderer>[1],
      theme as Parameters<EntryRenderer>[2],
    );
    if (!component) throw new Error("Changelog renderer did not return a component");
    for (const width of [20, 60, 100]) {
      const lines = component.render(width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines.map(stripVTControlCharacters).join("\n")).toContain("What's New in Axon");
    }
    expect(data.markdown).not.toContain("earendil-works");
    expect(data.markdown).not.toContain("pi.dev");
  });
});

describe("Axon startup release tracking", () => {
  test("first launch silently establishes an owner-only baseline and repeat launches do not rewrite it", async () => {
    const harness = setup();
    await harness.start();
    expect(harness.appendEntry).not.toHaveBeenCalled();
    expect(await Bun.file(statePath).json()).toEqual({
      schemaVersion: 1,
      lastSeenAxonVersion: "1.0.3",
    });
    expect((await lstat(statePath)).mode & 0o777).toBe(0o600);
    const inode = (await lstat(statePath)).ino;
    await harness.start();
    expect((await lstat(statePath)).ino).toBe(inode);
  });

  test("an upgrade shows only unseen Axon entries once, including after a reload", async () => {
    await writeState("1.0.2");
    const harness = setup();
    await harness.start();
    expect(harness.appendEntry).toHaveBeenCalledTimes(1);
    expect(harness.appendEntry.mock.calls[0]?.[1].markdown).toBe(AXON_RELEASES[0].markdown);
    await harness.start();
    expect(harness.appendEntry).toHaveBeenCalledTimes(1);
    expect((await Bun.file(statePath).json()).lastSeenAxonVersion).toBe("1.0.3");
  });

  test("resumed conversations defer the upgrade notice and leave state unchanged", async () => {
    await writeState("1.0.0");
    const harness = setup({ resumed: true });
    await harness.start();
    expect(harness.appendEntry).not.toHaveBeenCalled();
    expect((await Bun.file(statePath).json()).lastSeenAxonVersion).toBe("1.0.0");
    harness.editor().onSubmit?.("/changelog");
    expect(harness.appendEntry).toHaveBeenCalledTimes(1);
  });

  for (const mode of ["print", "json", "rpc"] as const) {
    test(`${mode} mode does not install an editor, show startup notes, or mark them seen`, async () => {
      await writeState("1.0.0");
      const harness = setup();
      await harness.start(mode);
      expect(harness.setEditorComponent).not.toHaveBeenCalled();
      expect(harness.appendEntry).not.toHaveBeenCalled();
      expect((await Bun.file(statePath).json()).lastSeenAxonVersion).toBe("1.0.0");
    });
  }

  test("downgrades retain the higher seen version", async () => {
    await writeState("2.0.0");
    const harness = setup();
    await harness.start();
    expect(harness.appendEntry).not.toHaveBeenCalled();
    expect((await Bun.file(statePath).json()).lastSeenAxonVersion).toBe("2.0.0");
  });

  test("development prereleases do not reveal later release notes", async () => {
    expect(newReleaseNotes("1.0.1", "1.0.2-beta.2")).toBe("");
    expect(newReleaseNotes("1.0.2-beta.2", "1.0.2")).toContain("## 1.0.2");
  });

  test("invalid build versions do not write state", async () => {
    for (const version of ["", "unknown", "1.0.1\n", "1.0.1-01"]) {
      process.env["PI_AXON_CLI_VERSION"] = version;
      await setup().start();
      expect(await Bun.file(statePath).exists()).toBe(false);
    }
  });

  test("unsafe or corrupt state is left untouched without breaking /changelog", async () => {
    await mkdir(directory, { recursive: true });
    for (const content of ["{", "[]", '{"schemaVersion":1,"lastSeenAxonVersion":"bad"}']) {
      await Bun.write(statePath, content);
      const harness = setup();
      await harness.start();
      expect(await Bun.file(statePath).text()).toBe(content);
      expect(harness.notify).toHaveBeenCalledTimes(1);
      harness.editor().onSubmit?.("/changelog");
      expect(harness.appendEntry).toHaveBeenCalledTimes(1);
    }
    await rm(statePath);
    const target = join(root, "target.json");
    await Bun.write(target, "{}");
    await symlink(target, statePath);
    const harness = setup();
    await harness.start();
    expect((await lstat(statePath)).isSymbolicLink()).toBe(true);
    expect(await Bun.file(target).text()).toBe("{}");
    expect(harness.notify).toHaveBeenCalledTimes(1);
  });
});

test("latest changelog entry matches the CLI release version", async () => {
  const { version } = await Bun.file(resolve(import.meta.dir, "../package.json")).json();
  expect(AXON_RELEASES[0].version).toBe(version);
  expect(AXON_RELEASES[0].markdown.startsWith(`## ${version}\n`)).toBe(true);
});

test("skipped releases include all unseen entries, newest first", () => {
  expect(newReleaseNotes("1.0.0", "1.0.3")).toBe(
    [AXON_RELEASES[0].markdown, AXON_RELEASES[1].markdown, AXON_RELEASES[2].markdown].join(
      "\n\n",
    ),
  );
  expect(newReleaseNotes("1.0.0", "1.0.2")).not.toContain("## 1.0.0");
  expect(newReleaseNotes("1.0.1", "1.0.2")).not.toContain("## 1.0.1");
});

test("SemVer release ordering handles prereleases, build metadata, and multi-digit identifiers", () => {
  const ordered = [
    "1.0.0-alpha",
    "1.0.0-alpha.2",
    "1.0.0-alpha.10",
    "1.0.0-beta",
    "1.0.0",
    "1.0.1",
    "1.10.0",
    "2.0.0",
  ];
  for (let index = 1; index < ordered.length; index++) {
    const left = required(ordered[index - 1]);
    const right = required(ordered[index]);
    expect(compareVersions(left, right)).toBeLessThan(0);
    expect(compareVersions(right, left)).toBeGreaterThan(0);
  }
  expect(compareVersions("1.0.1+first", "1.0.1+second")).toBe(0);
});

test("release notes stay out of the model context", async () => {
  const harness = setup();
  await harness.start();
  harness.editor().onSubmit?.("/changelog");
  const [type, data] = required(harness.appendEntry.mock.calls[0]);
  const session = SessionManager.inMemory(root);
  session.appendCustomEntry(type, data);
  expect(session.getEntries()).toHaveLength(1);
  expect(session.buildSessionContext().messages).toEqual([]);
});

test("loads standalone in the pinned native Pi runtime without touching runtime files", async () => {
  const project = resolve(import.meta.dir, "..");
  const child = Bun.spawn(
    [
      join(project, "node_modules/.bin/pi"),
      "--offline",
      "--no-extensions",
      "--extension",
      join(project, "src/harnesses/pi/resources/extensions/axon-changelog.ts"),
      "--list-models",
    ],
    {
      cwd: root,
      env: {
        HOME: root,
        PATH: process.env["PATH"] ?? "",
        PI_CODING_AGENT_DIR: directory,
        PI_SKIP_VERSION_CHECK: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  expect(code).toBe(0);
  expect(stderr).toBe("");
});
