package lakeadk

import "os"

// Enabled reports whether the Phase 0 ADK spike is explicitly enabled. The
// default Lake runtime never consults ADK unless this flag is set; Phase 1
// replaces this with a per-session runtime option.
func Enabled() bool {
	return os.Getenv("LAKE_ADK_SPIKE") == "1"
}
