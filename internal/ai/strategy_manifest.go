package ai

import (
	"encoding/json"
	"errors"
	"runtime/debug"
	"strings"
	"sync"

	"github.com/Clean-Lakes/Lake/internal/strategy"
)

const promptPermissionPolicyVersion = "lake-runtime-permissions-v1"

var promptBuild = sync.OnceValues(func() (string, bool) {
	commit, dirty := "unknown", false
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, v := range info.Settings {
			switch v.Key {
			case "vcs.revision":
				commit = v.Value
			case "vcs.modified":
				dirty = v.Value == "true"
			}
		}
	}
	return commit, dirty
})

func promptFingerprint(v any) (string, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return "", errors.New("cannot fingerprint provider request")
	}
	return strategy.ContentHash(string(b)), nil
}

// No JSON serialization of Config/Model is permitted here: keys, headers,
// credential references and endpoint URLs must not influence this digest.
func promptModelHash(c Config, m Model) (string, error) {
	return promptFingerprint(struct {
		Provider, Name, Protocol, ReasoningEffort string
		Reasoning                                 ReasoningCapability
		ContextWindow, MaxOutput                  int
		ImageInput, ImageOutput                   bool
	}{c.ModelProviderID, m.Name, protocol(m), m.ReasoningEffort, ReasoningSupport(m), m.ContextWindow, m.MaxOutput, m.SupportsImageInput, m.SupportsImageOutput})
}

func (d *adkTurnDriver) basePromptFragments(history []Message) ([]strategy.PromptFragment, bool) {
	d.session.mu.Lock()
	defer d.session.mu.Unlock()
	baseline := d.session.state.PromptBaseline
	if len(history) > 0 && baseline != nil && strategy.ContentHash(history[0].Content) == baseline.SystemHash {
		return append([]strategy.PromptFragment(nil), baseline.Fragments...), true
	}
	// Old sessions and explicitly restored history have no trustworthy layer
	// layout. Record actual hashes and the gap; never label user text as fixed.
	if len(history) > 0 {
		p := strategy.Composition{}
		p.Append(strategy.TaskContext, "unclassified-restored-system", history[0].Content)
		return p.Fragments(), false
	}
	return []strategy.PromptFragment{}, false
}

func appendPromptFragment(fragments []strategy.PromptFragment, layer strategy.PromptLayer, source, text string) []strategy.PromptFragment {
	if strings.TrimSpace(text) == "" {
		return fragments
	}
	p := strategy.Composition{}
	p.Append(layer, source, text)
	return append(fragments, p.Fragments()...)
}
