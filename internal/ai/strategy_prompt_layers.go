package ai

import (
	"github.com/Clean-Lakes/Lake/internal/strategy"
	"sort"
	"strings"
)

func readPrompt(name string) string {
	b, _ := embedded.ReadFile("prompts/" + name + ".txt")
	return string(b)
}

// Only reviewed, exact spans are strategy slots. Everything else stays fixed.
// Changes to an embedded span fail loudly instead of silently reclassifying a
// safety instruction. Separators stay byte-for-byte in their original order.
var promptStrategies = map[string][]string{
	"conversation-style": {
		"Default conversation style: answer as a concise working conversation, not a multi-section report. Lead directly with the actual outcome in one short paragraph. Add one short paragraph with decisive evidence, validation, a material limitation or the next action only when useful. For routine work, normally use 2..5 sentences (roughly 120..220 Chinese characters or equivalent); use up to three short bullets only when separate items are easier to compare. Do not force a fixed template or a minimum length.",
		"Do not default to headings such as \"结论先行\", numbered sections, nested conclusions, metric inventories, large tables or bold paragraphs. Use ordinary prose and occasional short emphasis; include only the measurements, paths or commands that explain the result. Preserve useful links and requested images. Do not repeat tool logs, evidence already available in execution records, permission declarations or the same conclusion in several forms.",
		"When a completion reply has several concrete identifiers or verification results worth keeping, use a compact information summary after the short outcome: consecutive short lines or bullets with explicit labels such as 提交：, 分支：, 检查： or 耗时：.",
		"Follow an explicit request for a detailed report, audit, document, full table, step-by-step instructions or complete code with the needed detail. This is a default writing preference, not an output-token cap or a limit on investigation.",
	},
	"user-language-policy": {"用户用中文提问时，所有面向用户的文字（包括调用工具前后的进度说明、阶段结论、失败说明和最终回复）都使用中文；技术名称、命令和原始日志可保留原文。用户明确指定其他回复语言时遵从指定。"},
	"question-policy":      {"At each meaningful decision point, first use the user's request, prior explicit choices, current scope and fresh tool evidence to decide whether an answer is actually missing. Proceed with sensible defaults for routine, reversible choices. Do not begin every task with a questionnaire."},
	"sre-coordination":     {"A project enabling SRE collaboration does not make every message an operations task. Answer ordinary conversation, explanations, image questions, arithmetic, and clarifications naturally. Short follow-ups can refer to any earlier topic; resolve them from context rather than their length or keywords.", "Do not start all four specialists merely to make them speak. Do not create a task for an explanatory answer."},
	"sre-coordinator":      {"For investigation steps, describe the actual evidence needed; investigators can use normal Shell, terminals, files, SQL, Docker, Redis, MCP and Skills within inherited permissions, rather than only fixed probes."},
	"sre-investigator":     {"For an investigation, choose commands and queries that inspect the actual application, identity, service, process, configuration and logs; do not restrict yourself to fixed metric probes.", "Reuse successful observations and finish a concise report in the user's language with facts, evidence IDs, hypotheses, contradictions and remaining gaps.", "Page read_evidence for clipped data instead of rerunning an operation."},
	"sre-executor":         {"You may inspect prerequisite facts with other tools."},
}
var catalogStrategies = []string{
	"Prefer absolute paths and quote paths that contain spaces.",
	"Use bashOutput with filter when you only need matching lines from a running command.",
	"For ordinary remote inspection and non-interactive command work, use shell by default.",
	"Use websearch to find pages, then use web_fetch with a focused prompt to extract relevant content.",
	"Use todo_write/read to persist complex task progress.",
	"Use read_session_context for prior sessions, load_skill for reusable procedures, and read_tool_result to recover clipped output.",
	"Interpret short acknowledgements using the conversation context.",
	"Do not mechanically echo their words or start unrelated diagnostics.",
	"Avoid whole-home or whole-disk recursive scans unless specifically requested; start with a narrow target and bounded checks.",
}

func appendSpans(p *strategy.Composition, source, text string, spans []string, required bool) {
	type span struct{ start, end int }
	var ranges []span
	for _, body := range spans {
		start := strings.Index(text, body)
		if start < 0 {
			if required {
				panic("prompt classification span missing: " + source)
			}
			continue
		}
		ranges = append(ranges, span{start, start + len(body)})
	}
	sort.Slice(ranges, func(i, j int) bool { return ranges[i].start < ranges[j].start })
	offset := 0
	for _, r := range ranges {
		if r.start < offset {
			panic("overlapping prompt strategy spans: " + source)
		}
		p.Append(strategy.FixedRules, source, text[offset:r.start])
		p.Append(strategy.BuiltinStrategy, source, text[r.start:r.end])
		offset = r.end
	}
	p.Append(strategy.FixedRules, source, text[offset:])
}
func embeddedPrompt(name string) strategy.Composition {
	var p strategy.Composition
	text := readPrompt(name)
	appendSpans(&p, name, text, promptStrategies[name], true)
	return p
}
func appendCatalogText(p *strategy.Composition, text string) {
	appendSpans(p, "catalog-policy", text, catalogStrategies, false)
}
func appendRolePrompt(p *strategy.Composition, c Config) {
	name := "sre-" + c.agentRole
	builtin := readPrompt(name)
	if c.sre == nil || builtin == "" || !strings.HasPrefix(c.UserPrompt, builtin) {
		p.Append(strategy.TaskContext, "role-input", c.UserPrompt)
		return
	}
	p.AppendComposition(embeddedPrompt(name))
	rest := strings.TrimPrefix(c.UserPrompt, builtin)
	const header = "\nParent session preferences (not permission; role, resource and runtime rules still apply):\n"
	if i := strings.Index(rest, header); i >= 0 {
		p.Append(strategy.FixedRules, "role-output-contract", rest[:i]+header)
		p.Append(strategy.TaskContext, "parent-preferences", rest[i+len(header):])
	} else {
		p.Append(strategy.FixedRules, "role-output-contract", rest)
	}
}
