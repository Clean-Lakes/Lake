import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { extractActivePromptInputTrigger } from "../src/lib/promptInputTriggers.js";
import { getMentionPanelGroupOrder } from "../src/mentions/mentionPanelRouting.js";
import { parseMentionMarkdown } from "../src/mentions/mentionMarkdown.js";
import { LakeResourceUserInputMention } from "../src/mentions/components/LakeResourceUserInputMention.js";
import {
  mapLakeResourcesToMentionItems,
  formatLakeResourceMention,
} from "../src/mentions/providers/lakeResourceMentionProvider.js";

test("an isolated uppercase L opens only the lake resource group", () => {
  assert.deepEqual(extractActivePromptInputTrigger("L"), { trigger: "L", query: "" });
  assert.deepEqual(extractActivePromptInputTrigger("检查 LRedis"), {
    trigger: "L",
    query: "Redis",
  });
  assert.equal(extractActivePromptInputTrigger("l"), null);
  assert.equal(extractActivePromptInputTrigger("fooL"), null);
  assert.equal(extractActivePromptInputTrigger("检查L"), null);
  assert.deepEqual(getMentionPanelGroupOrder("L"), ["lake-resources"]);
});

test("lake resource references carry a registration snapshot, not a connection claim", () => {
  const lake = { id: "lake-1", name: "订单湖" };
  const resource = {
    id: "resource-1",
    name: "订单 API",
    kind: "service" as const,
    environment: "production" as const,
    description: "核心服务",
    createdAt: 1,
  };
  const [item] = mapLakeResourcesToMentionItems(lake, [resource], "");
  assert.equal(item?.label, "订单 API");
  assert.equal(item?.category, "lake-resources");
  assert.match(item?.markdown ?? "", /lake-1/);
  assert.match(item?.markdown ?? "", /resource-1/);
  assert.match(item?.markdown ?? "", /production/);
  assert.match(item?.markdown ?? "", /核心服务/);
  assert.doesNotMatch(item?.markdown ?? "", /已连接|正在监控/);
  assert.equal(mapLakeResourcesToMentionItems(lake, [resource], "Redis").length, 0);
  assert.equal(mapLakeResourcesToMentionItems(lake, [resource], "订单").length, 1);
  assert.equal(formatLakeResourceMention(lake, resource), item?.markdown);
  assert.match(formatLakeResourceMention(lake, resource, "en-US"), /registered information only/);
});

test("sent and legacy lake resource snapshots display as one short mention without losing metadata", () => {
  const lake = { id: "lake-1", name: "订单湖" };
  const resource = {
    id: "resource-1",
    name: "订单 API",
    kind: "service" as const,
    environment: "production" as const,
    description: "核心服务",
    createdAt: 1,
  };
  const snapshot = formatLakeResourceMention(lake, resource);
  assert.deepEqual(parseMentionMarkdown(`${snapshot} 请检查它`), [
    { type: "lake-resource", label: "订单 API", metadata: snapshot },
    { type: "text", text: " 请检查它" },
  ]);
  const englishSnapshot = formatLakeResourceMention(lake, resource, "en-US");
  assert.deepEqual(parseMentionMarkdown(englishSnapshot), [
    { type: "lake-resource", label: "订单 API", metadata: englishSnapshot },
  ]);
  assert.deepEqual(parseMentionMarkdown("湖资源列表 请检查"), [
    { type: "text", text: "湖资源列表 请检查" },
  ]);
});

test("resource mention parsing keeps adjacent text and markdown inside registered metadata", () => {
  const lake = { id: "lake-1", name: "订单湖" };
  const resource = {
    id: "resource-1",
    name: "服务」A",
    kind: "service" as const,
    environment: "production" as const,
    description: "文档 [查看](https://example.test)",
    createdAt: 1,
  };
  const metadata = formatLakeResourceMention(lake, resource);
  const text = `先看 ${metadata} 再看 ${metadata} 完成`;
  assert.deepEqual(parseMentionMarkdown(text), [
    { type: "text", text: "先看 " },
    { type: "lake-resource", label: resource.name, metadata },
    { type: "text", text: " 再看 " },
    { type: "lake-resource", label: resource.name, metadata },
    { type: "text", text: " 完成" },
  ]);
});

test("user message renders an icon and name while the source text retains the full snapshot", () => {
  const lake = { id: "lake-1", name: "订单湖" };
  const resource = {
    id: "resource-1",
    name: "订单 API",
    kind: "service" as const,
    environment: "production" as const,
    description: "核心服务",
    createdAt: 1,
  };
  const sourceText = `${formatLakeResourceMention(lake, resource)} 请检查它`;
  const [part] = parseMentionMarkdown(sourceText);
  assert.equal(part?.type, "lake-resource");
  if (part?.type !== "lake-resource") return;
  const html = renderToStaticMarkup(
    createElement(LakeResourceUserInputMention, {
      label: part.label,
      metadata: part.metadata,
      className: "text-ui-base",
    }),
  );
  assert.match(html, /data-lake-resource-mention="true"/);
  assert.match(html, /<svg/);
  assert.equal(html.replace(/<[^>]*>/g, ""), "订单 API");
  assert.match(sourceText, /resource-1/);
  assert.match(sourceText, /核心服务/);
});
