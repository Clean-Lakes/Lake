package web

import (
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/platform"
)

// Only connection metadata belongs in the resource database. Human-entered
// passwords/tokens are saved separately and never returned in API responses.
func prepareService(home, kind string, input Object) (config Object, cleanup func()) {
	config = Object{}
	secrets := Object{}
	for key, value := range input {
		if key == "password" || key == "token" || key == "apiKey" || key == "kubeconfig" {
			secret, ok := value.(string)
			limit, invalidCharacters := 16384, "\r\n\x00"
			if key == "kubeconfig" {
				limit, invalidCharacters = kubeconfigLimit, "\x00"
			}
			if !ok || len(secret) > limit || strings.ContainsAny(secret, invalidCharacters) {
				fail(400, "凭据格式无效")
			}
			if secret != "" {
				secrets[key] = secret
			}
		} else {
			config[key] = value
		}
	}
	if len(secrets) > 0 {
		if stringOf(config["credentialRef"]) != "" {
			fail(400, "请只选择一种凭据来源")
		}
		allowed := set("password")
		if kind == "apisix" {
			allowed = set("apiKey")
		}
		if kind == "kubernetes" {
			allowed = set("token")
			if config["authMethod"] == "kubeconfig" {
				allowed = set("kubeconfig")
			}
		}
		if kind == "prometheus" || kind == "victoriametrics" {
			allowed = set("password token")
		}
		for key := range secrets {
			if !allowed[key] {
				fail(400, "该资源不支持此凭据类型")
			}
		}
		if kind == "docker" || kind == "database" && config["driver"] == "sqlite" || secrets["password"] != nil && secrets["token"] != nil {
			fail(400, "该资源的凭据配置无效")
		}
	}
	config = validateService(kind, config)
	if kind == "kubernetes" {
		config = normalizeKubernetesSettings(config, secrets)
	}
	root := filepath.Join(home, "secrets")
	if ref := stringOf(config["credentialRef"]); ref != "" {
		if _, err := privateFile(root, ref); err != nil {
			fail(400, "凭据须为当前 Lake Home 的 secrets 目录中的私有文件")
		}
	}
	cleanup = func() {}
	if len(secrets) == 0 {
		return
	}
	must(platform.MkdirAll(root, 0700))
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !platform.Private(root, info) {
		fail(400, "Lake 凭据目录须归当前用户所有且权限为 0700")
	}
	if username := stringOf(config["username"]); username != "" {
		secrets["username"] = username
	}
	ref := "service-secret-" + ident() + ".json"
	path := filepath.Join(root, ref)
	cleanup = func() { _ = os.Remove(path) }
	defer func() {
		if p := recover(); p != nil {
			cleanup()
			panic(p)
		}
	}()
	must(atomicFile(path, []byte(jsonText(secrets))))
	config["credentialRef"] = ref
	return
}

func validateService(kind string, input Object) Object {
	fields := map[string]string{
		"database":        "driver host port username database path credentialRef tls sslmode",
		"redis":           "host port username db credentialRef tls",
		"docker":          "endpoint ssh_asset_ref",
		"kubernetes":      "endpoint context namespace credentialRef authMethod requestTimeout tlsMode",
		"apisix":          "endpoint credentialRef",
		"prometheus":      "endpoint username credentialRef",
		"victoriametrics": "endpoint username credentialRef",
	}
	allowedFields, ok := fields[kind]
	if !ok {
		fail(400, "Unsupported resource type")
	}
	if len(input) == 0 || len(jsonText(input)) > 4000 {
		fail(400, "Connection settings required and must be under 4000 bytes")
	}
	allowed := set(allowedFields)
	v := Object{}
	for key, value := range input {
		if !allowed[key] {
			fail(400, "Unsupported connection field; credentials must use credentialRef")
		}
		if key == "port" || key == "db" || key == "requestTimeout" {
			switch value.(type) {
			case int, int64, float64:
			default:
				fail(400, "Port and database index must be numbers")
			}
		}
		if key == "tls" {
			if _, ok := value.(bool); !ok {
				fail(400, "TLS must be boolean")
			}
		} else if key != "port" && key != "db" && key != "requestTimeout" {
			text, ok := value.(string)
			if !ok || strings.ContainsAny(text, "\r\n\x00") {
				fail(400, "Connection fields must be text")
			}
		}
		v[key] = value
	}
	if v["credentialRef"] == "" {
		delete(v, "credentialRef")
	}
	if kind == "database" && !set("postgres mysql sqlite")[stringOf(v["driver"])] {
		fail(400, "Database driver must be postgres, mysql or sqlite")
	}
	if kind == "redis" || kind == "database" && v["driver"] != "sqlite" {
		if !hostPattern.MatchString(stringOf(v["host"])) {
			fail(400, "Explicit connection host required")
		}
		if v["port"] == nil {
			v["port"] = 5432
			if kind == "redis" {
				v["port"] = 6379
			} else if v["driver"] == "mysql" {
				v["port"] = 3306
			}
		}
		if n := number(v["port"]); n != float64(integer(v["port"])) || n < 1 || n > 65535 {
			fail(400, "Connection port must be 1..65535")
		}
	}
	if kind == "redis" {
		if v["db"] == nil {
			v["db"] = 0
		}
		if n := number(v["db"]); n != float64(integer(v["db"])) || n < 0 || n > 65535 {
			fail(400, "Redis database must be 0..65535")
		}
	}
	if kind == "database" {
		if v["driver"] == "sqlite" && !filepath.IsAbs(stringOf(v["path"])) {
			fail(400, "SQLite path must be absolute")
		}
		if mode := stringOf(v["sslmode"]); mode != "" && !set("disable allow prefer require verify-ca verify-full")[mode] {
			fail(400, "Invalid PostgreSQL SSL mode")
		}
	}
	if kind == "docker" {
		if stringOf(v["ssh_asset_ref"]) == "" && stringOf(v["endpoint"]) == "" {
			fail(400, "Docker endpoint or SSH resource required")
		}
		if endpoint := stringOf(v["endpoint"]); strings.ContainsAny(endpoint, "@?#") {
			fail(400, "Endpoint must not contain credentials")
		}
	}
	if kind == "kubernetes" {
		if v["authMethod"] == nil {
			v["authMethod"] = "token"
		}
		if !set("kubeconfig token")[stringOf(v["authMethod"])] {
			fail(400, "不支持的 Kubernetes 认证方式")
		}
		if v["requestTimeout"] == nil {
			v["requestTimeout"] = 10
		}
		if n := number(v["requestTimeout"]); n != float64(integer(v["requestTimeout"])) || n < 1 || n > 60 {
			fail(400, "Kubernetes 超时须为 1～60 秒的整数")
		}
		if v["tlsMode"] == nil {
			v["tlsMode"] = "config"
		}
		if !set("config verify skip")[stringOf(v["tlsMode"])] {
			fail(400, "不支持的 TLS 验证方式")
		}
		validateKubeNamespace(stringOf(v["namespace"]))
	}
	if set("kubernetes apisix prometheus victoriametrics")[kind] && !(kind == "kubernetes" && v["authMethod"] == "kubeconfig" && v["endpoint"] == nil) {
		endpoint := strings.TrimSpace(stringOf(v["endpoint"]))
		u, err := url.Parse(endpoint)
		if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || strings.ContainsAny(endpoint, "?#\\") || strings.ContainsAny(endpoint, " \t") {
			fail(400, "端点须为不含用户名、密码、查询参数或片段的 HTTP(S) 地址")
		}
		if port := u.Port(); port != "" {
			n, err := strconv.Atoi(port)
			if err != nil || n < 1 || n > 65535 {
				fail(400, "Connection port must be 1..65535")
			}
		}
		v["endpoint"] = strings.TrimRight(endpoint, "/")
	}
	return v
}
