package ai

import (
	"context"
	"encoding/json"
	"os"
	"runtime"
	"strings"
	"testing"
)

type promptBaseline struct {
	Name   string
	Config Config
}

func promptBaselineCases() []promptBaseline {
	base := Config{Runtime: "local", Model: Model{SupportsImageInput: true}}
	out := []promptBaseline{}
	add := func(name string, c Config) { out = append(out, promptBaseline{name, c}) }
	add("default", base)
	for _, profile := range []string{"core", "terminal2", "db-query-editor", "unknown"} {
		c := base
		c.Profile = profile
		add(profile, c)
	}
	c := base
	c.MemoryEnabled = true
	add("memory", c)
	c = base
	c.Permissions = &Permissions{}
	add("permissions-denied", c)
	c = base
	c.Permissions = &Permissions{SilentCommands: true, SilentReadFiles: true, SilentWriteFiles: true}
	add("permissions-silent", c)
	c = base
	c.UserPrompt = "用户指定的工作偏好"
	add("preset", c)
	c = base
	c.Model.SupportsImageInput = false
	add("text-only", c)
	c = base
	c.sreCoordinator = true
	c.UserPrompt = "用户偏好"
	add("sre-dispatch", c)
	c = base
	c.workflowMode = true
	add("workflow", c)
	c = base
	c.legacyInvestigations = true
	c.MultiAgentMode = "auto"
	add("legacy-investigation", c)
	for _, role := range []SREAgentRole{SRECoordinator, SREInvestigator, SREExecutor, SREVerifier} {
		c = base
		c.agentRole = string(role)
		c.sre = &sreRoleContext{Role: role, FullTools: true}
		b, _ := embedded.ReadFile("prompts/sre-" + string(role) + ".txt")
		c.UserPrompt = string(b) + sreOutputInstruction(SREPlanStep{Kind: "observe", Role: role}) + "\nParent session preferences (not permission; role, resource and runtime rules still apply):\n用户偏好"
		add("role-"+string(role), c)
	}
	return out
}

type promptGolden struct {
	PromptHash string `json:"promptHash"`
	ToolsHash  string `json:"toolsHash"`
}

func TestStrategyDisabledPromptGolden(t *testing.T) {
	raw, err := os.ReadFile("testdata/strategy-disabled.v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var goldens map[string]promptGolden
	if err = json.Unmarshal(raw, &goldens); err != nil {
		t.Fatal(err)
	}
	cases := promptBaselineCases()
	if len(goldens) != len(cases) {
		t.Fatal("baseline case set changed")
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			// Only the host OS placeholder varies by platform; all remaining bytes stay exact.
			prompt := strings.ReplaceAll(Prompt(tc.Config), "Local operating system: "+runtime.GOOS+".", "Local operating system: <GOOS>.")
			e := &Engine{}
			got := promptGolden{hash(prompt), hash(js(e.sessionCatalog(context.Background(), "baseline", tc.Config)))}
			if got != goldens[tc.Name] {
				t.Fatalf("disabled prompt/catalog changed: got %+v want %+v", got, goldens[tc.Name])
			}
		})
	}
}
