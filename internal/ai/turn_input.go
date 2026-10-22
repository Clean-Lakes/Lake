package ai

import (
	"errors"
	"unicode/utf8"
)

type TurnInput struct {
	StrategyMessageID   string       `json:"-"`
	SRECoordination     bool         `json:"-"`
	IgnoreProjectMemory bool         `json:"ignoreProjectMemory,omitempty"`
	TargetScope         *TargetScope `json:"-"`
	workflow            []WorkflowStep
	UserText            string            `json:"message"`
	Context             string            `json:"context,omitempty"`
	References          []map[string]any  `json:"references,omitempty"`
	Images              []ImageAttachment `json:"images,omitempty"`
}

func (input TurnInput) validate() error {
	if input.UserText == "" && len(input.Images) == 0 || utf8.RuneCountInString(input.UserText) > 100000 {
		return errors.New("invalid chat message")
	}
	if len(input.Context) > 2<<20 {
		return errors.New("server context exceeds 2 MiB")
	}
	return nil
}
func boundedTurnContext(text, context string, c Config) string {
	// Preserve the user text. Trim old context, never split a UTF-8 character.
	max := c.Model.ContextWindow*2 - len(Prompt(c)) - len(js(Catalog(c.Profile))) - len(text) - c.Model.MaxOutput*2
	if max < 256 {
		return "[TERMINAL_CONTEXT truncated: model context budget insufficient]"
	}
	if len(context) <= max {
		return context
	}
	headerEnd := min(512, len(context))
	for headerEnd > 0 && !utf8.RuneStart(context[headerEnd]) {
		headerEnd--
	}
	marker := "\n[older terminal evidence truncated for model context budget]\n"
	keep := max - headerEnd - len(marker)
	if keep < 1 {
		return context[:headerEnd] + marker
	}
	end := len(context) - keep
	for end < len(context) && !utf8.RuneStart(context[end]) {
		end++
	}
	return context[:headerEnd] + marker + context[end:]
}
func validRemembered(c Config, remembered []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, ref := range remembered {
		for _, a := range c.Assets {
			if a.ID == ref && !seen[ref] {
				out = append(out, ref)
				seen[ref] = true
			}
		}
	}
	return out
}
func (e *Engine) ReferencedAssets(id string) ([]string, error) {
	s, err := e.get(id)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string{}, s.state.ReferencedAssetIDs...), nil
}
func (e *Engine) ClearReferences(id string) error {
	s, err := e.get(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel != nil {
		return errors.New("session busy")
	}
	s.state.ReferencedAssetIDs = nil
	s.state.TargetScope = nil
	s.state.Config.ReferencedAssets = nil
	return e.save(s)
}

// Called after an explicit application target authorization. Configure prunes
// records against the current project assets before they can authorize tools.
func (e *Engine) RememberResource(id, ref string) error {
	if !identifier.MatchString(ref) {
		return errors.New("invalid resource identifier")
	}
	s, err := e.get(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, existing := range s.state.ReferencedAssetIDs {
		if existing == ref {
			return nil
		}
	}
	s.state.ReferencedAssetIDs = append(s.state.ReferencedAssetIDs, ref)
	s.state.Config.ReferencedAssets = append([]string(nil), s.state.ReferencedAssetIDs...)
	return e.save(s)
}
func (e *Engine) rememberApproved(s *session, c Config, ref string) error {
	if ref == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state.ReferencedAssetIDs = validRemembered(c, append(s.state.ReferencedAssetIDs, ref))
	s.state.Config.ReferencedAssets = append([]string(nil), s.state.ReferencedAssetIDs...)
	return e.save(s)
}
