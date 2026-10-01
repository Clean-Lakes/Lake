package remote

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"path"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/cloudwego/eino/lake/store"
	sshtransport "github.com/cloudwego/eino/lake/transport/ssh"
)

const maxRemoteText = 64 << 10

type Runner interface {
	RunWithInput(context.Context, sshtransport.Target, []byte, string, []byte) (sshtransport.Result, error)
}

type Workspace struct {
	Root   string
	Target sshtransport.Target
	Key    []byte
	Runner Runner
}

type RunResult struct {
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	ExitCode  int    `json:"exit_code"`
	Truncated bool   `json:"truncated"`
	Unknown   bool   `json:"unknown"`
}

func (w Workspace) validate() error {
	if !store.ValidRemoteRoot(w.Root) || w.Target.Host == "" || w.Target.Username == "" || w.Target.Port < 1 || w.Target.Port > 65535 || len(w.Key) == 0 || w.Runner == nil {
		return errors.New("远程代码工作区连接参数无效")
	}
	return nil
}

func quote(value string) string { return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'" }

func allowedPath(relative string) bool {
	if relative == "" || strings.HasPrefix(relative, "/") || path.Clean(relative) != relative || len(relative) > 1024 || strings.ContainsAny(relative, "\x00\r\n\t\\") {
		return false
	}
	for _, part := range strings.Split(relative, "/") {
		lower := strings.ToLower(part)
		if part == "" || part == "." || part == ".." || lower == ".git" || lower == ".lake" || lower == ".ssh" || lower == "secrets" || lower == ".env" || strings.HasPrefix(lower, ".env.") && !strings.HasSuffix(lower, ".example") || strings.HasSuffix(lower, ".pem") || strings.HasSuffix(lower, ".key") || lower == "id_rsa" || lower == "id_ed25519" {
			return false
		}
	}
	return true
}

func (w Workspace) shell(ctx context.Context, script string, input []byte) (sshtransport.Result, error) {
	if err := w.validate(); err != nil {
		return sshtransport.Result{}, err
	}
	return w.Runner.RunWithInput(ctx, w.Target, w.Key, "sh -c "+quote(script), input)
}

func (w Workspace) prefix() string {
	return "set -eu; cd -- " + quote(w.Root) + "; [ \"$(pwd -P)\" = " + quote(w.Root) + " ] || exit 74; "
}

// Probe verifies that the registered root is an existing canonical directory.
func (w Workspace) Probe(ctx context.Context) error {
	result, err := w.shell(ctx, w.prefix()+"pwd -P", nil)
	if err != nil {
		return err
	}
	if result.ExitCode != 0 || strings.TrimSpace(result.Stdout) != w.Root {
		return errors.New("远程根目录不存在或并非规范物理路径")
	}
	return nil
}

func (w Workspace) List(ctx context.Context) ([]string, error) {
	result, err := w.shell(ctx, w.prefix()+"find . -type f -print0", nil)
	if err != nil {
		return nil, err
	}
	if result.ExitCode != 0 || result.Truncated {
		return nil, errors.New("远程文件列表失败或超过输出上限")
	}
	out := make([]string, 0)
	for _, raw := range strings.Split(result.Stdout, "\x00") {
		name := strings.TrimPrefix(raw, "./")
		if allowedPath(name) {
			out = append(out, name)
		}
		if len(out) >= 200 {
			break
		}
	}
	sort.Strings(out)
	return out, nil
}

func (w Workspace) Read(ctx context.Context, relative string) (string, error) {
	if !allowedPath(relative) {
		return "", errors.New("远程文件路径不在代码工作区或属于敏感文件")
	}
	script := w.prefix() + "target=$(realpath -- " + quote(relative) + "); case \"$target\" in " + quote(w.Root) + "/*) ;; *) exit 75;; esac; [ -f \"$target\" ] && [ ! -L \"$target\" ] || exit 76; head -c 65537 -- \"$target\""
	result, err := w.shell(ctx, script, nil)
	if err != nil {
		return "", err
	}
	if result.ExitCode != 0 || result.Truncated || len(result.Stdout) > maxRemoteText {
		return "", errors.New("远程文件读取失败或超过 64 KiB")
	}
	if !utf8.ValidString(result.Stdout) || strings.IndexByte(result.Stdout, 0) >= 0 {
		return "", errors.New("远程文件不是 UTF-8 文本")
	}
	return result.Stdout, nil
}

// Write uses a content hash precondition and a single SSH invocation. A
// transport failure after dispatch is always unknown; callers must not retry.
func (w Workspace) Write(ctx context.Context, relative, expectedSHA string, content []byte) (RunResult, error) {
	if !allowedPath(relative) || len(content) > maxRemoteText || bytes.IndexByte(content, 0) >= 0 || !utf8.Valid(content) {
		return RunResult{}, errors.New("远程写入只能使用工作区内不超过 64 KiB 的 UTF-8 文本")
	}
	if expectedSHA != "absent" {
		if len(expectedSHA) != 64 {
			return RunResult{}, errors.New("原文件哈希无效")
		}
		if _, err := hex.DecodeString(expectedSHA); err != nil {
			return RunResult{}, errors.New("原文件哈希无效")
		}
	}
	root := quote(w.Root)
	script := w.prefix() + "parent=$(realpath -- \"$(dirname -- " + quote(relative) + ")\"); case \"$parent\" in " + root + "|" + root + "/*) ;; *) exit 75;; esac; target=\"$parent/$(basename -- " + quote(relative) + ")\"; [ ! -L \"$target\" ] || exit 76; "
	if expectedSHA == "absent" {
		script += "[ ! -e \"$target\" ] || exit 77; "
	} else {
		script += "[ -f \"$target\" ] && [ \"$(sha256sum -- \"$target\" | cut -d ' ' -f 1)\" = " + quote(expectedSHA) + " ] || exit 77; "
	}
	script += "tmp=$(mktemp \"$parent/.lake-write.XXXXXX\"); trap 'rm -f \"$tmp\"' EXIT; cat > \"$tmp\"; chmod 600 \"$tmp\"; "
	if expectedSHA == "absent" {
		script += "ln -- \"$tmp\" \"$target\"; "
	} else {
		script += "mv -f -- \"$tmp\" \"$target\"; "
	}
	script += "sha256sum -- \"$target\" | cut -d ' ' -f 1"
	result, err := w.shell(ctx, script, content)
	if err != nil {
		return RunResult{Unknown: true}, errors.New("远程写入结果未知，请人工核对目标文件后再操作")
	}
	if result.ExitCode == 0 && strings.TrimSpace(result.Stdout) != ContentSHA(content) {
		return RunResult{Unknown: true}, errors.New("远程写入校验结果未知，请人工核对目标文件")
	}
	return RunResult{Stdout: result.Stdout, Stderr: result.Stderr, ExitCode: result.ExitCode, Truncated: result.Truncated}, nil
}

func (w Workspace) Run(ctx context.Context, command string) (RunResult, error) {
	if strings.TrimSpace(command) == "" || len(command) > 4000 || strings.ContainsAny(command, "\x00\r\n") {
		return RunResult{}, errors.New("远程命令须为不超过 4000 字符的单行文本")
	}
	script := w.prefix() + "sh -c " + quote(command)
	result, err := w.shell(ctx, script, nil)
	if err != nil {
		return RunResult{Unknown: true}, errors.New("远程命令结果未知，请人工核对后再操作")
	}
	return RunResult{Stdout: result.Stdout, Stderr: result.Stderr, ExitCode: result.ExitCode, Truncated: result.Truncated}, nil
}

func ContentSHA(content []byte) string {
	digest := sha256.Sum256(content)
	return hex.EncodeToString(digest[:])
}
