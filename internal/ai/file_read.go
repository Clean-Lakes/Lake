package ai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"
)

const maxReadPageBytes = 32000

func (e *Engine) readFilePage(ctx context.Context, c Config, a map[string]any) (any, error) {
	path := str(a["path"])
	format := str(a["format"])
	ext := strings.ToLower(filepath.Ext(path))
	if format == "" || format == "auto" {
		format = "text"
		if strings.Contains(" .png .jpg .jpeg .gif .webp ", " "+ext+" ") {
			format = "image"
		}
		if ext == ".pdf" {
			format = "pdf"
		}
	}
	if format == "image" {
		if !c.Model.SupportsImageInput {
			return nil, errors.New("selected model cannot view images")
		}
		local := localFileRuntime(c, a)
		var data []byte
		if local {
			f, err := os.Open(path)
			if err != nil {
				return nil, err
			}
			defer f.Close()
			st, err := f.Stat()
			if err != nil || !st.Mode().IsRegular() {
				return nil, errors.New("image must be a regular file")
			}
			data, err = io.ReadAll(io.LimitReader(f, (2<<20)+1))
			if err != nil {
				return nil, err
			}
		} else {
			runtimeArgs := map[string]any{}
			for k, v := range a {
				runtimeArgs[k] = v
			}
			runtimeArgs["__output_limit"] = 3 << 20
			r, err := e.execRuntime(ctx, c, runtimeArgs, []string{"/bin/sh", "-c", "base64 < " + quote(path)}, "")
			if err != nil {
				return nil, err
			}
			if num(r["exitCode"], 0) != 0 || r["truncated"] == true {
				return nil, errors.New("image read failed or exceeds size limit")
			}
			data, err = base64.StdEncoding.DecodeString(strings.Join(strings.Fields(runtimeStdout(r)), ""))
			if err != nil {
				return nil, err
			}
		}
		images, err := ValidateImages([]ImageAttachment{{Base64: base64.StdEncoding.EncodeToString(data), Name: filepath.Base(path)}})
		if err != nil {
			return nil, err
		}
		return map[string]any{"path": path, "type": "image", "image": images[0]}, nil
	}
	offset, limit, byteOffset := num(a["offset"], 0), num(a["limit"], 200), num(a["byte_offset"], 0)
	if offset < 0 || limit < 1 || limit > 2000 || byteOffset < 0 {
		return nil, errors.New("invalid file page")
	}
	if format == "pdf" {
		argv := []string{"pdftotext", "-layout"}
		if pages := str(a["pages"]); pages != "" {
			bounds := strings.Split(pages, "-")
			start, err := strconv.Atoi(bounds[0])
			if err != nil || start < 1 || len(bounds) > 2 {
				return nil, errors.New("pages must be N or N-M")
			}
			end := start
			if len(bounds) == 2 {
				end, err = strconv.Atoi(bounds[1])
				if err != nil || end < start || end-start > 100 {
					return nil, errors.New("invalid PDF page range")
				}
			}
			argv = append(argv, "-f", strconv.Itoa(start), "-l", strconv.Itoa(end))
		}
		argv = append(argv, path, "-")
		r, err := e.execRuntime(ctx, c, a, argv, "")
		if err != nil {
			return nil, errors.New("PDF text adapter unavailable; install pdftotext on the runtime host")
		}
		if num(r["exitCode"], 0) != 0 {
			return nil, errors.New("PDF text extraction failed")
		}
		if r["truncated"] == true {
			return nil, errors.New("PDF text exceeds output limit; select a smaller pages range")
		}
		return textReadPage(path, runtimeStdout(r), offset, limit, byteOffset, "", c)
	}
	if format != "text" {
		return nil, errors.New("unsupported read format")
	}
	if localFileRuntime(c, a) {
		f, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		st, err := f.Stat()
		if err != nil || !st.Mode().IsRegular() {
			return nil, errors.New("read requires a regular file")
		}
		if st.Size() > maxStoredToolResultBytes {
			return nil, errors.New("file exceeds 16 MiB read limit; narrow the source")
		}
		data, err := io.ReadAll(io.LimitReader(f, maxStoredToolResultBytes+1))
		if err != nil {
			return nil, err
		}
		if len(data) > maxStoredToolResultBytes {
			return nil, errors.New("file exceeds read limit")
		}
		if bytes.IndexByte(data, 0) >= 0 || !utf8.Valid(data) {
			return nil, errors.New("binary file cannot be read as text")
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return textReadPage(path, string(data), offset, limit, byteOffset, hash(string(data)), c)
	}
	// Hash and selected lines come from the same explicit runtime. Never open an interactive terminal for file reads.
	hashResult, err := e.execRuntime(ctx, c, a, []string{"/bin/sh", "-c", "if command -v sha256sum >/dev/null 2>&1; then sha256sum -- " + quote(path) + "; else shasum -a 256 -- " + quote(path) + "; fi"}, "")
	if err != nil {
		return nil, err
	}
	contentHash := ""
	fields := strings.Fields(runtimeStdout(hashResult))
	if num(hashResult["exitCode"], 0) == 0 && len(fields) > 0 && validFileHash(fields[0]) {
		contentHash = strings.ToLower(fields[0])
	}
	cmd := fmt.Sprintf("sed -n '%d,%dp' %s", offset+1, offset+limit+1, quote(path))
	if byteOffset > 0 {
		cmd += " | tail -c +" + strconv.Itoa(byteOffset+1)
	}
	r, err := e.execRuntime(ctx, c, a, []string{"/bin/sh", "-c", cmd}, "")
	if err != nil {
		return nil, err
	}
	if num(r["exitCode"], 0) != 0 {
		return nil, errors.New("file read failed")
	}
	text := runtimeStdout(r)
	if strings.IndexByte(text, 0) >= 0 || !utf8.ValidString(text) {
		return nil, errors.New("binary file cannot be read as text")
	}
	value, err := textReadPage(path, text, 0, limit, 0, contentHash, c)
	if err != nil {
		return nil, err
	}
	out := obj(value)
	out["offset"] = offset
	if n, ok := out["next_offset"]; ok {
		out["next_offset"] = offset + num(n, 0)
		if num(n, 0) == 0 {
			out["next_byte_offset"] = byteOffset + num(out["next_byte_offset"], 0)
		}
	}
	if r["truncated"] == true {
		out["truncated"] = true
		out["source_truncated"] = true
	}
	return out, nil
}

func validFileHash(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, ch := range value {
		if !(ch >= '0' && ch <= '9' || ch >= 'a' && ch <= 'f' || ch >= 'A' && ch <= 'F') {
			return false
		}
	}
	return true
}
func localFileRuntime(c Config, a map[string]any) bool {
	runtime := str(a["runtime"])
	if runtime == "" {
		runtime = c.Runtime
	}
	return runtime == "local" || runtime == ""
}
func textReadPage(path, content string, offset, limit, byteOffset int, contentHash string, c Config) (any, error) {
	// ReadString preserves the missing trailing newline; its source is already bounded.
	reader := bufio.NewReader(strings.NewReader(content))
	line := 0
	selected := strings.Builder{}
	nextLine, nextByte, more := offset, byteOffset, false
	for {
		part, err := reader.ReadString('\n')
		if err != nil && err != io.EOF {
			return nil, err
		}
		if len(part) == 0 {
			break
		}
		if line >= offset {
			start := 0
			if line == offset {
				start = byteOffset
			}
			if start > len(part) || start < len(part) && part[start]&0xc0 == 0x80 {
				return nil, errors.New("invalid byte_offset")
			}
			if line >= offset+limit {
				more = true
				nextLine = line
				nextByte = 0
				break
			}
			remain := part[start:]
			room := maxReadPageBytes - selected.Len()
			piece := utf8Prefix(remain, room)
			selected.WriteString(piece)
			if len(piece) < len(remain) {
				more = true
				nextLine = line
				nextByte = start + len(piece)
				break
			}
		}
		line++
		if err == io.EOF {
			break
		}
	}
	if offset > line {
		return nil, errors.New("offset outside file")
	}
	out := map[string]any{"path": path, "type": "text", "content": redact(selected.String(), c), "offset": offset, "truncated": more}
	if contentHash != "" {
		out["content_hash"] = contentHash
	}
	if more {
		out["next_offset"] = nextLine
		out["next_byte_offset"] = nextByte
	}
	return out, nil
}
func fileReadKey(c Config, a map[string]any) string {
	args := hostArguments(c, a)
	ref := str(args["asset_ref"])
	if as, err := asset(c, ref); err == nil {
		ref = as.ID
	}
	container := str(a["container_id"])
	if container == "" {
		container = c.Container
	}
	return js([]string{str(args["runtime"]), ref, container, filepath.Clean(str(a["path"]))})
}
