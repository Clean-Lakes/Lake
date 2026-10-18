package web

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"github.com/Clean-Lakes/Lake/internal/platform"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"golang.org/x/text/encoding/simplifiedchinese"
	textunicode "golang.org/x/text/encoding/unicode"
)

const importTextLimit = 1 << 20

type importSource struct {
	ID, Project, Session, Name, Text string
}
type importCandidate struct {
	Name, Kind, Folder, Error string
	Config                    Object
}
type importPlan struct {
	ID, Project, Session, Name string
	Candidates                 []importCandidate
	Source                     string
	Notice                     string
}

// Serialize commits so a replay or concurrent selection cannot create duplicates.
var importCommitMu sync.Mutex

func validateImportText(value string) {
	if value == "" || len(value) > importTextLimit || !utf8.ValidString(value) || strings.IndexFunc(value, func(r rune) bool { return r < 32 && r != '\n' && r != '\r' && r != '\t' }) >= 0 {
		fail(400, "请选择有效文本文件（每个文件最多 1 MB）；不支持二进制文件")
	}
}
func (b *Server) importFilePath(prefix, id string) string {
	if !regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(id) {
		fail(400, "导入标识无效")
	}
	root := filepath.Join(b.Models.Home, "secrets")
	must(platform.MkdirAll(root, 0700))
	rootInfo, rootErr := os.Lstat(root)
	if rootErr != nil || !rootInfo.IsDir() || !platform.Private(root, rootInfo) {
		fail(400, "Lake 凭据目录须归当前用户所有且权限为 0700")
	}
	dir := filepath.Join(root, "resource-imports")
	must(platform.MkdirAll(dir, 0700))
	info, err := os.Lstat(dir)
	if err != nil || !platform.Private(dir, info) || info.Mode()&os.ModeSymlink != 0 {
		fail(400, "导入目录须归当前用户所有且权限为 0700")
	}
	return filepath.Join(dir, prefix+id+".json")
}
func (b *Server) saveImportSource(project, session, name, value string) Object {
	b.Store.Project(project)
	validateImportText(value)
	source := importSource{ident(), project, session, text(name, "文件名", 200), value}
	must(atomicFile(b.importFilePath("source-", source.ID), []byte(jsonText(source))))
	return Object{"sourceId": source.ID, "name": source.Name}
}
func (b *Server) loadImportSource(project, session, id string) importSource {
	if attachmentID.MatchString(id) {
		a, filename := b.loadAttachment(project, session, id)
		if a.Size > importTextLimit {
			fail(400, "资源导入的文本附件最多 1 MiB")
		}
		verifyAttachment(a, filename)
		raw, err := os.ReadFile(filename)
		must(err)
		return importSource{id, project, session, a.Name, decodeImportFile(raw)}
	}
	var source importSource
	p := b.importFilePath("source-", id)
	if _, err := privateFile(filepath.Join(b.Models.Home, "secrets"), p); err != nil {
		fail(400, "文本附件权限无效")
	}
	data, err := os.ReadFile(p)
	if err != nil || json.Unmarshal(data, &source) != nil {
		fail(404, "文本附件不存在，请重新选择文件")
	}
	if source.Project != project || source.Session != session {
		fail(403, "只能读取当前项目和聊天的文本附件")
	}
	return source
}
func (b *Server) loadImportPlan(project, session, id string) importPlan {
	var plan importPlan
	p := b.importFilePath("plan-", id)
	if _, err := privateFile(filepath.Join(b.Models.Home, "secrets"), p); err != nil {
		fail(400, "导入预览权限无效")
	}
	data, err := os.ReadFile(p)
	if err != nil || json.Unmarshal(data, &plan) != nil {
		fail(404, "导入预览不存在，请重新识别文件")
	}
	if plan.Project != project || plan.Session != session {
		fail(403, "只能导入当前项目和聊天的资源预览")
	}
	return plan
}

var importKeyBlock = regexp.MustCompile(`(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----`)
var importSecretField = regexp.MustCompile(`(?i)("?(?:password|passwd|passphrase|private[_-]?key|api[_-]?key|token|secret|密码|口令)"?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)`)
var importURLPassword = regexp.MustCompile(`([a-zA-Z][a-zA-Z0-9+.-]*://[^\s/@:]+:)([^\s/@]+)(@)`)

func maskImportText(raw string) (string, map[string]string) {
	secrets := map[string]string{}
	token := func(value string) string {
		id := "LAKE_IMPORT_SECRET_" + strconv.Itoa(len(secrets)+1)
		secrets[id] = value
		return id
	}
	masked := importKeyBlock.ReplaceAllStringFunc(raw, func(value string) string { return token(value) })
	masked = importSecretField.ReplaceAllStringFunc(masked, func(match string) string {
		parts := importSecretField.FindStringSubmatch(match)
		value := parts[2]
		if strings.HasPrefix(value, "\"") {
			var decoded string
			if json.Unmarshal([]byte(value), &decoded) == nil {
				value = decoded
			}
		} else {
			value = strings.Trim(value, "'")
		}
		if strings.HasPrefix(value, "LAKE_IMPORT_SECRET_") {
			return parts[1] + strconv.Quote(value)
		}
		return parts[1] + strconv.Quote(token(value))
	})
	masked = importURLPassword.ReplaceAllStringFunc(masked, func(match string) string {
		parts := importURLPassword.FindStringSubmatch(match)
		value, err := url.PathUnescape(parts[2])
		if err != nil {
			value = parts[2]
		}
		return parts[1] + token(value) + parts[3]
	})
	return masked, secrets
}

func importFieldName(value string) string {
	value = strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(strings.TrimSpace(value), "_", ""), "-", ""))
	return mapAlias(value)
}
func mapAlias(value string) string {
	aliases := map[string]string{"名称": "name", "资源名称": "name", "类型": "kind", "type": "kind", "ip": "host", "地址": "host", "主机": "host", "hostname": "host", "端口": "port", "user": "username", "用户": "username", "用户名": "username", "密码": "password", "passwd": "password", "口令": "passphrase", "目录": "folder", "分组": "folder", "dirpath": "folder", "dbtype": "driver", "db": "database", "数据库": "database", "privatekey": "privateKey", "identityfile": "identityFile", "authmethod": "authMethod", "credentialref": "credentialRef", "sslmode": "sslmode"}
	if alias := aliases[value]; alias != "" {
		return alias
	}
	return value
}
func normalizeImportRecord(record Object) Object {
	out := Object{}
	for k, v := range record {
		out[importFieldName(k)] = v
	}
	if nested := object(record["ssh"]); len(nested) > 0 {
		for k, v := range nested {
			out[importFieldName(k)] = v
		}
		out["kind"] = "ssh"
	}
	if nested := object(record["settings"]); len(nested) > 0 {
		for k, v := range nested {
			out[importFieldName(k)] = v
		}
	}
	return out
}

// HexHub export's SSH fields use a fixed AES-CBC compatibility layer. Decode
// locally; these values must never be returned to the model or preview UI.
func decodeHexHubSecretText(value string) string {
	if value == "" {
		return ""
	}
	data, err := base64.StdEncoding.DecodeString(value)
	if err != nil || len(data) == 0 || len(data)%aes.BlockSize != 0 {
		fail(400, "HexHub 凭据格式无效")
	}
	block, _ := aes.NewCipher([]byte("CsN#&Uc!aOUQbh&B"))
	cipher.NewCBCDecrypter(block, []byte("w6KQ^MPlEx*mfHcb")).CryptBlocks(data, data)
	padding := int(data[len(data)-1])
	if padding < 1 || padding > aes.BlockSize {
		fail(400, "HexHub 凭据解码失败")
	}
	for _, value := range data[len(data)-padding:] {
		if int(value) != padding {
			fail(400, "HexHub 凭据解码失败")
		}
	}
	value = string(data[:len(data)-padding])
	if !utf8.ValidString(value) {
		fail(400, "HexHub 凭据解码失败")
	}
	return value
}

func decodeHexHubSecret(value string) string {
	value = decodeHexHubSecretText(value)
	if strings.HasPrefix(value, "{") {
		var key Object
		if json.Unmarshal([]byte(value), &key) == nil {
			return stringOf(key["privateKey"])
		}
	}
	return value
}

func hexHubRecord(input any) Object {
	if value, ok := input.(map[string]any); ok {
		copy := Object{}
		for key, item := range value {
			copy[key] = item
		}
		return copy
	}
	var value Object
	if json.Unmarshal([]byte(stringOf(input)), &value) != nil {
		return nil
	}
	return value
}

func structuredImportRecords(raw string) ([]Object, bool) {
	var data any
	if json.Unmarshal([]byte(strings.TrimPrefix(raw, "\ufeff")), &data) == nil {
		if doc, ok := data.(map[string]any); ok {
			list, exists := doc["list"]
			if !exists {
				list, exists = doc["data"]
			}
			if exists && doc["version"] != nil {
				if stringOf(doc["password"]) != "" {
					fail(400, "导出文件已整体加密，请在 HexHub 中导出未设置额外加密密码的文件")
				}
				keys := map[string]string{}
				for _, item := range objects(list) {
					if integer(item["type"]) == 1 {
						var value Object
						if value = hexHubRecord(item["data"]); value != nil {
							keys[stringOf(item["id"])] = decodeHexHubSecret(stringOf(value["privateKey"]))
						}
					}
				}
				out := []Object{}
				for _, item := range objects(list) {
					kind := integer(item["type"])
					if !set("2 4 15")[strconv.Itoa(kind)] {
						continue
					}
					var value Object
					if value = hexHubRecord(item["data"]); value == nil {
						continue
					}
					value["name"], value["folder"] = item["name"], item["dirPath"]
					value["username"] = value["user"]
					switch kind {
					case 2:
						value["kind"] = "ssh"
						password := decodeHexHubSecret(stringOf(value["password"]))
						if integer(value["authType"]) == 1 {
							key := decodeHexHubSecret(stringOf(value["privateKey"]))
							if key == "" {
								key = keys[stringOf(value["privateKeyId"])]
							}
							value["authMethod"], value["privateKey"], value["passphrase"] = "key", key, password
							delete(value, "password")
						} else {
							value["authMethod"], value["password"] = "password", password
						}
						if integer(object(value["proxy"])["method"]) != 0 {
							value["importError"] = "当前导入不支持跳板或代理配置"
						}
					case 4:
						value["kind"], value["driver"] = "database", map[int]string{0: "mysql", 1: "postgres", 17: "mysql"}[integer(value["dbType"])]
						if value["enableSsh"] == true {
							value["importError"] = "当前导入不支持数据库 SSH 隧道配置"
						}
						if integer(object(value["sslConfig"])["mode"]) == 0 {
							value["tls"], value["sslmode"] = false, "disable"
						} else {
							value["importError"] = "请在 Lake 中配置此连接的 TLS 证书"
						}
					case 15:
						value["kind"] = "redis"
						value["tls"] = integer(object(value["sslConfig"])["mode"]) != 0
						if integer(value["mode"]) != 0 {
							value["importError"] = "当前导入仅支持单节点 Redis"
						}
					}
					out = append(out, value)
				}
				return out, true
			}
			for _, name := range []string{"resources", "assets", "connections"} {
				if list, ok := doc[name].([]any); ok {
					return objects(list), true
				}
			}
			if doc["host"] != nil || doc["ssh"] != nil || doc["settings"] != nil {
				return []Object{doc}, true
			}
		} else if list, ok := data.([]any); ok {
			return objects(list), true
		}
	}
	for _, delimiter := range []rune{',', '\t', ';'} {
		reader := csv.NewReader(strings.NewReader(strings.TrimPrefix(raw, "\ufeff")))
		reader.Comma = delimiter
		rows, err := reader.ReadAll()
		if err != nil || len(rows) < 2 {
			continue
		}
		hostColumn := false
		for _, header := range rows[0] {
			hostColumn = hostColumn || importFieldName(header) == "host"
		}
		if !hostColumn {
			continue
		}
		out := []Object{}
		for _, row := range rows[1:] {
			item := Object{}
			for i, header := range rows[0] {
				item[importFieldName(header)] = row[i]
			}
			out = append(out, item)
		}
		return out, true
	}
	return nil, false
}

func importFolder(value string) string {
	parts := []string{}
	for _, part := range strings.Split(strings.ReplaceAll(value, "\\", "/"), "/") {
		if part == "" {
			continue
		}
		if part == "." || part == ".." || strings.ContainsAny(part, "\r\n\x00") || len(part) > 120 {
			fail(400, "资源目录无效")
		}
		parts = append(parts, part)
	}
	if len(parts) > 32 {
		fail(400, "目录层级最多 32 级")
	}
	return strings.Join(parts, "/")
}

func (b *Server) prepareImportCandidate(record Object, secrets map[string]string, source string) (candidate importCandidate) {
	defer func() {
		if p := recover(); p != nil {
			candidate.Config = nil
			candidate.Error = "连接配置无效"
			if f, ok := p.(*Failure); ok {
				candidate.Error = f.Message
			}
		}
	}()
	r := normalizeImportRecord(record)
	if value, ok := r["tls"].(string); ok {
		if value == "true" {
			r["tls"] = true
		} else if value == "false" {
			r["tls"] = false
		} else {
			fail(400, "TLS 须为 true 或 false")
		}
	}
	for _, field := range []string{"password", "passphrase", "privateKey"} {
		value := stringOf(r[field])
		if secret, exists := secrets[value]; exists {
			r[field] = secret
		} else if strings.HasPrefix(value, "LAKE_IMPORT_SECRET_") {
			fail(400, "识别的凭据引用无效")
		}
	}
	if stringOf(r["importerror"]) != "" {
		fail(400, stringOf(r["importerror"]))
	}
	kind := strings.ToLower(stringOf(r["kind"]))
	if kind == "" {
		kind = "ssh"
	}
	if kind == "db" || set("mysql postgres postgresql starrocks sqlite")[kind] {
		if r["driver"] == nil {
			r["driver"] = kind
		}
		kind = "database"
	}
	candidate.Kind = kind
	name := stringOf(r["name"])
	if name == "" {
		name = stringOf(r["host"])
	}
	if name == "" {
		name = stringOf(r["endpoint"])
	}
	candidate.Name = text(name, "资源名称", 120)
	candidate.Folder = importFolder(stringOf(r["folder"]))
	if raw, ok := r["port"].(string); ok && raw != "" {
		port, err := strconv.Atoi(raw)
		if err != nil {
			fail(400, "端口须为整数")
		}
		r["port"] = port
	} else if raw == "" && ok {
		delete(r, "port")
	}
	config := Object{}
	if kind == "ssh" {
		for _, field := range strings.Fields("host port username authMethod identityFile privateKey password passphrase shell") {
			if r[field] != nil && r[field] != "" {
				config[field] = r[field]
			}
		}
		// A metadata-only fallback remains importable; the preview explicitly
		// reports unavailable login information.
		if source == "hexhub" && (config["username"] == nil || (config["identityFile"] == nil && config["privateKey"] == nil && config["password"] == nil)) {
			for _, field := range strings.Fields("authMethod identityFile privateKey password passphrase") {
				delete(config, field)
			}
			if !hostPattern.MatchString(stringOf(config["host"])) {
				fail(400, "SSH 主机地址无效")
			}
			if config["port"] != nil {
				port := integer(config["port"])
				if float64(port) != number(config["port"]) || port < 1 || port > 65535 {
					fail(400, "SSH 端口须为 1..65535")
				}
			}
		} else {
			if config["authMethod"] == nil {
				if config["privateKey"] != nil || config["identityFile"] != nil {
					config["authMethod"] = "key"
				} else {
					config["authMethod"] = "password"
				}
			}
			var cleanup func()
			config, cleanup = prepareSSH(b.Models.Home, config)
			_ = cleanup // Validated credential files remain available to this saved plan.
		}
	} else if set("database redis docker")[kind] {
		for _, field := range strings.Fields("driver host port username database path endpoint tls sslmode db") {
			if r[field] != nil && r[field] != "" {
				config[field] = r[field]
			}
		}
		driver := strings.ToLower(stringOf(config["driver"]))
		if driver == "postgresql" || driver == "pg" {
			driver = "postgres"
		}
		if driver == "starrocks" {
			driver = "mysql"
		}
		if kind == "database" {
			config["driver"] = driver
		}
		if config["port"] == nil {
			switch {
			case kind == "redis":
				config["port"] = 6379
			case driver == "postgres":
				config["port"] = 5432
			case driver == "mysql":
				config["port"] = 3306
			}
		}
		config = validateService(kind, config)
		if password := stringOf(r["password"]); password != "" {
			ref := "import-service-" + ident() + ".json"
			root := filepath.Join(b.Models.Home, "secrets")
			must(platform.MkdirAll(root, 0700))
			info, err := os.Lstat(root)
			if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !platform.Private(root, info) {
				fail(400, "Lake 凭据目录须归当前用户所有且权限为 0700")
			}
			must(atomicFile(filepath.Join(root, ref), []byte(jsonText(Object{"password": password}))))
			config["credentialRef"] = ref
		}
	} else {
		fail(400, "仅支持 SSH、数据库、Redis 和 Docker 资源")
	}
	candidate.Config = config
	return candidate
}

func publicImportPlan(plan importPlan) Object {
	rows := []Object{}
	for i, item := range plan.Candidates {
		row := Object{"index": i, "name": item.Name, "kind": item.Kind, "folder": item.Folder, "error": item.Error}
		for _, field := range strings.Fields("host port username driver database endpoint authMethod") {
			if item.Config[field] != nil {
				row[field] = item.Config[field]
			}
		}
		row["hasCredential"] = item.Config["credentialRef"] != nil || item.Config["identityFile"] != nil
		rows = append(rows, row)
	}
	return Object{"planId": plan.ID, "name": plan.Name, "resources": rows, "notice": plan.Notice}
}

func (b *Server) previewResourceImport(ctx context.Context, project, session string, input Object) Object {
	b.Store.Project(project)
	name, raw := stringOf(input["name"]), stringOf(input["text"])
	source, notice := "", ""
	records, parsed := []Object{}, false
	secrets := map[string]string{}
	if hex, ok := input["hexhub"].(bool); ok && hex {
		name, source = "HexHub 资产", "hexhub"
		records, notice = b.hexHubRecordsWithLogins(ctx, b.fetchHexHubAssets(ctx))
		parsed = true
	} else if id := stringOf(input["source_id"]); id != "" {
		attachment := b.loadImportSource(project, session, id)
		name, raw = attachment.Name, attachment.Text
	} else if path := stringOf(input["path"]); path != "" {
		if strings.HasPrefix(path, "~/") {
			h, _ := os.UserHomeDir()
			path = filepath.Join(h, path[2:])
		}
		path, err := filepath.EvalSymlinks(path)
		if err != nil {
			fail(400, "无法读取指定文本文件")
		}
		secretRoot := filepath.Join(b.Models.Home, "secrets")
		if path == secretRoot || strings.HasPrefix(path, secretRoot+string(os.PathSeparator)) || strings.Contains(strings.ToLower(path), "/keychains/") {
			fail(403, "不能通过导入读取 Lake 凭据或 Keychain")
		}
		f, err := os.Open(path)
		if err != nil {
			fail(400, "无法读取指定文本文件")
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil || !info.Mode().IsRegular() || info.Size() > importTextLimit {
			fail(400, "请选择不超过 1 MB 的普通文本文件")
		}
		data, err := io.ReadAll(io.LimitReader(f, importTextLimit+1))
		if err != nil {
			fail(400, "读取文本文件失败")
		}
		raw, name = decodeImportFile(data), filepath.Base(path)
	}
	if source != "hexhub" {
		validateImportText(raw)
		if name == "" {
			name = "文本资源配置"
		}
		records, parsed = structuredImportRecords(raw)
	}
	if !parsed {
		model := b.Models.Active()
		if model == nil {
			fail(400, "识别此文本需要先配置模型；JSON/CSV 文件可直接导入")
		}
		masked, values := maskImportText(raw)
		secrets = values
		var err error
		records, err = ai.ExtractImportResources(ctx, *model, masked)
		if err != nil {
			fail(400, err.Error())
		}
		for _, record := range records {
			config := normalizeImportRecord(record)
			for _, field := range []string{"password", "passphrase", "privateKey"} {
				value := stringOf(config[field])
				if value != "" {
					if _, ok := secrets[value]; !ok {
						record["importError"] = "无法确认凭据来源，请在文件中使用 password/privateKey 等明确字段"
					}
				}
			}
			if path := stringOf(config["identityFile"]); path != "" && !strings.Contains(raw, path) {
				record["importError"] = "私钥文件路径须明确出现在源文件中"
			}
		}
	}
	if len(records) == 0 || len(records) > 1000 {
		fail(400, "未识别到连接配置，或资源数量超过 1000 条")
	}
	plan := importPlan{ID: ident(), Project: project, Session: session, Name: text(name, "文件名", 200), Source: source, Notice: notice}
	for _, record := range records {
		plan.Candidates = append(plan.Candidates, b.prepareImportCandidate(record, secrets, source))
	}
	must(atomicFile(b.importFilePath("plan-", plan.ID), []byte(jsonText(plan))))
	return publicImportPlan(plan)
}

func importConnectionKey(kind string, config Object) string {
	return importIdentityKey(kind, config, "host port username driver database path endpoint")
}
func importEndpointKey(kind string, config Object) string {
	return importIdentityKey(kind, config, "host port driver database path endpoint")
}
func importIdentityKey(kind string, config Object, fields string) string {
	key := Object{"kind": kind}
	for _, field := range strings.Fields(fields) {
		key[field] = config[field]
	}
	if key["port"] == nil {
		switch {
		case kind == "ssh":
			key["port"] = 22
		case kind == "redis":
			key["port"] = 6379
		case kind == "database" && config["driver"] == "mysql":
			key["port"] = 3306
		case kind == "database" && config["driver"] == "postgres":
			key["port"] = 5432
		}
	}
	return jsonText(key)
}

// validateImportedSSH 校验缺少登录信息的导入条目：连接目标必须有效。
func validateImportedSSH(v Object) {
	if !hostPattern.MatchString(stringOf(v["host"])) {
		fail(400, "SSH 主机地址无效")
	}
	if v["port"] != nil {
		port := integer(v["port"])
		if float64(port) != number(v["port"]) || port < 1 || port > 65535 {
			fail(400, "SSH port must be 1..65535")
		}
	}
}
func (b *Server) importFolderNode(project, folder string) string {
	parent := ""
	for _, name := range strings.Split(folder, "/") {
		if name == "" {
			continue
		}
		nodes := objects(b.Store.Catalog()["resourceTree"])
		found := ""
		for _, node := range nodes {
			if node["projectId"] == project && node["kind"] == "folder" && stringOf(node["parentId"]) == parent && node["name"] == name {
				found = stringOf(node["id"])
				break
			}
		}
		if found == "" {
			for _, node := range b.Store.EditResourceTree(project, Object{"operation": "create", "name": name, "parentId": parent}) {
				if node["kind"] == "folder" && stringOf(node["parentId"]) == parent && node["name"] == name {
					found = stringOf(node["id"])
					break
				}
			}
		}
		parent = found
	}
	return parent
}
func selectImportIndexes(plan importPlan, indexes any) []int {
	selected := []int{}
	if indexes == nil {
		for i, item := range plan.Candidates {
			if item.Error == "" {
				selected = append(selected, i)
			}
		}
	} else {
		values, ok := indexes.([]any)
		if !ok {
			fail(400, "请选择有效的导入条目")
		}
		seen := map[int]bool{}
		for _, value := range values {
			switch value.(type) {
			case float64, int, int64:
			default:
				fail(400, "请选择有效的导入条目")
			}
			index := integer(value)
			if number(value) != float64(index) || index < 0 || index >= len(plan.Candidates) || seen[index] || plan.Candidates[index].Error != "" {
				fail(400, "请选择有效的导入条目")
			}
			seen[index] = true
			selected = append(selected, index)
		}
	}
	if len(selected) == 0 {
		fail(400, "请选择至少一个有效资源")
	}
	return selected
}
func (b *Server) commitResourceImport(project, session, id string, indexes any) Object {
	importCommitMu.Lock()
	defer importCommitMu.Unlock()
	b.messageMu.Lock()
	defer b.messageMu.Unlock()
	b.Terminals.mu.Lock()
	defer b.Terminals.mu.Unlock()
	plan := b.loadImportPlan(project, session, id)
	selected := selectImportIndexes(plan, indexes)
	// Revalidate all selected configurations before any resource write.
	for _, index := range selected {
		item := plan.Candidates[index]
		if item.Kind == "ssh" {
			if plan.Source == "hexhub" && !importSSHHasLogin(item.Config) {
				validateImportedSSH(item.Config)
			} else {
				validateSSH(b.Models.Home, item.Config)
			}
		} else {
			validateService(item.Kind, item.Config)
			if ref := stringOf(item.Config["credentialRef"]); ref != "" {
				if _, err := privateFile(filepath.Join(b.Models.Home, "secrets"), ref); err != nil {
					fail(400, "连接凭据不可用，请重新选择文件")
				}
			}
		}
	}
	existing := map[string]Object{}
	endpoints := map[string][]Object{}
	existingEndpoints := map[string]bool{}
	for _, resource := range objects(b.Store.Catalog()["resources"]) {
		if resource["projectId"] != project {
			continue
		}
		config := object(resource["settings"])
		if resource["kind"] == "ssh" {
			config = object(resource["ssh"])
		}
		existing[importConnectionKey(stringOf(resource["kind"]), config)] = resource
		endpoint := importLoginEndpointKey(stringOf(resource["kind"]), config)
		endpoints[endpoint] = append(endpoints[endpoint], resource)
		existingEndpoints[importEndpointKey(stringOf(resource["kind"]), config)] = true
	}
	updates := map[string]Object{}
	for _, index := range selected {
		item := plan.Candidates[index]
		if plan.Source != "hexhub" || !set("ssh database redis")[item.Kind] || !importResourceHasLogin(item.Kind, item.Config) {
			continue
		}
		found := existing[importConnectionKey(item.Kind, item.Config)]
		if found == nil {
			matches := endpoints[importLoginEndpointKey(item.Kind, item.Config)]
			if len(matches) > 1 {
				for _, match := range matches {
					if stringOf(importResourceConfig(match)["username"]) == "" {
						fail(409, "已有多个同端点资源，无法确定要同步哪个；请先在资源编辑中补齐登录信息")
					}
				}
			}
			if len(matches) == 1 && !importResourceHasLogin(item.Kind, importResourceConfig(matches[0])) && (stringOf(importResourceConfig(matches[0])["username"]) == "" || importResourceConfig(matches[0])["username"] == item.Config["username"]) && (stringOf(importResourceConfig(matches[0])["database"]) == "" || importResourceConfig(matches[0])["database"] == item.Config["database"]) {
				found = matches[0]
			}
		}
		if found != nil && !importResourceHasLogin(item.Kind, importResourceConfig(found)) {
			if previous, ok := updates[stringOf(found["id"])]; ok && importConnectionKey(item.Kind, previous) != importConnectionKey(item.Kind, item.Config) {
				fail(409, "多个导入条目匹配同一资源，请仅选择一个登录配置")
			}
			config := Object{}
			for key, value := range item.Config {
				config[key] = value
			}
			if shell := importResourceConfig(found)["shell"]; shell != nil {
				config["shell"] = shell
			}
			updates[stringOf(found["id"])] = config
		}
	}
	if len(updates) > 0 {
		for sid, running := range b.runningMessages {
			if running && b.Store.Session(sid)["projectId"] == project {
				fail(409, "请等待项目中本轮 AI 任务结束后同步登录信息")
			}
		}
		b.Store.SyncImportedLogins(project, updates)
		for _, session := range objects(b.Store.Catalog()["sessions"]) {
			if session["projectId"] == project {
				b.resetConnectionFailures(stringOf(session["id"]))
			}
		}
	}
	created, skipped, updated := []Object{}, []Object{}, []Object{}
	updatedKeys := map[string]bool{}
	for id, config := range updates {
		resource := b.Store.Resource(id)
		existing[importConnectionKey(stringOf(resource["kind"]), config)] = resource
		endpoint := importLoginEndpointKey(stringOf(resource["kind"]), config)
		endpoints[endpoint] = []Object{resource}
		updatedKeys[importConnectionKey(stringOf(resource["kind"]), config)] = true
		existingEndpoints[importEndpointKey(stringOf(resource["kind"]), config)] = true
		updated = append(updated, Object{"name": resource["name"], "kind": resource["kind"]})
	}
	for _, index := range selected {
		item := plan.Candidates[index]
		key, endpoint := importConnectionKey(item.Kind, item.Config), importLoginEndpointKey(item.Kind, item.Config)
		if updatedKeys[key] {
			continue
		}
		if found := existing[key]; found != nil || (stringOf(item.Config["username"]) == "" && existingEndpoints[importEndpointKey(item.Kind, item.Config)]) {
			skipped = append(skipped, Object{"name": item.Name, "kind": item.Kind})
			continue
		}
		resource := b.Store.CreateResource(project, item.Name, item.Kind, item.Config)
		b.Store.EditResourceTree(project, Object{"operation": "move", "nodeId": resource["id"], "parentId": b.importFolderNode(project, item.Folder)})
		existing[key] = resource
		endpoints[endpoint] = append(endpoints[endpoint], resource)
		existingEndpoints[importEndpointKey(item.Kind, item.Config)] = true
		created = append(created, Object{"name": item.Name, "kind": item.Kind})
	}
	return Object{"created": created, "skipped": skipped, "updated": updated, "createdCount": len(created), "skippedCount": len(skipped), "updatedCount": len(updated)}
}

func (b *Server) importBridgePolicy(id, name string, args Object) Object {
	project := stringOf(b.Store.Session(id)["projectId"])
	data := Object{"target": "项目资源导入", "runtime": "local", "fingerprint": fmt.Sprintf("%x", shaImport(jsonText(args)+project)), "risk": "readonly"}
	data["localFileRead"] = stringOf(args["path"]) != ""
	if name == "import_resources" {
		plan := b.loadImportPlan(project, id, stringOf(args["plan_id"]))
		data["risk"], data["target"] = "write", "导入资源到「"+stringOf(b.Store.Project(project)["name"])+"」"
		selected := selectImportIndexes(plan, args["indexes"])
		preview := publicImportPlan(plan)
		rows := objects(preview["resources"])
		filtered := []Object{}
		for _, index := range selected {
			filtered = append(filtered, rows[index])
		}
		preview["resources"] = filtered
		data["importPreview"] = preview
	}
	return data
}

func shaImport(value string) [32]byte { return sha256.Sum256([]byte(value)) }

func decodeImportFile(data []byte) string {
	if len(data) > importTextLimit {
		fail(400, "文本文件超过 1 MB")
	}
	var decoded []byte
	var err error
	switch {
	case len(data) >= 2 && data[0] == 0xff && data[1] == 0xfe:
		decoded, err = textunicode.UTF16(textunicode.LittleEndian, textunicode.ExpectBOM).NewDecoder().Bytes(data)
	case len(data) >= 2 && data[0] == 0xfe && data[1] == 0xff:
		decoded, err = textunicode.UTF16(textunicode.BigEndian, textunicode.ExpectBOM).NewDecoder().Bytes(data)
	case utf8.Valid(data):
		decoded = data
	default:
		decoded, err = simplifiedchinese.GB18030.NewDecoder().Bytes(data)
	}
	if err != nil {
		fail(400, "文件编码无法识别，请保存为 UTF-8 后重试")
	}
	value := strings.TrimPrefix(string(decoded), "\ufeff")
	validateImportText(value)
	return value
}
