import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  OMARCHY_TOOL_SCHEMAS,
  OmarchyToolError,
  omarchyAvailable,
  runOmarchyTool,
  type OmarchyToolDeps,
} from "./omarchy-tools.ts";

interface Call {
  file: string;
  argv: string[];
  timeoutMs: number;
}

interface CatalogCommand {
  route: string;
  binary: string;
  group: string;
  name: string;
  summary: string;
  requires_sudo: boolean;
  hidden: boolean;
  args: unknown[];
  examples: string[];
}

function catalogCommand(
  route: string,
  overrides: Partial<Pick<CatalogCommand, "hidden" | "requires_sudo">> = {},
): CatalogCommand {
  const parts = route.split(" ");
  return {
    route: `omarchy ${route}`,
    binary: `/usr/bin/omarchy-${parts.join("-")}`,
    group: parts[0],
    name: parts.at(-1) ?? route,
    summary: `${route} test fixture`,
    requires_sudo: false,
    hidden: false,
    args: [],
    examples: [],
    ...overrides,
  };
}

function fakeDeps(
  commands: CatalogCommand[] = [],
  output = "ok",
): { deps: OmarchyToolDeps; calls: Call[] } {
  const calls: Call[] = [];
  const deps: OmarchyToolDeps = {
    home: "/home/test",
    async exec(file, argv, { timeoutMs }) {
      assert.ok(Array.isArray(argv), "executor must receive argv arrays");
      assert.ok(argv.every((arg) => typeof arg === "string"), "every argv item must be a string");
      calls.push({ file, argv, timeoutMs });
      if (file === "omarchy" && argv.join(" ") === "commands --json") {
        return { stdout: JSON.stringify({ ok: true, commands }), stderr: "" };
      }
      return { stdout: output, stderr: "" };
    },
  };
  return { deps, calls };
}

async function rejectsWithCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof OmarchyToolError && error.code === code);
}

test("exports the complete focused Omarchy schema set", () => {
  const names = OMARCHY_TOOL_SCHEMAS.map((tool) => tool.name);
  assert.equal(names.length, 19);
  assert.deepEqual(new Set(names).size, names.length);
  assert.ok(names.includes("omarchy_status"));
  assert.ok(names.includes("hyprland_set_option"));
  assert.ok(names.includes("read_config_file"));
  assert.ok(names.includes("omarchy_help"));
  assert.ok(names.includes("omarchy_command"));
});

test("precise tools validate arguments before exec and always pass argv plus a timeout", async () => {
  const { deps, calls } = fakeDeps();
  await runOmarchyTool("omarchy_brightness", { action: "up", percent: 7 }, deps);
  assert.deepEqual(calls, [{ file: "omarchy", argv: ["brightness", "display", "+7%"], timeoutMs: 5_000 }]);

  await rejectsWithCode(runOmarchyTool("omarchy_brightness", { action: "set", percent: 101 }, deps), "bad_args");
  await rejectsWithCode(runOmarchyTool("omarchy_open_url", { url: "file:///etc/passwd" }, deps), "bad_args");
  await rejectsWithCode(runOmarchyTool("omarchy_launch", { target: "terminal", arg: "rm -rf /" }, deps), "bad_args");
  assert.equal(calls.length, 1);
});

test("the long-tail executor allowlists safe catalog routes and denies everything else", async () => {
  const denied = [
    "launch or focus",
    "launch terminal",
    "launch tui",
    "mise install",
    "refresh config",
    "hyprland toggle",
    "network password",
  ];
  const allowed = ["theme set", "toggle nightlight", "launch browser"];
  const confirmations = ["system lock", "hyprland monitor internal", "toggle hybrid gpu"];
  const catalog = [
    ...denied.map((route) => catalogCommand(route)),
    ...allowed.map((route) => catalogCommand(route)),
    ...confirmations.map((route) => catalogCommand(route)),
    catalogCommand("theme hidden", { hidden: true }),
    catalogCommand("audio privileged", { requires_sudo: true }),
  ];
  const { deps, calls } = fakeDeps(catalog, "allowed");

  for (const route of [...denied, "theme hidden", "audio privileged", ...confirmations]) {
    await rejectsWithCode(runOmarchyTool("omarchy_command", { route }, deps), "denied");
  }
  assert.equal(calls.length, 1, "denied routes must stop after the cached catalog lookup");

  for (const route of allowed) {
    assert.equal(await runOmarchyTool("omarchy_command", { route }, deps), "allowed");
  }
  assert.deepEqual(calls.slice(-3).map(({ argv }) => argv), [
    ["theme", "set"],
    ["toggle", "nightlight"],
    ["launch", "browser"],
  ]);

  for (const route of confirmations) {
    await runOmarchyTool("omarchy_command", { route, confirmed: true }, deps);
  }
});

test("omarchy_command validates argv before loading or executing a route", async () => {
  const { deps, calls } = fakeDeps([catalogCommand("update available")]);
  await rejectsWithCode(
    runOmarchyTool("omarchy_command", { route: "update available", args: ["--json", 2] }, deps),
    "bad_args",
  );
  assert.equal(calls.length, 0);
});

test("omarchy_help discovers even denied routes without running them and caps output", async () => {
  const { deps, calls } = fakeDeps([catalogCommand("launch terminal")], "x".repeat(5_000));
  const output = await runOmarchyTool("omarchy_help", { route: "launch terminal" }, deps);
  assert.ok(output.length < 4_100);
  assert.match(output, /\[truncated\]$/);
  assert.deepEqual(calls.at(-1), {
    file: "omarchy",
    argv: ["launch", "terminal", "--help"],
    timeoutMs: 15_000,
  });
  await rejectsWithCode(runOmarchyTool("omarchy_help", { route: "not real" }, deps), "bad_args");
});

test("omarchy_status returns partial results within its whole-operation deadline", async () => {
  const calls: Call[] = [];
  const deps: OmarchyToolDeps = {
    home: "/home/test",
    async exec(file, argv, { timeoutMs }) {
      calls.push({ file, argv, timeoutMs });
      if (file === "omarchy" && argv.join(" ") === "theme current") {
        return { stdout: "Tokyo Night", stderr: "" };
      }
      return new Promise(() => undefined);
    },
  };

  const started = Date.now();
  const output = await runOmarchyTool("omarchy_status", {}, deps);
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 1_600, `status took ${elapsed} ms`);
  assert.match(output, /^Theme: Tokyo Night;/);
  assert.match(output, /unavailable/);
  assert.equal(calls.length, 10);
});

test("omarchy_status caps its final assembled output", async () => {
  const { deps } = fakeDeps([], "x".repeat(5_000));
  const output = await runOmarchyTool("omarchy_status", {}, deps);
  assert.ok(output.length < 4_100);
  assert.match(output, /\[truncated\]$/);
});

test("Hyprland option tools validate dotted keys and safely encode typed values", async () => {
  const { deps, calls } = fakeDeps([], '{"bool":true,"set":true}');
  const read = await runOmarchyTool("hyprland_get_option", { key: "input.touchpad.natural_scroll" }, deps);
  assert.match(read, /natural_scroll/);
  assert.deepEqual(calls[0], {
    file: "hyprctl",
    argv: ["getoption", "-j", "input:touchpad:natural_scroll"],
    timeoutMs: 5_000,
  });

  await runOmarchyTool("hyprland_set_option", { key: "decoration.blur.enabled", value: false }, deps);
  assert.deepEqual(calls[1], {
    file: "hyprctl",
    argv: ["eval", "hl.config({ decoration = { blur = { enabled = false } } })"],
    timeoutMs: 5_000,
  });
  await rejectsWithCode(runOmarchyTool("hyprland_set_option", { key: "decoration.blur); os.execute('x')", value: true }, deps), "bad_args");
  await rejectsWithCode(runOmarchyTool("hyprland_set_option", { key: "decoration.blur.enabled", value: "line\nbreak" }, deps), "bad_args");
  await rejectsWithCode(runOmarchyTool("hyprland_set_option", { key: "decoration.blur.enabled", value: { bad: true } }, deps), "bad_args");
  assert.equal(calls.length, 2);
});

test("read_config_file permits only real files under the five roots and rejects traversal and symlink escapes", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "omarchy-tools-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const allowed = join(home, ".config/hypr");
  await mkdir(allowed, { recursive: true });
  const config = join(allowed, "input.lua");
  await writeFile(config, Array.from({ length: 220 }, (_, index) => `line ${index + 1}`).join("\n"));
  const outside = join(home, "secret.txt");
  await writeFile(outside, "secret");
  await symlink(outside, join(allowed, "escape.lua"));
  const deps: OmarchyToolDeps = {
    home,
    async exec() {
      assert.fail("reading config must not execute a process");
    },
  };

  const output = await runOmarchyTool("read_config_file", { path: "~/.config/hypr/input.lua" }, deps);
  assert.match(output, /^line 1/m);
  assert.doesNotMatch(output, /line 201/);
  assert.match(output, /truncated/);

  await rejectsWithCode(runOmarchyTool("read_config_file", { path: "~/.config/hypr/../../secret.txt" }, deps), "denied");
  await rejectsWithCode(runOmarchyTool("read_config_file", { path: "~/.config/hypr/escape.lua" }, deps), "denied");
  await rejectsWithCode(runOmarchyTool("read_config_file", { path: "relative.lua" }, deps), "bad_args");
});

test("omarchyAvailable detects an executable from PATH without running it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "omarchy-path-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, "omarchy");
  await writeFile(binary, "#!/bin/sh\nexit 0\n");
  assert.equal(omarchyAvailable(directory), false);
  await chmod(binary, 0o700);
  assert.equal(omarchyAvailable(directory), true);
  assert.equal(omarchyAvailable(""), false);
});
