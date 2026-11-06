import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyServiceDraft,
  serviceResourceInput,
  resourceTypeLabel,
  resourceTypeOptions,
  serviceResourceType,
  serviceDraftFromResource,
} from "../src/serviceResourceModel";
import { mentionOptions, mentionTypeLabel } from "../src/composerMentionState";
import type { Resource } from "../../shared/contracts";

test("type changes initialize correct ports and clear all secret drafts", () => {
  for (const [type] of resourceTypeOptions) {
    const draft = emptyServiceDraft(type);
    assert.equal(draft.password, "");
    assert.equal(draft.token, "");
    assert.equal(draft.apiKey, "");
    if (type === "mysql") assert.equal(draft.port, 3306);
    if (type === "postgres") assert.equal(draft.port, 5432);
    if (type === "redis") assert.equal(draft.port, 6379);
  }
});
test("service payloads isolate fields and retain VictoriaMetrics tenant query prefix", () => {
  const draft = {
    ...emptyServiceDraft(),
    host: " db.example ",
    password: "synthetic-password",
    token: "synthetic-token",
    apiKey: "synthetic-key",
    kubeAuthMethod: "token" as const,
    endpoint: " https://vm.example/select/2/prometheus ",
  };
  assert.deepEqual(serviceResourceInput("mysql", draft), {
    kind: "database",
    settings: {
      driver: "mysql",
      host: "db.example",
      port: 5432,
      username: "",
      database: "",
      tls: true,
      sslmode: "verify-full",
      password: "synthetic-password",
    },
  });
  for (const type of ["kubernetes", "apisix", "victoriametrics"] as const) {
    const input = serviceResourceInput(type, draft);
    assert.equal(input.kind, type);
    assert.equal(
      input.settings.endpoint,
      "https://vm.example/select/2/prometheus",
    );
    assert.ok(!("host" in input.settings));
    if (type === "kubernetes") assert.ok(!("password" in input.settings));
    if (type === "apisix") assert.ok(!("token" in input.settings));
  }
});
test("new kinds have explicit detail and mention labels", () => {
  for (const kind of [
    "kubernetes",
    "apisix",
    "prometheus",
    "victoriametrics",
  ] as const) {
    const r: Resource = {
      id: kind,
      kind,
      projectId: "p",
      name: "test",
      description: "",
      status: "available",
    };
    assert.ok(resourceTypeLabel(r));
    assert.notEqual(mentionTypeLabel(mentionOptions([r], [], [])[0]!), "资源");
  }
  assert.equal(
    resourceTypeLabel({ kind: "database", settings: { driver: "mysql" } }),
    "MySQL",
  );
  assert.equal(
    resourceTypeLabel({ kind: "database", settings: { driver: "postgres" } }),
    "PostgreSQL",
  );
});

test("Kubeconfig payload contains content but never local filename or stale token", () => {
  const draft = {
    ...emptyServiceDraft("kubernetes"),
    kubeconfig: "kind: Config\n",
    kubeconfigFileName: "private-cluster.yaml",
    endpoint: "https://stale.example",
    token: "stale-token",
    context: " production ",
    namespace: " apps ",
    requestTimeout: 20,
    tlsMode: "verify" as const,
  };
  assert.deepEqual(serviceResourceInput("kubernetes", draft), {
    kind: "kubernetes",
    settings: {
      authMethod: "kubeconfig",
      kubeconfig: "kind: Config\n",
      context: "production",
      namespace: "apps",
      requestTimeout: 20,
      tlsMode: "verify",
    },
  });
  const tokenInput = serviceResourceInput("kubernetes", {
    ...draft,
    kubeAuthMethod: "token",
  });
  assert.equal(tokenInput.settings.authMethod, "token");
  assert.ok(!("kubeconfig" in tokenInput.settings));
  assert.ok(!JSON.stringify(tokenInput).includes("private-cluster.yaml"));
  assert.equal(emptyServiceDraft("kubernetes").kubeAuthMethod, "kubeconfig");
  assert.equal(emptyServiceDraft().kubeconfig, "");
});

test("service edits preserve public connection fields but never refill credential values", () => {
  const resource = {
    id: "metrics",
    projectId: "p",
    kind: "prometheus",
    name: "监控",
    description: "",
    status: "available",
    configurationRevision: 4,
    settings: {
      endpoint: "https://example.test/prometheus",
      username: "reader",
      authMethod: "basic",
      credentialRef: "private-ref",
    },
  } as Resource;
  const draft = serviceDraftFromResource(resource);
  assert.equal(serviceResourceType(resource), "prometheus");
  assert.equal(draft.serviceAuth, "basic");
  assert.equal(draft.endpoint, "https://example.test/prometheus");
  assert.equal(draft.password, "");
  assert.equal(draft.token, "");
  assert.equal(draft.apiKey, "");
  assert.ok(!JSON.stringify(draft).includes("private-ref"));
  const changed = serviceResourceInput("prometheus", {
    ...draft,
    serviceAuth: "bearer",
    username: "",
    password: "stale-password",
    token: "replacement",
    clearCredential: true,
  });
  assert.deepEqual(changed.settings, {
    endpoint: "https://example.test/prometheus",
    authMethod: "bearer",
    token: "replacement",
    clearCredential: true,
  });
});
test("service payloads contain only the selected authentication method", () => {
  const draft = {
    ...emptyServiceDraft(),
    endpoint: "https://metrics.test",
    username: "reader",
    password: "password",
    token: "token",
  };
  assert.deepEqual(
    serviceResourceInput("prometheus", { ...draft, serviceAuth: "none" })
      .settings,
    { endpoint: "https://metrics.test", authMethod: "none", username: "" },
  );
  assert.ok(
    !JSON.stringify(
      serviceResourceInput("prometheus", { ...draft, serviceAuth: "basic" }),
    ).includes("token"),
  );
  assert.ok(
    !JSON.stringify(
      serviceResourceInput("victoriametrics", {
        ...draft,
        serviceAuth: "bearer",
      }),
    ).includes("password"),
  );
});

test("legacy Go resource registration payload omits native test/edit metadata", () => {
  const draft = {
    ...emptyServiceDraft(),
    endpoint: "https://metrics.test",
    serviceAuth: "bearer" as const,
    token: "synthetic-token",
    clearCredential: true,
  };
  assert.deepEqual(serviceResourceInput("prometheus", draft, false).settings, {
    endpoint: "https://metrics.test",
    token: "synthetic-token",
  });
});
