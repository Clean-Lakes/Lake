import { object, text, type Params } from "./validation.js";

const KINDS = new Set(["pods", "deployments", "services", "nodes", "namespaces", "statefulsets", "daemonsets", "jobs", "cronjobs", "events"]);
export function kubeArgs(p: Params, spec: Params): string[] {
  const kind = text(p, "kind"), namespace = text(p, "namespace", text(spec, "namespace", "default")), name = text(p, "name");
  const valid = (s: string) => s.length <= 253 && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(s);
  if (!KINDS.has(kind) || (name && !valid(name)) || !valid(namespace)) throw new Error("Kubernetes 查询参数无效；只允许固定类型，不读取 Secret");
  if (!text(spec, "context")) throw new Error("Kubernetes 上下文未配置");
  return ["--context", text(spec, "context"), "--request-timeout=20s", ...(p.all_namespaces === true ? ["--all-namespaces"] : ["--namespace", namespace]), "get", kind, ...(name ? [name] : []), "--output=wide"];
}
export function inspectionSQL(kind: string, check: string, database: string): string {
  if (!["postgres", "mysql", "starrocks"].includes(kind)) throw new Error("资源不是受支持的数据库");
  if (check === "version") return "SELECT VERSION()";
  if (check === "databases") return kind === "postgres" ? "SELECT datname FROM pg_database WHERE datallowconn = true ORDER BY datname LIMIT 201" : "SHOW DATABASES";
  if (check === "tables") {
    if (kind === "postgres") return "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema, table_name LIMIT 201";
    if (!database) throw new Error("查询表需要配置数据库名");
    return "SHOW TABLES";
  }
  throw new Error("只允许 version、databases、tables 固定检查");
}
export function resourceIdentity(resource: Params): string {
  return JSON.stringify([resource.id, resource.lake_id, resource.kind, object(resource.ssh), object(resource.k8s), object(resource.db)]);
}
