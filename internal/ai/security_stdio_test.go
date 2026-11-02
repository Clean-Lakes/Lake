package ai

import (
	"context"
	"encoding/json"
	"io"
	"sync/atomic"
	"testing"
	"time"
)

type securityStdioEmptyProjectFixture struct{}

func (securityStdioEmptyProjectFixture) BindConfig(_ context.Context, _, _ string, c Config) (Config, error) {
	return c, nil
}
func (securityStdioEmptyProjectFixture) Close() error { return nil }

func TestSecurityStdioEnforcedEmptyProjectCannotReachModelOrCallback(t *testing.T) {
	var modelCalls atomic.Int32
	model, closeModel := fakeModel(t, func(_ int, _ map[string]any) any { modelCalls.Add(1); return response("must not run") })
	defer closeModel()
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	input, writer := io.Pipe()
	output, outWriter := io.Pipe()
	ready := make(chan *Engine, 1)
	done := make(chan error, 1)
	go func() {
		done <- ServeHome(ctx, t.TempDir(), input, outWriter, func(_ context.Context, _ *SecurityHome, e *Engine) (SecurityStdioHost, error) {
			db, storeID, epoch, err := e.securityTaskDB()
			if err != nil {
				return nil, err
			}
			if err = db.Create(&securityRuntimeModeRow{ID: 1, StoreID: storeID, RecoveryEpoch: epoch, Mode: "enforced", Revision: 1}).Error; err != nil {
				return nil, err
			}
			ready <- e
			return securityStdioEmptyProjectFixture{}, nil
		})
		outWriter.Close()
	}()
	var engine *Engine
	select {
	case engine = <-ready:
	case err := <-done:
		t.Fatal(err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	t.Cleanup(func() {
		cancel()
		writer.Close()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("stdio did not stop")
		}
		output.Close()
	})
	replies := make(chan Frame, 20)
	go func() {
		defer close(replies)
		d := json.NewDecoder(output)
		for {
			var f Frame
			if d.Decode(&f) != nil {
				return
			}
			replies <- f
		}
	}()
	call := func(frame Frame) Frame {
		t.Helper()
		if err := json.NewEncoder(writer).Encode(frame); err != nil {
			t.Fatal(err)
		}
		for {
			select {
			case f, ok := <-replies:
				if !ok {
					t.Fatal("stdio closed")
				}
				if f.Callback != "" {
					t.Fatal("empty project reached legacy callback", f.Method)
				}
				if f.ID == frame.ID {
					return f
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		}
	}
	response := call(Frame{ID: "configure", Method: "configure", Session: "empty-project", Data: json.RawMessage(js(Config{Model: model, Profile: "core"}))})
	if response.Error == "" {
		t.Fatal("enforced configure accepted empty project")
	}
	response = call(Frame{ID: "chat", Method: "chat", Session: "empty-project", Data: json.RawMessage(`{"message":"read local files"}`)})
	if response.Error == "" || modelCalls.Load() != 0 {
		t.Fatal("empty project reached model", response.Error, modelCalls.Load())
	}
	store, err := engine.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	var operations int64
	if err = store.DB.Model(&nativeOperation{}).Count(&operations).Error; err != nil || operations != 0 {
		t.Fatal("empty project dispatched native operation", operations, err)
	}
}

func TestSecurityEntrySourceExplicitAndCrossTransportDoesNotRewriteSeven(t *testing.T) {
	home := securityFixture(t)
	engine, err := New(t.TempDir(), func(context.Context, string, string, map[string]any, bool) (any, error) { return nil, nil }, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Shutdown()
	engine.SecurityRuntime = home
	if err = engine.SetSecurityEntrySource("standalone"); err != nil {
		t.Fatal(err)
	}
	if err = engine.Configure("actual-stdio", Config{SecurityProjectID: "project", Model: Model{URL: "http://127.0.0.1:1", Name: "fixture", Protocol: "openai"}}); err != nil {
		t.Fatal(err)
	}
	before, err := engine.SecurityLegacySessionPolicy(t.Context(), "project", "actual-stdio")
	if err != nil || before.Source != "standalone" {
		t.Fatal("non-nil callback invented Web origin", before, err)
	}
	db, storeID, epoch, err := engine.securityTaskDB()
	if err != nil {
		t.Fatal(err)
	}
	if err = recordLegacySessionPolicy(db, storeID, epoch, "project", "actual-stdio", "web", before.Permissions); err != nil {
		t.Fatal("same effective authority could not cross transport", err)
	}
	changed := before.Permissions
	changed.SilentCommands = !changed.SilentCommands
	if err = recordLegacySessionPolicy(db, storeID, epoch, "project", "actual-stdio", "web", changed); err == nil {
		t.Fatal("transport change widened or rewrote seven settings")
	}
	after, err := engine.SecurityLegacySessionPolicy(t.Context(), "project", "actual-stdio")
	if err != nil || after.Source != before.Source || after.Revision != before.Revision || after.Permissions != before.Permissions {
		t.Fatal("cross entry changed original confirmed snapshot", after, err)
	}
}
