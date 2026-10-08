import type { Resource } from "../domain/entities.js";
import { requireCondition } from "../domain/errors.js";
export function posixQuote(value: string): string {
  requireCondition(!/[\x00\r\n]/.test(value), "invalid_input");
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
export function quoteArgv(argv: string[]): string {
  return argv.map(posixQuote).join(" ");
}
export function allowedUnit(resource: Resource, unit: string): void {
  requireCondition(
    /^[A-Za-z0-9_.@-]+$/.test(unit) &&
      !unit.startsWith("-") &&
      Array.isArray(resource.settings.units) &&
      resource.settings.units.includes(unit),
    "scope_denied",
    "Unit is not bound to the resource",
  );
}
export interface ConfigBinding {
  checkArgv: string[];
  unit: string;
  action: "reload" | "restart";
}
export function configBinding(resource: Resource, path: string): ConfigBinding {
  const configs = resource.settings.configs as
    | Record<string, ConfigBinding>
    | undefined;
  const binding = configs?.[path];
  requireCondition(
    path.startsWith("/") &&
      !/[\x00\r\n]/.test(path) &&
      binding &&
      Array.isArray(binding.checkArgv) &&
      binding.checkArgv.length > 0 &&
      binding.checkArgv.every((x) => typeof x === "string") &&
      ["reload", "restart"].includes(binding.action),
    "scope_denied",
    "Configuration path is not bound",
  );
  allowedUnit(resource, binding.unit);
  return binding;
}
