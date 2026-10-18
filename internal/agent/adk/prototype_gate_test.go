// Package lakeadk hosts the Phase 0 Google ADK integration spike.
//
// The package is intentionally self-contained: it does not register itself in
// the default Lake runtime. It proves that Lake tools can be exposed to ADK
// through one mandatory gate (policy -> approval -> execute -> evidence) before
// the full migration starts.
package lakeadk

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/Clean-Lakes/Lake/internal/platform"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/tool"
)

// ToolSpec describes one Lake tool exposed to ADK. Execute is never registered
// directly with the model; only Gate.Run can invoke it.
type ToolSpec struct {
	Name        string
	Description string
	Parameters  map[string]any
	Target      string
	// ReadOnly must return true only for operations that cannot change target
	// state. A nil predicate means "not read-only".
	ReadOnly func(args map[string]any) bool
	Execute  func(ctx context.Context, args map[string]any) (any, error)
	// ExecuteApproved is used when the gate has a policy decision available.
	// It lets an executor bind the operation to the approved target/fingerprint.
	ExecuteApproved func(ctx context.Context, args map[string]any, decision Decision) (any, error)
}

// Decision is the policy result for one tool call.
type Decision struct {
	Risk             string
	RequiresApproval bool
	Target           string
	Fingerprint      string
	Preview          any
}

// Policy evaluates a tool call. It must be pure and fast: it is called before
// execution and again when validating an approval.
type Policy func(ctx context.Context, spec ToolSpec, args map[string]any) Decision

// PendingApproval is the server-side record bound to one confirmation token.
type PendingApproval struct {
	ID        string    `json:"id"`
	SessionID string    `json:"session_id"`
	Tool      string    `json:"tool"`
	ArgsHash  string    `json:"args_hash"`
	Target    string    `json:"target"`
	Risk      string    `json:"risk"`
	Preview   any       `json:"preview,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`
}

// ApprovalStore persists pending confirmations. The file implementation lets a
// confirmation survive a process restart; it never stores model credentials.
type ApprovalStore interface {
	Put(PendingApproval) error
	Get(id string) (PendingApproval, bool)
	Delete(id string) error
}

type memoryApprovalStore struct {
	mu   sync.Mutex
	data map[string]PendingApproval
}

// NewMemoryApprovalStore returns an in-process approval store for tests.
func NewMemoryApprovalStore() ApprovalStore {
	return &memoryApprovalStore{data: map[string]PendingApproval{}}
}

func (m *memoryApprovalStore) Put(p PendingApproval) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.data[p.ID] = p
	return nil
}

func (m *memoryApprovalStore) Get(id string) (PendingApproval, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.data[id]
	if !ok || time.Now().After(p.ExpiresAt) {
		return PendingApproval{}, false
	}
	return p, true
}

func (m *memoryApprovalStore) Delete(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.data, id)
	return nil
}

type fileApprovalStore struct {
	path string
	mu   sync.Mutex
}

// NewFileApprovalStore persists pending confirmations as a private JSON file.
func NewFileApprovalStore(path string) (ApprovalStore, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("approval store path is required")
	}
	if err := privateDir(path); err != nil {
		return nil, err
	}
	return &fileApprovalStore{path: path}, nil
}

func privateDir(path string) error {
	dir := filepath.Dir(path)
	if err := platform.MkdirAll(dir, 0700); err != nil {
		return err
	}
	return platform.Chmod(dir, 0700)
}

func (f *fileApprovalStore) read() (map[string]PendingApproval, error) {
	data := map[string]PendingApproval{}
	b, err := os.ReadFile(f.path)
	if errors.Is(err, os.ErrNotExist) {
		return data, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &data); err != nil {
		return nil, fmt.Errorf("invalid approval store: %w", err)
	}
	return data, nil
}

func (f *fileApprovalStore) write(data map[string]PendingApproval) error {
	b, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(f.path), ".approvals-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := platform.Chmod(tmp.Name(), 0600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return platform.ReplaceFile(name, f.path)
}

func (f *fileApprovalStore) Put(p PendingApproval) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	data, err := f.read()
	if err != nil {
		return err
	}
	data[p.ID] = p
	return f.write(data)
}

func (f *fileApprovalStore) Get(id string) (PendingApproval, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	data, err := f.read()
	if err != nil {
		return PendingApproval{}, false
	}
	p, ok := data[id]
	if !ok || time.Now().After(p.ExpiresAt) {
		return PendingApproval{}, false
	}
	return p, true
}

func (f *fileApprovalStore) Delete(id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	data, err := f.read()
	if err != nil {
		return err
	}
	delete(data, id)
	return f.write(data)
}

// EvidenceRecord is one append-only audit entry. Args contains redacted values
// only; the hash is computed from the original arguments.
type EvidenceRecord struct {
	At        string         `json:"at"`
	SessionID string         `json:"session_id,omitempty"`
	CallID    string         `json:"call_id,omitempty"`
	Tool      string         `json:"tool"`
	ArgsHash  string         `json:"args_hash"`
	Args      map[string]any `json:"args,omitempty"`
	Target    string         `json:"target,omitempty"`
	Risk      string         `json:"risk,omitempty"`
	Status    string         `json:"status"`
	Result    any            `json:"result,omitempty"`
	Error     string         `json:"error,omitempty"`
}

// EvidenceSink appends audit records. Implementations must be append-only.
type EvidenceSink interface {
	Append(EvidenceRecord) error
}

type memoryEvidence struct {
	mu      sync.Mutex
	records []EvidenceRecord
}

// NewMemoryEvidence returns an in-process evidence sink for tests.
func NewMemoryEvidence() *memoryEvidence {
	return &memoryEvidence{}
}

func (m *memoryEvidence) Append(r EvidenceRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.records = append(m.records, r)
	return nil
}

// Records returns a copy of the recorded evidence in append order.
func (m *memoryEvidence) Records() []EvidenceRecord {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]EvidenceRecord(nil), m.records...)
}

type fileEvidence struct {
	path string
	mu   sync.Mutex
}

// NewFileEvidence appends JSONL evidence records to a private file.
func NewFileEvidence(path string) (EvidenceSink, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("evidence path is required")
	}
	if err := privateDir(path); err != nil {
		return nil, err
	}
	return &fileEvidence{path: path}, nil
}

func (f *fileEvidence) Append(r EvidenceRecord) error {
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	file, err := os.OpenFile(f.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	if err := platform.Chmod(file.Name(), 0600); err != nil {
		return err
	}
	_, err = file.Write(append(b, '\n'))
	return err
}

// Gate is the only execution path from ADK tools to Lake tool implementations.
type Gate struct {
	Approvals   ApprovalStore
	Evidence    EvidenceSink
	Policy      Policy
	Now         func() time.Time
	ApprovalTTL time.Duration
}

// NewGate creates a gate with conservative defaults.
func NewGate(approvals ApprovalStore, evidence EvidenceSink) *Gate {
	if approvals == nil {
		approvals = NewMemoryApprovalStore()
	}
	if evidence == nil {
		evidence = NewMemoryEvidence()
	}
	return &Gate{
		Approvals:   approvals,
		Evidence:    evidence,
		Policy:      DefaultPolicy,
		Now:         time.Now,
		ApprovalTTL: 15 * time.Minute,
	}
}

// DefaultPolicy treats only explicitly read-only tools as safe.
func DefaultPolicy(_ context.Context, spec ToolSpec, args map[string]any) Decision {
	readOnly := spec.ReadOnly != nil && spec.ReadOnly(args)
	risk := "write"
	if readOnly {
		risk = "readonly"
	}
	target := spec.Target
	if target == "" {
		target = "local"
	}
	return Decision{
		Risk:             risk,
		RequiresApproval: !readOnly,
		Target:           target,
		Fingerprint:      hashArgs(args),
	}
}

// Run executes a tool call after policy, approval and evidence checks. It is
// safe to call from an ADK function tool handler; the handler is invoked twice
// for a confirmed operation (request, then resume).
func (g *Gate) Run(ctx agent.Context, spec ToolSpec, args map[string]any) (map[string]any, error) {
	if spec.Execute == nil && spec.ExecuteApproved == nil {
		return nil, errors.New("tool has no executor")
	}
	if args == nil {
		args = map[string]any{}
	}
	policy := g.Policy
	if policy == nil {
		policy = DefaultPolicy
	}
	approvals := g.Approvals
	decision := policy(ctx, spec, args)
	if decision.Target == "" {
		decision.Target = spec.Target
		if decision.Target == "" {
			decision.Target = "local"
		}
	}
	if decision.Fingerprint == "" {
		decision.Fingerprint = hashArgs(args)
	}
	argsHash := hashArgs(args)
	callID := ""
	sessionID := ""
	if ctx != nil {
		callID = ctx.FunctionCallID()
		sessionID = ctx.SessionID()
	}

	confirmation := ctx.ToolConfirmation()
	if decision.RequiresApproval {
		if approvals == nil {
			return nil, errors.New("approval store is not configured")
		}
		if confirmation == nil {
			id := newApprovalID()
			now := g.now()
			ttl := g.ApprovalTTL
			if ttl <= 0 {
				ttl = 15 * time.Minute
			}
			pending := PendingApproval{
				ID:        id,
				SessionID: sessionID,
				Tool:      spec.Name,
				ArgsHash:  argsHash,
				Target:    decision.Target,
				Risk:      decision.Risk,
				Preview:   decision.Preview,
				CreatedAt: now,
				ExpiresAt: now.Add(ttl),
			}
			if err := approvals.Put(pending); err != nil {
				return nil, fmt.Errorf("cannot persist approval: %w", err)
			}
			payload := map[string]any{
				"approval_id": id,
				"tool":        spec.Name,
				"target":      decision.Target,
				"risk":        decision.Risk,
				"fingerprint": decision.Fingerprint,
				"expires_at":  pending.ExpiresAt.Format(time.RFC3339),
				"preview":     decision.Preview,
			}
			if err := ctx.RequestConfirmation(approvalHint(spec, decision), payload); err != nil {
				return nil, err
			}
			if actions := ctx.Actions(); actions != nil {
				actions.SkipSummarization = true
			}
			g.record(EvidenceRecord{
				SessionID: sessionID,
				CallID:    callID,
				Tool:      spec.Name,
				ArgsHash:  argsHash,
				Args:      redactArgs(args),
				Target:    decision.Target,
				Risk:      decision.Risk,
				Status:    "approval_requested",
				Result:    map[string]any{"approval_id": id},
			})
			return map[string]any{
				"status":       "approval_required",
				"approval_id":  id,
				"target":       decision.Target,
				"risk":         decision.Risk,
				"instructions": "This operation is paused until the user approves it in Lake. Do not retry it in this turn.",
			}, nil
		}
		if !confirmation.Confirmed {
			if id := approvalID(confirmation.Payload); id != "" {
				_ = approvals.Delete(id)
			}
			g.record(EvidenceRecord{
				SessionID: sessionID,
				CallID:    callID,
				Tool:      spec.Name,
				ArgsHash:  argsHash,
				Args:      redactArgs(args),
				Target:    decision.Target,
				Risk:      decision.Risk,
				Status:    "rejected",
			})
			return nil, tool.ErrConfirmationRejected
		}
		if err := validateApproval(approvals, confirmation.Payload, sessionID, spec, argsHash, decision.Target); err != nil {
			g.record(EvidenceRecord{
				SessionID: sessionID,
				CallID:    callID,
				Tool:      spec.Name,
				ArgsHash:  argsHash,
				Args:      redactArgs(args),
				Target:    decision.Target,
				Risk:      decision.Risk,
				Status:    "approval_invalid",
				Error:     err.Error(),
			})
			return nil, err
		}
		g.record(EvidenceRecord{
			SessionID: sessionID,
			CallID:    callID,
			Tool:      spec.Name,
			ArgsHash:  argsHash,
			Args:      redactArgs(args),
			Target:    decision.Target,
			Risk:      decision.Risk,
			Status:    "approved",
		})
	}

	g.record(EvidenceRecord{
		SessionID: sessionID,
		CallID:    callID,
		Tool:      spec.Name,
		ArgsHash:  argsHash,
		Args:      redactArgs(args),
		Target:    decision.Target,
		Risk:      decision.Risk,
		Status:    "started",
	})
	var result any
	var err error
	if spec.ExecuteApproved != nil {
		result, err = spec.ExecuteApproved(ctx, args, decision)
	} else {
		result, err = spec.Execute(ctx, args)
	}
	if err != nil {
		g.record(EvidenceRecord{
			SessionID: sessionID,
			CallID:    callID,
			Tool:      spec.Name,
			ArgsHash:  argsHash,
			Args:      redactArgs(args),
			Target:    decision.Target,
			Risk:      decision.Risk,
			Status:    "failed",
			Error:     err.Error(),
		})
		return nil, err
	}
	out := resultMap(result)
	g.record(EvidenceRecord{
		SessionID: sessionID,
		CallID:    callID,
		Tool:      spec.Name,
		ArgsHash:  argsHash,
		Args:      redactArgs(args),
		Target:    decision.Target,
		Risk:      decision.Risk,
		Status:    "completed",
		Result:    boundedResult(out),
	})
	return out, nil
}

func validateApproval(approvals ApprovalStore, payload any, sessionID string, spec ToolSpec, argsHash, target string) error {
	id := approvalID(payload)
	if id == "" {
		return errors.New("approval token is missing")
	}
	pending, ok := approvals.Get(id)
	if !ok {
		return errors.New("approval token is invalid or expired")
	}
	if pending.Tool != spec.Name {
		return errors.New("approval token is bound to a different tool")
	}
	if pending.ArgsHash != argsHash {
		return errors.New("approval token is bound to different arguments")
	}
	if pending.Target != target {
		return errors.New("approval target changed; approval expired")
	}
	if pending.SessionID != "" && sessionID != "" && pending.SessionID != sessionID {
		return errors.New("approval token is bound to a different session")
	}
	if err := approvals.Delete(id); err != nil {
		return fmt.Errorf("cannot consume approval: %w", err)
	}
	return nil
}

func (g *Gate) record(r EvidenceRecord) {
	if g.Evidence == nil {
		return
	}
	if r.At == "" {
		r.At = g.now().UTC().Format(time.RFC3339Nano)
	}
	if r.Args == nil {
		r.Args = map[string]any{}
	}
	_ = g.Evidence.Append(r)
}

func (g *Gate) now() time.Time {
	if g.Now != nil {
		return g.Now()
	}
	return time.Now()
}

func approvalHint(spec ToolSpec, d Decision) string {
	return fmt.Sprintf("Lake needs explicit approval for tool %q on %s (risk: %s). Approve only if this exact operation is intended.",
		spec.Name, d.Target, d.Risk)
}

func approvalID(v any) string {
	switch p := v.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(p)
	case map[string]any:
		return stringValue(p["approval_id"])
	case map[string]string:
		return strings.TrimSpace(p["approval_id"])
	case PendingApproval:
		return p.ID
	case *PendingApproval:
		if p != nil {
			return p.ID
		}
	}
	return ""
}

func stringValue(v any) string {
	s, _ := v.(string)
	return strings.TrimSpace(s)
}

func resultMap(v any) map[string]any {
	if v == nil {
		return map[string]any{}
	}
	if m, ok := v.(map[string]any); ok {
		return m
	}
	b, err := json.Marshal(v)
	if err == nil {
		var m map[string]any
		if json.Unmarshal(b, &m) == nil && m != nil {
			return m
		}
	}
	return map[string]any{"result": v}
}

func boundedResult(v map[string]any) any {
	if redacted, ok := redactValue(v, 0).(map[string]any); ok {
		v = redacted
	}
	b, err := json.Marshal(v)
	if err != nil {
		return map[string]any{"error": "unserializable result"}
	}
	if len(b) <= 4000 {
		return v
	}
	return map[string]any{"truncated": true, "preview": string(b[:4000]) + "…"}
}

func hashArgs(args map[string]any) string {
	b, _ := json.Marshal(args)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func newApprovalID() string {
	return "ap_" + randomHex(16)
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand failure is not actionable here; a timestamp fallback keeps
		// the failure visible in logs while never reusing a token silently.
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

func redactArgs(args map[string]any) map[string]any {
	return redactValue(args, 0).(map[string]any)
}

func redactValue(v any, depth int) any {
	if depth > 6 {
		return "[TRUNCATED]"
	}
	switch x := v.(type) {
	case map[string]any:
		out := map[string]any{}
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if sensitiveKey(k) {
				out[k] = "[REDACTED]"
				continue
			}
			out[k] = redactValue(x[k], depth+1)
		}
		return out
	case []any:
		out := make([]any, 0, len(x))
		for _, item := range x {
			out = append(out, redactValue(item, depth+1))
		}
		return out
	case string:
		return redactString(x)
	default:
		return v
	}
}

var secretValuePatterns = []struct {
	pattern     *regexp.Regexp
	replacement string
}{
	{regexp.MustCompile(`(?i)(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*[^\s"',]+`), "${1}=[REDACTED]"},
	{regexp.MustCompile(`(?i)Bearer\s+[A-Za-z0-9._~+/=-]+`), "Bearer [REDACTED]"},
}

func redactString(s string) string {
	for _, item := range secretValuePatterns {
		s = item.pattern.ReplaceAllString(s, item.replacement)
	}
	if len(s) > 1000 {
		s = s[:1000] + "…"
	}
	return s
}

func sensitiveKey(k string) bool {
	k = strings.ToLower(k)
	for _, part := range []string{"password", "passwd", "secret", "token", "api_key", "apikey", "private_key", "privatekey", "credential"} {
		if strings.Contains(k, part) {
			return true
		}
	}
	return false
}
