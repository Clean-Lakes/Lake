package web

import (
	"encoding/hex"
	"os"
	"path/filepath"
)

// Explicit history erasure only; no ticker, model, tool or execution capability.
func (b *Server) pruneErasedExperiments() {
	root := filepath.Join(b.options.DataDir, "strategy-experiments")
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return
	}
	runs, err := strategyCall(b.Store, false, func() []Object {
		return b.Store.rows("SELECT r.id FROM strategyExperimentRuns r JOIN strategyExperiments e ON e.jobId=r.experimentId WHERE e.frozenJSON='' AND r.status<>'running' LIMIT 1000")
	})
	if err != nil {
		return
	}
	for _, r := range runs {
		id := stringOf(r["id"])
		decoded, decodeErr := hex.DecodeString(id)
		if decodeErr == nil && len(decoded) == 16 {
			_ = os.RemoveAll(filepath.Join(b.options.DataDir, "strategy-experiments", id))
		}
	}
}
