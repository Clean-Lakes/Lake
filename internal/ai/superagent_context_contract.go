package ai

import (
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	ContextProtocolV1   = 1
	RouterContextBytes  = 16 * 1024
	TaskDigestBytes     = 1536
	TaskDigestTextBytes = 512
	TaskDigestRefs      = 4
	RouterTaskDigests   = 8
)

// Context references carry provenance, never an execution capability.
type ContextRefV1 struct {
	Kind     string `json:"kind"`
	ID       string `json:"id"`
	Revision int64  `json:"revision"`
	Hash     string `json:"hash"`
}

func (r ContextRefV1) Validate() error {
	if !contextID(r.ID) || r.Revision < 1 || len(r.Hash) != 64 {
		return errSuperBinding
	}
	for _, c := range r.Hash {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return errSuperBinding
		}
	}
	switch r.Kind {
	case "event", "task", "worker", "task_digest":
		return nil
	}
	return errSuperBinding
}
func contextID(s string) bool {
	return s != "" && len(s) <= 256 && utf8.ValidString(s) && strings.IndexByte(s, 0) < 0
}

type TaskAssignmentV1 struct {
	Version             int          `json:"version"`
	ProjectID           string       `json:"projectId"`
	RoleID              string       `json:"roleId"`
	RoleRevision        int64        `json:"roleRevision"`
	TaskID              string       `json:"taskId"`
	WorkerID            string       `json:"workerId"`
	SessionID           string       `json:"sessionId"`
	OriginRootTurnID    string       `json:"originRootTurnId"`
	OriginalRequirement ContextRefV1 `json:"originalRequirementRef"`
}

func (a TaskAssignmentV1) Validate() error {
	if a.Version != ContextProtocolV1 || a.RoleRevision < 1 {
		return errSuperBinding
	}
	for _, id := range []string{a.ProjectID, a.RoleID, a.TaskID, a.WorkerID, a.SessionID, a.OriginRootTurnID} {
		if !contextID(id) {
			return errSuperBinding
		}
	}
	if a.OriginalRequirement.Kind != "event" {
		return errSuperBinding
	}
	return a.OriginalRequirement.Validate()
}

type TaskDigestV1 struct {
	Version           int            `json:"version"`
	ProjectID         string         `json:"projectId"`
	RoleID            string         `json:"roleId"`
	RoleRevision      int64          `json:"roleRevision"`
	TaskID            string         `json:"taskId"`
	WorkerID          string         `json:"workerId"`
	SessionID         string         `json:"sessionId"`
	CanonicalRevision int64          `json:"canonicalRevision"`
	ObservedAt        time.Time      `json:"observedAt"`
	State             string         `json:"state"`
	AcceptanceState   string         `json:"acceptanceState"`
	NextAction        string         `json:"nextAction,omitempty"`
	Title             string         `json:"title"`
	Summary           string         `json:"summary,omitempty"`
	Refs              []ContextRefV1 `json:"refs"`
	Truncated         bool           `json:"truncated,omitempty"`
}

func (d TaskDigestV1) Validate() error {
	if d.Version != ContextProtocolV1 || d.CanonicalRevision < 1 || d.RoleRevision < 0 || d.ObservedAt.IsZero() || len(d.Refs) < 1 || len(d.Refs) > TaskDigestRefs || len(d.Summary) > TaskDigestTextBytes || len(js(d)) > TaskDigestBytes {
		return errors.New("superagent: invalid task digest")
	}
	switch d.State {
	case "queued", "running", "waiting_external", "waiting_user", "paused", "blocked", "failed", "cancelled", "completed":
	default:
		return errSuperBinding
	}
	switch d.AcceptanceState {
	case "not_evaluated", "insufficient", "pass":
	default:
		return errSuperBinding
	}
	if !utf8.ValidString(d.Summary+d.Title+d.NextAction) || strings.IndexByte(d.Summary+d.Title+d.NextAction, 0) >= 0 || len(d.NextAction) > 64 {
		return errSuperBinding
	}
	for _, id := range []string{d.ProjectID, d.RoleID, d.TaskID, d.WorkerID, d.SessionID} {
		if !contextID(id) {
			return errSuperBinding
		}
	}
	for _, ref := range d.Refs {
		if err := ref.Validate(); err != nil {
			return err
		}
	}
	return nil
}

// Only host-generated references are stored here; knowledge text belongs to Memory.
type TaskWorkingSetV1 struct {
	Version      int              `json:"version"`
	Assignment   TaskAssignmentV1 `json:"assignment"`
	SteeringRefs []ContextRefV1   `json:"steeringRefs,omitempty"`
	PendingRefs  []ContextRefV1   `json:"pendingRefs,omitempty"`
}

// DecodeTaskDigestV1 rejects incompatible/unknown fields at the contract seam.
func DecodeTaskDigestV1(raw string) (TaskDigestV1, error) {
	var out TaskDigestV1
	if len(raw) > TaskDigestBytes || !utf8.ValidString(raw) {
		return out, errSuperBinding
	}
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&out); err != nil {
		return out, err
	}
	var extra any
	if dec.Decode(&extra) != io.EOF {
		return TaskDigestV1{}, errSuperBinding
	}
	return out, out.Validate()
}
