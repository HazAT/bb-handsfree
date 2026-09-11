export interface ActivityResult {
  threadId: string;
  title: string;
  status: string;
  live: boolean;
  cursor: string | null;
  activity: boolean;
  summary: string | null;
  raw: string | null;
}

export interface UpdateScheduleDeps {
  fetchActivity(args: {
    threadId: string;
    afterSeq: string | null;
    sinceMs: number | null;
    focus: string | null;
  }): Promise<ActivityResult>;
  deliver(content: string, logText: string): void;
  log(kind: string, payload?: Record<string, unknown>): void;
  now?: () => number;
}

interface ScheduleState {
  threadId: string;
  intervalMs: number;
  focus: string | null;
  cursor: string | null;
  failures: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const COMPLETION_NOTICE_SUPPRESSION_MS = 30_000;

export function formatProgressUpdate(result: ActivityResult): { content: string; logText: string } {
  const status = result.live ? "running" : result.status === "error" ? "failed" : "finished";
  const summary = (result.summary ?? result.raw ?? "No new activity since the last update.")
    .replace(/\s+/g, " ")
    .trim();
  let content = `Progress on ${JSON.stringify(result.title)}: ${summary}`;
  if (!result.live) {
    content += status === "failed"
      ? " The thread failed; updates have stopped."
      : " The thread has finished; updates have stopped.";
  }
  return {
    content: content.slice(0, 1500),
    logText: `Progress update — ${result.title}: ${summary}`,
  };
}

export class UpdateSchedule {
  private schedule: ScheduleState | null = null;
  private lastDeliveredTerminal: { threadId: string; at: number } | null = null;
  private readonly deps: UpdateScheduleDeps;
  private readonly now: () => number;

  constructor(deps: UpdateScheduleDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  isActive(): boolean {
    return this.schedule !== null;
  }

  start(options: { threadId: string; intervalMs: number; focus: string | null }) {
    if (this.schedule) this.stop("replaced");
    const schedule: ScheduleState = { ...options, cursor: null, failures: 0, timer: null };
    this.schedule = schedule;
    this.arm(schedule);
  }

  handleThreadFinished(threadId: string) {
    if (this.schedule?.threadId !== threadId) return;
    if (this.lastDeliveredTerminal?.threadId === threadId) this.lastDeliveredTerminal = null;
    this.stop("thread-finished");
  }

  suppressCompletionNotice(threadId: string): boolean {
    const terminal = this.lastDeliveredTerminal;
    if (!terminal) return false;
    if (this.now() - terminal.at > COMPLETION_NOTICE_SUPPRESSION_MS) {
      this.lastDeliveredTerminal = null;
      return false;
    }
    if (terminal.threadId !== threadId) return false;
    this.lastDeliveredTerminal = null;
    return true;
  }

  stop(reason: string): boolean {
    const schedule = this.schedule;
    if (!schedule) return false;
    if (schedule.timer) clearTimeout(schedule.timer);
    schedule.timer = null;
    this.schedule = null;
    this.deps.log("updates.stopped", { reason });
    return true;
  }

  private arm(schedule: ScheduleState) {
    if (this.schedule !== schedule) return;
    schedule.timer = setTimeout(() => {
      schedule.timer = null;
      void this.tick(schedule);
    }, schedule.intervalMs);
  }

  private async tick(schedule: ScheduleState) {
    if (this.schedule !== schedule) return;
    try {
      const result = await this.deps.fetchActivity({
        threadId: schedule.threadId,
        afterSeq: schedule.cursor,
        sinceMs: schedule.cursor === null ? this.now() - schedule.intervalMs : null,
        focus: schedule.focus,
      });
      if (this.schedule !== schedule) return;
      schedule.failures = 0;
      if (result.cursor !== null) schedule.cursor = result.cursor;
      const update = formatProgressUpdate(result);
      this.deps.deliver(update.content, update.logText);
      if (!result.live) {
        this.lastDeliveredTerminal = { threadId: schedule.threadId, at: this.now() };
        this.stop("thread-finished");
      } else this.arm(schedule);
    } catch (error) {
      if (this.schedule !== schedule) return;
      schedule.failures += 1;
      this.deps.log("updates.tick.failed", {
        failures: schedule.failures,
        error: error instanceof Error ? error.message : String(error),
      });
      if (schedule.failures >= 3) {
        this.deps.deliver(
          "Progress updates stopped: bb could not fetch thread activity.",
          "Progress updates stopped — thread activity could not be fetched.",
        );
        this.stop("failed");
      } else {
        this.arm(schedule);
      }
    }
  }
}
