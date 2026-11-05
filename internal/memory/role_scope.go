// Package memory defines the host-owned file-memory contracts. This first
// delivery does not start a publisher, migrate content or enable Worker recall.
package memory

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"path/filepath"
	"regexp"
)

const RoleProtocolV1 = 1

var opaqueID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var ErrRoleScope = errors.New("memory: invalid role knowledge scope")

type RoleKnowledgeSettings struct {
	AccumulateEnabled bool  `json:"roleKnowledgeAccumulateEnabled"`
	UseEnabled        bool  `json:"roleKnowledgeUseEnabled"`
	Revision          int64 `json:"revision"`
}

type RoleKnowledgeScopeV1 struct {
	Version          int    `json:"version"`
	StoreID          string `json:"storeId"`
	ProjectID        string `json:"projectId"`
	RoleID           string `json:"roleId"`
	SettingsRevision int64  `json:"settingsRevision"`
	RecoveryEpoch    string `json:"recoveryEpoch"`
}

func (s RoleKnowledgeScopeV1) Validate() error {
	if s.Version != RoleProtocolV1 || s.SettingsRevision < 1 {
		return ErrRoleScope
	}
	for _, id := range []string{s.StoreID, s.ProjectID, s.RoleID, s.RecoveryEpoch} {
		if !opaqueID.MatchString(id) {
			return ErrRoleScope
		}
	}
	return nil
}
func (s RoleKnowledgeScopeV1) Key() (string, error) {
	if err := s.Validate(); err != nil {
		return "", err
	}
	h := sha256.Sum256([]byte(s.StoreID + "\x00" + s.ProjectID + "\x00" + s.RoleID))
	return hex.EncodeToString(h[:]), nil
}

// RelativeDirectory contains only validated host IDs, never a model path.
func (s RoleKnowledgeScopeV1) RelativeDirectory() (string, error) {
	if err := s.Validate(); err != nil {
		return "", err
	}
	return filepath.Join("projects", s.ProjectID, "roles", s.RoleID), nil
}

type KnowledgeRefV1 struct {
	ScopeKey    string `json:"scopeId"`
	EntryID     string `json:"entryId"`
	Revision    int64  `json:"revision"`
	ContentHash string `json:"contentHash"`
}

func (r KnowledgeRefV1) Validate(s RoleKnowledgeScopeV1) error {
	key, err := s.Key()
	if err != nil {
		return err
	}
	digest, decodeErr := hex.DecodeString(r.ContentHash)
	if r.ScopeKey != key || !opaqueID.MatchString(r.EntryID) || r.Revision < 1 || decodeErr != nil || len(digest) != sha256.Size {
		return ErrRoleScope
	}
	return nil
}

// A publish receipt is fenced against BOTH source withdrawal and the base file
// version. It is not a cross-database transaction or an execution permission.
type RolePublishFenceV1 struct {
	Scope              RoleKnowledgeScopeV1 `json:"scope"`
	BaseRevision       int64                `json:"baseRevision"`
	WithdrawalRevision int64                `json:"withdrawalRevision"`
	CommitID           string               `json:"commitId"`
}

func (f RolePublishFenceV1) Matches(current RoleKnowledgeScopeV1, base, withdrawal int64) bool {
	return f.Scope.Validate() == nil && f.Scope == current && f.BaseRevision == base && base >= 0 && f.WithdrawalRevision == withdrawal && withdrawal >= 0 && opaqueID.MatchString(f.CommitID)
}
