package ai

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"google.golang.org/adk/v2/agent"
	adksession "google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool/toolconfirmation"
	"gorm.io/gorm"
)

func grantConfirmationFixture(t *testing.T) (*Engine, Config, Call, *SecurityPreparedOperation, *securityGrantConfirmation) {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "bounded.log")
	if err = os.WriteFile(path, []byte("bounded actual content\n"), 0600); err != nil {
		t.Fatal(err)
	}
	as := Asset{ID: "resource", Kind: "local", Name: "fixture host"}
	e, c := fixedReadManagedFixture(t, as, security.Rule{Capability: "file.read", Effect: security.EffectAsk, Grantable: true, Confirmation: security.ConfirmEither, Limits: security.ScopeLimits{FileRoots: []string{dir}}})
	db, _, _, _ := e.securityTaskDB()
	if err = db.AutoMigrate(securityConfirmationModels()...); err != nil {
		t.Fatal(err)
	}
	policy, err := e.SecurityProjectPolicy(t.Context(), "project")
	if err != nil {
		t.Fatal(err)
	}
	policy.Rules = append(policy.Rules, security.Rule{Capability: "local.execute", Effect: security.EffectAllow})
	if _, err = e.PutSecurityProjectPolicy(t.Context(), SecurityPolicyAction{ActorID: "user", ActionID: "grant-policy", ProjectID: "project", ExpectedRevision: policy.Revision}, policy); err != nil {
		t.Fatal(err)
	}
	call := Call{ID: "read-call", Name: "read", Arguments: js(map[string]any{"asset_ref": assetAlias("resource"), "path": path})}
	a, _ := args(call)
	prepared, decision, err := e.PrepareCatalogOperation(t.Context(), "case", c, call, a)
	if err != nil || prepared == nil || decision.Effect != security.EffectApprovalRequired {
		t.Fatal(decision, err)
	}
	p, err := e.buildSecurityGrantConfirmation(t.Context(), prepared)
	if err != nil || p == nil {
		t.Fatal("no actual grant proposal", err)
	}
	p.SourceMessageID = "original-human-message"
	return e, c, call, prepared, p
}

func storeSelectedGrantProposal(t *testing.T, e *Engine, c Config, prepared *SecurityPreparedOperation, p *securityGrantConfirmation, choice string) nativeApproval {
	t.Helper()
	db, storeID, epoch, _ := e.securityTaskDB()
	op := prepared.descriptor
	question := securityConfirmationQuestionRow{QuestionID: "security-confirm-grant", Kind: "task_grant_proposal", ProjectID: op.ProjectID, SessionID: op.SessionID, RootTurnID: op.RootTurnID, GoalID: op.GoalID, SourceMessageID: p.SourceMessageID, CallID: op.CallID, StoreID: storeID, RecoveryEpoch: epoch, Data: js(p), Answers: js(map[string][]string{"grant_scope": {choice}}), Status: "answered", Revision: 2, CreatedAt: time.Now().UTC(), ExpiresAt: time.Now().Add(14 * time.Minute)}
	if err := db.Create(&question).Error; err != nil {
		t.Fatal(err)
	}
	p.QuestionID, p.QuestionDataDigest, p.Choice = question.QuestionID, hash(question.Data), choice
	preview := e.securityGrantApprovalPreview(c, p)
	record := nativeApproval{ID: "final-grant-approval", EnvelopeException: p.SingleException, GrantProposal: js(p), Binding: js(Approval{ID: "final-grant-approval", Fingerprint: prepared.digest, Preview: preview}), PreviewHash: hash(js(preview)), Status: "decided", Accepted: true, SessionID: op.SessionID, RootTurnID: op.RootTurnID, ScopeID: op.ChildScopeID, CallID: op.CallID, StoreID: storeID, RecoveryEpoch: epoch, SecurityTaskID: op.TaskID, DescriptorDigest: prepared.digest, ExecutionRevision: op.ExecutionRevision, CreatedAt: time.Now().UTC(), ExpiresAt: time.Now().Add(10 * time.Minute)}
	if err := db.Create(&record).Error; err != nil {
		t.Fatal(err)
	}
	return record
}

func TestSecurityTaskGrantProposalHasNoAuthorityUntilExactFinalApprovalClaim(t *testing.T) {
	e, c, call, prepared, p := grantConfirmationFixture(t)
	db, _, _, _ := e.securityTaskDB()
	var count int64
	db.Model(&securityTaskGrantRow{}).Count(&count)
	if count != 0 {
		t.Fatal("preview issued authority")
	}
	record := storeSelectedGrantProposal(t, e, c, prepared, p, securityGrantTaskChoice)
	db.Model(&securityTaskGrantRow{}).Count(&count)
	if count != 0 {
		t.Fatal("question answer issued authority")
	}
	if !strings.Contains(str(e.securityGrantApprovalPreview(c, p)["after"]), "10") || !strings.Contains(str(e.securityGrantApprovalPreview(c, p)["after"]), "绝对到期") {
		t.Fatal("final scope not visible")
	}
	err := e.workMutation(db, func(tx *gorm.DB) error {
		return e.claimSecurityTaskGrantApprovalTx(t.Context(), tx, record, prepared, time.Now().UTC())
	})
	if err != nil {
		t.Fatal(err)
	}
	var approval nativeApproval
	db.First(&approval, "id = ?", record.ID)
	if approval.Status != "consumed" {
		t.Fatal("grant reused single operation authority", approval.Status)
	}
	var question securityConfirmationQuestionRow
	db.First(&question, "question_id = ?", p.QuestionID)
	if question.Status != "grant_confirmed" {
		t.Fatal(question.Status)
	}
	// The old descriptor has no new envelope/grant binding and cannot dispatch.
	oldCtx := SecurityOperationContext(t.Context(), prepared)
	s, _ := e.get("case")
	if _, err = e.dispatchNativeOperation(oldCtx, s, prepared.executionConfig, call, "readonly", "fixture host", prepared.digest); err == nil {
		t.Fatal("stale prepared operation dispatched")
	}
	a, _ := args(call)
	fresh, decision, err := e.PrepareCatalogOperation(t.Context(), "case", c, call, a)
	if err != nil || fresh == nil || decision.Effect != security.EffectAllow || fresh.digest == prepared.digest {
		t.Fatal("grant did not require fresh preparation", decision, err)
	}
	ctx := SecurityOperationContext(t.Context(), fresh)
	operation, err := e.dispatchNativeOperation(ctx, s, fresh.executionConfig, call, "readonly", "fixture host", fresh.digest)
	if err != nil {
		t.Fatal(err)
	}
	var grant securityTaskGrantRow
	if err = db.First(&grant, "task_id = ?", fresh.descriptor.TaskID).Error; err != nil || grant.RemainingUses != 9 {
		t.Fatal("grant/envelope budget not consumed exactly once", grant.RemainingUses, err)
	}
	result, err := e.executeSecurityLocalFile(securityPermitContext(ctx, operation.permit), fresh.executionConfig, "read", fresh.executionArgs)
	if err != nil || !strings.Contains(js(result), "bounded actual content") {
		t.Fatal(result, err)
	}
	if err = e.finishNativeOperation(operation, c, result, err); err != nil {
		t.Fatal(err)
	}
	if err = e.workMutation(db, func(tx *gorm.DB) error {
		return e.claimSecurityTaskGrantApprovalTx(t.Context(), tx, record, prepared, time.Now().UTC())
	}); err == nil {
		t.Fatal("final grant approval replayed")
	}
}
func TestSecurityTaskGrantFinalClaimRollsBackAndRejectsHiddenOrStaleScope(t *testing.T) {
	for _, change := range []string{"rollback", "hidden-preview", "changed-task", "changed-scope", "unselected"} {
		t.Run(change, func(t *testing.T) {
			e, c, _, prepared, p := grantConfirmationFixture(t)
			db, _, _, _ := e.securityTaskDB()
			record := storeSelectedGrantProposal(t, e, c, prepared, p, securityGrantTaskChoice)
			switch change {
			case "hidden-preview":
				db.Model(&nativeApproval{}).Where("id = ?", record.ID).Updates(map[string]any{"binding": js(Approval{Preview: map[string]any{"after": "single operation"}}), "preview_hash": hash(js(map[string]any{"after": "single operation"}))})
			case "changed-task":
				db.Model(&securityTaskRow{}).Where("id = ?", prepared.descriptor.TaskID).Update("state_revision", gorm.Expr("state_revision+1"))
			case "changed-scope":
				p.Issue.Grant.RemainingUses = 100
				record.GrantProposal = js(p)
			case "unselected":
				db.Model(&securityConfirmationQuestionRow{}).Where("question_id = ?", p.QuestionID).Update("answers", js(map[string][]string{"grant_scope": {securityGrantOnceChoice}}))
			}
			err := e.workMutation(db, func(tx *gorm.DB) error {
				if err := e.claimSecurityTaskGrantApprovalTx(t.Context(), tx, record, prepared, time.Now().UTC()); err != nil {
					return err
				}
				return errors.New("forced final transaction failure")
			})
			if err == nil {
				t.Fatal("invalid final claim passed")
			}
			var count int64
			db.Model(&securityTaskGrantRow{}).Count(&count)
			if count != 0 {
				t.Fatal("failed claim leaked grant")
			}
			db.Model(&securityTaskEnvelopeRow{}).Count(&count)
			if count != 0 {
				t.Fatal("failed claim leaked envelope")
			}
		})
	}
}
func TestSecurityGrantOnceChoiceAndScopeDigestDoNotBroadenAuthority(t *testing.T) {
	e, _, _, prepared, p := grantConfirmationFixture(t)
	if selected, err := e.selectSecurityGrantChoice(context.Background(), p, map[string][]string{"grant_scope": {securityGrantOnceChoice}}); err != nil || selected != nil {
		t.Fatal("ordinary once became task grant", selected, err)
	}
	p.OnceRequiresGrant = true
	selected, err := e.selectSecurityGrantChoice(t.Context(), p, map[string][]string{"grant_scope": {securityGrantOnceChoice}})
	if err != nil || !selected.SingleException {
		t.Fatal(selected, err)
	}
	p.SingleException = false
	p.TaskOnly = true
	selected, err = e.selectSecurityGrantChoice(t.Context(), p, map[string][]string{"grant_scope": {securityGrantOnceChoice}})
	if err != nil || selected.SingleException || selected.Issue.Grant.RemainingUses != 1 {
		t.Fatal("task-only policy did not bind explicit one-use grant", selected, err)
	}
	original := securityGrantScopeDigest(prepared.descriptor)
	copy := prepared.descriptor
	copy.ID = "new-id"
	copy.CallID = "new-call"
	if securityGrantScopeDigest(copy) != original {
		t.Fatal("fresh call cannot review same proposal")
	}
	copy.ArgumentsDigest = hash("different actual arguments")
	if securityGrantScopeDigest(copy) == original {
		t.Fatal("proposal matched unreviewed arguments")
	}
	var round securityGrantConfirmation
	raw, _ := json.Marshal(selected)
	if json.Unmarshal(raw, &round) != nil || round.Issue.Grant.RemainingUses != 1 {
		t.Fatal("lost explicit once budget")
	}
}

func TestSecurityTaskBudgetExtraOnceConsumesOriginalApprovalWithoutRefill(t *testing.T) {
	e, c, call, prepared, p := grantConfirmationFixture(t)
	db, _, _, _ := e.securityTaskDB()
	in := *p.Issue
	in.Grant.RemainingUses = 1
	issued, err := e.IssueSecurityTaskGrant(t.Context(), in)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Model(&securityTaskGrantRow{}).Where("id = ?", issued.ID).Update("remaining_uses", 0).Error; err != nil {
		t.Fatal(err)
	}
	call.ID = "extra-once"
	a, _ := args(call)
	prepared, decision, err := e.PrepareCatalogOperation(t.Context(), "case", c, call, a)
	if err != nil || decision.Effect != security.EffectApprovalRequired {
		t.Fatal(decision, err)
	}
	p, err = e.buildSecurityGrantConfirmation(t.Context(), prepared)
	if err != nil || p == nil {
		t.Fatal(p, err)
	}
	p.SourceMessageID = "original-human-message"
	p, err = e.selectSecurityGrantChoice(t.Context(), p, map[string][]string{"grant_scope": {securityGrantOnceChoice}})
	if err != nil || p == nil || !p.SingleException {
		t.Fatal(p, err)
	}
	record := storeSelectedGrantProposal(t, e, c, prepared, p, securityGrantOnceChoice)
	if err = e.workMutation(db, func(tx *gorm.DB) error {
		return e.claimSecurityTaskGrantApprovalTx(t.Context(), tx, record, prepared, time.Now().UTC())
	}); err != nil {
		t.Fatal(err)
	}
	var count int64
	db.Model(&securityTaskGrantRow{}).Count(&count)
	if count != 1 {
		t.Fatal("extra once created grant", count)
	}
	fresh, decision, err := e.PrepareCatalogOperation(t.Context(), "case", c, call, a)
	if err != nil || decision.Effect != security.EffectAllow {
		t.Fatal("exact single budget exception still loops", decision, err)
	}
	ctx := SecurityOperationContext(t.Context(), fresh)
	s, _ := e.get("case")
	operation, err := e.dispatchNativeOperation(ctx, s, fresh.executionConfig, call, "readonly", "fixture host", fresh.digest)
	if err != nil {
		t.Fatal(err)
	}
	var grant securityTaskGrantRow
	db.First(&grant, "id = ?", issued.ID)
	if grant.RemainingUses != 0 || grant.Revision != issued.Revision {
		t.Fatal("single exception refilled original budget", grant)
	}
	var approval nativeApproval
	db.First(&approval, "id = ?", record.ID)
	if approval.Status != "consumed" {
		t.Fatal("single extra approval not consumed", approval.Status)
	}
	result, readErr := e.executeSecurityLocalFile(securityPermitContext(ctx, operation.permit), fresh.executionConfig, "read", fresh.executionArgs)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if err = e.finishNativeOperation(operation, c, result, readErr); err != nil {
		t.Fatal(err)
	}
	call.ID = "unapproved-followup"
	_, decision, err = e.PrepareCatalogOperation(t.Context(), "case", c, call, a)
	if err != nil || decision.Effect == security.EffectAllow {
		t.Fatal("single exception leaked to next call", decision, err)
	}
}

// This uses the actual question/decision/native approval application APIs. The
// ADK context only records its confirmation envelope; no provider or I/O is
// mocked into granting authority.
type securityGrantADKContext struct {
	agent.Context
	confirmation *toolconfirmation.ToolConfirmation
	actions      adksession.EventActions
	requested    map[string]any
}

func (c *securityGrantADKContext) ToolConfirmation() *toolconfirmation.ToolConfirmation {
	return c.confirmation
}
func (c *securityGrantADKContext) RequestConfirmation(_ string, payload any) error {
	c.requested = obj(payload)
	return nil
}
func (c *securityGrantADKContext) Actions() *adksession.EventActions { return &c.actions }

func TestSecurityGrantActualQuestionThenOriginalNativeDecision(t *testing.T) {
	e, c, call, prepared, _ := grantConfirmationFixture(t)
	s, _ := e.get("case")
	s.mu.Lock()
	s.state.Config = c
	s.state.SecurityManaged = true
	s.state.SecuritySourceMessageID = "actual-human-source"
	s.state.SecurityTaskID = prepared.descriptor.TaskID
	s.mu.Unlock()
	questions := make(chan string, 1)
	e.Emit = func(event Event) {
		if event.Type == "question" {
			if request, ok := event.Data.(*QuestionRequest); ok && request != nil {
				questions <- request.ID
			}
		}
	}
	type result struct {
		proposal *securityGrantConfirmation
		err      error
	}
	done := make(chan result, 1)
	go func() {
		p, err := e.prepareSecurityGrantConfirmation(t.Context(), s, c, call, prepared)
		done <- result{p, err}
	}()
	var questionID string
	select {
	case questionID = <-questions:
	case value := <-done:
		t.Fatal("question not shown", value.err)
	case <-time.After(4 * time.Second):
		t.Fatal("question not presented")
	}
	db, _, _, _ := e.securityTaskDB()
	var count int64
	db.Model(&securityTaskGrantRow{}).Count(&count)
	if count != 0 {
		t.Fatal("pending question granted authority")
	}
	if err := e.ReplyQuestion("case", questionID, map[string][]string{"grant_scope": {securityGrantTaskChoice}}); err != nil {
		t.Fatal(err)
	}
	var p *securityGrantConfirmation
	select {
	case value := <-done:
		if value.err != nil || value.proposal == nil {
			t.Fatal(value.err)
		}
		p = value.proposal
	case <-time.After(4 * time.Second):
		t.Fatal("question did not resume")
	}
	db.Model(&securityTaskGrantRow{}).Count(&count)
	if count != 0 {
		t.Fatal("question answer signed a grant")
	}
	tc := &securityGrantADKContext{}
	ctx := withSecurityGrantConfirmation(SecurityOperationContext(t.Context(), prepared), p)
	ctx = context.WithValue(ctx, adkToolContextKey{}, tc)
	approval := &Approval{ID: "live-final", Call: call, Kind: "operation", Target: "fixture host", Risk: "readonly", Fingerprint: prepared.digest, Preview: e.securityGrantApprovalPreview(c, p)}
	if _, err := e.waitNativeApproval(ctx, s, c, approval); !errors.Is(err, errADKApprovalPending) {
		t.Fatal("missing original final approval", err)
	}
	approvalID := str(tc.requested["approval_id"])
	if approvalID == "" {
		t.Fatal("ADK confirmation has no original approval ID")
	}
	db.Model(&securityTaskGrantRow{}).Count(&count)
	if count != 0 {
		t.Fatal("pending final approval signed a grant")
	}
	if err := e.Decision("case", approvalID, true, ""); err != nil {
		t.Fatal(err)
	}
	db.Model(&securityTaskGrantRow{}).Count(&count)
	if count != 0 {
		t.Fatal("decided but unclaimed approval signed a grant")
	}
	tc.confirmation = &toolconfirmation.ToolConfirmation{Confirmed: true, Payload: map[string]any{"approval_id": approvalID}}
	accepted, err := e.waitNativeApproval(ctx, s, c, &Approval{ID: "resume", Call: call, Kind: "operation", Target: "fixture host", Risk: "readonly", Fingerprint: prepared.digest, Preview: e.securityGrantApprovalPreview(c, p)})
	if err != nil || !accepted {
		t.Fatal("actual final native approval could not claim task grant", accepted, err)
	}
	db.Model(&securityTaskGrantRow{}).Count(&count)
	if count != 1 {
		t.Fatal("final claim did not sign exactly one grant", count)
	}
	db.Model(&nativeOperation{}).Count(&count)
	if count != 0 {
		t.Fatal("approval claim executed operation without re-preparing")
	}
	a, _ := args(call)
	fresh, decision, err := e.PrepareCatalogOperation(t.Context(), "case", c, call, a)
	if err != nil || fresh == nil || decision.Effect != security.EffectAllow || fresh.digest == prepared.digest {
		t.Fatal("fresh grant-bound operation not available", decision, err)
	}
}

func TestSecurityGrantBridgeExpansionPreservesUsedBudgetAndAbsoluteExpiry(t *testing.T) {
	e, c, call, prepared, p := grantConfirmationFixture(t)
	db, _, _, _ := e.securityTaskDB()
	issued, err := e.IssueSecurityTaskGrant(t.Context(), *p.Issue)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Model(&securityTaskGrantRow{}).Where("id = ?", issued.ID).Update("remaining_uses", 7).Error; err != nil {
		t.Fatal(err)
	}
	a, _ := args(call)
	second := filepath.Join(filepath.Dir(str(a["path"])), "second.log")
	if err = os.WriteFile(second, []byte("second bounded file\n"), 0600); err != nil {
		t.Fatal(err)
	}
	a["path"] = second
	call.ID = "expanded-read"
	call.Arguments = js(a)
	prepared, decision, err := e.PrepareCatalogOperation(t.Context(), "case", c, call, a)
	if err != nil || decision.ReasonCode != security.ReasonTaskScopeExtensionRequired {
		t.Fatal(decision, err)
	}
	p, err = e.buildSecurityGrantConfirmation(t.Context(), prepared)
	if err != nil || p == nil || p.Expansion == nil || p.Change == nil {
		t.Fatal("no explicit scope diff", p, err)
	}
	if p.Change.BeforeGrant.RemainingUses != 7 || p.Change.AfterGrant.RemainingUses != 17 || !p.Change.AfterGrant.ExpiresAt.Equal(issued.ExpiresAt) {
		t.Fatal("preview reset budget or expiry", p.Change)
	}
	p.SourceMessageID = "original-human-message"
	record := storeSelectedGrantProposal(t, e, c, prepared, p, securityGrantTaskChoice)
	if err = e.workMutation(db, func(tx *gorm.DB) error {
		return e.claimSecurityTaskGrantApprovalTx(t.Context(), tx, record, prepared, time.Now().UTC())
	}); err != nil {
		t.Fatal(err)
	}
	var after securityTaskGrantRow
	if err = db.First(&after, "id = ?", issued.ID).Error; err != nil || after.RemainingUses != 17 || after.Revision != 2 || !after.ExpiresAt.Equal(issued.ExpiresAt) {
		t.Fatal("expansion reset or lost original budget", after, err)
	}
	var envelope securityTaskEnvelopeRow
	if err = db.First(&envelope, "task_id = ?", issued.TaskID).Error; err != nil || envelope.Revision != 2 {
		t.Fatal(envelope, err)
	}
	_, decision, err = e.PrepareCatalogOperation(t.Context(), "case", c, call, a)
	if err != nil || decision.Effect != security.EffectAllow {
		t.Fatal("expanded exact scope still unavailable", decision, err)
	}
}

func TestSecurityGrantInvokeQuestionNativeDecisionAndFreshIO(t *testing.T) {
	e, c, call, _, _ := grantConfirmationFixture(t)
	s, _ := e.get("case")
	s.mu.Lock()
	s.state.Config = c
	s.state.SecurityManaged = true
	s.state.SecuritySourceMessageID = "actual-human-source"
	s.mu.Unlock()
	questions := make(chan string, 1)
	e.Emit = func(event Event) {
		if event.Type == "question" {
			if request, ok := event.Data.(*QuestionRequest); ok && request != nil {
				questions <- request.ID
			}
		}
	}
	tc := &securityGrantADKContext{}
	ctx := context.WithValue(t.Context(), adkToolContextKey{}, tc)
	done := make(chan error, 1)
	go func() { _, err := e.invoke(ctx, s, c, call); done <- err }()
	var questionID string
	select {
	case questionID = <-questions:
	case err := <-done:
		t.Fatal("invoke did not ask scope", err)
	case <-time.After(5 * time.Second):
		t.Fatal("missing invoke scope question")
	}
	if err := e.ReplyQuestion("case", questionID, map[string][]string{"grant_scope": {securityGrantTaskChoice}}); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if !errors.Is(err, errADKApprovalPending) {
			t.Fatal("invoke did not publish original native approval", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("invoke did not yield for original approval")
	}
	approvalID := str(tc.requested["approval_id"])
	db, _, _, _ := e.securityTaskDB()
	var count int64
	db.Model(&nativeOperation{}).Count(&count)
	if count != 0 {
		t.Fatal("invoke executed before final approval")
	}
	db.Model(&securityTaskGrantRow{}).Count(&count)
	if count != 0 {
		t.Fatal("invoke question prematurely signed grant")
	}
	if err := e.Decision("case", approvalID, true, ""); err != nil {
		t.Fatal(err)
	}
	tc.confirmation = &toolconfirmation.ToolConfirmation{Confirmed: true, Payload: map[string]any{"approval_id": approvalID}}
	value, err := e.invoke(ctx, s, c, call)
	if err != nil || !strings.Contains(js(value), "bounded actual content") {
		t.Fatal("managed invoke did not freshly authorize real I/O", value, err)
	}
	// A replay of the already-claimed SDK confirmation cannot ask a new scope
	// question, refill the task, or execute the same original call again.
	if _, replayErr := e.invoke(ctx, s, c, call); replayErr == nil {
		t.Fatal("consumed SDK confirmation replayed")
	}

	var operations []nativeOperation
	if err = db.Find(&operations).Error; err != nil || len(operations) != 1 || operations[0].Status != "succeeded" {
		t.Fatal("invoke did not preserve original operation ledger", operations, err)
	}
	var grant securityTaskGrantRow
	if err = db.First(&grant).Error; err != nil || grant.RemainingUses != 9 {
		t.Fatal("invoke did not consume finite grant once", grant, err)
	}
	var approval nativeApproval
	if err = db.First(&approval, "id = ?", approvalID).Error; err != nil || approval.Status != "consumed" {
		t.Fatal("original native approval not consumed", approval, err)
	}
}
