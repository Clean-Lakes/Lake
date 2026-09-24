import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildSubagentSuggestions } from "../src/slashCommandHelpers.js";
import { useSlashCommandMentionPanelSections } from "../src/slashCommandPanelSections.js";
import type { IntlInstance } from "../src/i18n/IntlProvider.js";

const messages: Record<string, string> = {
  "settings.subagents.builtin.generalPurpose.name": "通用河狸",
  "settings.subagents.builtin.generalPurpose.description": "可使用全部工具",
  "settings.subagents.builtin.explore.name": "探索河狸",
  "settings.subagents.builtin.explore.description": "只读搜索与研究",
  "settings.subagents.builtin.sre.name": "SRE 河狸",
  "settings.subagents.builtin.sre.description": "只读分析软件故障",
  "settings.subagents.group.builtIn": "内置河狸",
};

const intl: IntlInstance = {
  formatMessage: ({ id }) => messages[id] ?? id,
};

test("slash subagent suggestions show Beaver names while keeping invocation values", () => {
  const suggestions = buildSubagentSuggestions(
    [
      {
        id: "built-in:general-purpose",
        name: "general-purpose",
        description: "General-purpose agent",
        path: "built-in:general-purpose",
        scope: "built-in",
        source: "built-in",
        enabled: true,
      },
      {
        id: "built-in:Explore",
        name: "Explore",
        description: "Read-only search agent",
        path: "built-in:Explore",
        scope: "built-in",
        source: "built-in",
        enabled: true,
      },
      {
        id: "built-in:lake-sre",
        name: "lake-sre",
        description: "Read-only SRE",
        path: "built-in:lake-sre",
        scope: "built-in",
        source: "built-in",
        enabled: true,
      },
      {
        id: "user:custom",
        name: "custom",
        description: "Custom agent",
        path: "user:custom",
        scope: "user",
        source: "user",
        enabled: true,
      },
    ],
    (id) => intl.formatMessage({ id }),
  );

  assert.deepEqual(
    suggestions.map(({ label, value }) => ({ label, value })),
    [
      { label: "通用河狸", value: "general-purpose" },
      { label: "探索河狸", value: "Explore" },
      { label: "SRE 河狸", value: "lake-sre" },
      { label: "custom", value: "custom" },
    ],
  );
  assert.ok(suggestions.every((suggestion) => suggestion.keywords?.includes("河狸")));
  assert.ok(suggestions.every((suggestion) => suggestion.keywords?.includes("beaver")));

  function PanelOptions() {
    const sections = useSlashCommandMentionPanelSections(
      intl,
      0,
      [],
      [],
      false,
      null,
      suggestions,
      false,
      null,
    );
    return (
      <div>
        {sections[2]?.options.map((option) => (
          <div key={option.id} aria-label={option.label}>
            {option.content}
          </div>
        ))}
      </div>
    );
  }

  const html = renderToStaticMarkup(<PanelOptions />);
  assert.match(html, /aria-label="通用河狸"[^>]*>.*?通用河狸/);
  assert.match(html, /aria-label="探索河狸"[^>]*>.*?探索河狸/);
  assert.match(html, /aria-label="SRE 河狸"[^>]*>.*?SRE 河狸/);
  assert.match(html, /aria-label="custom"[^>]*>.*?custom/);
  assert.doesNotMatch(html, />general-purpose</);
  assert.doesNotMatch(html, />Explore</);
  assert.equal((html.match(/data-testid="beaver-icon"/g) ?? []).length, 4);
  assert.equal((html.match(/data-testid="beaver-icon" aria-hidden="true"/g) ?? []).length, 4);
});
