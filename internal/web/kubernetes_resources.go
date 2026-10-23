package web

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"
)

const kubeconfigLimit = 1 << 20

// Parse uploaded content only: never run kubeconfig plugins or resolve file paths.
type kubeconfigDocument struct {
	APIVersion     string `yaml:"apiVersion"`
	Kind           string `yaml:"kind"`
	CurrentContext string `yaml:"current-context"`
	Clusters       []struct {
		Name    string            `yaml:"name"`
		Cluster kubeconfigCluster `yaml:"cluster"`
	} `yaml:"clusters"`
	Contexts []struct {
		Name    string `yaml:"name"`
		Context struct {
			Cluster   string `yaml:"cluster"`
			User      string `yaml:"user"`
			Namespace string `yaml:"namespace"`
		} `yaml:"context"`
	} `yaml:"contexts"`
	Users []struct {
		Name string         `yaml:"name"`
		User kubeconfigUser `yaml:"user"`
	} `yaml:"users"`
}
type kubeconfigCluster struct {
	Server     string `yaml:"server"`
	CAData     string `yaml:"certificate-authority-data"`
	CAFile     string `yaml:"certificate-authority"`
	Insecure   bool   `yaml:"insecure-skip-tls-verify"`
	ServerName string `yaml:"tls-server-name"`
	ProxyURL   string `yaml:"proxy-url"`
}
type kubeconfigUser struct {
	Token             string              `yaml:"token"`
	TokenFile         string              `yaml:"tokenFile"`
	Username          string              `yaml:"username"`
	Password          string              `yaml:"password"`
	CertificateData   string              `yaml:"client-certificate-data"`
	KeyData           string              `yaml:"client-key-data"`
	CertificateFile   string              `yaml:"client-certificate"`
	KeyFile           string              `yaml:"client-key"`
	Exec              yaml.Node           `yaml:"exec"`
	AuthProvider      yaml.Node           `yaml:"auth-provider"`
	Impersonate       string              `yaml:"as"`
	ImpersonateUID    string              `yaml:"as-uid"`
	ImpersonateGroups []string            `yaml:"as-groups"`
	ImpersonateExtra  map[string][]string `yaml:"as-user-extra"`
}
type kubernetesConnection struct {
	endpoint, selectedContext, namespace string
	token, username, password            string
	tls                                  *tls.Config
}

func boundedKubeYAML(n *yaml.Node, depth int, count *int) {
	(*count)++
	if depth > 64 || *count > 20000 || n.Kind == yaml.AliasNode || n.Anchor != "" {
		fail(400, "Kubeconfig 结构过于复杂或含不支持的 YAML 引用")
	}
	for _, child := range n.Content {
		boundedKubeYAML(child, depth+1, count)
	}
}
func decodeKubeData(value, field string) []byte {
	data, err := base64.StdEncoding.DecodeString(value)
	if err != nil || len(data) == 0 {
		fail(400, "Kubeconfig 的 "+field+" 数据无效")
	}
	return data
}
func validateKubeNamespace(namespace string) {
	if namespace != "" && (len(namespace) > 63 || !regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`).MatchString(namespace)) {
		fail(400, "命名空间须为有效的 Kubernetes 命名空间名称")
	}
}
func parseKubeconfig(raw string, settings Object) kubernetesConnection {
	if len(raw) == 0 || len(raw) > kubeconfigLimit || strings.ContainsRune(raw, '\x00') {
		fail(400, "请选择或粘贴非空 Kubeconfig，最大 1 MB")
	}
	decoder := yaml.NewDecoder(strings.NewReader(raw))
	var node yaml.Node
	if decoder.Decode(&node) != nil {
		fail(400, "Kubeconfig YAML 格式无效")
	}
	count := 0
	boundedKubeYAML(&node, 0, &count)
	var extra yaml.Node
	if decoder.Decode(&extra) != io.EOF {
		fail(400, "Kubeconfig 须为单个 YAML 或 JSON 文档")
	}
	var doc kubeconfigDocument
	if node.Decode(&doc) != nil || doc.Kind != "" && doc.Kind != "Config" || doc.APIVersion != "" && doc.APIVersion != "v1" {
		fail(400, "请选择有效的 Kubernetes v1 Kubeconfig")
	}
	selected := stringOf(settings["context"])
	if selected == "" {
		selected = doc.CurrentContext
	}
	if selected == "" && len(doc.Contexts) == 1 {
		selected = doc.Contexts[0].Name
	}
	contextIndex := -1
	names := map[string]bool{}
	for i, item := range doc.Contexts {
		if item.Name == "" || names[item.Name] {
			fail(400, "Kubeconfig Context 名称为空或重复")
		}
		names[item.Name] = true
		if item.Name == selected {
			contextIndex = i
		}
	}
	if contextIndex < 0 {
		fail(400, "未找到所选 Context，请检查 current-context 或填写 Context 名称")
	}
	selectedContext := doc.Contexts[contextIndex].Context
	var cluster *kubeconfigCluster
	names = map[string]bool{}
	for _, item := range doc.Clusters {
		if item.Name == "" || names[item.Name] {
			fail(400, "Kubeconfig 集群名称为空或重复")
		}
		names[item.Name] = true
		if item.Name == selectedContext.Cluster {
			copy := item.Cluster
			cluster = &copy
		}
	}
	if cluster == nil {
		fail(400, "Context 引用的集群不存在")
	}
	if cluster.CAFile != "" && cluster.CAData == "" {
		fail(400, "请将 CA 证书内嵌到 certificate-authority-data，不读取 Kubeconfig 引用的本地文件")
	}
	if cluster.ProxyURL != "" {
		fail(400, "此版本暂不支持 Kubeconfig 的 proxy-url")
	}
	var user kubeconfigUser
	found := selectedContext.User == ""
	names = map[string]bool{}
	for _, item := range doc.Users {
		if item.Name == "" || names[item.Name] {
			fail(400, "Kubeconfig 用户名称为空或重复")
		}
		names[item.Name] = true
		if item.Name == selectedContext.User {
			user = item.User
			found = true
		}
	}
	if !found {
		fail(400, "Context 引用的用户不存在")
	}
	if user.Exec.Kind != 0 || user.AuthProvider.Kind != 0 {
		fail(400, "此版本不运行 Kubeconfig 认证插件，请使用内嵌 Token 或证书")
	}
	if user.TokenFile != "" || user.CertificateFile != "" && user.CertificateData == "" || user.KeyFile != "" && user.KeyData == "" {
		fail(400, "请使用内嵌 Token、client-certificate-data 和 client-key-data，不读取外部凭据文件")
	}
	if user.Impersonate != "" || user.ImpersonateUID != "" || len(user.ImpersonateGroups) > 0 || len(user.ImpersonateExtra) > 0 {
		fail(400, "此版本暂不支持 Kubeconfig 身份模拟")
	}
	if len(user.Token) > 16384 || strings.ContainsAny(user.Token, " \t\r\n\x00") {
		fail(400, "Kubeconfig Token 格式无效")
	}
	config := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: cluster.ServerName, InsecureSkipVerify: cluster.Insecure} // Selected kubeconfig or explicit TLS option controls verification.
	if cluster.ServerName != "" && !hostPattern.MatchString(cluster.ServerName) {
		fail(400, "Kubeconfig TLS server name 无效")
	}
	if cluster.CAData != "" {
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(decodeKubeData(cluster.CAData, "CA 证书")) {
			fail(400, "Kubeconfig CA 证书无效")
		}
		config.RootCAs = pool
	}
	if user.CertificateData != "" || user.KeyData != "" {
		pair, err := tls.X509KeyPair(decodeKubeData(user.CertificateData, "客户端证书"), decodeKubeData(user.KeyData, "客户端密钥"))
		if err != nil {
			fail(400, "Kubeconfig 客户端证书与密钥无效或不匹配")
		}
		config.Certificates = []tls.Certificate{pair}
	}
	switch settings["tlsMode"] {
	case "verify":
		config.InsecureSkipVerify = false
	case "skip":
		config.InsecureSkipVerify = true
	}
	namespace := stringOf(settings["namespace"])
	if namespace == "" {
		namespace = selectedContext.Namespace
	}
	if namespace == "" {
		namespace = "default"
	}
	validateKubeNamespace(namespace)
	return kubernetesConnection{endpoint: cluster.Server, selectedContext: selected, namespace: namespace, token: user.Token, username: user.Username, password: user.Password, tls: config}
}

func normalizeKubernetesSettings(settings, secrets Object) Object {
	if settings["authMethod"] == "kubeconfig" {
		connection := parseKubeconfig(stringOf(secrets["kubeconfig"]), settings)
		settings["endpoint"], settings["context"], settings["namespace"] = connection.endpoint, connection.selectedContext, connection.namespace
	}
	return validateService("kubernetes", settings)
}

func testKubernetesConnection(ctx context.Context, home string, input Object) Object {
	settings, cleanup := prepareService(home, "kubernetes", input)
	defer cleanup()
	secrets := Object{}
	if ref := stringOf(settings["credentialRef"]); ref != "" {
		path, err := privateFile(filepath.Join(home, "secrets"), ref)
		if err != nil {
			fail(400, "Kubernetes 凭据不可用")
		}
		file, err := os.Open(path)
		if err != nil {
			fail(400, "Kubernetes 凭据不可用")
		}
		defer file.Close()
		data, err := io.ReadAll(io.LimitReader(file, 6*kubeconfigLimit+1))
		if err != nil || len(data) > 6*kubeconfigLimit || json.Unmarshal(data, &secrets) != nil {
			fail(400, "Kubernetes 凭据无效")
		}
	}
	connection := kubernetesConnection{endpoint: stringOf(settings["endpoint"]), token: stringOf(secrets["token"]), namespace: stringOf(settings["namespace"]), tls: &tls.Config{MinVersion: tls.VersionTLS12}}
	if settings["authMethod"] == "kubeconfig" {
		connection = parseKubeconfig(stringOf(secrets["kubeconfig"]), settings)
	} else if settings["tlsMode"] == "skip" {
		connection.tls.InsecureSkipVerify = true
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(integer(settings["requestTimeout"]))*time.Second)
	defer cancel()
	transport := &http.Transport{TLSClientConfig: connection.tls, DisableKeepAlives: true, MaxResponseHeaderBytes: 64 << 10}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(connection.endpoint, "/")+"/version", nil)
	if err != nil {
		fail(400, "Kubernetes API Server 地址无效")
	}
	request.Header.Set("Accept", "application/json")
	if connection.token != "" {
		request.Header.Set("Authorization", "Bearer "+connection.token)
	} else if connection.username != "" || connection.password != "" {
		request.SetBasicAuth(connection.username, connection.password)
	}
	response, err := client.Do(request)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			fail(504, "连接超时，请检查集群地址或调整超时")
		}
		var verification *tls.CertificateVerificationError
		if errors.As(err, &verification) {
			fail(400, "TLS 证书验证失败，请检查 Kubeconfig 的 CA 证书与服务地址")
		}
		fail(400, "无法连接 Kubernetes API Server，请检查地址、网络和证书配置")
	}
	defer response.Body.Close()
	if response.StatusCode == 401 {
		fail(400, "Kubernetes 认证失败，请检查 Token 或客户端证书")
	}
	if response.StatusCode == 403 {
		fail(400, "Kubernetes 拒绝访问版本信息，请检查账号权限")
	}
	if response.StatusCode != 200 {
		fail(400, "Kubernetes API Server 未返回有效的版本信息")
	}
	var version struct {
		GitVersion string `json:"gitVersion"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&version) != nil || !regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$`).MatchString(version.GitVersion) || len(version.GitVersion) > 128 || connection.token != "" && strings.Contains(version.GitVersion, connection.token) {
		fail(400, "Kubernetes API Server 返回的版本信息无效")
	}
	return Object{"success": true, "message": "连接成功", "version": version.GitVersion, "endpoint": settings["endpoint"], "context": settings["context"], "namespace": settings["namespace"]}
}
