package workflow

import (
	"strings"
	"testing"
)

const validV2JSON = `{
  "version":2,"name":"巡检并汇总","max_parallel":4,
  "nodes":[
    {"id":"hosts","kind":"tool_call","tool":"lake_resources","output_type":"array","inputs":{}},
    {"id":"check","kind":"ssh_check","depends_on":["hosts"],"target":{"type":"string","literal":"host-1"},"check":"uptime","for_each":{"ref":{"node":"hosts","type":"array"},"max_items":4}},
    {"id":"summary","kind":"specialist_task","depends_on":["check"],"specialist":"lake_ssh_agent","request":{"type":"string","literal":"汇总巡检"}}
  ]
}`

func TestCompileV2JSONAndYAML(t *testing.T) {
	def, err := ParseV2([]byte(validV2JSON))
	if err != nil {
		t.Fatal(err)
	}
	compiled, err := CompileV2(def)
	if err != nil {
		t.Fatal(err)
	}
	if len(compiled.Order) != 3 || compiled.Order[0].ID != "hosts" || compiled.Order[1].ID != "check" || compiled.Order[2].ID != "summary" || compiled.MaxParallel != 4 || compiled.MaxExpanded != 6 {
		t.Fatalf("compiled=%+v", compiled)
	}
	yaml := `version: 2
name: inspect
nodes:
  - id: read
    kind: code_task
    request:
      type: string
      literal: inspect project
  - id: report
    kind: tool_call
    tool: lake_resources
    output_type: object
    depends_on: [read]
    inputs:
      prompt:
        type: string
        ref: {node: read, type: string}
`
	def, err = ParseV2([]byte(yaml))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := CompileV2(def); err != nil {
		t.Fatal(err)
	}
}

func TestCompileV2RejectsUnsafeGraphsAndReferences(t *testing.T) {
	for label, modify := range map[string]string{
		"cycle":       strings.Replace(validV2JSON, `"id":"hosts","kind":"tool_call"`, `"id":"hosts","depends_on":["summary"],"kind":"tool_call"`, 1),
		"fanout":      strings.Replace(validV2JSON, `"max_items":4`, `"max_items":33`, 1),
		"parallel":    strings.Replace(validV2JSON, `"max_parallel":4`, `"max_parallel":5`, 1),
		"type":        strings.Replace(validV2JSON, `"node":"hosts","type":"array"`, `"node":"hosts","type":"string"`, 1),
		"missing_dep": strings.Replace(validV2JSON, `"depends_on":["hosts"],`, ``, 1),
	} {
		t.Run(label, func(t *testing.T) {
			def, err := ParseV2([]byte(modify))
			if err == nil {
				_, err = CompileV2(def)
			}
			if err == nil {
				t.Fatal("accepted invalid v2 workflow")
			}
		})
	}
}

func TestV1ValidationStillUsesExistingDefinition(t *testing.T) {
	def := Definition{Name: "legacy", Steps: []Step{{ID: "one", Name: "check", Kind: "ssh_check", Resource: "host", Check: "uptime"}}}
	if err := Validate(def); err != nil {
		t.Fatal(err)
	}
}

func TestCompileV2AllNodeKindsAndConditions(t *testing.T) {
	def, err := ParseV2([]byte(`{
	  "version":2,"name":"operations","nodes":[
	    {"id":"read","kind":"ssh_check","target":{"type":"string","literal":"host"},"check":"uptime"},
	    {"id":"command","kind":"ssh_command","depends_on":["read"],"when":"all_success","target":{"type":"string","literal":"host"},"command":{"type":"string","literal":"date"}},
	    {"id":"code","kind":"code_task","request":{"type":"string","literal":"inspect"}},
	    {"id":"delegate","kind":"specialist_task","depends_on":["command"],"when":"any_failure","specialist":"lake_ssh_agent","request":{"type":"string","literal":"explain"}},
	    {"id":"report","kind":"tool_call","tool":"lake_resources","output_type":"object","depends_on":["code"],"inputs":{"note":{"type":"string","ref":{"node":"code","type":"string"}}}}
	  ]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	compiled, err := CompileV2(def)
	if err != nil || len(compiled.Order) != 5 {
		t.Fatalf("compiled=%+v err=%v", compiled, err)
	}
}

func TestParseV2RejectsUnknownFieldAndYAMLAlias(t *testing.T) {
	for _, input := range []string{
		`{"version":2,"name":"bad","nodes":[],"api_key":"secret"}`,
		"version: 2\nname: bad\nnodes: &nodes []\nother: *nodes\n",
	} {
		if _, err := ParseV2([]byte(input)); err == nil {
			t.Fatal("accepted unknown field or YAML alias")
		}
	}
}

func TestCompileV2FanoutItemBinding(t *testing.T) {
	def, err := ParseV2([]byte(`{"version":2,"name":"fanout","nodes":[{"id":"hosts","kind":"tool_call","tool":"lake_resources","output_type":"array"},{"id":"check","kind":"ssh_check","depends_on":["hosts"],"target":{"type":"string","item":true},"check":"uptime","for_each":{"ref":{"node":"hosts","type":"array"},"element_type":"string","max_items":3}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := CompileV2(def); err != nil {
		t.Fatal(err)
	}
	def.Nodes[1].ForEach.ElementType = "number"
	if _, err := CompileV2(def); err == nil {
		t.Fatal("mismatched fanout element accepted")
	}
}
