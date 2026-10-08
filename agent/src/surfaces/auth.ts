import { randomBytes, timingSafeEqual } from "node:crypto";
import { requireCondition } from "../domain/errors.js";
export class BootstrapAuth {
  readonly token = randomBytes(32).toString("base64url");
  readonly nonce = randomBytes(16).toString("hex");
  private readonly tickets = new Map<string, number>();
  issue(): string {
    const ticket = randomBytes(32).toString("base64url");
    this.tickets.set(ticket, Date.now() + 60000);
    return ticket;
  }
  exchange(ticket: string): {
    token: string;
    nonce: string;
  } {
    const expiry = this.tickets.get(ticket);
    requireCondition(expiry && expiry > Date.now(), "unauthorized");
    this.tickets.delete(ticket);
    return { token: this.token, nonce: this.nonce };
  }
  validate(header: string | undefined): void {
    const value = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const a = Buffer.from(value),
      b = Buffer.from(this.token);
    requireCondition(
      a.length === b.length && timingSafeEqual(a, b),
      "unauthorized",
    );
  }
}
