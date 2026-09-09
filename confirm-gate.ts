export const CONFIRMED_TOOLS = new Set(["send_to_thread", "start_thread", "delegate"]);

interface PendingCall {
  name: string;
  args: Record<string, unknown>;
  userTurns: number;
}

export class ConfirmationGate {
  private pending: PendingCall | null = null;

  propose(name: string, args: Record<string, unknown>): string {
    this.pending = { name, args, userTurns: 0 };
    return "Request staged, but nothing was sent. Read it back in one short sentence, ask whether to send it, then stop and wait. Call confirm_pending only after the user says yes.";
  }

  noteUserTurn() {
    if (this.pending) this.pending.userTurns += 1;
  }

  take():
    | { ok: true; name: string; args: Record<string, unknown> }
    | { ok: false; output: string } {
    const pending = this.pending;
    if (!pending) {
      return { ok: false, output: "Confirmation refused: no request is staged. Stage it and ask the user first." };
    }
    if (pending.userTurns === 0) {
      return { ok: false, output: "Confirmation refused: the user has not answered yet. Read the request back and wait for their answer." };
    }
    this.pending = null;
    if (pending.userTurns >= 2) {
      return { ok: false, output: "Confirmation refused: the staged request expired because more than one user turn passed. Stage it again and ask again." };
    }
    return { ok: true, name: pending.name, args: pending.args };
  }

  reset() {
    this.pending = null;
  }

  hasPending(): boolean {
    return this.pending !== null;
  }
}
