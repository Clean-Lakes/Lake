import type { Resource } from "../../shared/contracts";
export const resourceTypeOptions = [
  ["ssh", "SSH 主机"],
  ["kubernetes", "Kubernetes (K8s)"],
  ["mysql", "MySQL"],
  ["postgres", "PostgreSQL"],
  ["redis", "Redis"],
  ["apisix", "APISIX"],
  ["prometheus", "Prometheus"],
  ["victoriametrics", "VictoriaMetrics (VM 时序库)"],
] as const;
export type ResourceInputType = (typeof resourceTypeOptions)[number][0];
export type ServiceDraft = {
  host: string;
  port: number;
  username: string;
  database: string;
  db: number;
  tls: boolean;
  endpoint: string;
  context: string;
  namespace: string;
  password: string;
  token: string;
  apiKey: string;
  serviceAuth: "none" | "basic" | "bearer";
  clearCredential?: boolean;
  kubeAuthMethod: "kubeconfig" | "token";
  kubeconfig: string;
  kubeconfigFileName: string;
  requestTimeout: number;
  tlsMode: "config" | "verify" | "skip";
};
export function emptyServiceDraft(
  type: ResourceInputType = "postgres",
): ServiceDraft {
  return {
    host: "",
    port: type === "mysql" ? 3306 : type === "redis" ? 6379 : 5432,
    username: "",
    database: "",
    db: 0,
    tls: type !== "redis",
    endpoint: "",
    context: "",
    namespace: "",
    password: "",
    token: "",
    apiKey: "",
    serviceAuth: "none",
    kubeAuthMethod: "kubeconfig",
    kubeconfig: "",
    kubeconfigFileName: "",
    requestTimeout: 10,
    tlsMode: "config",
  };
}
export function serviceResourceType(
  resource: Pick<Resource, "kind" | "settings">,
): ResourceInputType | undefined {
  if (
    resource.kind === "database" &&
    ["mysql", "postgres"].includes(String(resource.settings?.driver))
  )
    return resource.settings!.driver as "mysql" | "postgres";
  if (
    ["redis", "apisix", "prometheus", "victoriametrics"].includes(resource.kind)
  )
    return resource.kind as ResourceInputType;
}
export function serviceDraftFromResource(resource: Resource): ServiceDraft {
  const type = serviceResourceType(resource),
    draft = emptyServiceDraft(type),
    settings = resource.settings ?? {};
  for (const key of ["host", "username", "database", "endpoint"] as const)
    if (typeof settings[key] === "string") draft[key] = settings[key];
  for (const key of ["port", "db"] as const)
    if (typeof settings[key] === "number") draft[key] = settings[key];
  if (typeof settings.tls === "boolean") draft.tls = settings.tls;
  draft.serviceAuth = ["none", "basic", "bearer"].includes(
    String(settings.authMethod),
  )
    ? (settings.authMethod as ServiceDraft["serviceAuth"])
    : draft.username
      ? "basic"
      : settings.credentialRef
        ? "bearer"
        : "none";
  return draft;
}
export function serviceResourceInput(
  type: ResourceInputType,
  v: ServiceDraft,
  nativeConnections = true,
) {
  if (type === "ssh") throw new Error("SSH uses its own form");
  const credential = {
    ...(v.clearCredential && nativeConnections
      ? { clearCredential: true }
      : {}),
  };
  if (type === "mysql" || type === "postgres")
    return {
      kind: "database",
      settings: {
        driver: type,
        host: v.host.trim(),
        port: v.port,
        username: v.username,
        database: v.database,
        tls: v.tls,
        sslmode: v.tls ? "verify-full" : "disable",
        password: v.password,
        ...credential,
      },
    };
  if (type === "redis")
    return {
      kind: type,
      settings: {
        host: v.host.trim(),
        port: v.port,
        username: v.username,
        db: v.db,
        tls: v.tls,
        password: v.password,
        ...credential,
      },
    };
  if (type === "kubernetes")
    return {
      kind: type,
      settings: {
        authMethod: v.kubeAuthMethod,
        context: v.context.trim(),
        namespace: v.namespace.trim(),
        requestTimeout: v.requestTimeout,
        tlsMode: v.tlsMode,
        ...(v.kubeAuthMethod === "kubeconfig"
          ? { kubeconfig: v.kubeconfig }
          : { endpoint: v.endpoint.trim(), token: v.token }),
      },
    };
  if (type === "apisix")
    return {
      kind: type,
      settings: {
        endpoint: v.endpoint.trim(),
        apiKey: v.apiKey,
        ...credential,
      },
    };
  return {
    kind: type,
    settings: {
      endpoint: v.endpoint.trim(),
      ...(nativeConnections ? { authMethod: v.serviceAuth } : {}),
      ...(v.serviceAuth === "basic"
        ? { username: v.username, password: v.password }
        : v.serviceAuth === "bearer"
          ? { token: v.token }
          : { username: "" }),
      ...credential,
    },
  };
}
export function resourceTypeLabel(
  resource: Pick<Resource, "kind" | "settings">,
): string {
  if (resource.kind === "database")
    return (
      (
        { mysql: "MySQL", postgres: "PostgreSQL", sqlite: "SQLite" } as Record<
          string,
          string
        >
      )[String(resource.settings?.driver)] ?? "数据库"
    );
  return {
    local: "本机资源",
    ssh: "SSH 主机",
    docker: "Docker",
    redis: "Redis",
    kubernetes: "Kubernetes (K8s)",
    apisix: "APISIX",
    prometheus: "Prometheus",
    victoriametrics: "VictoriaMetrics (VM 时序库)",
  }[resource.kind];
}
