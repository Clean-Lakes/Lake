package specialist

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sync"

	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/compose"
	"github.com/cloudwego/eino/schema"
	"golang.org/x/sys/unix"
)

const checkpointLimit = 16 << 20

var taskIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,100}$`)
var ErrUnknownWrite = errors.New("专员有结果未知的写操作；核对外部结果后显式允许 retry_writes，并重新批准")

type toolRecord struct {
	Name     string `json:"name"`
	InputSHA string `json:"input_sha256"`
	Output   string `json:"output,omitempty"`
	Done     bool   `json:"done"`
}
type modelRecord struct {
	InputSHA string          `json:"input_sha256"`
	Response *schema.Message `json:"response"`
}

// Checkpoint keeps execution content outside the metadata database. Credentials
// are never part of Runtime or model options serialized here.
type Checkpoint struct {
	Output    *string               `json:"output,omitempty"`
	Version   int                   `json:"version"`
	TaskID    string                `json:"task_id"`
	Prepared  Prepared              `json:"prepared"`
	Arguments string                `json:"arguments"`
	Models    []modelRecord         `json:"models"`
	Tools     map[string]toolRecord `json:"tools"`
}
type executionLog struct {
	mu          sync.Mutex
	state       Checkpoint
	path        string
	modelIndex  int
	retryWrites bool
}
type logKey struct{}

func digest(v any) string {
	b, _ := json.Marshal(v)
	h := sha256.Sum256(b)
	return fmt.Sprintf("%x", h)
}
func checkpointDir(root string) (string, error) {
	p := filepath.Join(root, "specialist-checkpoints")
	if err := os.MkdirAll(p, 0700); err != nil {
		return "", err
	}
	info, err := os.Lstat(p)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0700 {
		return "", errors.New("专员检查点目录权限无效")
	}
	return p, nil
}
func lockCheckpoint(root, id string) (string, func(), error) {
	if !taskIDPattern.MatchString(id) {
		return "", nil, errors.New("专员任务 ID 无效")
	}
	dir, err := checkpointDir(root)
	if err != nil {
		return "", nil, err
	}
	fd, err := unix.Open(filepath.Join(dir, id+".lock"), unix.O_CREAT|unix.O_RDWR|unix.O_NOFOLLOW, 0600)
	if err != nil {
		return "", nil, err
	}
	f := os.NewFile(uintptr(fd), "specialist-lock")
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 {
		f.Close()
		return "", nil, errors.New("专员任务锁权限无效")
	}
	if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		f.Close()
		return "", nil, errors.New("专员任务正在执行")
	}
	return filepath.Join(dir, id+".json"), func() { _ = unix.Flock(fd, unix.LOCK_UN); _ = f.Close() }, nil
}
func LoadCheckpoint(root, id string) (Checkpoint, error) {
	var state Checkpoint
	if !taskIDPattern.MatchString(id) {
		return state, errors.New("专员任务 ID 无效")
	}
	dir, err := checkpointDir(root)
	if err != nil {
		return state, err
	}
	p := filepath.Join(dir, id+".json")
	fd, err := unix.Open(p, unix.O_RDONLY|unix.O_NOFOLLOW, 0)
	if err != nil {
		return state, err
	}
	f := os.NewFile(uintptr(fd), "specialist-checkpoint")
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() > checkpointLimit {
		return state, errors.New("专员检查点权限或大小无效")
	}
	b, err := io.ReadAll(io.LimitReader(f, checkpointLimit+1))
	if err != nil {
		return state, err
	}
	if json.Unmarshal(b, &state) != nil || state.Version != 1 || state.TaskID != id || state.Tools == nil {
		return state, errors.New("专员检查点内容无效")
	}
	return state, nil
}
func (l *executionLog) save() error {
	b, err := json.Marshal(l.state)
	if err != nil {
		return err
	}
	if len(b) > checkpointLimit {
		return errors.New("专员检查点超过 16 MiB")
	}
	f, err := os.CreateTemp(filepath.Dir(l.path), ".checkpoint-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(b)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(f.Name(), l.path); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(l.path))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

type recordedModel struct{ original model.BaseChatModel }

func (m recordedModel) WithTools(infos []*schema.ToolInfo) (model.ToolCallingChatModel, error) {
	if original, ok := m.original.(model.ToolCallingChatModel); ok {
		bound, err := original.WithTools(infos)
		if err != nil {
			return nil, err
		}
		return recordedModel{bound}, nil
	}
	// Legacy models are supported by ADK via per-call options, avoiding mutation.
	return recordedModel{optionModel{original: m.original, infos: infos}}, nil
}

type optionModel struct {
	original model.BaseChatModel
	infos    []*schema.ToolInfo
}

func (m optionModel) Generate(ctx context.Context, in []*schema.Message, opts ...model.Option) (*schema.Message, error) {
	return m.original.Generate(ctx, in, append(opts, model.WithTools(m.infos))...)
}
func (m optionModel) Stream(ctx context.Context, in []*schema.Message, opts ...model.Option) (*schema.StreamReader[*schema.Message], error) {
	return m.original.Stream(ctx, in, append(opts, model.WithTools(m.infos))...)
}
func (m recordedModel) run(ctx context.Context, in []*schema.Message, stream bool, opts ...model.Option) (*schema.Message, error) {
	l, _ := ctx.Value(logKey{}).(*executionLog)
	if l == nil {
		return m.original.Generate(ctx, in, opts...)
	}
	l.mu.Lock()
	index := l.modelIndex
	l.modelIndex++
	sha := digest(in)
	if index < len(l.state.Models) {
		r := l.state.Models[index]
		l.mu.Unlock()
		if r.InputSHA != sha {
			return nil, errors.New("专员模型重放上下文已变化")
		}
		return r.Response, nil
	}
	l.mu.Unlock()
	var response *schema.Message
	var err error
	if stream {
		var reader *schema.StreamReader[*schema.Message]
		reader, err = m.original.Stream(ctx, in, opts...)
		if err == nil {
			defer reader.Close()
			var parts []*schema.Message
			var size int
			for {
				v, e := reader.Recv()
				if e == io.EOF {
					break
				}
				if e != nil {
					err = e
					break
				}
				b, _ := json.Marshal(v)
				size += len(b)
				if size > checkpointLimit {
					err = errors.New("专员模型响应过大")
					break
				}
				parts = append(parts, v)
			}
			if err == nil {
				response, err = schema.ConcatMessages(parts)
			}
		}
	} else {
		response, err = m.original.Generate(ctx, in, opts...)
	}
	if err != nil {
		return nil, err
	}
	if response == nil {
		return nil, errors.New("专员模型响应为空")
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.state.Models = append(l.state.Models, modelRecord{sha, response})
	if err = l.save(); err != nil {
		return nil, err
	}
	return response, nil
}
func (m recordedModel) Generate(ctx context.Context, in []*schema.Message, opts ...model.Option) (*schema.Message, error) {
	return m.run(ctx, in, false, opts...)
}
func (m recordedModel) Stream(ctx context.Context, in []*schema.Message, opts ...model.Option) (*schema.StreamReader[*schema.Message], error) {
	v, err := m.run(ctx, in, true, opts...)
	if err != nil {
		return nil, err
	}
	return schema.StreamReaderFromArray([]*schema.Message{v}), nil
}

type recordedTool struct {
	original tool.InvokableTool
	name     string
}

func (t recordedTool) Info(ctx context.Context) (*schema.ToolInfo, error) {
	return t.original.Info(ctx)
}
func readOnlyTool(name string, args string) bool {
	switch name {
	case "lake_code_list", "lake_code_read", "lake_code_search", "lake_code_status", "lake_code_diff", "lake_overview", "lake_resources", "lake_k8s_get", "lake_database_inspect", "lake_ssh_session_list", "lake_remote_code_list", "lake_remote_code_read", "lake_script_status", "lake_script_wait", "lake_script_jobs", "lake_workflow_recovery_complete":
		return true
	case "lake_ssh":
		var in struct{ Check, Command string }
		return json.Unmarshal([]byte(args), &in) == nil && in.Check != "" && in.Command == ""
	}
	return false
}
func (t recordedTool) InvokableRun(ctx context.Context, args string, opts ...tool.Option) (string, error) {
	l, _ := ctx.Value(logKey{}).(*executionLog)
	if l == nil {
		return t.original.InvokableRun(ctx, args, opts...)
	}
	l.mu.Lock()
	key := fmt.Sprintf("%d:%s:%s", l.modelIndex, compose.GetToolCallID(ctx), t.name)
	sha := digest(args)
	if prior, ok := l.state.Tools[key]; ok {
		if prior.InputSHA != sha {
			l.mu.Unlock()
			return "", errors.New("专员工具重放参数已变化")
		}
		if prior.Done {
			l.mu.Unlock()
			return prior.Output, nil
		}
		if !readOnlyTool(t.name, args) && !l.retryWrites {
			l.mu.Unlock()
			return "", ErrUnknownWrite
		}
	}
	l.state.Tools[key] = toolRecord{Name: t.name, InputSHA: sha}
	err := l.save()
	l.mu.Unlock()
	if err != nil {
		return "", err
	}
	output, err := t.original.InvokableRun(ctx, args, opts...)
	if err != nil {
		return "", err
	}
	if !readOnlyTool(t.name, args) && uncertainToolOutput(t.name, output) {
		return "", fmt.Errorf("%w；工具 %s，保留检查点；先核对外部任务状态，不自动重放", ErrUnknownWrite, t.name)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.state.Tools[key] = toolRecord{Name: t.name, InputSHA: sha, Output: output, Done: true}
	if err = l.save(); err != nil {
		return "", err
	}
	return output, nil
}

func uncertainToolOutput(name, output string) bool {
	if name == "lake_ssh" {
		// The SSH service distinguishes pre-execution rejection from a transport
		// or audit failure after execution. Old outputs remain conservative.
		var value struct {
			Unknown *bool `json:"unknown"`
		}
		if json.Unmarshal([]byte(output), &value) == nil && value.Unknown != nil {
			return *value.Unknown
		}
	}
	return uncertainOutput(output)
}

func uncertainOutput(output string) bool {
	var value any
	if json.Unmarshal([]byte(output), &value) != nil {
		return false
	}
	var visit func(any) bool
	visit = func(v any) bool {
		switch x := v.(type) {
		case map[string]any:
			for k, c := range x {
				if k == "unknown" && c == true {
					return true
				}
				if k == "error" {
					if text, ok := c.(string); ok && text != "" {
						return true
					}
				}
				if visit(c) {
					return true
				}
			}
		case []any:
			for _, c := range x {
				if visit(c) {
					return true
				}
			}
		}
		return false
	}
	return visit(value)
}
