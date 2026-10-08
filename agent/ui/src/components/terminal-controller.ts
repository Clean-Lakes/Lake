import { api } from "../api/client";
export class TerminalController {
  async subscribe(id: string, after: string): Promise<Record<string, any>[]> {
    return api("GET", `terminals/${id}/output?after=${after}`);
  }
  async requestControl(terminal: Record<string, any>): Promise<number> {
    return (
      await api(
        "POST",
        `terminals/${terminal.id}/control`,
        { confirmed: true },
        terminal.revision,
      )
    ).epoch;
  }
  async sendInput(
    terminal: Record<string, any>,
    text: string,
    epoch: number,
  ): Promise<void> {
    await api(
      "POST",
      `terminals/${terminal.id}/input`,
      { text, epoch },
      terminal.revision,
    );
  }
  async release(terminal: Record<string, any>): Promise<void> {
    await api(
      "POST",
      `terminals/${terminal.id}/release`,
      { stopped: true },
      terminal.revision,
    );
  }
}
