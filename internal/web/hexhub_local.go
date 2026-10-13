package web

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// Local login material supplements only an unambiguously matching MCP asset.
// The reader never accesses model-provider stores, Keychain or browser logins.
func readHexHubLocalAssets(ctx context.Context) ([]Object, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	profiles, err := filepath.Glob(filepath.Join(home, ".hexhub", "cache", "Default", "IndexedDB", "http_localhost_*.indexeddb.leveldb"))
	if err != nil || len(profiles) != 1 {
		return nil, errors.New("未找到唯一的 HexHub 本地连接存储")
	}
	var assets []Object
	for attempts := 0; attempts < 3; attempts++ {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		assets, err = hexHubAssetsFromStorage(ctx, profiles[0])
		if err == nil {
			return assets, nil
		}
	}
	return nil, errHexHubStorage
}
func hexHubLocalIdentity(record Object) string {
	kind := stringOf(record["kind"])
	config := Object{}
	for _, key := range []string{"host", "port", "driver", "database"} {
		if record[key] != nil {
			config[key] = record[key]
		}
	}
	config["host"] = strings.ToLower(strings.TrimSpace(stringOf(config["host"])))
	// Database names are not exposed by list_assets. Match endpoint/driver only,
	// then require a unique name/folder match before copying the saved database.
	delete(config, "database")
	return jsonText(Object{"name": record["name"], "folder": importFolder(stringOf(record["folder"])), "endpoint": importEndpointKey(kind, config)})
}
func hexHubPrivateKey(value string) (key, phrase string) {
	decoded := decodeHexHubSecretText(value)
	if record := hexHubRecord(decoded); record != nil {
		return stringOf(record["privateKey"]), stringOf(record["password"])
	}
	return decoded, ""
}
func hexHubLocalRecord(item Object, references map[string]Object) (record Object) {
	record = Object{"name": item["name"], "folder": item["dirPath"]}
	defer func() {
		if recover() != nil {
			record["importError"] = "HexHub 登录信息无法解码，请在 HexHub 中检查此连接"
		}
	}()
	value := hexHubRecord(item["data"])
	if value == nil {
		record["importError"] = "HexHub 连接配置格式无效"
		return
	}
	for _, key := range []string{"host", "port", "database", "db"} {
		if value[key] != nil {
			record[key] = value[key]
		}
	}
	record["username"] = value["user"]
	switch integer(item["type"]) {
	case 2:
		record["kind"] = "ssh"
		if record["port"] == nil {
			record["port"] = 22
		}
		if record["username"] == nil {
			record["username"] = "root"
		}
		if integer(object(value["proxy"])["method"]) != 0 {
			record["importError"] = "当前导入不支持跳板或代理配置"
			return
		}
		switch integer(value["authType"]) {
		case 0:
			record["authMethod"], record["password"] = "password", decodeHexHubSecret(stringOf(value["password"]))
		case 1:
			var key, phrase string
			// HexHub gives a saved key reference precedence over an inline key.
			if ref := stringOf(value["privateKeyId"]); ref != "" {
				target := references[ref]
				if target == nil || integer(target["type"]) != 1 {
					record["importError"] = "HexHub 私钥引用不可用"
					return
				}
				saved := hexHubRecord(target["data"])
				key, phrase = hexHubPrivateKey(stringOf(saved["privateKey"]))
				if saved["password"] != nil {
					phrase = decodeHexHubSecret(stringOf(saved["password"]))
				}
			} else {
				key, phrase = hexHubPrivateKey(stringOf(value["privateKey"]))
			}
			if key == "" {
				record["importError"] = "HexHub 未保存可导入的私钥"
				return
			}
			record["authMethod"], record["privateKey"], record["passphrase"] = "key", key, phrase
		case 5:
			target := references[stringOf(value["passwordPairId"])]
			if target == nil || integer(target["type"]) != 19 {
				record["importError"] = "HexHub 用户名密码引用不可用"
				return
			}
			saved := hexHubRecord(target["data"])
			record["username"], record["password"], record["authMethod"] = saved["username"], saved["password"], "password"
		default:
			record["importError"] = "此 HexHub 登录方式不能同步，请在 Lake 中配置密码或私钥"
		}
	case 4:
		record["kind"], record["driver"] = "database", map[int]string{0: "mysql", 1: "postgres", 17: "mysql"}[integer(value["dbType"])]
		record["password"] = value["password"]
		if value["defaultDb"] != nil {
			record["database"] = value["defaultDb"]
		}
		if value["enableSsh"] == true {
			record["importError"] = "当前导入不支持数据库 SSH 隧道配置"
		}
		if integer(object(value["sslConfig"])["mode"]) == 0 {
			record["tls"], record["sslmode"] = false, "disable"
		} else {
			record["importError"] = "请在 Lake 中配置此连接的 TLS 证书"
		}
	case 15:
		record["kind"], record["password"] = "redis", value["password"]
		record["tls"] = integer(object(value["sslConfig"])["mode"]) != 0
		if integer(value["mode"]) != 0 {
			record["importError"] = "当前导入仅支持单节点 Redis"
		}
	}
	return
}
func (b *Server) hexHubRecordsWithLogins(ctx context.Context, assets []hexHubAsset) ([]Object, string) {
	records := hexHubImportRecords(assets)
	reader := b.HexHubLocalAssets
	if reader == nil {
		reader = readHexHubLocalAssets
	}
	local, err := reader(ctx)
	if err != nil {
		return records, "未能读取 HexHub 本地登录信息；本次仅导入连接清单，可在资源编辑中补充"
	}
	refs := map[string]Object{}
	for _, item := range local {
		refs[stringOf(item["id"])] = item
	}
	candidates := map[string][]Object{}
	for _, item := range local {
		switch integer(item["type"]) {
		case 2, 4, 15:
			record := hexHubLocalRecord(item, refs)
			key := hexHubLocalIdentity(record)
			candidates[key] = append(candidates[key], record)
		}
	}
	matched := 0
	for i, record := range records {
		if record["importError"] != nil {
			continue
		}
		matches := candidates[hexHubLocalIdentity(record)]
		if len(matches) != 1 {
			continue
		}
		records[i] = matches[0]
		matched++
	}
	if matched == 0 {
		return records, "未找到唯一匹配的本地登录信息；可在资源编辑中补充"
	}
	return records, "已读取本机 HexHub 保存的登录信息；密码和私钥不会在预览中显示"
}

func importSSHHasLogin(config Object) bool {
	if stringOf(config["username"]) == "" {
		return false
	}
	return stringOf(config["credentialRef"]) != "" || stringOf(config["identityFile"]) != "" || stringOf(config["privateKey"]) != "" || stringOf(config["password"]) != ""
}
func (s *Store) SyncImportedLogins(project string, updates map[string]Object) {
	s.update(func() any {
		s.projectIdleForDeletion(project)
		for id := range updates {
			resource := s.resource(id)
			if resource["projectId"] != project || !set("ssh database redis")[stringOf(resource["kind"])] || importResourceHasLogin(stringOf(resource["kind"]), importResourceConfig(resource)) {
				fail(409, "已有连接配置已变化，请重新预览导入")
			}
			s.resourceIdleForChange(id, "同步登录信息")
		}
		for id, config := range updates {
			if s.resource(id)["kind"] == "ssh" {
				s.exec("UPDATE resources SET description=? WHERE id=?", stringOf(config["username"])+"@"+stringOf(config["host"])+":"+jsonText(integer(config["port"])), id)
			}
			s.exec("INSERT INTO resourceConnections(resourceId,config) VALUES(?,?) ON CONFLICT(resourceId) DO UPDATE SET config=excluded.config", id, jsonText(config))
		}
		for _, session := range s.rows("SELECT id FROM sessions WHERE projectId=?", project) {
			s.event(stringOf(session["id"]), "session")
		}
		return nil
	})
}

func importResourceConfig(resource Object) Object {
	if resource["kind"] == "ssh" {
		return object(resource["ssh"])
	}
	return object(resource["settings"])
}
func importResourceHasLogin(kind string, config Object) bool {
	if kind == "ssh" {
		return importSSHHasLogin(config)
	}
	// Service connections can intentionally have no password. A saved database
	// username is sufficient to synchronize its login profile.
	if kind == "database" {
		return stringOf(config["username"]) != ""
	}
	return stringOf(config["credentialRef"]) != ""
}
func importLoginEndpointKey(kind string, config Object) string {
	return importIdentityKey(kind, config, "host port driver path endpoint")
}
