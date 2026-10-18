package ai

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"

	"github.com/Clean-Lakes/Lake/internal/platform"
)

type attachmentReader struct {
	context context.Context
	reader  io.Reader
}

func (r attachmentReader) Read(p []byte) (int, error) {
	if err := r.context.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}

func (e *Engine) stageAttachment(ctx context.Context, id string, c Config, a map[string]any) (any, error) {
	if e.Bridge == nil {
		return nil, errors.New("附件需要 Lake 工作台")
	}
	value, err := e.bridgeCall(ctx, id, "attachment_source", map[string]any{"source_id": a["source_id"]}, false)
	if err != nil {
		return nil, err
	}
	source := obj(value)
	destination := str(a["path"])
	if err = safeFile(destination); err != nil {
		return nil, err
	}
	input, err := os.Open(str(source["path"]))
	if err != nil {
		return nil, errors.New("附件原件不可用")
	}
	defer input.Close()
	target := str(a["runtime"])
	if target == "local" {
		if err = safeLocalFile(destination); err != nil {
			return nil, err
		}
		as, err := asset(c, str(a["asset_ref"]))
		if err != nil || as.Kind != "local" {
			return nil, errors.New("local target requires local asset")
		}
		f, err := os.CreateTemp(filepath.Dir(destination), ".lake-attachment-*")
		if err != nil {
			return nil, errors.New("目标目录不可写或不存在")
		}
		temp := f.Name()
		defer os.Remove(temp)
		defer f.Close()
		if err = f.Chmod(0600); err != nil {
			return nil, err
		}
		digest := sha256.New()
		_, err = io.Copy(io.MultiWriter(f, digest), attachmentReader{ctx, input})
		if err != nil {
			return nil, err
		}
		if hex.EncodeToString(digest.Sum(nil)) != str(source["sha256"]) {
			return nil, errors.New("附件完整性校验失败")
		}
		if err = f.Sync(); err != nil {
			return nil, err
		}
		if err = f.Close(); err != nil {
			return nil, err
		}
		if err = ctx.Err(); err != nil {
			return nil, err
		}
		if a["overwrite"] == true {
			err = platform.ReplaceFile(temp, destination)
		} else {
			err = os.Link(temp, destination)
		}
		if err != nil {
			return nil, errors.New("目标已存在或无法写入；覆盖需要显式 overwrite")
		}
	} else {
		// All user values are positional parameters, never shell source. A hard link
		// makes the default no-overwrite publication atomic on the target filesystem.
		script := `set -eu
umask 077
dest=$1
expected=$2
overwrite=$3
[ ! -d "$dest" ] || exit 73
tmp=$(mktemp "${dest}.lake.XXXXXX")
trap 'rm -f "$tmp"' EXIT HUP INT TERM
cat > "$tmp"
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$tmp"); else actual=$(shasum -a 256 "$tmp"); fi
[ "${actual%% *}" = "$expected" ] || exit 74
if [ "$overwrite" = true ]; then mv -f "$tmp" "$dest"; else ln "$tmp" "$dest"; fi
`
		overwrite := "false"
		if a["overwrite"] == true {
			overwrite = "true"
		}
		args := map[string]any{}
		for k, v := range a {
			args[k] = v
		}
		if args["timeout_ms"] == nil {
			args["timeout_ms"] = 300000
		}
		result, err := e.execRuntimeInput(ctx, c, args, []string{"sh", "-c", script, "lake-stage", destination, str(source["sha256"]), overwrite}, input)
		if err != nil {
			return nil, err
		}
		if num(result["exitCode"], -1) != 0 {
			return nil, errors.New("附件传输未完成；请核查目标文件后再决定后续操作")
		}
	}
	return map[string]any{"transferred": true, "path": destination, "sha256": source["sha256"], "sizeBytes": source["sizeBytes"]}, nil
}
