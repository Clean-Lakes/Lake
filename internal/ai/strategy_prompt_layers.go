package ai

import (
	"github.com/Clean-Lakes/Lake/internal/strategy"
	"strings"
)

func readPrompt(name string) string {
	b, _ := embedded.ReadFile("prompts/" + name + ".txt")
	return string(b)
}
func embeddedPrompt(name string) strategy.Composition {
	var p strategy.Composition
	p.Append(strategy.FixedRules, name, readPrompt(name))
	return p
}
func appendCatalogText(p *strategy.Composition, text string) {
	p.Append(strategy.FixedRules, "catalog-policy", text)
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
