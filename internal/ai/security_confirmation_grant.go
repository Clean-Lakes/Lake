package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"slices"
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"google.golang.org/adk/v2/agent"
	"gorm.io/gorm"
)

const securityGrantOnceChoice = "仅本次操作"
const securityGrantTaskChoice = "本任务范围内自动执行"

type securityGrantConfirmation struct {
	QuestionID, QuestionDataDigest, ScopeDigest, DescriptorDigest string
	TaskRevision, PolicyRevision, EnvelopeRevision                int64
	SourceMessageID                                               string
	Choice                                                        string
	OnceRequiresGrant                                             bool
	TaskOnly                                                      bool
	SingleException                                               bool
	RequestedScope                                                security.TaskGrant
	ServiceTargets                                                []security.ServiceDefinition
	RequestedCommand                                              []string
	CommandDirectory                                              string
	Issue                                                         *SecurityTaskGrantAction
	Expansion                                                     *SecurityTaskGrantExpansion
	Change                                                        *SecurityTaskGrantChange
}
type securityGrantConfirmationKey struct{}

func withSecurityGrantConfirmation(ctx context.Context, p *securityGrantConfirmation) context.Context {
	return context.WithValue(ctx, securityGrantConfirmationKey{}, p)
}

func securityGrantScopeDigest(op security.PreparedOperation) string {
	op.ID, op.CallID = "", ""
	// ArgumentsDigest binds the actual effects; retain it independently while
	// excluding per-call identity so a recovered proposal can be reviewed again
	// on a fresh exact native approval, never used as execution authority.
	return hash(js(struct{ Operation security.PreparedOperation }{op}))
}

func securityGrantLimits(op security.PreparedOperation) security.ScopeLimits {
	s := op.Scope
	l := security.ScopeLimits{DatabaseID: s.DatabaseID, MaxRows: s.MaxRows, MaxDurationMS: s.MaxDurationMS, ClusterID: s.ClusterID, MaxLogLines: s.LogLines, MaxLogSeconds: s.LogSeconds}
	if s.FilePath != "" {
		l.FileRoots = []string{s.FilePath}
	}
	if s.Schema != "" {
		l.Schemas = []string{s.Schema}
	}
	if s.Namespace != "" {
		l.Namespaces = []string{s.Namespace}
	}
	if s.ResourceKind != "" {
		l.ResourceKinds = []string{s.ResourceKind}
	}
	if s.Verb != "" {
		l.Verbs = []string{s.Verb}
	}
	if s.NetworkHost != "" {
		target := security.NetworkLimit{Scheme: s.NetworkScheme, Host: s.NetworkHost, Port: s.NetworkPort}
		for _, raw := range s.ResolvedAddresses {
			if ip, err := netip.ParseAddr(raw); err == nil {
				target.AddressCIDRs = append(target.AddressCIDRs, netip.PrefixFrom(ip, ip.BitLen()).String())
			}
		}
		l.NetworkTargets = []security.NetworkLimit{target}
	}
	return l
}

func mergeGrantLimits(before, add security.ScopeLimits) (security.ScopeLimits, bool) {
	if before.DatabaseID != "" && add.DatabaseID != "" && before.DatabaseID != add.DatabaseID || before.ClusterID != "" && add.ClusterID != "" && before.ClusterID != add.ClusterID {
		return before, false
	}
	union := func(a, b []string) []string {
		a = slices.Clone(a)
		for _, v := range b {
			if !slices.Contains(a, v) {
				a = append(a, v)
			}
		}
		return a
	}
	before.FileRoots = union(before.FileRoots, add.FileRoots)
	before.Schemas = union(before.Schemas, add.Schemas)
	before.Namespaces = union(before.Namespaces, add.Namespaces)
	before.ResourceKinds = union(before.ResourceKinds, add.ResourceKinds)
	before.Verbs = union(before.Verbs, add.Verbs)
	if before.DatabaseID == "" {
		before.DatabaseID = add.DatabaseID
	}
	if before.ClusterID == "" {
		before.ClusterID = add.ClusterID
	}
	before.MaxRows = max(before.MaxRows, add.MaxRows)
	before.MaxDurationMS = max(before.MaxDurationMS, add.MaxDurationMS)
	before.MaxLogLines = max(before.MaxLogLines, add.MaxLogLines)
	before.MaxLogSeconds = max(before.MaxLogSeconds, add.MaxLogSeconds)
	for _, target := range add.NetworkTargets {
		if !slices.ContainsFunc(before.NetworkTargets, func(t security.NetworkLimit) bool { return js(t) == js(target) }) {
			before.NetworkTargets = append(before.NetworkTargets, target)
		}
	}
	return before, true
}

func (e *Engine) buildSecurityGrantConfirmation(ctx context.Context, prepared *SecurityPreparedOperation) (out *securityGrantConfirmation, err error) {
	if prepared == nil || prepared.descriptor.Proof == security.ProofOpaque || prepared.descriptor.RequireSingleConfirmation || security.PureTaskControl(prepared.descriptor) || prepared.descriptor.Actor == "child" {
		return nil, nil
	}
	op := prepared.descriptor
	for _, cap := range op.Capabilities {
		if !security.TaskGrantable(cap, op.Proof) {
			return nil, nil
		}
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return nil, err
	}
	// A rollback-only validation exercises the same grant/envelope/policy checks
	// used by the eventual approval transaction. It creates no authority.
	rollback := errors.New("security: preview rollback")
	needsScopeChange := false
	err = e.withSecurityDispatchBarrier(func() error {
		return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			bound, err := e.bindCurrentCatalogSnapshot(ctx, tx, op)
			if err != nil {
				return err
			}
			input, err := loadSecurityEvaluation(bound, op, prepared.owner, time.Now().UTC())
			if err != nil {
				return err
			}

			currentDecision := security.Evaluate(input)
			if currentDecision.Effect == security.EffectDeny {
				return rollback
			}
			needsScopeChange = currentDecision.ReasonCode == security.ReasonTaskScopeExtensionRequired

			resourceIDs := securityCatalogResources(op.Resources)
			if len(resourceIDs) == 0 {
				resourceIDs = []string{""}
			}
			for _, cap := range op.Capabilities {
				for _, resourceID := range resourceIDs {
					if rule, ok := security.ResolveCapabilityRule(input.Policy.Rules, cap, resourceID); ok && rule.Effect == security.EffectAsk && rule.Confirmation == security.ConfirmTask && !rule.Grantable {
						return errors.New("security: 项目策略要求任务授权但未允许该能力取得任务授权，需要先明确修正项目策略")
					}
				}
			}

			now := time.Now().UTC()
			expiry := minTime(now.Add(15*time.Minute), input.Task.ExpiresAt)
			if !expiry.After(now.Add(time.Second)) {
				return rollback
			}
			action := SecurityTaskAction{ActorID: "local-user", ActionID: "native-task-grant:" + uid(), ProjectID: op.ProjectID, SessionID: op.SessionID, GoalID: op.GoalID, TaskID: op.TaskID, ExpectedRevision: input.Task.StateRevision}
			grant := security.TaskGrant{Resources: slices.Clone(op.Resources), Capabilities: slices.Clone(op.Capabilities), Limits: securityGrantLimits(op), RemainingUses: 10, ExpiresAt: expiry}
			if op.CommandProfileID != "" {
				grant.RemainingUses = security.DefaultDiagnosticUses
				if op.CommandProfileID == "service_restart" {
					grant.RemainingUses = security.DefaultRestartUses
				}
				grant.CommandProfiles = []security.CommandProfileScope{{ID: op.CommandProfileID, Version: op.CommandProfileVersion, ArgumentsDigest: op.CommandArgumentsDigest}}
			}
			if op.ServiceID != "" {
				grant.ServiceIDs = []string{op.ServiceID}
			}
			if err = freezeSecurityGrantCommandTargets(tx, storeID, epoch, op.ProjectID, &grant, false); err != nil {
				return rollback
			}
			out = &securityGrantConfirmation{RequestedScope: grant, OnceRequiresGrant: input.Envelope != nil, ScopeDigest: securityGrantScopeDigest(op), DescriptorDigest: prepared.digest, TaskRevision: input.Task.StateRevision, PolicyRevision: op.PolicyRevision, EnvelopeRevision: op.EnvelopeRevision}

			frozenCommand := prepared.command
			if frozenCommand == nil && prepared.read != nil {
				frozenCommand = prepared.read.command
			}
			if frozenCommand != nil {
				out.RequestedCommand = append([]string{frozenCommand.Executable()}, frozenCommand.Arguments()...)
				out.CommandDirectory = frozenCommand.Directory()
			}
			for _, cap := range op.Capabilities {
				for _, resource := range append(securityCatalogResources(op.Resources), "") {
					if rule, ok := security.ResolveCapabilityRule(input.Policy.Rules, cap, resource); ok && rule.Effect == security.EffectAsk && rule.Confirmation == security.ConfirmTask {
						out.OnceRequiresGrant = true
						out.TaskOnly = true
					}
				}
			}
			if input.Envelope == nil || security.GrantWithinEnvelope(grant, *input.Envelope) {
				in := SecurityTaskGrantAction{Action: action, Grant: grant, BackgroundPolicy: "foreground_only"}
				if input.Envelope != nil {
					in.BackgroundPolicy = input.Envelope.BackgroundPolicy
				}
				if _, err = issueSecurityTaskGrant(tx, storeID, epoch, in, now); err != nil {
					out = nil
					return rollback
				}
				out.Issue = &in
			} else {
				envelope := input.Envelope
				var selected *security.TaskGrant
				for i := range input.Grants {
					g := &input.Grants[i]
					if !g.Revoked && now.Before(g.ExpiresAt) && slices.Contains(envelope.BudgetGrantIDs, g.ID) {
						selected = g
						break
					}
				}
				if selected == nil {
					out = nil
					return rollback
				}
				desired := *selected
				desired.Resources = slices.Clone(envelope.Resources)
				desired.Capabilities = slices.Clone(envelope.Capabilities)
				desired.CommandProfiles = slices.Clone(envelope.CommandProfiles)
				desired.ServiceIDs = slices.Clone(envelope.ServiceIDs)
				for _, r := range grant.Resources {
					if !slices.ContainsFunc(desired.Resources, func(old security.ResourceRevision) bool { return old.ID == r.ID }) {
						desired.Resources = append(desired.Resources, r)
					}
				}
				for _, cap := range grant.Capabilities {
					if !slices.Contains(desired.Capabilities, cap) {
						desired.Capabilities = append(desired.Capabilities, cap)
					}
				}
				for _, profile := range grant.CommandProfiles {
					if !slices.Contains(desired.CommandProfiles, profile) {
						desired.CommandProfiles = append(desired.CommandProfiles, profile)
					}
				}
				for _, service := range grant.ServiceIDs {
					if !slices.Contains(desired.ServiceIDs, service) {
						desired.ServiceIDs = append(desired.ServiceIDs, service)
					}
				}
				var ok bool
				desired.Limits, ok = mergeGrantLimits(envelope.Limits, grant.Limits)
				if !ok {
					out = nil
					return rollback
				}
				in := SecurityTaskGrantExpansion{Action: action, GrantID: selected.ID, ExpectedGrantRevision: selected.Revision, ExpectedEnvelopeRevision: envelope.Revision, DesiredScope: desired, AdditionalUses: 10, BackgroundPolicy: envelope.BackgroundPolicy}
				change, err := previewSecurityTaskGrantExpansion(tx, storeID, epoch, in, now)
				if err != nil {
					out = nil
					return rollback
				}
				in.ConfirmedChangeDigest = change.Digest
				out.Expansion = &in
				out.Change = &change
			}

			shown := out.RequestedScope
			if out.Change != nil {
				shown = out.Change.AfterGrant
			}
			for _, resource := range shown.Resources {
				if len(shown.ServiceIDs) == 0 {
					break
				}
				target, loadErr := loadSecurityCommandTarget(tx, op.ProjectID, resource.ID, storeID, epoch)
				if loadErr != nil {
					out = nil
					return rollback
				}
				for _, service := range target.Services {
					if slices.Contains(shown.ServiceIDs, service.ID) {
						out.ServiceTargets = append(out.ServiceTargets, service)
					}
				}
			}
			return rollback
		})
	})
	if errors.Is(err, rollback) {
		if out == nil && needsScopeChange {
			return nil, errors.New("security: 当前任务范围或额度需要显式调整，无法生成有效授权预览；请先明确确认扩大的任务范围、追加次数和绝对到期时间")
		}
		return out, nil
	}
	return nil, err
}
func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

func (e *Engine) prepareSecurityGrantConfirmation(ctx context.Context, s *session, c Config, call Call, prepared *SecurityPreparedOperation) (*securityGrantConfirmation, error) {
	if e.worker != nil || e.workParent != nil || prepared == nil || prepared.descriptor.Actor == "child" {
		return nil, nil
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return nil, err
	}

	op := prepared.descriptor
	if resumingNativeApproval(ctx) {
		tc, _ := ctx.Value(adkToolContextKey{}).(agent.Context)
		var original nativeApproval
		id := str(obj(tc.ToolConfirmation().Payload)["approval_id"])
		if readErr := db.WithContext(ctx).First(&original, "id = ?", id).Error; readErr != nil {
			return nil, readErr
		}
		if original.GrantProposal != "" {
			if original.Status != "decided" || original.DescriptorDigest != prepared.digest || original.SessionID != op.SessionID || original.RootTurnID != op.RootTurnID || original.CallID != op.CallID || original.SecurityTaskID != op.TaskID || original.ScopeID != op.ChildScopeID {
				return nil, errors.New("security: original task approval changed or was already applied; inspect current task before a fresh operation")
			}
			var exact securityGrantConfirmation
			if decodeSecurityJSON(original.GrantProposal, &exact) != nil {
				return nil, security.ErrConflict
			}
			return &exact, nil
		}
	}
	scopeDigest := securityGrantScopeDigest(op)
	var rows []securityConfirmationQuestionRow
	if err = db.WithContext(ctx).Where("kind = ? AND store_id = ? AND recovery_epoch = ? AND project_id = ? AND session_id = ? AND root_turn_id = ? AND goal_id = ? AND expires_at > ?", "task_grant_proposal", storeID, epoch, op.ProjectID, op.SessionID, op.RootTurnID, op.GoalID, time.Now().UTC()).Order("created_at DESC").Find(&rows).Error; err != nil {
		return nil, err
	}
	for _, row := range rows {
		var p securityGrantConfirmation
		if decodeSecurityJSON(row.Data, &p) != nil || p.ScopeDigest != scopeDigest || p.PolicyRevision != op.PolicyRevision || p.EnvelopeRevision != op.EnvelopeRevision {
			continue
		}
		if row.Status == "pending" {
			return nil, errors.New("security: task grant scope question is still pending")
		}
		if row.Status != "answered" {
			continue
		}
		var answers map[string][]string
		if json.Unmarshal([]byte(row.Answers), &answers) != nil {
			return nil, security.ErrConflict
		}

		p.QuestionID, p.QuestionDataDigest, p.DescriptorDigest = row.QuestionID, hash(row.Data), prepared.digest
		return e.selectSecurityGrantChoice(ctx, &p, answers)

	}
	p, err := e.buildSecurityGrantConfirmation(ctx, prepared)
	if err != nil || p == nil {
		return nil, err
	}
	s.mu.Lock()
	source := s.state.SecuritySourceMessageID
	s.mu.Unlock()
	p.SourceMessageID = source
	detail := e.securityGrantApprovalText(c, p)
	onceDescription := "只申请这次操作；后续操作仍按当前权限逐次确认。"
	if p.OnceRequiresGrant {
		onceDescription = "仅额外执行这一项；下一张审批卡会显示精确范围，原任务预算不新增、不扩大、不重置。"
		if p.TaskOnly {
			onceDescription = "项目策略要求任务额度：本次仅申请1次；下一张审批卡会显示范围，原有额度和绝对到期时间不重置。"
		}
	}
	question := UserQuestion{ID: "grant_scope", Title: "这次按单次操作确认，还是确认本任务的有限范围？", Reason: "这里只选择授权方式，尚未授权执行。选择任务范围后，还会展示完整范围并单独确认。", Options: []QuestionOption{{Label: securityGrantTaskChoice, Description: utf8Prefix(detail, 1800), Recommended: true}, {Label: securityGrantOnceChoice, Description: onceDescription}}}
	// Keep the ordinary tool's exact call identity for crash recovery. Question
	// answers are requirements only; recovered output never reports execution.
	questionCall := Call{ID: call.ID, Name: call.Name, Arguments: js(map[string]any{"questions": []UserQuestion{question}})}
	binding := &securityConfirmationQuestionContext{Row: securityConfirmationQuestionRow{Kind: "task_grant_proposal", ProjectID: op.ProjectID, SessionID: op.SessionID, RootTurnID: op.RootTurnID, SourceMessageID: source, GoalID: op.GoalID, CallID: call.ID, Data: js(p), ExpiresAt: time.Now().UTC().Add(14 * time.Minute)}}
	if _, err = e.askQuestion(withSecurityConfirmationQuestion(ctx, binding), s, questionCall); err != nil {
		return nil, err
	}
	var answered securityConfirmationQuestionRow
	if err = db.First(&answered, "question_id = ?", binding.QuestionID).Error; err != nil {
		return nil, err
	}
	var answers map[string][]string
	if answered.Status != "answered" || json.Unmarshal([]byte(answered.Answers), &answers) != nil {
		return nil, security.ErrConflict
	}

	p.QuestionID, p.QuestionDataDigest = binding.QuestionID, hash(answered.Data)
	return e.selectSecurityGrantChoice(ctx, p, answers)

}

func (e *Engine) selectSecurityGrantChoice(ctx context.Context, p *securityGrantConfirmation, answers map[string][]string) (*securityGrantConfirmation, error) {
	selected := answers["grant_scope"]
	if slices.Equal(selected, []string{securityGrantOnceChoice}) {
		if !p.OnceRequiresGrant {
			return nil, nil
		}
		p.Choice = securityGrantOnceChoice
		if !p.TaskOnly {
			p.SingleException = true
			return p, nil
		}
		if p.Issue != nil {
			p.Issue.Grant.RemainingUses = 1
		}
		if p.Expansion != nil {
			p.Expansion.AdditionalUses = 1
			db, storeID, epoch, err := e.securityTaskDB()
			if err != nil {
				return nil, err
			}
			err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
				change, err := previewSecurityTaskGrantExpansion(tx, storeID, epoch, *p.Expansion, time.Now().UTC())
				if err == nil {
					p.Change = &change
					p.Expansion.ConfirmedChangeDigest = change.Digest
				}
				return err
			})
			if err != nil {
				return nil, err
			}
		}
		return p, nil
	}
	if slices.Equal(selected, []string{securityGrantTaskChoice}) {
		p.Choice = securityGrantTaskChoice
		return p, nil
	}
	return nil, errors.New("security: explicit once/task choice required")
}

func (e *Engine) securityGrantApprovalText(c Config, p *securityGrantConfirmation) string {
	if p == nil {
		return ""
	}
	var grant security.TaskGrant
	prefix := "新增本任务有限授权（不含未支持的 Shell/MCP 任意执行）"
	if p.Issue != nil {
		grant = p.Issue.Grant
		grant.BackgroundPolicy = p.Issue.BackgroundPolicy
		if grant.BackgroundPolicy == "" {
			grant.BackgroundPolicy = "foreground_only"
		}
	} else if p.Change != nil {
		grant = p.Change.AfterGrant
		prefix = fmt.Sprintf("显式扩大任务范围；原剩余%d次，增加%d次，合计%d次；保留原绝对到期时间", p.Change.BeforeGrant.RemainingUses, p.Expansion.AdditionalUses, grant.RemainingUses)

	} else {
		return ""
	}
	if p.SingleException {
		grant = p.RequestedScope
		grant.RemainingUses = 1
		grant.BackgroundPolicy = "foreground_only"
		prefix = "仅额外执行下面这一项操作；不新增、不扩大、不重置原任务额度，其他操作仍按原权限确认"
	}
	resources := []string{}
	for _, r := range grant.Resources {
		name := r.ID
		for _, as := range c.Assets {
			if as.ID == r.ID {
				name = as.Name
				break
			}
		}
		resources = append(resources, fmt.Sprintf("%s（连接版本%d）", name, r.ConnectionRevision))
	}
	if len(resources) == 0 {
		resources = []string{"仅下列明确网络目标"}
	}
	profiles := []string{}
	for _, profile := range grant.CommandProfiles {
		profiles = append(profiles, fmt.Sprintf("%s v%d", profile.ID, profile.Version))
	}
	return fmt.Sprintf("%s\n任务版本：%d\n目标：%s\n能力：%s\n命令模板：%s\n本次实际程序与参数：%s\n工作目录：%s\n服务集合：%s\n实际服务目标：%s\n模板注册版本：%s\n子Agent执行范围：%s\n总剩余次数：%d\n绝对到期：%s\n后台：%s\n具体范围：%s", prefix, p.TaskRevision, strings.Join(resources, "、"), strings.Join(grant.Capabilities, "、"), strings.Join(profiles, "、"), js(p.RequestedCommand), p.CommandDirectory, strings.Join(grant.ServiceIDs, "、"), js(p.ServiceTargets), js(grant.CommandTargetRevisions), js(grant.AllowedChildScopes), grant.RemainingUses, grant.ExpiresAt.Local().Format("2006-01-02 15:04:05 MST"), grant.BackgroundPolicy, js(grant.Limits))
}
func (e *Engine) securityGrantApprovalPreview(c Config, p *securityGrantConfirmation) map[string]any {
	before := "当前没有本次拟授予的任务权限。"
	if p.Change != nil {

		previous := *p
		previous.SingleException = false
		previous.Change = nil
		previous.Expansion = nil
		previous.RequestedCommand = nil
		previous.CommandDirectory = ""
		previous.Issue = &SecurityTaskGrantAction{Grant: p.Change.BeforeGrant, BackgroundPolicy: p.Change.BeforeEnvelope.BackgroundPolicy}
		before = "原任务范围：\n" + e.securityGrantApprovalText(c, &previous)

	}
	return objJSON(js(map[string]any{"before": before, "after": e.securityGrantApprovalText(c, p), "taskGrantProposal": p}))
}

func (e *Engine) claimSecurityTaskGrantApprovalTx(ctx context.Context, tx *gorm.DB, record nativeApproval, prepared *SecurityPreparedOperation, now time.Time) error {
	if record.GrantProposal == "" {
		return errors.New("security: task grant proposal missing")
	}
	var p securityGrantConfirmation
	if decodeSecurityJSON(record.GrantProposal, &p) != nil || prepared == nil || p.DescriptorDigest != prepared.digest || p.ScopeDigest != securityGrantScopeDigest(prepared.descriptor) {
		return security.ErrConflict
	}

	op := prepared.descriptor
	var actual nativeApproval
	if err := tx.First(&actual, "id = ?", record.ID).Error; err != nil {
		return err
	}
	if actual.Status != "decided" || !actual.Accepted || actual.GrantProposal != record.GrantProposal || actual.DescriptorDigest != prepared.digest || actual.SecurityTaskID != op.TaskID || actual.StoreID != op.StoreID || actual.RecoveryEpoch != op.RecoveryEpoch || actual.SessionID != op.SessionID || actual.RootTurnID != op.RootTurnID || actual.ScopeID != op.ChildScopeID || actual.ExecutionRevision != op.ExecutionRevision || !now.Before(actual.ExpiresAt) {
		return security.ErrConflict
	}
	var displayed Approval
	if json.Unmarshal([]byte(actual.Binding), &displayed) != nil || actual.PreviewHash != hash(js(displayed.Preview)) || hash(js(displayed.Preview)) != hash(js(e.securityGrantApprovalPreview(prepared.executionConfig, &p))) {
		return errors.New("security: final approval does not display the exact task grant")
	}
	action := SecurityTaskAction{}
	if p.Issue != nil {
		action = p.Issue.Action
	} else if p.Expansion != nil {
		action = p.Expansion.Action
	}
	if action.ActorID != "local-user" || action.ProjectID != op.ProjectID || action.SessionID != op.SessionID || action.GoalID != op.GoalID || action.TaskID != op.TaskID || action.ExpectedRevision != p.TaskRevision {
		return security.ErrConflict
	}
	var question securityConfirmationQuestionRow
	if err := tx.First(&question, "question_id = ?", p.QuestionID).Error; err != nil {
		return err
	}
	if question.Kind != "task_grant_proposal" || question.Status != "answered" || question.StoreID != op.StoreID || question.RecoveryEpoch != op.RecoveryEpoch || question.ProjectID != op.ProjectID || question.SessionID != op.SessionID || question.RootTurnID != op.RootTurnID || question.GoalID != op.GoalID || question.SourceMessageID != p.SourceMessageID || hash(question.Data) != p.QuestionDataDigest || !now.Before(question.ExpiresAt) {
		return security.ErrConflict
	}
	var answers map[string][]string
	if json.Unmarshal([]byte(question.Answers), &answers) != nil || !slices.Equal(answers["grant_scope"], []string{p.Choice}) {
		return errors.New("security: task grant proposal was not selected by human")
	}
	bound, err := e.bindCurrentCatalogSnapshot(ctx, tx, op)
	if err != nil {
		return err
	}
	input, err := loadSecurityEvaluation(bound, op, prepared.owner, now)
	if err != nil {
		return err
	}
	if input.Task.StateRevision != p.TaskRevision || input.Policy.Revision != p.PolicyRevision || op.EnvelopeRevision != p.EnvelopeRevision || security.Evaluate(input).Effect == security.EffectDeny {
		return security.ErrConflict
	}
	if record.Status != "decided" || !record.Accepted {
		return security.ErrConflict
	}
	if (p.Issue == nil) == (p.Expansion == nil) {
		return security.ErrConflict
	}

	if p.SingleException {
		if p.TaskOnly || p.Choice != securityGrantOnceChoice || !actual.EnvelopeException || !now.Before(p.RequestedScope.ExpiresAt) {
			return security.ErrConflict
		}
		result := tx.Model(&nativeApproval{}).Where("id = ? AND status = ? AND accepted = ?", record.ID, "decided", true).Update("status", "authorized")
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return security.ErrConflict
		}
		result = tx.Model(&securityConfirmationQuestionRow{}).Where("question_id = ? AND status = ? AND revision = ?", question.QuestionID, "answered", question.Revision).Updates(map[string]any{"status": "single_confirmed", "revision": question.Revision + 1})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return security.ErrConflict
		}
		return e.appendNativeEvidence(tx, &nativeEvidence{SessionID: op.SessionID, CallID: op.CallID, Tool: op.Tool, Status: "single_scope_exception_confirmed", Data: js(map[string]any{"approval_id": record.ID, "question_id": question.QuestionID, "descriptor_hash": prepared.digest, "extra_operations": 1, "original_budget_unchanged": true}), At: now})
	}
	var grant security.TaskGrant
	if p.Issue != nil {
		grant, err = issueSecurityTaskGrant(tx, op.StoreID, op.RecoveryEpoch, *p.Issue, now)
	} else {
		grant, err = expandSecurityTaskGrant(tx, op.StoreID, op.RecoveryEpoch, *p.Expansion, now)
	}
	if err != nil {
		return err
	}
	result := tx.Model(&nativeApproval{}).Where("id = ? AND status = ? AND accepted = ?", record.ID, "decided", true).Update("status", "consumed")
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return security.ErrConflict
	}
	result = tx.Model(&securityConfirmationQuestionRow{}).Where("question_id = ? AND status = ? AND revision = ?", question.QuestionID, "answered", question.Revision).Updates(map[string]any{"status": "grant_confirmed", "revision": question.Revision + 1})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return security.ErrConflict
	}
	return e.appendNativeEvidence(tx, &nativeEvidence{SessionID: op.SessionID, CallID: op.CallID, Tool: op.Tool, Status: "task_grant_confirmed", Data: js(map[string]any{"approval_id": record.ID, "question_id": question.QuestionID, "grant_id": grant.ID, "grant_revision": grant.Revision, "descriptor_hash": prepared.digest}), At: now})
}
