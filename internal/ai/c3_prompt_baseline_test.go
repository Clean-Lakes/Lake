package ai

import (
	"encoding/json"
	"os"
	"runtime"
	"strings"
	"testing"
)

// Frozen on develop@cd75e2c7 before removing optimization slots. Only host OS
// text is normalized so the same prompt byte-parity guard runs on Windows.
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
