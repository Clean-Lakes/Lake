package web

import (
	"github.com/Clean-Lakes/Lake/internal/ai"
	"net/http/httptest"
	"testing"
)

func TestSpecialistsUsePilotPermissionsAndRejectLocalOverrides(t *testing.T) {
	b, pid, pilot, worker, ch := roleWorkspaceFixture(t)
	b.Models.Save(&ai.Model{URL: "http://127.0.0.1:1", Name: "metadata-only", Protocol: "openai"})
	b.configure(pilot, nil)
	// Old independent channel/task options must not remain authority.
	b.Store.SaveOptions(ch.SessionID, Object{"silentReadFiles": true, "silentWriteFiles": true, "silentMCPCalls": false})
	b.Store.SaveOptions(worker.SessionID, Object{"silentReadFiles": true, "silentWriteFiles": true, "silentMCPCalls": false})
	b.configureUserOptions(pilot, Object{"silentReadFiles": false, "silentWriteFiles": false, "silentMCPCalls": true})
	for _, id := range []string{ch.SessionID, worker.SessionID} {
		opts := b.sessionOptions(id)
		if opts["silentReadFiles"] != false || opts["silentWriteFiles"] != false || opts["silentMCPCalls"] != true {
			t.Fatal("local snapshot won", id, opts)
		}
	}
	h := httptest.NewServer(b)
	defer h.Close()
	apiTest(t, h, "POST", "/api/sessions/"+worker.SessionID+"/ai/configure", Object{"silentMCPCalls": false}, 409)
	apiTest(t, h, "POST", "/api/sessions/"+ch.SessionID+"/ai/configure", Object{"silentWriteFiles": true}, 409)
	apiTest(t, h, "POST", "/api/sessions/"+worker.SessionID+"/ai/configure", Object{"silentMCPCalls": true, "maxSteps": 42}, 200)
	b.configure(worker.SessionID, b.superWorkerTargetOptions(pid, worker.WorkerID, worker.SessionID))
	current, err := b.Engine.SecurityLegacySessionPolicy(t.Context(), pid, worker.SessionID)
	if err != nil || current.Source != "pilot:"+pilot || !current.Permissions.SilentMCPCalls || current.Permissions.SilentReadFiles {
		t.Fatal("Worker execution did not use Pilot", current, err)
	}
	// Ordinary runtime refreshes cannot invent new shared authority.
	before := current
	b.configure(pilot, Object{"silentReadFiles": true})
	current, err = b.Engine.SecurityLegacySessionPolicy(t.Context(), pid, worker.SessionID)
	if err != nil || current.Revision != before.Revision || current.Permissions.SilentReadFiles {
		t.Fatal("refresh expanded authority", current, err)
	}
	b.configureUserOptions(pilot, Object{"silentMCPCalls": false})
	current, err = b.Engine.SecurityLegacySessionPolicy(t.Context(), pid, worker.SessionID)
	if err != nil || current.Permissions.SilentMCPCalls || current.Revision <= before.Revision {
		t.Fatal("Pilot revocation not inherited", current, err)
	}
}
