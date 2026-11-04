package web

import (
	"net/http"
	"os"
)

// Drain is a host lifecycle action, never a model tool. Cancelling admission
// first lets the existing Engine shutdown persist checkpoints, revoke owners,
// reconcile owned processes and retain unknown effects before releasing Home.
func (b *Server) DrainSuperagent() {
	b.draining.Store(true)
	if b.cancel != nil {
		b.cancel()
	}
}

func (b *Server) superagentLifecycleRoute(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path != "/api/superagent/lifecycle" {
		return false
	}
	switch r.Method {
	case "GET":
		reply(w, 200, Object{"pid": os.Getpid(), "home": b.options.Home, "dataDirectory": b.options.DataDir, "draining": b.draining.Load(), "backendRuntime": "go"})
	case "POST":
		input := body(w, r, 4096)
		if input["action"] != "drain" {
			fail(400, "Unknown lifecycle action")
		}
		b.draining.Store(true)
		reply(w, 202, Object{"state": "draining", "pid": os.Getpid()})
		// Close never runs while this handler owns gate.RLock. Start returns
		// after cancellation and its owner calls Close after the response.
		b.DrainSuperagent()
	default:
		fail(405, "Method not allowed")
	}
	return true
}
