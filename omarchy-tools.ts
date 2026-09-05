import { access, readFile, realpath } from "node:fs/promises";
import { accessSync, constants } from "node:fs";
import { basename, delimiter, isAbsolute, resolve, sep } from "node:path";

const QUICK_TIMEOUT_MS = 5_000;
const ROUTE_TIMEOUT_MS = 15_000;
const OUTPUT_LIMIT = 4_000;
const MAX_ARG_LENGTH = 2_000;

export interface OmarchyToolDeps {
  exec(
    file: string,
    argv: string[],
    options: { timeoutMs: number },
  ): Promise<{ stdout: string; stderr: string }>;
  home: string;
}

export type OmarchyToolErrorCode = "bad_args" | "denied" | "timeout" | "exec_failed";

export class OmarchyToolError extends Error {
  readonly code: OmarchyToolErrorCode;

  constructor(code: OmarchyToolErrorCode, message: string) {
    super(message);
    this.name = "OmarchyToolError";
    this.code = code;
  }
}

const functionTool = (
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
) => ({
  type: "function",
  name,
  description,
  parameters: { type: "object", properties, ...(required.length ? { required } : {}) },
});

export const OMARCHY_TOOL_SCHEMAS = [
  functionTool(
    "omarchy_status",
    "Get a fast spoken-status snapshot of this Omarchy desktop: theme, background, display, power, network, sound, toggles, version, and host. Use for 'how is the system?'; do not use it to change anything.",
  ),
  functionTool(
    "omarchy_theme",
    "List, inspect, or apply Omarchy themes, or advance the current background. Use only for appearance requests.",
    {
      action: { type: "string", enum: ["list", "current", "set", "next_background"] },
      name: { type: "string", description: "Exact theme name from the list; required for set." },
    },
    ["action"],
  ),
  functionTool(
    "omarchy_toggle",
    "Read or change one supported Omarchy desktop toggle. Use this instead of the general command router for these fixed flags.",
    {
      flag: {
        type: "string",
        enum: ["nightlight", "idle", "notification-silencing", "bar", "touchpad", "touchscreen", "screensaver"],
      },
      state: { type: "string", enum: ["on", "off", "toggle", "status"] },
    },
    ["flag", "state"],
  ),
  functionTool(
    "omarchy_audio",
    "Adjust output volume, mute, output device, or microphone mute. Use only for audio controls; percent is required for set_volume and optional for volume steps.",
    {
      action: {
        type: "string",
        enum: ["volume_up", "volume_down", "set_volume", "mute_toggle", "switch_output", "mic_mute_toggle"],
      },
      percent: { type: "number", minimum: 0, maximum: 100 },
    },
    ["action"],
  ),
  functionTool(
    "omarchy_brightness",
    "Set or step the focused display's brightness. Use only for display brightness; percent is required for set and optional for steps.",
    {
      action: { type: "string", enum: ["set", "up", "down"] },
      percent: { type: "number", minimum: 1, maximum: 100 },
    },
    ["action"],
  ),
  functionTool(
    "omarchy_launch",
    "Launch one known desktop application or surface. Use omarchy_open_url for a web address; arg is accepted only as an editor path.",
    {
      target: {
        type: "string",
        enum: ["browser", "terminal", "editor", "files", "spotify", "signal", "1password", "about", "screensaver"],
      },
      arg: { type: "string", description: "A path for the editor target." },
    },
    ["target"],
  ),
  functionTool(
    "omarchy_open_url",
    "Open one http or https URL in the default browser. Do not use for local files or shell commands.",
    { url: { type: "string", description: "Complete http or https URL." } },
    ["url"],
  ),
  functionTool(
    "omarchy_focus_app",
    "Focus an existing Hyprland application by its human app name. Do not use this to launch an app.",
    { app_name: { type: "string" } },
    ["app_name"],
  ),
  functionTool(
    "hyprland_query",
    "Inspect active windows, workspaces, or monitors in a short bounded summary. Use for current window-manager state, not configuration values.",
    { kind: { type: "string", enum: ["active_window", "windows", "workspaces", "monitors"] } },
    ["kind"],
  ),
  functionTool(
    "hyprland_dispatch",
    "Perform one allowlisted Hyprland navigation or active-window action. Closing the active window requires confirmed=true after asking the user.",
    {
      action: {
        type: "string",
        enum: ["workspace", "focus_window", "move_to_workspace", "fullscreen", "toggle_floating", "close_active"],
      },
      arg: { type: "string", description: "Workspace or window selector, when the action needs one." },
      confirmed: { type: "boolean", description: "True only after the user confirms closing the active window." },
    },
    ["action"],
  ),
  functionTool(
    "hyprland_window",
    "Apply one focused-window, workspace-layout, or monitor-scaling operation. Use only for these fixed operations.",
    {
      action: {
        type: "string",
        enum: ["gaps_toggle", "transparency_toggle", "tiled_fullscreen_toggle", "layout_toggle", "pop", "scaling_up", "scaling_down"],
      },
    },
    ["action"],
  ),
  functionTool(
    "hyprland_get_option",
    "Read one Hyprland runtime option by dotted key, for example decoration.blur.enabled. Use read_config_file instead to explain persistent configuration.",
    { key: { type: "string" } },
    ["key"],
  ),
  functionTool(
    "hyprland_set_option",
    "Temporarily set one Hyprland runtime option until the next reload. This never edits configuration files.",
    {
      key: { type: "string", description: "Dotted option key such as decoration.rounding." },
      value: { oneOf: [{ type: "number" }, { type: "boolean" }, { type: "string", maxLength: 200 }] },
    },
    ["key", "value"],
  ),
  functionTool(
    "omarchy_notify",
    "Send a desktop notification with a short headline and optional body. Do not use for reminders that need a delay.",
    { headline: { type: "string" }, body: { type: "string" } },
    ["headline"],
  ),
  functionTool(
    "omarchy_osd",
    "Show a brief on-screen display message now. Do not use it for persistent notifications or reminders.",
    { message: { type: "string" } },
    ["message"],
  ),
  functionTool(
    "omarchy_reminder",
    "Schedule a desktop reminder a number of minutes from now. Use only when the user asks to be reminded later.",
    { minutes: { type: "number", minimum: 1, maximum: 10080 }, message: { type: "string" } },
    ["minutes"],
  ),
  functionTool(
    "read_config_file",
    "Read up to 200 lines from an allowed Omarchy or Hyprland config file so you can explain it. This is read-only and rejects paths outside the config roots.",
    { path: { type: "string" } },
    ["path"],
  ),
  functionTool(
    "omarchy_help",
    "Read bounded help for a known Omarchy route. Use this before omarchy_command when no precise tool fits; it never runs the route itself.",
    { route: { type: "string", description: "Route without the leading 'omarchy', for example 'update available'." } },
    ["route"],
  ),
  functionTool(
    "omarchy_command",
    "Run a discovered, non-privileged Omarchy route when no precise tool fits. Call omarchy_help first. Unsafe routes are denied, and disruptive routes require confirmed=true.",
    {
      route: { type: "string", description: "Known route without the leading 'omarchy'." },
      args: { type: "array", items: { type: "string" }, maxItems: 30 },
      confirmed: { type: "boolean" },
    },
    ["route"],
  ),
] as const;

function bad(message: string): never {
  throw new OmarchyToolError("bad_args", `Invalid arguments: ${message}`);
}

function textArg(args: Record<string, unknown>, key: string, max = 200): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") bad(`${key} is required`);
  if (value.length > max || /[\0\r\n]/.test(value)) bad(`${key} is too long or contains control characters`);
  return value;
}

function enumArg<const T extends readonly string[]>(
  args: Record<string, unknown>,
  key: string,
  choices: T,
): T[number] {
  const value = args[key];
  if (typeof value !== "string" || !choices.includes(value)) bad(`${key} must be one of ${choices.join(", ")}`);
  return value as T[number];
}

function percentArg(args: Record<string, unknown>, required: boolean, fallback: number): number {
  const value = args.percent;
  if (value === undefined && !required) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    bad("percent must be a whole number from 0 to 100");
  }
  return value;
}

function capped(text: string, max = OUTPUT_LIMIT): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}\n…[truncated]`;
}

async function execute(
  deps: OmarchyToolDeps,
  file: string,
  argv: string[],
  timeoutMs = QUICK_TIMEOUT_MS,
  outputLimit = OUTPUT_LIMIT,
): Promise<string> {
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== "string")) bad("command arguments must be an argv array");
  try {
    const result = await deps.exec(file, [...argv], { timeoutMs });
    return capped([result.stdout, result.stderr].filter(Boolean).join("\n"), outputLimit) || "Done.";
  } catch (cause) {
    if (cause instanceof OmarchyToolError) throw cause;
    const error = cause as { code?: unknown; killed?: unknown; signal?: unknown; message?: unknown };
    const timeout = error.code === "ETIMEDOUT" || (error.killed === true && error.signal === "SIGTERM");
    const reason = (cause instanceof Error ? cause.message : String(cause)).replace(/\s+/g, " ").trim();
    throw new OmarchyToolError(
      timeout ? "timeout" : "exec_failed",
      timeout
        ? `The command timed out after ${timeoutMs / 1000} seconds.`
        : `The command failed: ${capped(reason, 300)}`,
    );
  }
}

function resultValue(result: PromiseSettledResult<string>, fallback = "unavailable"): string {
  return result.status === "fulfilled" ? result.value.trim() || fallback : fallback;
}

async function flagExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function toggleStatus(flag: string, deps: OmarchyToolDeps): Promise<boolean> {
  switch (flag) {
    case "nightlight": {
      const output = await execute(deps, "omarchy", ["toggle", "nightlight", "--status"]);
      try {
        return JSON.parse(output).enabled === true;
      } catch {
        throw new OmarchyToolError("exec_failed", "Could not read nightlight status.");
      }
    }
    case "idle":
      return !(await flagExists(resolve(deps.home, ".local/state/omarchy/indicators/stay-awake")));
    case "notification-silencing":
      return (await execute(deps, "omarchy-shell", ["notifications", "isDnd"])).trim() === "on";
    case "bar":
      return !(await flagExists(resolve(deps.home, ".local/state/omarchy/toggles/bar-off")));
    case "touchpad":
      return !(await flagExists(resolve(deps.home, ".local/state/omarchy/toggles/hypr/touchpad-disabled-name")));
    case "touchscreen":
      return !(await flagExists(resolve(deps.home, ".local/state/omarchy/toggles/hypr/touchscreen-disabled-name")));
    case "screensaver":
      return !(await flagExists(resolve(deps.home, ".local/state/omarchy/toggles/screensaver-off")));
    default:
      return bad("unknown toggle flag");
  }
}

async function runStatus(deps: OmarchyToolDeps): Promise<string> {
  const commands = await Promise.allSettled([
    execute(deps, "omarchy", ["theme", "current"]),
    execute(deps, "omarchy", ["theme", "bg", "current"]),
    execute(deps, "omarchy", ["hyprland", "monitor", "focused"]),
    execute(deps, "upower", ["-i", "/org/freedesktop/UPower/devices/DisplayDevice"]),
    execute(deps, "nmcli", ["-t", "-f", "STATE,CONNECTIVITY", "general"]),
    execute(deps, "wpctl", ["get-volume", "@DEFAULT_AUDIO_SINK@"]),
    execute(deps, "omarchy", ["version"]),
    execute(deps, "hostname", []),
    toggleStatus("nightlight", deps).then((on) => (on ? "on" : "off")),
    toggleStatus("notification-silencing", deps).then((on) => (on ? "on" : "off")),
  ]);
  const batteryRaw = resultValue(commands[3]);
  const batteryPercent = batteryRaw.match(/percentage:\s*([^\n]+)/i)?.[1]?.trim();
  const batteryState = batteryRaw.match(/state:\s*([^\n]+)/i)?.[1]?.trim();
  const volumeRaw = resultValue(commands[5]);
  const volumeNumber = Number(volumeRaw.match(/Volume:\s*([0-9.]+)/i)?.[1]);
  const volume = Number.isFinite(volumeNumber) ? `${Math.round(volumeNumber * 100)}%` : "unavailable";
  const muted = /\[MUTED\]/i.test(volumeRaw) ? "muted" : "unmuted";
  const [idle, bar, touchpad, touchscreen, screensaver] = await Promise.all(
    ["idle", "bar", "touchpad", "touchscreen", "screensaver"].map((flag) => toggleStatus(flag, deps)),
  );
  const backgroundRaw = resultValue(commands[1]);
  const background = backgroundRaw === "unavailable" ? backgroundRaw : basename(backgroundRaw);
  return [
    `Theme: ${resultValue(commands[0])}; background: ${background}; monitor: ${resultValue(commands[2])}.`,
    `Battery: ${batteryPercent ?? "unavailable"}${batteryState ? ` (${batteryState})` : ""}; network: ${resultValue(commands[4])}; volume: ${volume} (${muted}).`,
    `Toggles: nightlight ${resultValue(commands[8])}, idle ${idle ? "on" : "off"}, notification silencing ${resultValue(commands[9])}, bar ${bar ? "on" : "off"}, touchpad ${touchpad ? "on" : "off"}, touchscreen ${touchscreen ? "on" : "off"}, screensaver ${screensaver ? "on" : "off"}.`,
    `Omarchy: ${resultValue(commands[6])}; host: ${resultValue(commands[7])}.`,
  ].join("\n");
}

const OPTION_KEY = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z][A-Za-z0-9_-]*)+$/;

function optionKey(args: Record<string, unknown>): string {
  const key = textArg(args, "key", 200);
  if (!OPTION_KEY.test(key)) bad("key must contain dotted identifiers such as decoration.blur.enabled");
  return key;
}

function luaValue(value: unknown): string {
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000) return String(value);
  if (typeof value === "string" && value.length <= 200 && !/[\0-\x1f\x7f]/.test(value)) return JSON.stringify(value);
  return bad("value must be a finite number, boolean, or short single-line string");
}

function configExpression(key: string, value: string): string {
  const parts = key.split(".");
  let nested = value;
  for (let index = parts.length - 1; index >= 0; index -= 1) nested = `{ ${parts[index]} = ${nested} }`;
  return `hl.config(${nested})`;
}

interface CommandInfo {
  route: string;
  requires_sudo?: boolean;
  hidden?: boolean;
}

const commandCaches = new WeakMap<OmarchyToolDeps, Promise<Map<string, CommandInfo>>>();

async function commandCatalog(deps: OmarchyToolDeps): Promise<Map<string, CommandInfo>> {
  let pending = commandCaches.get(deps);
  if (!pending) {
    pending = execute(deps, "omarchy", ["commands", "--json"], ROUTE_TIMEOUT_MS, Number.POSITIVE_INFINITY).then((output) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(output);
      } catch {
        throw new OmarchyToolError("exec_failed", "Omarchy returned an invalid command catalog.");
      }
      const commands = (parsed as { commands?: unknown }).commands;
      if (!Array.isArray(commands)) throw new OmarchyToolError("exec_failed", "Omarchy returned an invalid command catalog.");
      const catalog = new Map<string, CommandInfo>();
      for (const candidate of commands) {
        if (!candidate || typeof candidate !== "object") continue;
        const info = candidate as CommandInfo;
        if (typeof info.route !== "string" || !info.route.startsWith("omarchy ")) continue;
        catalog.set(info.route.slice("omarchy ".length).trim().replace(/\s+/g, " "), info);
      }
      return catalog;
    });
    commandCaches.set(deps, pending);
  }
  return pending;
}

function normalizedRoute(args: Record<string, unknown>): string {
  let route = textArg(args, "route", 300).trim().replace(/\s+/g, " ");
  if (route === "omarchy") bad("route must name an Omarchy subcommand");
  if (route.startsWith("omarchy ")) route = route.slice("omarchy ".length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+ -]*$/.test(route)) bad("route contains unsupported characters");
  return route;
}

function routeStarts(route: string, prefix: string): boolean {
  return route === prefix || route.startsWith(`${prefix} `);
}

function deniedRoute(route: string): boolean {
  if (routeStarts(route, "system") && !["system lock", "system wake", "system stats"].some((ok) => routeStarts(route, ok))) return true;
  if (routeStarts(route, "update") && !["update available", "update status"].some((ok) => routeStarts(route, ok))) return true;
  const prefixes = [
    "install", "remove", "pkg", "reinstall", "setup", "provision", "migrate", "hibernation", "drive", "dev", "channel", "upgrade", "snapshot", "factory", "tui remove", "webapp remove", "plugin add", "plugin remove", "theme remove", "theme install", "theme update", "hyprland window close all", "refresh pacman", "sudo",
  ];
  return prefixes.some((prefix) => routeStarts(route, prefix));
}

function confirmationRequired(route: string): boolean {
  return ["system lock", "hyprland monitor internal", "toggle hybrid gpu"].some((prefix) => routeStarts(route, prefix));
}

function routeArgs(args: Record<string, unknown>): string[] {
  if (args.args === undefined) return [];
  if (!Array.isArray(args.args) || args.args.length > 30) bad("args must be an array of at most 30 strings");
  return args.args.map((arg) => {
    if (typeof arg !== "string" || arg.length > MAX_ARG_LENGTH || arg.includes("\0")) bad("each command argument must be a short string");
    return arg;
  });
}

async function knownRoute(route: string, deps: OmarchyToolDeps): Promise<CommandInfo> {
  const command = (await commandCatalog(deps)).get(route);
  if (!command) bad(`unknown Omarchy route: ${route}`);
  return command;
}

async function readAllowedConfig(args: Record<string, unknown>, deps: OmarchyToolDeps): Promise<string> {
  const requested = textArg(args, "path", 1_000).replace(/^~(?=\/|$)/, deps.home);
  if (!isAbsolute(requested)) bad("path must be absolute or start with ~/");
  const target = resolve(requested);
  const roots = [
    resolve(deps.home, ".config/hypr"),
    resolve(deps.home, ".config/omarchy"),
    resolve(deps.home, "omarchy-config/shared/config"),
    "/usr/share/omarchy/default",
    "/usr/share/omarchy/config",
  ];
  let actual: string;
  try {
    actual = await realpath(target);
  } catch {
    throw new OmarchyToolError("bad_args", "Invalid arguments: config file does not exist.");
  }
  const realRoots = (await Promise.all(roots.map((root) => realpath(root).catch(() => null)))).filter(
    (root): root is string => root !== null,
  );
  if (!realRoots.some((root) => actual === root || actual.startsWith(`${root}${sep}`))) {
    throw new OmarchyToolError("denied", "That path is outside the allowed Omarchy configuration roots.");
  }
  let content: string;
  try {
    content = await readFile(actual, "utf8");
  } catch {
    throw new OmarchyToolError("bad_args", "Invalid arguments: path must name a readable text file.");
  }
  const lines = content.split(/\r?\n/);
  const limited = lines.slice(0, 200).join("\n");
  return capped(lines.length > 200 ? `${limited}\n…[truncated after 200 lines]` : limited);
}

export async function runOmarchyTool(
  name: string,
  args: Record<string, unknown>,
  deps: OmarchyToolDeps,
): Promise<string> {
  switch (name) {
    case "omarchy_status":
      return runStatus(deps);
    case "omarchy_theme": {
      const action = enumArg(args, "action", ["list", "current", "set", "next_background"] as const);
      if (action === "set") return execute(deps, "omarchy", ["theme", "set", textArg(args, "name")]);
      if (args.name !== undefined) bad("name is only valid with action set");
      const route = action === "next_background" ? ["theme", "bg", "next"] : ["theme", action];
      return execute(deps, "omarchy", route);
    }
    case "omarchy_toggle": {
      const flag = enumArg(args, "flag", ["nightlight", "idle", "notification-silencing", "bar", "touchpad", "touchscreen", "screensaver"] as const);
      const state = enumArg(args, "state", ["on", "off", "toggle", "status"] as const);
      const current = await toggleStatus(flag, deps);
      if (state === "status") return `${flag}: ${current ? "on" : "off"}.`;
      const target = state === "toggle" ? !current : state === "on";
      if (target === current) return `${flag} is already ${current ? "on" : "off"}.`;
      if (flag === "idle") await execute(deps, "omarchy", ["toggle", "idle", target ? "allow-idle" : "stay-awake"]);
      else if (["bar", "touchpad", "touchscreen"].includes(flag)) await execute(deps, "omarchy", ["toggle", flag, target ? "on" : "off"]);
      else {
        const routeFlag = flag === "notification-silencing" ? ["notification", "silencing"] : [flag];
        await execute(deps, "omarchy", ["toggle", ...routeFlag]);
      }
      return `${flag}: ${target ? "on" : "off"}.`;
    }
    case "omarchy_audio": {
      const action = enumArg(args, "action", ["volume_up", "volume_down", "set_volume", "mute_toggle", "switch_output", "mic_mute_toggle"] as const);
      if (action === "set_volume") {
        const percent = percentArg(args, true, 0);
        await execute(deps, "wpctl", ["set-volume", "@DEFAULT_AUDIO_SINK@", `${percent}%`]);
        await execute(deps, "omarchy", ["osd", "-i", percent === 0 ? "volume-muted" : "volume-high", "-p", String(percent)]);
        return `Volume: ${percent}%.`;
      }
      if (args.percent !== undefined && action !== "volume_up" && action !== "volume_down") bad("percent is only valid for volume changes");
      if (action === "volume_up" || action === "volume_down") {
        const percent = percentArg(args, false, 5);
        if (percent < 1) bad("volume step percent must be at least 1");
        await execute(deps, "omarchy", ["audio", "output", "volume", `${action === "volume_up" ? "+" : "-"}${percent}`]);
      } else if (action === "mute_toggle") await execute(deps, "omarchy", ["audio", "output", "volume", "mute-toggle"]);
      else if (action === "switch_output") await execute(deps, "omarchy", ["audio", "output", "switch"]);
      else await execute(deps, "omarchy", ["audio", "input", "mute"]);
      return "Audio updated.";
    }
    case "omarchy_brightness": {
      const action = enumArg(args, "action", ["set", "up", "down"] as const);
      const percent = percentArg(args, action === "set", 5);
      if (percent < 1) bad("brightness percent must be at least 1");
      const step = action === "set" ? `${percent}%` : action === "up" ? `+${percent}%` : `${percent}%-`;
      await execute(deps, "omarchy", ["brightness", "display", step]);
      return `Brightness ${action === "set" ? `set to ${percent}%` : "updated"}.`;
    }
    case "omarchy_launch": {
      const target = enumArg(args, "target", ["browser", "terminal", "editor", "files", "spotify", "signal", "1password", "about", "screensaver"] as const);
      const arg = args.arg;
      if (target === "editor") {
        const path = textArg(args, "arg", 1_000);
        await execute(deps, "omarchy", ["launch", "editor", path]);
      } else {
        if (arg !== undefined) bad("arg is only valid for the editor target");
        await execute(deps, "omarchy", ["launch", target === "files" ? "nautilus" : target]);
      }
      return `Launched ${target}.`;
    }
    case "omarchy_open_url": {
      const raw = textArg(args, "url", 2_048);
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return bad("url must be a complete http or https URL");
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") bad("url must use http or https");
      await execute(deps, "omarchy", ["launch", "browser", url.toString()]);
      return "Opened.";
    }
    case "omarchy_focus_app":
      await execute(deps, "omarchy", ["hyprland", "focus", "app", textArg(args, "app_name")]);
      return "Focused.";
    case "hyprland_query": {
      const kind = enumArg(args, "kind", ["active_window", "windows", "workspaces", "monitors"] as const);
      const command = kind === "active_window" ? "activewindow" : kind === "windows" ? "clients" : kind;
      const output = await execute(deps, "hyprctl", ["-j", command]);
      let parsed: unknown;
      try {
        parsed = JSON.parse(output);
      } catch {
        throw new OmarchyToolError("exec_failed", "Hyprland returned invalid state.");
      }
      if (kind === "active_window") {
        const window = parsed as Record<string, unknown>;
        return capped(JSON.stringify({ class: window.class, title: window.title, workspace: window.workspace, monitor: window.monitor, floating: window.floating, fullscreen: window.fullscreenClient }));
      }
      const rows = Array.isArray(parsed) ? parsed.slice(0, 50) : [];
      if (kind === "windows") return capped(JSON.stringify(rows.map((row) => ({ class: row.class, title: row.title, workspace: row.workspace, monitor: row.monitor }))));
      if (kind === "workspaces") return capped(JSON.stringify(rows.map((row) => ({ id: row.id, name: row.name, monitor: row.monitor, windows: row.windows, layout: row.tiledLayout }))));
      return capped(JSON.stringify(rows.map((row) => ({ id: row.id, name: row.name, description: row.description, workspace: row.activeWorkspace, scale: row.scale, focused: row.focused }))));
    }
    case "hyprland_dispatch": {
      const action = enumArg(args, "action", ["workspace", "focus_window", "move_to_workspace", "fullscreen", "toggle_floating", "close_active"] as const);
      if (action === "close_active" && args.confirmed !== true) throw new OmarchyToolError("denied", "Closing the active window needs a confirmation first.");
      const needsArg = action === "workspace" || action === "focus_window" || action === "move_to_workspace";
      const arg = needsArg ? textArg(args, "arg", 200) : undefined;
      if (!needsArg && args.arg !== undefined) bad(`arg is not valid for ${action}`);
      const dispatcher = { workspace: "workspace", focus_window: "focuswindow", move_to_workspace: "movetoworkspace", fullscreen: "fullscreen", toggle_floating: "togglefloating", close_active: "killactive" }[action];
      await execute(deps, "hyprctl", ["dispatch", dispatcher, ...(arg ? [arg] : [])]);
      return action === "close_active" ? "Window closed." : "Done.";
    }
    case "hyprland_window": {
      const action = enumArg(args, "action", ["gaps_toggle", "transparency_toggle", "tiled_fullscreen_toggle", "layout_toggle", "pop", "scaling_up", "scaling_down"] as const);
      const routes: Record<typeof action, string[]> = {
        gaps_toggle: ["hyprland", "window", "gaps", "toggle"],
        transparency_toggle: ["hyprland", "window", "transparency", "toggle"],
        tiled_fullscreen_toggle: ["hyprland", "window", "tiled", "fullscreen", "toggle"],
        layout_toggle: ["hyprland", "workspace", "layout", "toggle"],
        pop: ["hyprland", "window", "pop"],
        scaling_up: ["hyprland", "monitor", "scaling", "up"],
        scaling_down: ["hyprland", "monitor", "scaling", "down"],
      };
      await execute(deps, "omarchy", routes[action]);
      return "Done.";
    }
    case "hyprland_get_option": {
      const key = optionKey(args);
      const output = await execute(deps, "hyprctl", ["getoption", "-j", key.replaceAll(".", ":")]);
      return `${key}: ${output}`;
    }
    case "hyprland_set_option": {
      const key = optionKey(args);
      const expression = configExpression(key, luaValue(args.value));
      await execute(deps, "hyprctl", ["eval", expression]);
      return `${key} updated temporarily, until the next Hyprland reload.`;
    }
    case "omarchy_notify": {
      const headline = textArg(args, "headline", 200);
      const body = args.body === undefined ? undefined : textArg(args, "body", 500);
      await execute(deps, "omarchy", ["notification", "send", headline, ...(body ? [body] : [])]);
      return "Notification sent.";
    }
    case "omarchy_osd":
      await execute(deps, "omarchy", ["osd", "-m", textArg(args, "message", 500)]);
      return "Shown.";
    case "omarchy_reminder": {
      const minutes = args.minutes;
      if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > 10_080) bad("minutes must be a whole number from 1 to 10080");
      const message = args.message === undefined ? undefined : textArg(args, "message", 500);
      await execute(deps, "omarchy", ["reminder", String(minutes), ...(message ? [message] : [])]);
      return "Reminder set.";
    }
    case "read_config_file":
      return readAllowedConfig(args, deps);
    case "omarchy_help": {
      const route = normalizedRoute(args);
      await knownRoute(route, deps);
      return execute(deps, "omarchy", [...route.split(" "), "--help"], ROUTE_TIMEOUT_MS);
    }
    case "omarchy_command": {
      const route = normalizedRoute(args);
      const argv = routeArgs(args);
      const command = await knownRoute(route, deps);
      if (command.hidden || command.requires_sudo || deniedRoute(route)) {
        throw new OmarchyToolError("denied", `The Omarchy route '${route}' is off limits here.`);
      }
      if (confirmationRequired(route) && args.confirmed !== true) {
        throw new OmarchyToolError("denied", `The Omarchy route '${route}' needs a confirmation first.`);
      }
      return execute(deps, "omarchy", [...route.split(" "), ...argv], ROUTE_TIMEOUT_MS);
    }
    default:
      return bad(`unknown Omarchy tool: ${name}`);
  }
}

export function omarchyAvailable(path = process.env.PATH ?? ""): boolean {
  return path
    .split(delimiter)
    .filter(Boolean)
    .some((directory) => {
      try {
        // Local filesystem detection only: no child process is started.
        accessSync(resolve(directory, "omarchy"), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}
