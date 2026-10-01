package operate

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/cloudwego/eino/lake/agent"
	agentpolicy "github.com/cloudwego/eino/lake/agent/policy"
	"github.com/cloudwego/eino/lake/credential"
	"github.com/cloudwego/eino/lake/store"
	sshtransport "github.com/cloudwego/eino/lake/transport/ssh"
)

type SSHRunner interface {
	Run(context.Context, sshtransport.Target, []byte, string) (sshtransport.Result, error)
}

// ErrSSHExecutionUnknown marks failures after remote execution was attempted.
// Validation and authorization failures occur before this boundary.
var ErrSSHExecutionUnknown = errors.New("SSH 执行结果未知")

type SSHInputRunner interface {
	RunWithInput(context.Context, sshtransport.Target, []byte, string, []byte) (sshtransport.Result, error)
}
type SSHInputConnection interface {
	RunWithInput(context.Context, string, []byte) (sshtransport.Result, error)
}

type SSHConnection interface {
	Run(context.Context, string) (sshtransport.Result, error)
	Close() error
	IsClosed() bool
}

type SSHOpener func(context.Context, sshtransport.Target, []byte) (SSHConnection, error)

type KeyLoader interface {
	Load(string) ([]byte, error)
}

type Confirmation func(context.Context, string, string) (bool, error)

type sshApprovalBroker struct {
	confirm       Confirmation
	path, command string
}

func (b sshApprovalBroker) Request(ctx context.Context, request agent.PermissionRequest) (agent.PermissionDecision, error) {
	approved, err := b.confirm(ctx, b.path, b.command)
	if err != nil {
		return agent.PermissionDecision{}, err
	}
	outcome := agent.PermissionDeny
	if approved {
		outcome = agent.PermissionAllow
	}
	return agent.PermissionDecision{RequestID: request.ID, Outcome: outcome}, nil
}

func (s *Service) sshPolicyInput(actionID, resourceID, risk string, authorized bool, permissions store.PermissionPolicy) agentpolicy.Input {
	anchors := make([]string, 0, len(s.Anchors))
	for id := range s.Anchors {
		anchors = append(anchors, id)
	}
	_, frozen := s.Anchors[resourceID]
	return agentpolicy.Input{
		Spec:   agent.ToolSpec{Name: "lake_ssh", Capability: "execute"},
		Scope:  agent.RunScope{LakeID: s.Lake.ID, ToolNames: []string{"lake_ssh"}, ResourceIDs: anchors},
		Origin: s.Origin, Request: agent.PermissionRequest{ID: actionID, ToolName: "lake_ssh", Capability: "execute"},
		ResourceID: resourceID, ResourceFrozen: frozen, ResourceAuthorized: authorized, SSHRisk: risk,
		SilentSSHRead: permissions.SilentSSHRead && !s.RequireReadApproval, SilentSSHCommand: permissions.SilentSSHCommand,
	}
}

type Service struct {
	Store   *store.Store
	Runner  SSHRunner
	Opener  SSHOpener
	Keys    KeyLoader
	Lake    store.Lake
	Anchors map[string]struct{}
	RunID   string
	Origin  string
	Confirm Confirmation
	// RequireReadApproval strengthens this caller's policy without changing the
	// user's persistent global permissions. External MCP clients use it by default.
	RequireReadApproval bool
	sessionMu           sync.Mutex
	sessions            map[string]*sshSession
}

// SetRunID groups SSH audit events under a workflow run.
func (s *Service) SetRunID(id string) { s.RunID = id }

// NewService freezes the current lake's resource IDs for this conversation.
func NewService(ctx context.Context, s *store.Store) (*Service, error) {
	lake, err := s.CurrentLake(ctx)
	if err != nil {
		return nil, err
	}
	return newServiceForLake(ctx, s, lake)
}

// NewServiceForLake freezes the named lake without changing the user's current
// lake. Workflow runs use it so a saved workflow cannot silently switch scope.
func NewServiceForLake(ctx context.Context, s *store.Store, lakeName string) (*Service, error) {
	lake, err := s.GetLakeByName(ctx, lakeName)
	if err != nil {
		return nil, err
	}
	service, err := newServiceForLake(ctx, s, lake)
	if err == nil {
		service.Origin = "workflow"
	}
	return service, err
}

func newServiceForLake(ctx context.Context, s *store.Store, lake store.Lake) (*Service, error) {
	resources, err := s.ListResources(ctx, lake.ID)
	if err != nil {
		return nil, err
	}
	anchors := make(map[string]struct{}, len(resources))
	for _, resource := range resources {
		if resource.Kind == "host" {
			anchors[resource.ID] = struct{}{}
		}
	}
	runID, err := store.NewActionID()
	if err != nil {
		return nil, err
	}
	return &Service{
		Store: s, Runner: sshtransport.Client{}, Keys: credential.FileVault{Root: s.Root()},
		Opener: func(ctx context.Context, target sshtransport.Target, key []byte) (SSHConnection, error) {
			return (sshtransport.Client{}).Open(ctx, target, key)
		},
		Lake: lake, Anchors: anchors, RunID: runID, Origin: "model",
		sessions: make(map[string]*sshSession),
	}, nil
}

func (s *Service) ResourceNames(ctx context.Context) ([]string, error) {
	resources, err := s.ListResources(ctx)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(resources))
	for _, resource := range resources {
		names = append(names, resource.Name)
	}
	return names, nil
}

// ListResources returns the current state of resources frozen at conversation
// start. Newly added resources require a new conversation to enter its scope.
func (s *Service) ListResources(ctx context.Context) ([]store.Resource, error) {
	resources, err := s.Store.ListResources(ctx, s.Lake.ID)
	if err != nil {
		return nil, err
	}
	visible := make([]store.Resource, 0, len(resources))
	for _, resource := range resources {
		if _, ok := s.Anchors[resource.ID]; ok {
			visible = append(visible, resource)
		}
	}
	return visible, nil
}

var readCommands = map[string]string{
	"hostname": "hostname",
	"uptime":   "uptime",
	"os":       "uname -a",
	"cpu":      `a=$(awk 'NR==1 {for (i=2;i<=NF;i++) t+=$i; print t,$5+$6}' /proc/stat); sleep 1; b=$(awk 'NR==1 {for (i=2;i<=NF;i++) t+=$i; print t,$5+$6}' /proc/stat); printf '%s\n%s\n' "$a" "$b" | awk 'NR==1 {t=$1; idle=$2} NR==2 {dt=$1-t; if (dt<=0) exit 1; printf "CPU usage: %.1f%% (1s sample)\n", 100*(1-($2-idle)/dt)}'`,
	"disk":     "df -hP",
	"memory":   "free -h",
}

func (s *Service) RunRead(ctx context.Context, resourceName, check string) (sshtransport.Result, error) {
	command, ok := readCommands[check]
	if !ok {
		return sshtransport.Result{}, errors.New("SSH 检查类型仅支持 hostname、uptime、os、cpu、disk、memory")
	}
	return s.run(ctx, resourceName, command, "read", "check="+check)
}

// RunReadForResource keeps a workflow step bound to its original resource.
func (s *Service) RunReadForResource(ctx context.Context, resource store.Resource, check string) (sshtransport.Result, error) {
	command, ok := readCommands[check]
	if !ok {
		return sshtransport.Result{}, errors.New("SSH 检查类型无效")
	}
	return s.runWithInputBound(ctx, resource.Name, command, "read", "check="+check, nil, command, scriptTargetSHA(resource), resource.ID)
}

// RunCommand accepts an arbitrary command only when the global permission
// policy allows silent SSH commands or a person approves this invocation.
func (s *Service) RunCommand(ctx context.Context, resourceName, command string) (sshtransport.Result, error) {
	return s.runCommand(ctx, resourceName, command, nil)
}

// RunCommandForResource checks both identity and SSH target before execution,
// including changes made while the model's operation approval was pending.
func (s *Service) RunCommandForResource(ctx context.Context, resource store.Resource, command string) (sshtransport.Result, error) {
	return s.runCommand(ctx, resource.Name, command, &resource)
}

func (s *Service) runCommand(ctx context.Context, resourceName, command string, bound *store.Resource) (sshtransport.Result, error) {
	if strings.TrimSpace(command) == "" || len(command) > 2048 {
		return sshtransport.Result{}, errors.New("SSH 命令为空或过长")
	}
	for _, r := range command {
		if r < 0x20 || r == 0x7f {
			return sshtransport.Result{}, errors.New("SSH 命令包含控制字符")
		}
	}
	lower := strings.ToLower(strings.TrimSpace(command))
	for _, blocked := range []string{"rm -rf /", "mkfs", "shutdown", "reboot", "poweroff", "dd if=", "curl | sh", "wget | sh"} {
		if strings.Contains(lower, blocked) {
			return sshtransport.Result{}, errors.New("该 SSH 命令被 Lake 阻止")
		}
	}
	// Keep credentials embedded in commands out of the SQLite journal. The
	// terminal confirmation shows the complete command before execution.
	digest := sha256.Sum256([]byte(command))
	if bound != nil {
		return s.runWithInputBound(ctx, resourceName, command, "write", fmt.Sprintf("command_sha256=%x", digest), nil, command, scriptTargetSHA(*bound), bound.ID)
	}
	return s.run(ctx, resourceName, command, "write", fmt.Sprintf("command_sha256=%x", digest))
}

func (s *Service) RunScript(ctx context.Context, resourceName, scriptID, language, expectedSHA string, content []byte) (sshtransport.Result, error) {
	if scriptID == "" || len(content) == 0 || len(content) > 1<<20 {
		return sshtransport.Result{}, errors.New("脚本内容无效")
	}
	if language != "sh" && language != "bash" {
		return sshtransport.Result{}, errors.New("远程脚本只支持 sh 或 bash")
	}
	sum := sha256.Sum256(content)
	actual := fmt.Sprintf("%x", sum)
	if expectedSHA != actual {
		return sshtransport.Result{}, errors.New("脚本内容哈希已变化")
	}
	detail := "script_id=" + scriptID + " script_sha256=" + actual
	return s.runWithInput(ctx, resourceName, language+" -s", "write", detail, content, language+" -s ("+detail+")")
}

func (s *Service) run(ctx context.Context, resourceName, command, risk, detail string) (sshtransport.Result, error) {
	return s.runWithInput(ctx, resourceName, command, risk, detail, nil, command)
}

func (s *Service) runWithInput(ctx context.Context, resourceName, command, risk, detail string, input []byte, approvalSummary string) (sshtransport.Result, error) {
	return s.runWithInputBound(ctx, resourceName, command, risk, detail, input, approvalSummary, "")
}

// Persistent jobs bind every control request to their original SSH target.
func (s *Service) runWithInputBound(ctx context.Context, resourceName, command, risk, detail string, input []byte, approvalSummary, expectedTargetSHA string, expectedResourceID ...string) (sshtransport.Result, error) {
	if strings.Contains(resourceName, "/") {
		return sshtransport.Result{}, errors.New("SSH 工具只接受当前湖内的资源名")
	}
	resource, err := s.Store.ResolveResource(ctx, s.Lake.Name+"/"+resourceName)
	if err != nil {
		return sshtransport.Result{}, fmt.Errorf("查找 SSH 资源: %w", err)
	}
	if resource.Kind != "host" {
		return sshtransport.Result{}, errors.New("该资源不是 SSH 主机")
	}
	if len(expectedResourceID) > 0 && resource.ID != expectedResourceID[0] {
		return sshtransport.Result{}, errors.New("工作流步骤资源身份已变更，未执行")
	}
	if expectedTargetSHA != "" && scriptTargetSHA(resource) != expectedTargetSHA {
		return sshtransport.Result{}, errors.New("已绑定的 SSH 目标已变更，未执行")
	}
	actionID, err := store.NewActionID()
	if err != nil {
		return sshtransport.Result{}, err
	}
	path := s.Lake.Name + "/" + resource.Name
	log := func(event, detail string, exitCode *int, duration *int64) error {
		logCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, err := s.Store.AppendJournal(logCtx, store.JournalInput{
			RunID: s.RunID, ActionID: actionID, Actor: "agent", TargetPath: path,
			Tool: "lake_ssh", Risk: risk, Event: event, Detail: detail,
			ExitCode: exitCode, DurationMS: duration,
		})
		return err
	}
	if err := log("requested", detail, nil, nil); err != nil {
		return sshtransport.Result{}, err
	}
	if _, ok := s.Anchors[resource.ID]; !ok {
		_ = log("denied", "resource_outside_frozen_anchor", nil, nil)
		return sshtransport.Result{}, errors.New("资源不在本次 Lake Agent 的冻结范围内")
	}
	if !resource.ExecuteAuthz {
		_ = log("denied", "execute_authz=false", nil, nil)
		return sshtransport.Result{}, fmt.Errorf("资源 %s 尚未开启执行授权；请先运行 lake res authz %s on", path, path)
	}
	policy, err := s.Store.GetPermissionPolicy(ctx)
	if err != nil {
		return sshtransport.Result{}, fmt.Errorf("读取静默权限: %w", err)
	}
	permissionInput := s.sshPolicyInput(actionID, resource.ID, risk, resource.ExecuteAuthz, policy)
	preflight := agentpolicy.Decide(permissionInput)
	if preflight.Outcome == agent.PermissionDeny {
		_ = log("denied", preflight.Reason, nil, nil)
		return sshtransport.Result{}, agentpolicy.ErrDenied
	}
	needsApproval := preflight.Outcome == agent.PermissionAsk
	if risk == "write" || needsApproval {
		if err := log("proposed", detail, nil, nil); err != nil {
			return sshtransport.Result{}, err
		}
	}
	if needsApproval {
		if s.Confirm == nil {
			_ = log("denied", "terminal_confirmation_unavailable", nil, nil)
			return sshtransport.Result{}, errors.New("该 SSH 操作需要人在交互终端确认")
		}
		err := agentpolicy.Authorize(ctx, permissionInput, sshApprovalBroker{confirm: s.Confirm, path: path, command: approvalSummary})
		if err != nil {
			_ = log("denied", "human_rejected", nil, nil)
			if errors.Is(err, agentpolicy.ErrDenied) {
				return sshtransport.Result{}, errors.New("用户未批准 SSH 命令")
			}
			return sshtransport.Result{}, err
		}
		if err := log("approved", "human_approved", nil, nil); err != nil {
			return sshtransport.Result{}, err
		}
	} else if risk == "write" {
		if err := agentpolicy.Authorize(ctx, permissionInput, nil); err != nil {
			return sshtransport.Result{}, err
		}
		if err := log("approved", "silent_ssh_command_policy", nil, nil); err != nil {
			return sshtransport.Result{}, err
		}
	} else {
		if err := agentpolicy.Authorize(ctx, permissionInput, nil); err != nil {
			return sshtransport.Result{}, err
		}
	}
	// Approval can wait while authorization or the target is edited. Do not
	// execute against a new host or a withdrawn grant after that wait.
	current, err := s.Store.GetResource(ctx, resource.ID)
	if err != nil {
		return sshtransport.Result{}, err
	}
	if !current.ExecuteAuthz || current.LakeID != resource.LakeID || current.Kind != resource.Kind || scriptTargetSHA(current) != scriptTargetSHA(resource) {
		_ = log("denied", "resource_changed_after_approval", nil, nil)
		return sshtransport.Result{}, errors.New("资源授权或 SSH 目标在审批期间已变更，未执行")
	}
	var execute func() (sshtransport.Result, error)
	if connection := s.sessionFor(resource.ID); connection != nil {
		execute = func() (sshtransport.Result, error) {
			var result sshtransport.Result
			var err error
			if input == nil {
				result, err = connection.Run(ctx, command)
			} else if stream, ok := connection.(SSHInputConnection); ok {
				result, err = stream.RunWithInput(ctx, command, input)
			} else {
				return result, errors.New("当前 SSH 会话不支持脚本输入")
			}
			s.touchSession(resource.ID)
			return result, err
		}
	} else {
		attachments, err := s.Store.ListAttachments(ctx, resource.ID)
		if err != nil {
			_ = log("failed", "read_credential_ref", nil, nil)
			return sshtransport.Result{}, err
		}
		var ref string
		for _, attachment := range attachments {
			if attachment.Kind == "credential" {
				ref = attachment.Ref
				break
			}
		}
		if ref == "" {
			_ = log("failed", "credential_missing", nil, nil)
			return sshtransport.Result{}, errors.New("资源未关联 SSH 私钥")
		}
		key, err := s.Keys.Load(ref)
		if err != nil {
			_ = log("failed", "credential_read", nil, nil)
			return sshtransport.Result{}, fmt.Errorf("读取 SSH 凭据: %w", err)
		}
		defer clearBytes(key)
		execute = func() (sshtransport.Result, error) {
			target := sshtransport.Target{
				Host: resource.SSH.Host, Port: resource.SSH.Port, Username: resource.SSH.Username,
			}
			if input == nil {
				return s.Runner.Run(ctx, target, key, command)
			}
			stream, ok := s.Runner.(SSHInputRunner)
			if !ok {
				return sshtransport.Result{}, errors.New("SSH 传输不支持脚本输入")
			}
			return stream.RunWithInput(ctx, target, key, command, input)
		}
	}
	started := time.Now()
	if err := log("started", detail, nil, nil); err != nil {
		return sshtransport.Result{}, err
	}
	result, err := execute()
	duration := time.Since(started).Milliseconds()
	if err != nil {
		event := "failed"
		if risk == "write" && !errors.Is(err, sshtransport.ErrNotStarted) {
			event = "unknown"
		}
		_ = log(event, "ssh_transport_error", nil, &duration)
		if risk == "write" && !errors.Is(err, sshtransport.ErrNotStarted) {
			return result, fmt.Errorf("%w: %w", ErrSSHExecutionUnknown, err)
		}
		return result, err
	}
	event := "completed"
	if result.ExitCode != 0 {
		event = "failed"
	}
	if err := log(event, detail, &result.ExitCode, &duration); err != nil {
		if risk == "write" {
			return result, fmt.Errorf("%w: %w", ErrSSHExecutionUnknown, err)
		}
		return result, err
	}
	return result, nil
}

func clearBytes(data []byte) {
	for i := range data {
		data[i] = 0
	}
}
