package operate

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	agentpolicy "github.com/cloudwego/eino/lake/agent/policy"
	"github.com/cloudwego/eino/lake/store"
	sshtransport "github.com/cloudwego/eino/lake/transport/ssh"
)

// SSHSessionStatus describes a live SSH connection held by this Lake Agent
// process. It contains no credentials or remote command output.
type SSHSessionStatus struct {
	Resource   string    `json:"resource"`
	SSH        string    `json:"ssh"`
	State      string    `json:"state"`
	OpenedAt   time.Time `json:"opened_at"`
	LastUsedAt time.Time `json:"last_used_at"`
}

type sshSession struct {
	connection SSHConnection
	status     SSHSessionStatus
}

func (s *Service) sessionFor(resourceID string) SSHConnection {
	s.sessionMu.Lock()
	defer s.sessionMu.Unlock()
	current := s.sessions[resourceID]
	if current == nil {
		return nil
	}
	if current.connection.IsClosed() {
		delete(s.sessions, resourceID)
		return nil
	}
	return current.connection
}

func (s *Service) touchSession(resourceID string) {
	s.sessionMu.Lock()
	defer s.sessionMu.Unlock()
	if current := s.sessions[resourceID]; current != nil {
		if current.connection.IsClosed() {
			delete(s.sessions, resourceID)
		} else {
			current.status.LastUsedAt = time.Now()
		}
	}
}

// ListSessions reports SSH connections retained by this conversation.
func (s *Service) ListSessions() []SSHSessionStatus {
	s.sessionMu.Lock()
	defer s.sessionMu.Unlock()
	out := make([]SSHSessionStatus, 0, len(s.sessions))
	for id, current := range s.sessions {
		if current.connection.IsClosed() {
			delete(s.sessions, id)
			continue
		}
		out = append(out, current.status)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Resource < out[j].Resource })
	return out
}

// CloseSessions releases every retained connection when Lake Agent exits.
func (s *Service) CloseSessions() {
	s.sessionMu.Lock()
	current := s.sessions
	s.sessions = make(map[string]*sshSession)
	s.sessionMu.Unlock()
	for _, session := range current {
		_ = session.connection.Close()
	}
}

// OpenSession keeps an authenticated SSH connection in the current Agent
// process. Authorization and frozen-anchor checks happen before key access.
func (s *Service) OpenSession(ctx context.Context, resourceName string) (SSHSessionStatus, error) {
	if resourceName == "" || strings.Contains(resourceName, "/") {
		return SSHSessionStatus{}, errors.New("SSH 连接只接受当前湖内的资源名")
	}
	resource, err := s.Store.ResolveResource(ctx, s.Lake.Name+"/"+resourceName)
	if err != nil {
		return SSHSessionStatus{}, fmt.Errorf("查找 SSH 资源: %w", err)
	}
	if resource.Kind != "host" {
		return SSHSessionStatus{}, errors.New("该资源不是 SSH 主机")
	}
	actionID, err := store.NewActionID()
	if err != nil {
		return SSHSessionStatus{}, err
	}
	path := s.Lake.Name + "/" + resource.Name
	log := func(event, detail string) error {
		logCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, err := s.Store.AppendJournal(logCtx, store.JournalInput{
			RunID: s.RunID, ActionID: actionID, Actor: "agent", TargetPath: path,
			Tool: "lake_ssh_session", Risk: "none", Event: event, Detail: detail,
		})
		return err
	}
	if err := log("requested", "open"); err != nil {
		return SSHSessionStatus{}, err
	}
	if _, ok := s.Anchors[resource.ID]; !ok {
		_ = log("denied", "resource_outside_frozen_anchor")
		return SSHSessionStatus{}, errors.New("资源不在本次 Lake Agent 的冻结范围内")
	}
	if !resource.ExecuteAuthz {
		_ = log("denied", "execute_authz=false")
		return SSHSessionStatus{}, fmt.Errorf("资源 %s 尚未开启执行授权；请先运行 lake res authz %s on", path, path)
	}
	if err := agentpolicy.Authorize(ctx, s.sshPolicyInput(actionID, resource.ID, "read", resource.ExecuteAuthz, store.PermissionPolicy{SilentSSHRead: true}), nil); err != nil {
		_ = log("denied", "policy_denied")
		return SSHSessionStatus{}, err
	}
	if existing := s.sessionFor(resource.ID); existing != nil {
		for _, status := range s.ListSessions() {
			if status.Resource == path {
				if err := log("completed", "already_open"); err != nil {
					return SSHSessionStatus{}, err
				}
				return status, nil
			}
		}
	}
	attachments, err := s.Store.ListAttachments(ctx, resource.ID)
	if err != nil {
		_ = log("failed", "read_credential_ref")
		return SSHSessionStatus{}, err
	}
	var ref string
	for _, attachment := range attachments {
		if attachment.Kind == "credential" {
			ref = attachment.Ref
			break
		}
	}
	if ref == "" {
		_ = log("failed", "credential_missing")
		return SSHSessionStatus{}, errors.New("资源未关联 SSH 私钥")
	}
	key, err := s.Keys.Load(ref)
	if err != nil {
		_ = log("failed", "credential_read")
		return SSHSessionStatus{}, fmt.Errorf("读取 SSH 凭据: %w", err)
	}
	defer clearBytes(key)
	if err := log("started", "connect"); err != nil {
		return SSHSessionStatus{}, err
	}
	connection, err := s.Opener(ctx, sshtransport.Target{
		Host: resource.SSH.Host, Port: resource.SSH.Port, Username: resource.SSH.Username,
	}, key)
	if err != nil {
		_ = log("failed", "ssh_connect_error")
		return SSHSessionStatus{}, err
	}
	now := time.Now()
	status := SSHSessionStatus{
		Resource: path,
		SSH:      fmt.Sprintf("%s@%s:%d", resource.SSH.Username, resource.SSH.Host, resource.SSH.Port),
		State:    "connected", OpenedAt: now, LastUsedAt: now,
	}
	s.sessionMu.Lock()
	if existing := s.sessions[resource.ID]; existing != nil && !existing.connection.IsClosed() {
		status = existing.status
		s.sessionMu.Unlock()
		_ = connection.Close()
		if err := log("completed", "already_open"); err != nil {
			return SSHSessionStatus{}, err
		}
		return status, nil
	}
	s.sessions[resource.ID] = &sshSession{connection: connection, status: status}
	s.sessionMu.Unlock()
	if err := log("completed", "connected"); err != nil {
		s.sessionMu.Lock()
		delete(s.sessions, resource.ID)
		s.sessionMu.Unlock()
		_ = connection.Close()
		return SSHSessionStatus{}, err
	}
	return status, nil
}

// CloseSession explicitly disconnects a retained SSH connection.
func (s *Service) CloseSession(ctx context.Context, resourceName string) error {
	if resourceName == "" || strings.Contains(resourceName, "/") {
		return errors.New("SSH 连接只接受当前湖内的资源名")
	}
	resource, err := s.Store.ResolveResource(ctx, s.Lake.Name+"/"+resourceName)
	if err != nil {
		return fmt.Errorf("查找 SSH 资源: %w", err)
	}
	if _, ok := s.Anchors[resource.ID]; !ok {
		return errors.New("资源不在本次 Lake Agent 的冻结范围内")
	}
	actionID, err := store.NewActionID()
	if err != nil {
		return err
	}
	path := s.Lake.Name + "/" + resource.Name
	log := func(event string) error {
		_, err := s.Store.AppendJournal(ctx, store.JournalInput{
			RunID: s.RunID, ActionID: actionID, Actor: "agent", TargetPath: path,
			Tool: "lake_ssh_session", Risk: "none", Event: event, Detail: "close",
		})
		return err
	}
	if err := log("requested"); err != nil {
		return err
	}
	s.sessionMu.Lock()
	current := s.sessions[resource.ID]
	delete(s.sessions, resource.ID)
	s.sessionMu.Unlock()
	if current == nil {
		_ = log("failed")
		return errors.New("该资源没有挂起的 SSH 连接")
	}
	if err := current.connection.Close(); err != nil {
		_ = log("failed")
		return err
	}
	return log("completed")
}
