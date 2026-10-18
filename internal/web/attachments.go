package web

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Clean-Lakes/Lake/internal/platform"
)

const attachmentLimit int64 = 512 << 20

var attachmentID = regexp.MustCompile(`^file-[a-f0-9]{32}$`)

type chatAttachment struct {
	SourceID string `json:"sourceId"`
	Name     string `json:"name"`
	Size     int64  `json:"sizeBytes"`
	SHA256   string `json:"sha256"`
	MIME     string `json:"mimeType"`
	Project  string `json:"project"`
	Session  string `json:"session"`
}

func (a chatAttachment) public() Object {
	return Object{"sourceId": a.SourceID, "name": a.Name, "sizeBytes": a.Size, "sha256": a.SHA256, "mimeType": a.MIME, "kind": "file"}
}
func (b *Server) attachmentRoot() string {
	root := filepath.Join(b.options.DataDir, "attachments")
	must(platform.MkdirAll(root, 0700))
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !platform.Private(root, info) {
		fail(400, "附件目录权限无效")
	}
	return root
}
func (b *Server) saveAttachment(project, session, name string, reader io.Reader, limit int64) Object {
	b.Store.Project(project)
	if strings.TrimSpace(name) == "" || len(name) > 1000 || strings.ContainsAny(name, "/\\\x00\r\n") {
		fail(400, "文件名无效")
	}
	root := b.attachmentRoot()
	id := "file-" + ident()
	blob := filepath.Join(root, id+".blob")
	f, err := platform.OpenFile(blob, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	must(err)
	complete := false
	defer func() {
		f.Close()
		if !complete {
			os.Remove(blob)
			os.Remove(filepath.Join(root, id+".json"))
		}
	}()
	digest := sha256.New()
	size, err := io.Copy(io.MultiWriter(f, digest), io.LimitReader(reader, limit+1))
	if size > limit {
		fail(413, "每个附件最多 512 MiB")
	}
	if err != nil {
		fail(400, "附件上传未完成，请重新选择文件")
	}
	must(f.Sync())
	must(f.Close())
	probe := make([]byte, 512)
	input, err := os.Open(blob)
	must(err)
	n, _ := input.Read(probe)
	input.Close()
	typ := http.DetectContentType(probe[:n])
	if n == 0 {
		typ = "application/octet-stream"
	}
	a := chatAttachment{id, name, size, hex.EncodeToString(digest.Sum(nil)), typ, project, session}
	must(atomicFile(filepath.Join(root, id+".json"), []byte(jsonText(a))))
	complete = true
	return a.public()
}
func (b *Server) loadAttachment(project, session, id string) (chatAttachment, string) {
	if !attachmentID.MatchString(id) {
		fail(400, "附件标识无效")
	}
	root := b.attachmentRoot()
	meta := filepath.Join(root, id+".json")
	if _, err := privateFile(root, meta); err != nil {
		fail(404, "附件不存在，请重新选择文件")
	}
	raw, err := os.ReadFile(meta)
	var a chatAttachment
	if err != nil || len(raw) > 4096 || json.Unmarshal(raw, &a) != nil || a.SourceID != id {
		fail(404, "附件不存在")
	}
	if a.Project != project || a.Session != session {
		fail(403, "只能访问当前项目和会话的附件")
	}
	blob, err := privateFile(root, filepath.Join(root, id+".blob"))
	if err != nil {
		fail(400, "附件原件权限无效")
	}
	info, err := os.Stat(blob)
	if err != nil || info.Size() != a.Size {
		fail(409, "附件原件已变化，请重新上传")
	}
	return a, blob
}
func verifyAttachment(a chatAttachment, filename string) {
	f, err := os.Open(filename)
	must(err)
	defer f.Close()
	h := sha256.New()
	_, err = io.Copy(h, f)
	must(err)
	if hex.EncodeToString(h.Sum(nil)) != a.SHA256 {
		fail(409, "附件完整性校验失败，请重新上传")
	}
}
func (b *Server) attachmentRoute(w http.ResponseWriter, r *http.Request, id, source string) {
	project := stringOf(b.Store.Session(id)["projectId"])
	if source == "" && r.Method == "POST" {
		if r.ContentLength > attachmentLimit {
			fail(413, "每个附件最多 512 MiB")
		}
		name, err := url.PathUnescape(r.Header.Get("X-Lake-Filename"))
		if err != nil {
			fail(400, "文件名无效")
		}
		r.Body = http.MaxBytesReader(w, r.Body, attachmentLimit+1)
		reply(w, 201, b.saveAttachment(project, id, name, r.Body, attachmentLimit))
		return
	}
	if source != "" && r.Method == "GET" {
		if !attachmentID.MatchString(source) {
			legacy := b.loadImportSource(project, id, source)
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": legacy.Name}))
			w.Header().Set("X-Content-Type-Options", "nosniff")
			http.ServeContent(w, r, legacy.Name, time.Time{}, strings.NewReader(legacy.Text))
			return
		}
		a, filename := b.loadAttachment(project, id, source)
		f, err := os.Open(filename)
		must(err)
		defer f.Close()
		info, err := f.Stat()
		must(err)
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": a.Name}))
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		http.ServeContent(w, r, a.Name, info.ModTime(), f)
		return
	}
	fail(405, "附件操作不支持此请求")
}
func unsafeArchiveEntry(name string, link bool) bool {
	normalized := strings.ReplaceAll(name, "\\", "/")
	clean := path.Clean(normalized)
	return link || strings.HasPrefix(normalized, "/") || clean == ".." || strings.HasPrefix(clean, "../") || regexp.MustCompile(`^[A-Za-z]:`).MatchString(normalized) || strings.ContainsAny(name, "\x00\r\n")
}
func (b *Server) inspectAttachment(id string, args Object) Object {
	a, filename := b.loadAttachment(stringOf(b.Store.Session(id)["projectId"]), id, stringOf(args["source_id"]))
	verifyAttachment(a, filename)
	result := a.public()
	lower := strings.ToLower(a.Name)
	entries := []Object{}
	safe := true
	truncated := false
	add := func(name string, size int64, link bool) {
		bad := unsafeArchiveEntry(name, link)
		safe = safe && !bad
		entries = append(entries, Object{"name": name, "sizeBytes": size, "unsafe": bad})
	}
	if strings.HasSuffix(lower, ".zip") || strings.HasSuffix(lower, ".jar") || strings.HasSuffix(lower, ".war") || strings.HasSuffix(lower, ".apk") {
		archive, err := zip.OpenReader(filename)
		if err != nil {
			fail(400, "压缩包无法读取")
		}
		defer archive.Close()
		result["archiveFormat"] = "zip"
		for _, entry := range archive.File {
			if len(entries) >= 2000 {
				truncated = true
				break
			}
			add(entry.Name, int64(entry.UncompressedSize64), entry.Mode()&os.ModeSymlink != 0 || !entry.Mode().IsRegular() && !entry.FileInfo().IsDir())
		}
	} else if strings.HasSuffix(lower, ".tar") || strings.HasSuffix(lower, ".tar.gz") || strings.HasSuffix(lower, ".tgz") {
		f, err := os.Open(filename)
		must(err)
		defer f.Close()
		var input io.Reader = f
		if !strings.HasSuffix(lower, ".tar") {
			gz, err := gzip.NewReader(f)
			if err != nil {
				fail(400, "压缩包无法读取")
			}
			defer gz.Close()
			input = gz
		}
		archive := tar.NewReader(io.LimitReader(input, 32<<20))
		result["archiveFormat"] = "tar"
		for {
			entry, err := archive.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				truncated = true
				break
			}
			if len(entries) >= 2000 {
				truncated = true
				break
			}
			add(entry.Name, entry.Size, entry.Typeflag != tar.TypeReg && entry.Typeflag != tar.TypeDir && entry.Typeflag != tar.TypeRegA)
		}
	}
	if result["archiveFormat"] != nil {
		result["entries"] = entries
		result["truncated"] = truncated
		result["safeToExtract"] = safe && !truncated
	}
	if args["preview_text"] == true {
		if a.Size > importTextLimit {
			fail(400, "文本预览最多 1 MiB；大文件请先传到目标后使用文件工具读取")
		}
		raw, err := os.ReadFile(filename)
		must(err)
		value := decodeImportFile(raw)
		if len(value) > 32000 {
			value = value[:32000]
			for !utf8.ValidString(value) {
				value = value[:len(value)-1]
			}
		}
		result["textPreview"] = value
		result["textTruncated"] = len(raw) > 32000
	}
	return result
}
