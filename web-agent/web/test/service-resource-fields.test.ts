import { registerHooks } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import assert from "node:assert/strict";
import test from "node:test";
import { emptyServiceDraft } from "../src/serviceResourceModel";
import type { Resource } from "../../shared/contracts";
const css = registerHooks({
  load(url, context, next) {
    return url.endsWith(".css")
      ? { format: "module", source: "export {};", shortCircuit: true }
      : next(url, context);
  },
});
const { ServiceResourceFields } = await import("../src/ServiceResourceFields");
const { ServiceConfigEdit } = await import("../src/ServiceConfigEdit");
css.deregister();
test("six service forms render their actual connection fields and an explicit test action", () => {
  for (const type of [
    "mysql",
    "postgres",
    "redis",
    "apisix",
    "prometheus",
    "victoriametrics",
  ] as const) {
    const html = renderToStaticMarkup(
      createElement(ServiceResourceFields, {
        type,
        value: emptyServiceDraft(type),
        onChange: () => {},
        disabled: false,
        projectId: "p",
      }),
    );
    assert.match(html, /测试连接/);
    assert.match(html, /不会自动连接/);
    if (["mysql", "postgres", "redis"].includes(type))
      assert.match(html, /主机地址/);
    else assert.match(html, /<input[^>]+type="url"/);
    if (type === "redis") assert.match(html, /数据库编号/);
    if (type === "apisix") assert.match(html, /Admin API Key/);
  }
});
test("service edit supports stored connections without rendering a stored credential or private reference", () => {
  const resource = {
    id: "m",
    projectId: "p",
    kind: "prometheus",
    name: "监控",
    description: "",
    status: "available",
    settings: {
      endpoint: "https://metrics.test",
      username: "reader",
      authMethod: "basic",
      credentialRef: "private-file-reference",
    },
  } as Resource;
  const html = renderToStaticMarkup(
    createElement(ServiceConfigEdit, {
      resource,
      connected: true,
      onClose: () => {},
      onSaved: () => {},
    }),
  );
  assert.match(html, /编辑资源配置/);
  assert.match(html, /https:\/\/metrics.test/);
  assert.doesNotMatch(html, /private-file-reference/);
  assert.doesNotMatch(html, /默认 Shell/);
});
test("legacy registration form does not offer a connection endpoint absent from that runtime", () => {
  const html = renderToStaticMarkup(
    createElement(ServiceResourceFields, {
      type: "redis",
      value: emptyServiceDraft("redis"),
      onChange: () => {},
      disabled: false,
      projectId: "p",
      nativeConnections: false,
    }),
  );
  assert.doesNotMatch(html, /测试连接/);
  assert.match(html, /主机地址/);
});
