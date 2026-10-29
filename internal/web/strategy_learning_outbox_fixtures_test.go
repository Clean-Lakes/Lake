package web

// Historical fixture support only: never compiled into the Lake product.

import (
	"github.com/Clean-Lakes/Lake/internal/ai"
)

func (b *Server) strategySafeText(text string) bool {
	model := b.Models.Active()
	if model == nil {
		model = &ai.Model{}
	}
	return ai.SafeMemoryContent(text, *model) && !b.Models.strategyContainsProviderSecret(text) && !b.Terminals.containsCredential(text)
}
