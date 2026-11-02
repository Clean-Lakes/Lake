package ai

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

// SecurityTerminalHandoff is a host-only, single local handoff. Its private
// permit cannot be constructed from tool JSON or an approved boolean.
type SecurityTerminalHandoff struct {
	operation security.PreparedOperation
	bind      func(entryID, sourceOperationID string) error
}

func (h SecurityTerminalHandoff) DescriptorDigest() string {
	digest, _ := security.OperationDigest(h.operation)
	return digest
}
func (h SecurityTerminalHandoff) OwnerID() string        { return h.operation.OwnerID }
func (h SecurityTerminalHandoff) OwnerGeneration() int64 { return h.operation.OwnerGeneration }
func (h SecurityTerminalHandoff) OperationID() string    { return h.operation.ID }
func (h SecurityTerminalHandoff) Generation() string     { return h.operation.TerminalGeneration }
func (h SecurityTerminalHandoff) ContextRevision() int64 { return h.operation.TerminalContextRevision }
func (h SecurityTerminalHandoff) ResourceID() string {
	if len(h.operation.Resources) == 1 {
		return h.operation.Resources[0].ID
	}
	return ""
}
func (h SecurityTerminalHandoff) BindEntry(entryID, sourceOperationID string) error {
	if h.bind == nil {
		return errors.New("security: inactive terminal handoff")
	}
	return h.bind(entryID, sourceOperationID)
}

// WithSecurityTerminalHandoff keeps configuration mutation fenced through the
// short local PTY write, never through waiting for remote command completion.
// The callback must not call a runtime/barrier check or wait for network I/O.
func (e *Engine) WithSecurityTerminalHandoff(ctx context.Context, projectID, sessionID, terminalID, kind, payload string, handoff func(SecurityTerminalHandoff) error) error {
	p, _ := ctx.Value(securityPermitContextKey{}).(*SecurityPermit)
	if p == nil || p.prepared == nil || handoff == nil || terminalID == "" || p.operation.TerminalID != terminalID || p.operation.TerminalGeneration == "" || p.operation.TerminalContextRevision < 0 || p.operation.Proof != security.ProofOpaque {
		return errors.New("security: exact compatible terminal permit required")
	}
	a := p.prepared.executionArgs
	switch kind {
	case "command":
		if p.operation.Tool != "shell" && p.operation.Tool != "terminal_execute_command" {
			return security.ErrConflict
		}
		if str(a["command"]) != payload {
			return security.ErrConflict
		}
	case "input":
		expected, ok := securityTerminalInput(p.operation.Tool, a)
		if !ok || expected != payload {
			return security.ErrConflict
		}
	default:
		return errors.New("security: unsupported managed terminal effect")
	}
	db, _, _, err := e.securityTaskDB()
	if err != nil {
		return err
	}
	return e.validateSecurityPermitAtIO(ctx, projectID, sessionID, func(_ SecurityCatalogView) error {
		active, bound := true, false
		defer func() { active = false }()
		h := SecurityTerminalHandoff{operation: p.operation}
		h.bind = func(entryID, sourceOperationID string) error {
			if !active || bound || entryID == "" || strings.Contains(entryID, ":") {
				return security.ErrConflict
			}
			if kind == "input" && sourceOperationID == "" || kind == "command" && sourceOperationID != "" {
				return security.ErrConflict
			}
			err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
				if sourceOperationID != "" {
					var source nativeOperation
					if err := tx.First(&source, "id = ? AND status = ?", sourceOperationID, "dispatched").Error; err != nil {
						return err
					}
					var descriptor security.PreparedOperation
					if decodeSecurityJSON(source.SecurityDescriptor, &descriptor) != nil || source.Handle != terminalID+":"+entryID || descriptor.TaskID != p.operation.TaskID || descriptor.RootTurnID != p.operation.RootTurnID || descriptor.ChildScopeID != p.operation.ChildScopeID || descriptor.TerminalID != terminalID || descriptor.TerminalGeneration != p.operation.TerminalGeneration {
						return security.ErrConflict
					}

					sourceDigest, digestErr := security.OperationDigest(descriptor)
					if digestErr != nil || sourceDigest != source.DescriptorDigest || descriptor.OwnerID != p.operation.OwnerID || descriptor.OwnerGeneration != p.operation.OwnerGeneration || js(descriptor.Resources) != js(p.operation.Resources) {
						return security.ErrConflict
					}
				}
				result := tx.Model(&nativeOperation{}).Where("id = ? AND status = ? AND descriptor_digest = ? AND (handle = '' OR handle IS NULL)", p.operation.ID, "dispatched", p.digest).Update("handle", terminalID+":"+entryID)
				if result.Error != nil {
					return result.Error
				}
				if result.RowsAffected != 1 {
					return security.ErrConflict
				}
				return e.appendNativeEvidence(tx, &nativeEvidence{OperationID: p.operation.ID, SessionID: sessionID, CallID: p.operation.CallID, Tool: p.operation.Tool, Status: "terminal_handoff", Data: js(map[string]any{"terminal_id": terminalID, "entry_id": entryID, "generation": p.operation.TerminalGeneration, "context_revision": p.operation.TerminalContextRevision, "source_operation_id": sourceOperationID}), At: time.Now().UTC()})
			})
			if err == nil {
				bound = true
			}
			return err
		}
		err := handoff(h)
		if err == nil && !bound {
			return errors.New("security: terminal entry was not registered")
		}
		return err
	})
}

func securityTerminalInput(tool string, a map[string]any) (string, bool) {
	switch tool {
	case "ssh_terminal_send", "terminal_send_input", "ssh_terminal_expect", "terminal_expect":
		input := str(a["input"])
		if input == "" {
			return "", false
		}
		if a["append_enter"] == true && !strings.HasSuffix(input, "\n") && !strings.HasSuffix(input, "\r") {
			input += "\n"
		}
		return input, true
	case "ssh_terminal_key", "terminal_send_key":
		keys := map[string]string{"enter": "\r", "tab": "\t", "esc": "\x1b", "backspace": "\x7f", "delete": "\x1b[3~", "ctrl_c": "\x03", "ctrl_d": "\x04", "ctrl_z": "\x1a", "up": "\x1b[A", "down": "\x1b[B", "right": "\x1b[C", "left": "\x1b[D", "home": "\x1b[H", "end": "\x1b[F", "page_up": "\x1b[5~", "page_down": "\x1b[6~", "space": " "}
		key, ok := keys[str(a["key"])]
		if !ok {
			return "", false
		}
		count := num(a["count"], 1)
		if count < 1 {
			count = 1
		}
		if count > 100 {
			count = 100
		}
		return strings.Repeat(key, count), true
	}
	return "", false
}

// SecurityTerminalIdentity returns only the frozen host-selected terminal ID.
func (e *Engine) SecurityTerminalIdentity(ctx context.Context, projectID, sessionID string) (string, error) {
	p, _ := ctx.Value(securityPermitContextKey{}).(*SecurityPermit)
	if p == nil || p.operation.ProjectID != projectID || p.operation.SessionID != sessionID || p.operation.TerminalID == "" {
		return "", errors.New("security: frozen existing terminal required")
	}
	return p.operation.TerminalID, nil
}
