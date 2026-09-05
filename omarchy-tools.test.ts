import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  ALLOWED_ROUTES,
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
  args: string;
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
    args: route === "launch terminal" ? "[--shell]" : "",
    examples: [],
    ...overrides,
  };
}

function realDeps(): OmarchyToolDeps {
  return {
    home: homedir(),
    exec(file, argv, { timeoutMs }) {
      return new Promise((resolve, reject) => {
        execFile(
          file,
          argv,
          { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: timeoutMs },
          (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }),
        );
      });
    },
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
  const command = OMARCHY_TOOL_SCHEMAS.find((tool) => tool.name === "omarchy_command");
  assert.ok(command);
  assert.equal("args" in command.parameters.properties, false);
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

test("the long-tail executor accepts only fixed, argument-free catalog routes", async () => {
  const denied = [
    "notification send",
    "network qr",
    "launch editor",
    "launch terminal",
    "launch spotify",
    "launch signal",
    "launch 1password",
    "voxtype status",
    "toggle",
    "mise install",
    "theme current extra",
    "theme currentx",
  ];
  const catalog = [
    ...denied.map((route) => catalogCommand(route)),
    catalogCommand("theme current"),
    catalogCommand("system lock"),
    catalogCommand("toggle hybrid gpu", { requires_sudo: true }),
    catalogCommand("theme list", { hidden: true }),
  ];
  const { deps, calls } = fakeDeps(catalog, "allowed");

  for (const route of [...denied, "toggle hybrid gpu", "theme list", "system lock"]) {
    await rejectsWithCode(runOmarchyTool("omarchy_command", { route }, deps), "denied");
  }
  assert.equal(calls.length, 1, "denied routes must stop after the cached catalog lookup");

  assert.equal(await runOmarchyTool("omarchy_command", { route: "theme current" }, deps), "allowed");
  assert.deepEqual(calls.at(-1), {
    file: "omarchy",
    argv: ["theme", "current"],
    timeoutMs: 15_000,
  });

  assert.equal(
    await runOmarchyTool("omarchy_command", { route: "system lock", confirmed: true }, deps),
    "allowed",
  );
});

test("the fixed route list matches the real Omarchy catalog", { skip: !omarchyAvailable() }, async () => {
  const deps = realDeps();
  const { stdout } = await deps.exec("omarchy", ["commands", "--json"], { timeoutMs: 15_000 });
  const commands = (JSON.parse(stdout) as { commands: CatalogCommand[] }).commands;
  const catalog = new Map(commands.map((command) => [command.route.replace(/^omarchy /, ""), command]));

  for (const route of ALLOWED_ROUTES) {
    const command = catalog.get(route);
    assert.ok(command, `fixed route is missing from the real catalog: ${route}`);
    assert.equal(command.hidden, false, `fixed route is hidden: ${route}`);
    assert.equal(command.requires_sudo, false, `fixed route requires sudo: ${route}`);
  }

  const hybridGpu = catalog.get("toggle hybrid gpu");
  assert.ok(hybridGpu, "toggle hybrid gpu is missing from the real catalog");
  assert.equal(hybridGpu.requires_sudo, true);
  await rejectsWithCode(
    runOmarchyTool("omarchy_command", { route: "toggle hybrid gpu", confirmed: true }, deps),
    "denied",
  );
});

test("omarchy_command rejects args before loading or executing a route", async () => {
  const { deps, calls } = fakeDeps([catalogCommand("theme current")]);
  await rejectsWithCode(
    runOmarchyTool("omarchy_command", { route: "theme current", args: [] }, deps),
    "bad_args",
  );
  assert.equal(calls.length, 0);
});

test("Hyprland dispatch uses validated Lua dispatchers", async () => {
  const { deps, calls } = fakeDeps();

  await runOmarchyTool("hyprland_dispatch", { action: "workspace", arg: "3" }, deps);
  await runOmarchyTool("hyprland_dispatch", { action: "workspace", arg: "name:bb" }, deps);
  await runOmarchyTool("hyprland_dispatch", { action: "move_to_workspace", arg: "name:bb" }, deps);
  await runOmarchyTool("hyprland_dispatch", { action: "focus_window", arg: "address:0xdead" }, deps);
  await runOmarchyTool("hyprland_dispatch", { action: "fullscreen" }, deps);
  await runOmarchyTool("hyprland_dispatch", { action: "toggle_floating" }, deps);
  await runOmarchyTool("hyprland_dispatch", { action: "close_active", confirmed: true }, deps);

  assert.deepEqual(calls.map(({ file, argv }) => ({ file, argv })), [
    { file: "hyprctl", argv: ["eval", 'hl.dispatch(hl.dsp.focus({ workspace = "3" }))'] },
    { file: "hyprctl", argv: ["eval", 'hl.dispatch(hl.dsp.focus({ workspace = "name:bb" }))'] },
    { file: "hyprctl", argv: ["eval", 'hl.dispatch(hl.dsp.window.move({ workspace = "name:bb" }))'] },
    { file: "hyprctl", argv: ["eval", 'hl.dispatch(hl.dsp.focus({ window = "address:0xdead" }))'] },
    { file: "hyprctl", argv: ["eval", 'hl.dispatch(hl.dsp.window.fullscreen({ mode = "fullscreen" }))'] },
    { file: "hyprctl", argv: ["eval", 'hl.dispatch(hl.dsp.window.float({ action = "toggle" }))'] },
    { file: "hyprctl", argv: ["eval", "hl.dispatch(hl.dsp.window.close())"] },
  ]);

  await rejectsWithCode(
    runOmarchyTool("hyprland_dispatch", { action: "workspace", arg: '3; os.execute("id")' }, deps),
    "bad_args",
  );
  await rejectsWithCode(
    runOmarchyTool("hyprland_dispatch", { action: "close_active" }, deps),
    "denied",
  );
  assert.equal(calls.length, 7);

  const warning = "warning: hl.focus: window not found";
  const warningDeps = fakeDeps([], warning).deps;
  assert.equal(
    await runOmarchyTool("hyprland_dispatch", { action: "focus_window", arg: "address:0xdead" }, warningDeps),
    warning,
  );
});

test("Hyprland focus resolves an exact class or title to a validated address", async () => {
  const calls: Call[] = [];
  const deps: OmarchyToolDeps = {
    home: "/home/test",
    async exec(file, argv, { timeoutMs }) {
      calls.push({ file, argv, timeoutMs });
      if (file === "hyprctl" && argv.join(" ") === "clients -j") {
        return {
          stdout: JSON.stringify([{ address: "0xabc123", class: "org.example.App", title: "Example" }]),
          stderr: "",
        };
      }
      return { stdout: "ok", stderr: "" };
    },
  };

  await runOmarchyTool("hyprland_dispatch", { action: "focus_window", arg: "Example" }, deps);
  assert.deepEqual(calls.map(({ argv }) => argv), [
    ["clients", "-j"],
    ["eval", 'hl.dispatch(hl.dsp.focus({ window = "address:0xabc123" }))'],
  ]);
  await rejectsWithCode(
    runOmarchyTool("hyprland_dispatch", { action: "focus_window", arg: "Not running" }, deps),
    "bad_args",
  );
  assert.equal(calls.at(-1)?.argv.join(" "), "clients -j");
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

test("optional launchers check their executable before invoking installer-capable routes", async () => {
  const launchers = [
    { target: "spotify", binary: "spotify", label: "Spotify" },
    { target: "signal", binary: "signal-desktop", label: "Signal" },
    { target: "1password", binary: "1password", label: "1Password" },
  ] as const;
  const present = fakeDeps();

  for (const { target } of launchers) {
    assert.equal(await runOmarchyTool("omarchy_launch", { target }, present.deps), `Launched ${target}.`);
  }
  assert.deepEqual(present.calls.map(({ argv }) => argv), launchers.flatMap(({ target, binary }) => [
    ["cmd", "present", binary],
    ["launch", target],
  ]));

  for (const { target, binary, label } of launchers) {
    const calls: Call[] = [];
    const deps: OmarchyToolDeps = {
      home: "/home/test",
      async exec(file, argv, { timeoutMs }) {
        calls.push({ file, argv, timeoutMs });
        throw new Error("not found");
      },
    };
    await assert.rejects(
      runOmarchyTool("omarchy_launch", { target }, deps),
      (error: unknown) => error instanceof OmarchyToolError
        && error.code === "denied"
        && error.message === `${label} is not installed; installing needs a terminal`,
    );
    assert.deepEqual(calls, [{ file: "omarchy", argv: ["cmd", "present", binary], timeoutMs: 5_000 }]);
  }
});

test("positional Omarchy values reject option-like input and editor paths stay in allowed roots", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "omarchy-editor-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = join(home, "notes.txt");
  await writeFile(file, "notes");
  const { deps, calls } = fakeDeps();
  deps.home = home;

  await runOmarchyTool("omarchy_launch", { target: "editor", arg: file }, deps);
  assert.deepEqual(calls.at(-1)?.argv, ["launch", "editor", file]);

  await rejectsWithCode(runOmarchyTool("omarchy_notify", { headline: "--exec" }, deps), "bad_args");
  await rejectsWithCode(runOmarchyTool("omarchy_reminder", { minutes: 5, message: "-i" }, deps), "bad_args");
  await rejectsWithCode(runOmarchyTool("omarchy_launch", { target: "editor", arg: "/etc/passwd" }, deps), "denied");
  await rejectsWithCode(runOmarchyTool("omarchy_launch", { target: "editor", arg: "--inline" }, deps), "bad_args");
  await rejectsWithCode(runOmarchyTool("omarchy_theme", { action: "set", name: "../Tokyo Night" }, deps), "bad_args");
  await rejectsWithCode(runOmarchyTool("omarchy_focus_app", { app_name: "-i" }, deps), "bad_args");
  assert.equal(calls.length, 1);
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
