package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/Clean-Lakes/Lake/internal/agent/storage"
	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/model"
	adksession "google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool/toolconfirmation"
	"google.golang.org/genai"
	"gorm.io/gorm"
)

var errADKApprovalPending = errors.New("ADK confirmation pending")

type adkToolContextKey struct{}
type adkFreshConfirmationKey struct{}
type adkApprovalCallKey struct{}

func resumingNativeApproval(ctx context.Context) bool {
	tc, _ := ctx.Value(adkToolContextKey{}).(agent.Context)
	return tc != nil && tc.ToolConfirmation() != nil && ctx.Value(adkFreshConfirmationKey{}) != true
}

// NativeApproval is the durable server-owned binding. The UI supplies only its
// ID and decision. Neither model arguments nor a resume payload grant access.
type nativeApproval struct {
	ID               string `gorm:"primaryKey"`
	SessionID        string `gorm:"index"`
	RootTurnID       string
	RuntimeSessionID string
	CallID           string
	Fingerprint      string
	PolicyHash       string
	CallHash         string
	PreviewHash      string
	Binding          string
	Status           string
	Accepted         bool
	ConfirmationID   string
	Payload          string
	Author           string
	Branch           string
	ExpiresAt        time.Time
}

// publishFollowupConfirmations covers the public ToolContext re-entry case in
// ADK 2.6: the confirmation request processor yields the tool response but does
// not emit a second confirmation envelope requested by that resumed tool.
// Use public session events to preserve the same protocol; no SDK internals or
// repeated resource execution are involved.
func (e *Engine) publishFollowupConfirmations(ctx context.Context, s *session, service adksession.Service, runtimeID string, event *adksession.Event) error {
	if len(event.Actions.RequestedToolConfirmations) == 0 {
		return nil
	}
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	s.mu.Lock()
	id, turn := s.state.View.Session, s.state.View.RootTurnID
	s.mu.Unlock()
	for callID, confirmation := range event.Actions.RequestedToolConfirmations {
		var pending nativeApproval
		if err = store.DB.Where("session_id = ? AND root_turn_id = ? AND call_id = ? AND status IN ? AND confirmation_id = ?", id, turn, callID, []string{"pending", "decided"}, "").First(&pending).Error; errors.Is(err, gorm.ErrRecordNotFound) {
			continue
		} else if err != nil {
			return err
		}
		var binding Approval
		if err = json.Unmarshal([]byte(pending.Binding), &binding); err != nil {
			return err
		}
		var args map[string]any
		if err = json.Unmarshal([]byte(binding.Call.Arguments), &args); err != nil {
			return err
		}
		call := &genai.FunctionCall{ID: "confirm_" + uid(), Name: toolconfirmation.FunctionCallName, Args: map[string]any{"originalFunctionCall": &genai.FunctionCall{ID: callID, Name: binding.Call.Name, Args: args}, "toolConfirmation": confirmation}}
		next := &adksession.Event{ID: uid(), Timestamp: time.Now(), InvocationID: event.InvocationID, Author: event.Author, Branch: event.Branch, IsolationScope: event.IsolationScope, LongRunningToolIDs: []string{call.ID}, LLMResponse: model.LLMResponse{Content: &genai.Content{Role: "model", Parts: []*genai.Part{{FunctionCall: call}}}}}
		stored, err := service.Get(ctx, &adksession.GetRequest{AppName: "lake", UserID: "lake", SessionID: runtimeID})
		if err != nil {
			return err
		}
		if err = service.AppendEvent(ctx, stored.Session, next); err != nil {
			return err
		}
		if err = e.recordNativeConfirmation(s, call, next.Author, next.Branch); err != nil {
			return err
		}
	}
	return nil
}

func nativePolicyHash(c Config) string {
	return hash(js(struct {
		Mode        string
		Permissions *Permissions
		Scope       *TargetScope
		References  []string
		Assets      []Asset
		Terminal    string
		SRE         *sreRoleContext
	}{c.ConversationMode, c.Permissions, c.targetScope, c.ReferencedAssets, c.Assets, c.TerminalID, c.sre}))
}

func (e *Engine) waitNativeApproval(ctx context.Context, s *session, c Config, p *Approval) (accepted bool, waitErr error) {
	tc, _ := ctx.Value(adkToolContextKey{}).(agent.Context)
	if tc == nil {
		return false, errors.New("ADK tool context required for approval")
	}
	store, err := e.adkStore()
	if err != nil {
		return false, err
	}
	if confirmation := tc.ToolConfirmation(); confirmation != nil && ctx.Value(adkFreshConfirmationKey{}) != true {
		payload := obj(confirmation.Payload)
		id := str(payload["approval_id"])
		defer func() {
			if waitErr != nil {
				store.DB.Model(&nativeApproval{}).Where("id = ? AND status = ?", id, "decided").Update("status", "invalid")
			}
			s.mu.Lock()
			kept := s.state.View.PendingApprovals[:0]
			for _, pending := range s.state.View.PendingApprovals {
				if pending.ID != id {
					kept = append(kept, pending)
				}
			}
			s.state.View.PendingApprovals = kept
			s.state.View.Pending = nil
			if len(kept) > 0 {
				s.state.View.Pending = kept[0]
			}
			delete(s.decisions, id)
			if err := e.saveHumanInputState(s); waitErr == nil && err != nil {
				waitErr = err
			}
			s.mu.Unlock()
		}()
		var record nativeApproval
		if err = store.DB.First(&record, "id = ?", id).Error; err != nil {
			return false, errors.New("approval expired or already decided")
		}
		var original Approval
		if json.Unmarshal([]byte(record.Binding), &original) != nil {
			return false, errors.New("invalid approval binding")
		}
		s.mu.Lock()
		sessionID, turnID := s.state.View.Session, s.state.View.RootTurnID
		s.mu.Unlock()
		// A preceding approved call may bind the target, so current policy no
		// longer requests confirmation. Still settle this exact response once;
		// otherwise its decided card remains at the front of the queue forever.
		// The current policy has already authorized the call in that case, while
		// target, arguments, preview, expiry and single-use checks remain binding.
		policyChanged := p.Kind != "" && record.PolicyHash != nativePolicyHash(c)
		if record.SessionID != sessionID || record.RootTurnID != turnID || record.CallID != p.Call.ID || original.Call.Name != p.Call.Name || record.CallHash != hash(p.Call.Arguments) || record.Fingerprint != p.Fingerprint || original.Target != p.Target || record.PreviewHash != hash(js(p.Preview)) || original.TerminalGeneration != p.TerminalGeneration || original.TerminalVersion != p.TerminalVersion || policyChanged || !time.Now().Before(record.ExpiresAt) {
			return false, errors.New("target or terminal context changed; approval expired")
		}
		if record.Status != "decided" || record.Accepted != confirmation.Confirmed {
			return false, errors.New("approval expired or already decided")
		}
		claimErr := store.DB.Transaction(func(tx *gorm.DB) error {
			claimed := tx.Model(&nativeApproval{}).Where("id = ? AND status = ?", id, "decided").Update("status", "authorized")
			if claimed.Error != nil {
				return claimed.Error
			}
			if claimed.RowsAffected != 1 {
				return errors.New("approval already consumed")
			}
			// Authorization is consumed in the same transaction as dispatched.
			// A crash before that transaction cannot acquire an execution permit.
			return nil
		})
		if claimErr != nil {
			return false, claimErr
		}
		s.mu.Lock()
		kept := s.state.View.PendingApprovals[:0]
		for _, pending := range s.state.View.PendingApprovals {
			if pending.ID != id {
				kept = append(kept, pending)
			}
		}
		s.state.View.PendingApprovals = kept
		s.state.View.Pending = nil
		if len(kept) > 0 {
			s.state.View.Pending = kept[0]
		}
		err = e.saveHumanInputState(s)
		s.mu.Unlock()
		if err != nil {
			return false, err
		}
		if !confirmation.Confirmed {
			return false, errors.New("user rejected this tool call")
		}
		return true, nil
	}
	p.ID = "adk-" + p.ID
	s.mu.Lock()
	record := nativeApproval{ID: p.ID, SessionID: s.state.View.Session, RootTurnID: s.state.View.RootTurnID, CallID: p.Call.ID, Fingerprint: p.Fingerprint, PolicyHash: nativePolicyHash(c), Binding: string(safeJSON([]byte(js(p)), c)), CallHash: hash(p.Call.Arguments), PreviewHash: hash(js(p.Preview)), Status: "pending", ExpiresAt: time.Now().Add(15 * time.Minute)}
	if s.state.Runtime != nil {
		record.RuntimeSessionID = s.state.Runtime.SessionID
	}
	s.mu.Unlock()
	if err = store.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&record).Error; err != nil {
			return err
		}
		return e.appendNativeEvidence(tx, &nativeEvidence{SessionID: record.SessionID, CallID: p.Call.ID, Tool: p.Call.Name, Status: "approval_requested", Data: js(map[string]any{"approval_id": p.ID, "target": p.Target}), At: time.Now()})
	}); err != nil {
		return false, err
	}
	payload := map[string]any{"approval_id": p.ID}
	if err = tc.RequestConfirmation("Confirm "+p.Target, payload); err != nil {
		return false, err
	}
	tc.Actions().SkipSummarization = true
	s.mu.Lock()
	if s.decisions == nil {
		s.decisions = map[string]chan bool{}
	}
	s.decisions[p.ID] = make(chan bool, 1)
	s.state.View.PendingApprovals = append(s.state.View.PendingApprovals, p)
	if s.state.View.Pending == nil {
		s.state.View.Pending = p
	}
	s.state.View.Status = "waiting_approval"
	for i := range s.state.View.Cards {
		if str(obj(s.state.View.Cards[i].Data)["call_id"]) == p.Call.ID {
			s.state.View.Cards[i].Status = "pending"
		}
	}
	err = e.saveHumanInputState(s)
	e.notify(s, "approval", s.state.View.Pending)
	s.mu.Unlock()
	if err != nil {
		return false, err
	}
	return false, errADKApprovalPending
}

func (e *Engine) recordNativeConfirmation(s *session, call *genai.FunctionCall, author, branch string) error {
	if call.Name != toolconfirmation.FunctionCallName {
		return nil
	}
	original, err := toolconfirmation.OriginalCallFrom(call)
	if err != nil {
		return err
	}
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	s.mu.Lock()
	id, turn := s.state.View.Session, s.state.View.RootTurnID
	s.mu.Unlock()
	result := store.DB.Model(&nativeApproval{}).Where("session_id = ? AND root_turn_id = ? AND call_id = ? AND status IN ?", id, turn, original.ID, []string{"pending", "decided"}).Updates(map[string]any{"confirmation_id": call.ID, "payload": js(call.Args["toolConfirmation"]), "author": author, "branch": branch})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return errors.New("confirmation has no persisted approval")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state.Runtime != nil {
		if s.state.Runtime.PendingConfirmations == nil {
			s.state.Runtime.PendingConfirmations = map[string]string{}
		}
		for _, pending := range s.state.View.PendingApprovals {
			if pending.Call.ID == original.ID {
				s.state.Runtime.PendingConfirmations[pending.ID] = call.ID
			}
		}
	}
	return e.save(s)
}

func (e *Engine) settleNativeRejection(s *session, record nativeApproval) error {
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	err = store.DB.Transaction(func(tx *gorm.DB) error {
		result := tx.Model(&nativeApproval{}).Where("id = ? AND status = ? AND accepted = ?", record.ID, "decided", false).Update("status", "consumed")
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return errors.New("approval already consumed")
		}
		var p Approval
		if err := json.Unmarshal([]byte(record.Binding), &p); err != nil {
			return err
		}
		return e.appendNativeEvidence(tx, &nativeEvidence{SessionID: record.SessionID, CallID: record.CallID, Tool: p.Call.Name, Status: "rejected", Data: js(map[string]any{"approval_id": record.ID}), At: time.Now()})
	})
	if err != nil {
		return err
	}
	var binding Approval
	if err = json.Unmarshal([]byte(record.Binding), &binding); err != nil {
		return err
	}
	s.mu.Lock()
	config := s.state.Config
	s.mu.Unlock()
	e.finishSREPreparation(config, binding.Call, errors.New("user rejected this tool call"))
	s.mu.Lock()
	defer s.mu.Unlock()
	kept := s.state.View.PendingApprovals[:0]
	for _, p := range s.state.View.PendingApprovals {
		if p.ID != record.ID {
			kept = append(kept, p)
		}
	}
	s.state.View.PendingApprovals = kept
	s.state.View.Pending = nil
	if len(kept) > 0 {
		s.state.View.Pending = kept[0]
	}
	delete(s.decisions, record.ID)
	for i := range s.state.View.Cards {
		card := &s.state.View.Cards[i]
		if str(obj(card.Data)["call_id"]) == record.CallID {
			card.Status = "failed"
			card.Content = "user rejected this tool call"
		}
	}
	return e.saveHumanInputState(s)
}

func (e *Engine) decideNativeApproval(store *storage.Store, s *session, id string, accept bool, confirmation string) (chan bool, error) {
	p := s.state.View.Pending
	for _, candidate := range s.state.View.PendingApprovals {
		if candidate.ID == id {
			p = candidate
			break
		}
	}
	if p == nil || p.ID != id {
		return nil, errors.New("approval expired or already decided")
	}
	if accept && p.Confirmation != "" && confirmation != p.Confirmation {
		return nil, errors.New("explicit target confirmation required")
	}

	result := store.DB.Model(&nativeApproval{}).Where("id = ? AND session_id = ? AND root_turn_id = ? AND status = ? AND expires_at > ?", id, s.state.View.Session, s.state.View.RootTurnID, "pending", time.Now()).Updates(map[string]any{"status": "decided", "accepted": accept})
	storeErr := result.Error
	if storeErr == nil && result.RowsAffected != 1 {
		storeErr = errors.New("approval expired or already decided")
	}

	if storeErr != nil {
		return nil, fmt.Errorf("decide approval: %w", storeErr)
	}
	return s.decisions[id], nil
}

func (e *Engine) claimNativeApprovals(tx *gorm.DB, scopeID, turnID, callID, operationID string) error {
	var approvals []nativeApproval
	if err := tx.Where("session_id = ? AND root_turn_id = ? AND call_id = ? AND status = ?", scopeID, turnID, callID, "authorized").Find(&approvals).Error; err != nil {
		return err
	}
	for _, p := range approvals {
		result := tx.Model(&nativeApproval{}).Where("id = ? AND status = ? AND accepted = ? AND expires_at > ?", p.ID, "authorized", true, time.Now()).Update("status", "consumed")
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return errors.New("approval expired or already consumed")
		}
		var binding Approval
		if err := json.Unmarshal([]byte(p.Binding), &binding); err != nil {
			return err
		}
		if err := e.appendNativeEvidence(tx, &nativeEvidence{SessionID: p.SessionID, OperationID: operationID, CallID: callID, Tool: binding.Call.Name, Status: "approved", Data: js(map[string]any{"approval_id": p.ID}), At: time.Now()}); err != nil {
			return err
		}
	}
	return nil
}
