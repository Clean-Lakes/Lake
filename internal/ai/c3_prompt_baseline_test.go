package ai

import (
	"encoding/json"
	"os"
	"runtime"
	"strings"
	"testing"
)

// Initially frozen before removing optimization slots; intentionally refreshed
// for native Kubernetes action/preflight instructions. Only host OS text varies.
func TestC3PromptAssemblyMatchesPreCleanupBytes(t *testing.T) {
	raw, err := os.ReadFile("testdata/c3-prompt-baseline.json")
	if err != nil {
		t.Fatal(err)
	}
	var want map[string]string
	if json.Unmarshal(raw, &want) != nil {
		t.Fatal("invalid baseline")
	}
	for _, tc := range promptBaselineCases() {
		got := hash(strings.ReplaceAll(composePrompt(tc.Config).Text(), runtime.GOOS, "<HOST_OS>"))
		if got != want[tc.Name] {
			t.Errorf("prompt bytes changed: %s", tc.Name)
		}
	}
}
