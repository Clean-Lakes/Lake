package ai

import (
	"errors"
	"testing"
)

func TestMemoryEvidenceDoesNotTreatTransportSuccessAsCompletedExecution(t *testing.T) {
	for _, tc := range []struct {
		result map[string]any
		err    error
		want   string
	}{
		{map[string]any{"status": "running"}, nil, "running"},
		{map[string]any{"running": true}, nil, "running"},
		{map[string]any{"status": "unknown"}, nil, "unknown"},
		{map[string]any{"status": "not_executed"}, nil, "unknown"},
		{map[string]any{"effect_dispatched": false}, nil, "unknown"},
		{map[string]any{"exitCode": 1}, nil, "completed_failure"},
		{map[string]any{"exit_code": 2.0}, nil, "completed_failure"},
		{map[string]any{"exitCode": "0"}, nil, "unknown"},
		{map[string]any{"success": false}, nil, "completed_failure"},
		{map[string]any{"error": "synthetic"}, nil, "completed_failure"},
		{map[string]any{"exitCode": 0}, errors.New("transport failure"), "unknown"},
		{map[string]any{"exitCode": 0}, nil, "completed_success"},
	} {
		if got := memoryEvidenceEligible(tc.result, tc.err); got != tc.want {
			t.Errorf("%v: got %s want %s", tc.result, got, tc.want)
		}
	}
}

func TestMemoryV2ToolSchemaRequiresRevisionAndCannotSetTrustedEvidence(t *testing.T) {
	for _, tool := range projectMemoryTools(Config{MemorySchemaVersion: 2}) {
		props := obj(tool.Parameters["properties"])
		for _, key := range []string{"projectId", "generation", "observedAt", "verification", "alwaysReference"} {
			if props[key] != nil {
				t.Errorf("tool %s accepts trusted field %s", tool.Name, key)
			}
		}
		if tool.Name == "read_project_memory" {
			found := false
			for _, key := range tool.Parameters["required"].([]string) {
				found = found || key == "expectedRevision"
			}
			if !found {
				t.Fatal("direct reads can omit revision")
			}
		}
	}
}

func TestMemoryV2StructuredClaimAdapterIsNarrowAndCredentialFree(t *testing.T) {
	value := map[string]any{"exitCode": 0, "identity": map[string]any{"target_match": true, "api_server": "https://192.0.2.10:6443"}}
	claims := memoryStructuredClaims("observe_cluster", value)
	if len(claims) != 1 || claims[0].Value != "https://192.0.2.10:6443" || claims[0].Field != "kubernetes.api-server" {
		t.Fatal("typed API observation was not projected")
	}
	if len(memoryStructuredClaims("call_mcp_tool", value)) != 0 {
		t.Fatal("opaque MCP result acquired a typed claim")
	}
	for _, endpoint := range []string{"https://user:pass@192.0.2.10:6443", "https://192.0.2.10:6443?token=fixture", "not-a-url"} {
		obj(value["identity"])["api_server"] = endpoint
		if len(memoryStructuredClaims("observe_cluster", value)) != 0 {
			t.Fatal("unsafe endpoint promoted")
		}
	}
}
