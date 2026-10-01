package remote

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/cloudwego/eino/lake/agent"
	"github.com/cloudwego/eino/lake/agent/policy"
	"github.com/cloudwego/eino/lake/code"
	"github.com/cloudwego/eino/lake/credential"
	"github.com/cloudwego/eino/lake/store"
	sshtransport "github.com/cloudwego/eino/lake/transport/ssh"
)

// Service is the only policy and credential entry point for a registered
// remote code workspace. Host execution authorization is deliberately separate.
type Service struct {
	Store   *store.Store
	Runner  Runner
	Keys    interface{ Load(string) ([]byte, error) }
	Approve func(kind, target, detail string) (bool, error)
	Origin  string
	Actor   string
	RunID   string
}

func (s Service) defaults() Service {
	if s.Runner == nil {
		s.Runner = sshtransport.Client{}
	}
	if s.Keys == nil && s.Store != nil {
		s.Keys = credential.FileVault{Root: s.Store.Root()}
	}
	if s.Origin == "" {
		s.Origin = "cli"
	}
	if s.Actor == "" {
		s.Actor = "cli"
	}
	return s
}

func (s Service) connection(ctx context.Context, resource store.Resource, root string) (Workspace, func(), error) {
	s = s.defaults()
	if s.Store == nil || resource.Kind != "host" || !store.ValidRemoteRoot(root) {
		return Workspace{}, nil, errors.New("远程代码工作区连接参数无效")
	}
	attachments, err := s.Store.ListAttachments(ctx, resource.ID)
	if err != nil {
		return Workspace{}, nil, err
	}
	var ref string
	for _, attachment := range attachments {
		if attachment.Kind == "credential" {
			ref = attachment.Ref
			break
		}
	}
	if ref == "" {
		return Workspace{}, nil, errors.New("远程主机未关联 SSH 私钥")
	}
	key, err := s.Keys.Load(ref)
	if err != nil {
		return Workspace{}, nil, errors.New("读取远程主机 SSH 凭据失败")
	}
	w := Workspace{Root: root, Target: sshtransport.Target{Host: resource.SSH.Host, Port: resource.SSH.Port, Username: resource.SSH.Username}, Key: key, Runner: s.Runner}
	return w, func() { clear(key) }, nil
}

// Register verifies the physical root before inserting a disabled binding.
func (s Service) Register(ctx context.Context, lakeName, resourcePath, name, root string) (store.CodeWorkspace, error) {
	if s.Store == nil || !store.ValidRemoteRoot(root) {
		return store.CodeWorkspace{}, errors.New("远程项目根目录无效")
	}
	lake, err := s.Store.GetLakeByName(ctx, lakeName)
	if err != nil {
		return store.CodeWorkspace{}, err
	}
	resource, err := s.Store.ResolveResource(ctx, resourcePath)
	if err != nil {
		return store.CodeWorkspace{}, err
	}
	if resource.Kind != "host" || resource.LakeID != lake.ID {
		return store.CodeWorkspace{}, errors.New("远程项目必须使用同一湖的 SSH 主机")
	}
	w, done, err := s.connection(ctx, resource, root)
	if err != nil {
		return store.CodeWorkspace{}, err
	}
	defer done()
	if err := w.Probe(ctx); err != nil {
		return store.CodeWorkspace{}, err
	}
	return s.Store.CreateCodeWorkspace(ctx, lake.ID, resource.ID, name, root)
}

type approvalBroker struct {
	approve              func(string, string, string) (bool, error)
	kind, target, detail string
}

func (b approvalBroker) Request(_ context.Context, request agent.PermissionRequest) (agent.PermissionDecision, error) {
	if b.approve == nil {
		return agent.PermissionDecision{RequestID: request.ID, Outcome: agent.PermissionDeny}, nil
	}
	allow, err := b.approve(b.kind, b.target, b.detail)
	if err != nil {
		return agent.PermissionDecision{}, err
	}
	outcome := agent.PermissionDeny
	if allow {
		outcome = agent.PermissionAllow
	}
	return agent.PermissionDecision{RequestID: request.ID, Outcome: outcome}, nil
}

func (s Service) journal(ctx context.Context, id, tool, target, risk, detail, event string, exit *int, elapsed *int64) error {
	s = s.defaults()
	logCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := s.Store.AppendJournal(logCtx, store.JournalInput{RunID: s.RunID, ActionID: id, Actor: s.Actor, Tool: tool, TargetPath: target, Risk: risk, Detail: detail, Event: event, ExitCode: exit, DurationMS: elapsed})
	return err
}

// prepare refreshes the registration and authorization on every operation.
func (s Service) prepare(ctx context.Context, id, tool, capability, target, detail string) (Workspace, func(), string, string, error) {
	s = s.defaults()
	if s.Store == nil {
		return Workspace{}, nil, "", "", errors.New("远程代码工作区未配置")
	}
	item, err := s.Store.GetCodeWorkspace(ctx, id)
	if err != nil {
		return Workspace{}, nil, "", "", err
	}
	resource, err := s.Store.GetResource(ctx, item.ResourceID)
	if err != nil {
		return Workspace{}, nil, "", "", err
	}
	if resource.Kind != "host" || resource.LakeID != item.LakeID {
		return Workspace{}, nil, "", "", errors.New("远程代码工作区主机绑定已变化")
	}
	actionID, err := store.NewActionID()
	if err != nil {
		return Workspace{}, nil, "", "", err
	}
	digest := sha256.Sum256([]byte(detail))
	audit := "arguments_sha256=" + hex.EncodeToString(digest[:])
	risk := "read"
	if capability != "read" {
		risk = "write"
	}
	if err := s.journal(ctx, actionID, tool, target, risk, audit, "requested", nil, nil); err != nil {
		return Workspace{}, nil, "", "", err
	}
	request := agent.PermissionRequest{ID: actionID, ToolName: tool, Capability: capability, Target: target, ArgumentsSHA: hex.EncodeToString(digest[:])}
	err = policy.Authorize(ctx, policy.Input{
		Spec:   agent.ToolSpec{Name: tool, Capability: capability},
		Scope:  agent.RunScope{LakeID: item.LakeID, ToolNames: []string{tool}, ResourceIDs: []string{item.ResourceID}},
		Origin: s.Origin, Request: request, ResourceID: item.ResourceID,
		ResourceFrozen: true, ResourceAuthorized: item.Authorized,
	}, approvalBroker{approve: s.Approve, kind: tool, target: target, detail: detail})
	if err != nil {
		_ = s.journal(ctx, actionID, tool, target, risk, audit, "denied", nil, nil)
		return Workspace{}, nil, "", "", err
	}
	if err := s.journal(ctx, actionID, tool, target, risk, audit, "approved", nil, nil); err != nil {
		return Workspace{}, nil, "", "", err
	}
	// Recheck revocation after a human approval, before credential access.
	current, err := s.Store.GetCodeWorkspace(ctx, id)
	if err != nil || !current.Authorized || current.ResourceID != item.ResourceID || current.RemoteRoot != item.RemoteRoot {
		_ = s.journal(ctx, actionID, tool, target, risk, audit, "denied", nil, nil)
		return Workspace{}, nil, "", "", errors.New("远程代码工作区授权已变化")
	}
	w, done, err := s.connection(ctx, resource, item.RemoteRoot)
	if err != nil {
		_ = s.journal(ctx, actionID, tool, target, risk, audit, "failed", nil, nil)
		return Workspace{}, nil, "", "", err
	}
	return w, done, actionID, audit, nil
}

func (s Service) finish(ctx context.Context, id, tool, target, capability, audit string, started time.Time, exit *int, unknown bool, err error) error {
	risk := "read"
	if capability != "read" {
		risk = "write"
	}
	event := "completed"
	if unknown {
		event = "unknown"
	} else if err != nil || exit != nil && *exit != 0 {
		event = "failed"
	}
	duration := time.Since(started).Milliseconds()
	return s.journal(ctx, id, tool, target, risk, audit, event, exit, &duration)
}

func (s Service) List(ctx context.Context, id string) ([]string, error) {
	w, done, action, audit, err := s.prepare(ctx, id, "lake_remote_code_list", "read", id, "list")
	if err != nil {
		return nil, err
	}
	defer done()
	if err := s.journal(ctx, action, "lake_remote_code_list", id, "read", audit, "started", nil, nil); err != nil {
		return nil, err
	}
	started := time.Now()
	items, err := w.List(ctx)
	if logErr := s.finish(ctx, action, "lake_remote_code_list", id, "read", audit, started, nil, false, err); logErr != nil {
		return nil, logErr
	}
	return items, err
}

func (s Service) Read(ctx context.Context, id, relative string) (string, error) {
	w, done, action, audit, err := s.prepare(ctx, id, "lake_remote_code_read", "read", id+"/"+relative, relative)
	if err != nil {
		return "", err
	}
	defer done()
	if err := s.journal(ctx, action, "lake_remote_code_read", id+"/"+relative, "read", audit, "started", nil, nil); err != nil {
		return "", err
	}
	started := time.Now()
	result, err := w.Read(ctx, relative)
	if logErr := s.finish(ctx, action, "lake_remote_code_read", id+"/"+relative, "read", audit, started, nil, false, err); logErr != nil {
		return "", logErr
	}
	return result, err
}

func (s Service) Write(ctx context.Context, id, relative, expectedSHA string, content []byte) (RunResult, error) {
	detail := fmt.Sprintf("写入远程文件 %s，原 SHA-256：%s，新 SHA-256：%s（%d 字节）", relative, expectedSHA, ContentSHA(content), len(content))
	target := id + "/" + relative
	w, done, action, audit, err := s.prepare(ctx, id, "lake_remote_code_write", "write", target, detail)
	if err != nil {
		return RunResult{}, err
	}
	defer done()
	if err := s.journal(ctx, action, "lake_remote_code_write", target, "write", audit, "started", nil, nil); err != nil {
		return RunResult{}, err
	}
	started := time.Now()
	result, err := w.Write(ctx, relative, expectedSHA, content)
	var exit *int
	if !result.Unknown {
		exit = &result.ExitCode
	}
	if logErr := s.finish(ctx, action, "lake_remote_code_write", target, "write", audit, started, exit, result.Unknown, err); logErr != nil {
		return RunResult{}, logErr
	}
	return result, err
}

func (s Service) Run(ctx context.Context, id, command string) (RunResult, error) {
	w, done, action, audit, err := s.prepare(ctx, id, "lake_remote_code_run", "execute", id, command)
	if err != nil {
		return RunResult{}, err
	}
	defer done()
	if err := s.journal(ctx, action, "lake_remote_code_run", id, "write", audit, "started", nil, nil); err != nil {
		return RunResult{}, err
	}
	started := time.Now()
	result, err := w.Run(ctx, command)
	var exit *int
	if !result.Unknown {
		exit = &result.ExitCode
	}
	if logErr := s.finish(ctx, action, "lake_remote_code_run", id, "execute", audit, started, exit, result.Unknown, err); logErr != nil {
		return RunResult{}, logErr
	}
	return result, err
}

// RunInTerminal revalidates workspace authorization for every command while
// retaining shell state. A broken shell is closed and is never retried here.
func (s Service) RunInTerminal(ctx context.Context, id, command string, terminal **code.TerminalSession) (code.TerminalResult, error) {
	if terminal == nil {
		return code.TerminalResult{}, errors.New("远程终端会话参数无效")
	}
	if strings.TrimSpace(command) == "" || len(command) > 4000 || strings.ContainsAny(command, "\x00\r\n") {
		return code.TerminalResult{}, errors.New("远程终端命令无效")
	}
	w, done, action, audit, err := s.prepare(ctx, id, "lake_remote_code_run", "execute", id, command)
	if err != nil {
		return code.TerminalResult{}, err
	}
	defer done()
	if *terminal == nil {
		shell, err := (sshtransport.Client{}).OpenShell(ctx, w.Target, w.Key, w.Root)
		if err != nil {
			_ = s.finish(ctx, action, "lake_remote_code_run", id, "execute", audit, time.Now(), nil, false, err)
			return code.TerminalResult{}, err
		}
		session, err := code.NewStreamTerminal(w.Root, w.Target.Username, shell.Stdin, shell.Stdout, shell.Stderr, shell.Close)
		if err != nil {
			shell.Close()
			return code.TerminalResult{}, err
		}
		session.TransportTarget = fmt.Sprintf("%s@%s:%d", w.Target.Username, w.Target.Host, w.Target.Port)
		*terminal = session
	}
	if (*terminal).Root != w.Root || (*terminal).User != w.Target.Username || (*terminal).TransportTarget != fmt.Sprintf("%s@%s:%d", w.Target.Username, w.Target.Host, w.Target.Port) {
		return code.TerminalResult{}, errors.New("终端工作区绑定已变化")
	}
	if err := s.journal(ctx, action, "lake_remote_code_run", id, "write", audit, "started", nil, nil); err != nil {
		return code.TerminalResult{}, err
	}
	started := time.Now()
	result, err := (*terminal).Run(ctx, command)
	var exit *int
	if err == nil {
		exit = &result.ExitCode
	}
	if logErr := s.finish(ctx, action, "lake_remote_code_run", id, "execute", audit, started, exit, err != nil, err); logErr != nil {
		return result, logErr
	}
	return result, err
}
