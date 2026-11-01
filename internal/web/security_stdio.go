package web

import (
	"context"
	"encoding/json"
	"errors"
	"gorm.io/gorm"
	"path/filepath"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/extensions"
)

// NewSecurityStdioHost borrows the already-owned Home and Engine. It opens no
// HTTP listener, scheduler, second SDK runtime, Memory worker or Home owner.
func NewSecurityStdioHost(ctx context.Context, home *ai.SecurityHome, engine *ai.Engine) (host ai.SecurityStdioHost, err error) {
	if home == nil || engine == nil || home.ReadOnlyView() {
		return nil, errors.New("security: writable owned Home required for stdio host")
	}
	control, err := ai.ReadSecurityControl(home.Home)
	if err != nil {
		return nil, err
	}
	store, err := openStore(filepath.Dir(home.RuntimeRoot), operationalMemoryV2Ready, storeOpenOptions{SkipMemoryInitialization: control.RecoveryID != ""})
	if err != nil {
		return nil, err
	}
	child, cancel := context.WithCancel(ctx)
	b := &Server{Store: store, Models: &Models{Home: home.Home, Dir: filepath.Dir(home.RuntimeRoot)}, Engine: engine, securityRuntime: home, Context: child, cancel: cancel, options: Options{Home: home.Home, DataDir: filepath.Dir(home.RuntimeRoot)}}
	b.Extensions = extensions.NewManager(extensions.NewStore(home.Home))
	b.Terminals = NewTerminals(store, b.Models, "")
	b.Terminals.ResolveAccess = b.terminalOwner
	b.Terminals.OnClose = b.revokeTerminal
	b.Terminals.OnControl = func(tid string, holder any) {
		if holder != "agent" {
			b.revokeTerminal(tid)
		}
	}
	b.Terminals.HostKeyApproval = b.ensureHostKey
	ready := false
	defer func() {
		if !ready {
			cancel()
			b.Terminals.Shutdown()
			b.Extensions.Close()
			_ = store.Close()
		}
		if recover() != nil {
			host = nil
			err = errors.New("security: actual Home stdio catalog unavailable")
		}
	}()
	if err = b.initializeSecurityCatalog(); err != nil {
		return nil, err
	}
	ready = true
	return &securityStdioHost{server: b}, nil
}

type securityStdioHost struct{ server *Server }

func (h *securityStdioHost) Close() error {
	h.server.cancel()
	h.server.workflowMu.Lock()
	cancellations := []context.CancelFunc{}
	for _, cancel := range h.server.workflowCancels {
		cancellations = append(cancellations, cancel)
	}
	h.server.workflowMu.Unlock()
	for _, cancel := range cancellations {
		cancel()
	}
	h.server.workers.Wait()
	h.server.schedulerWorkers.Wait()
	h.server.Terminals.Shutdown()
	h.server.Extensions.Close()
	return h.server.Store.Close()
}
func (h *securityStdioHost) BindConfig(ctx context.Context, sessionID, projectID string, c ai.Config) (result ai.Config, err error) {
	defer func() {
		if recover() != nil {
			result = ai.Config{}
			err = errors.New("security: actual stdio session/project catalog unavailable")
		}
	}()
	if err = ctx.Err(); err != nil {
		return result, err
	}
	session := h.server.Store.Session(sessionID)
	actualProject := stringOf(session["projectId"])
	if actualProject == "" || projectID != "" && projectID != actualProject {
		return result, errors.New("security: host project does not match actual Home session")
	}
	// Only canonical assets and their actual opaque credential references enter
	// execution. Caller-provided Asset/SSH/Directory/CredentialDir values are not
	// connection authority, even though configure itself is a host protocol frame.
	c.Assets, c.Directories = h.server.sessionAssetCatalog(sessionID)
	c.SecurityProjectID = actualProject
	c.CredentialDir = filepath.Join(h.server.Models.Home, "secrets")
	c.TerminalID = "" // Stdio has no implicit ownership of an interactive terminal.
	permissions := ai.DefaultPermissions()
	if snapshot, readErr := h.server.Engine.SecurityLegacySessionPolicy(ctx, actualProject, sessionID); readErr == nil {
		permissions = snapshot.Permissions
	} else if errors.Is(readErr, gorm.ErrRecordNotFound) {
		if err = json.Unmarshal([]byte(jsonText(h.server.sessionOptions(sessionID))), &permissions); err != nil {
			return result, err
		}
	} else {
		return result, readErr
	}
	c.Permissions = &permissions
	// Memory consent remains owned by the existing store. Binding a project does
	// not introduce consent or initialize recovered, unqualified Memory data.
	requestedUse, requestedExtraction := c.MemoryEnabled, c.MemoryExtractionEnabled
	c.MemoryProjectID = ""
	c.MemoryEnabled = false
	c.MemoryExtractionEnabled = false
	if requestedUse || requestedExtraction {
		settings := h.server.Store.MemorySettings(actualProject)
		c.MemoryProjectID = actualProject
		c.MemoryEnabled = requestedUse && settings["useEnabled"] == true
		c.MemoryExtractionEnabled = c.MemoryEnabled && requestedExtraction && settings["extractionEnabled"] == true
		c.MemorySchemaVersion = integer(settings["memorySchemaVersion"])
		c.MemoryEpoch, c.MemoryKnowledgeRevision = integer(settings["epoch"]), integer(settings["revision"])
	}
	return c, nil
}

func (h *securityStdioHost) Bridge(ctx context.Context, session, name string, args map[string]any, approved bool) (any, error) {
	return h.server.bridge(ctx, session, name, args, approved)
}
