package kubernetes

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"io"
	"regexp"
	"strings"

	"go.yaml.in/yaml/v3"
)

const ConfigLimit = 1 << 20

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
type Connection struct {
	endpoint, selectedContext, namespace string
	token, username, password            string
	tls                                  *tls.Config
}

func boundedKubeYAML(n *yaml.Node, depth int, count *int) error {
	(*count)++
	if depth > 64 || *count > 20000 || n.Kind == yaml.AliasNode || n.Anchor != "" {
		return errors.New("Kubeconfig 结构过于复杂或含不支持的 YAML 引用")
	}
	for _, child := range n.Content {
		if err := boundedKubeYAML(child, depth+1, count); err != nil {
			return err
		}
	}
	return nil
}
func decodeKubeData(value, field string) ([]byte, error) {
	data, err := base64.StdEncoding.DecodeString(value)
	if err != nil || len(data) == 0 {
		return nil, errors.New("Kubeconfig 的 " + field + " 数据无效")
	}
	return data, nil
}
func ValidateNamespace(namespace string) error {
	if namespace != "" && (len(namespace) > 63 || !regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`).MatchString(namespace)) {
		return errors.New("命名空间须为有效的 Kubernetes 命名空间名称")
	}
	return nil
}
func text(v any) string { s, _ := v.(string); return s }
func (c Connection) Metadata() map[string]any {
	return map[string]any{"endpoint": c.endpoint, "context": c.selectedContext, "namespace": c.namespace}
}
func Resolve(raw string, settings map[string]any) (Connection, error) {
	if len(raw) == 0 || len(raw) > ConfigLimit || strings.ContainsRune(raw, '\x00') {
		return Connection{}, errors.New("请选择或粘贴非空 Kubeconfig，最大 1 MB")
	}
	decoder := yaml.NewDecoder(strings.NewReader(raw))
	var node yaml.Node
	if decoder.Decode(&node) != nil {
		return Connection{}, errors.New("Kubeconfig YAML 格式无效")
	}
	count := 0
	if err := boundedKubeYAML(&node, 0, &count); err != nil {
		return Connection{}, err
	}
	var extra yaml.Node
	if decoder.Decode(&extra) != io.EOF {
		return Connection{}, errors.New("Kubeconfig 须为单个 YAML 或 JSON 文档")
	}
	var doc kubeconfigDocument
	if node.Decode(&doc) != nil || doc.Kind != "" && doc.Kind != "Config" || doc.APIVersion != "" && doc.APIVersion != "v1" {
		return Connection{}, errors.New("请选择有效的 Kubernetes v1 Kubeconfig")
	}
	selected := text(settings["context"])
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
			return Connection{}, errors.New("Kubeconfig Context 名称为空或重复")
		}
		names[item.Name] = true
		if item.Name == selected {
			contextIndex = i
		}
	}
	if contextIndex < 0 {
		return Connection{}, errors.New("未找到所选 Context，请检查 current-context 或填写 Context 名称")
	}
	selectedContext := doc.Contexts[contextIndex].Context
	var cluster *kubeconfigCluster
	names = map[string]bool{}
	for _, item := range doc.Clusters {
		if item.Name == "" || names[item.Name] {
			return Connection{}, errors.New("Kubeconfig 集群名称为空或重复")
		}
		names[item.Name] = true
		if item.Name == selectedContext.Cluster {
			copy := item.Cluster
			cluster = &copy
		}
	}
	if cluster == nil {
		return Connection{}, errors.New("Context 引用的集群不存在")
	}
	if cluster.CAFile != "" && cluster.CAData == "" {
		return Connection{}, errors.New("请将 CA 证书内嵌到 certificate-authority-data，不读取 Kubeconfig 引用的本地文件")
	}
	if cluster.ProxyURL != "" {
		return Connection{}, errors.New("此版本暂不支持 Kubeconfig 的 proxy-url")
	}
	var user kubeconfigUser
	found := selectedContext.User == ""
	names = map[string]bool{}
	for _, item := range doc.Users {
		if item.Name == "" || names[item.Name] {
			return Connection{}, errors.New("Kubeconfig 用户名称为空或重复")
		}
		names[item.Name] = true
		if item.Name == selectedContext.User {
			user = item.User
			found = true
		}
	}
	if !found {
		return Connection{}, errors.New("Context 引用的用户不存在")
	}
	if user.Exec.Kind != 0 || user.AuthProvider.Kind != 0 {
		return Connection{}, errors.New("此版本不运行 Kubeconfig 认证插件，请使用内嵌 Token 或证书")
	}
	if user.TokenFile != "" || user.CertificateFile != "" && user.CertificateData == "" || user.KeyFile != "" && user.KeyData == "" {
		return Connection{}, errors.New("请使用内嵌 Token、client-certificate-data 和 client-key-data，不读取外部凭据文件")
	}
	if user.Impersonate != "" || user.ImpersonateUID != "" || len(user.ImpersonateGroups) > 0 || len(user.ImpersonateExtra) > 0 {
		return Connection{}, errors.New("此版本暂不支持 Kubeconfig 身份模拟")
	}
	if len(user.Token) > 16384 || strings.ContainsAny(user.Token, " \t\r\n\x00") {
		return Connection{}, errors.New("Kubeconfig Token 格式无效")
	}
	config := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: cluster.ServerName, InsecureSkipVerify: cluster.Insecure} // Selected kubeconfig or explicit TLS option controls verification.
	if cluster.ServerName != "" && !regexp.MustCompile(`^[a-zA-Z0-9_.:-]+$`).MatchString(cluster.ServerName) {
		return Connection{}, errors.New("Kubeconfig TLS server name 无效")
	}
	if cluster.CAData != "" {
		pool := x509.NewCertPool()
		ca, err := decodeKubeData(cluster.CAData, "CA 证书")
		if err != nil {
			return Connection{}, err
		}
		if !pool.AppendCertsFromPEM(ca) {
			return Connection{}, errors.New("Kubeconfig CA 证书无效")
		}
		config.RootCAs = pool
	}
	if user.CertificateData != "" || user.KeyData != "" {
		cert, err := decodeKubeData(user.CertificateData, "客户端证书")
		if err != nil {
			return Connection{}, err
		}
		key, err := decodeKubeData(user.KeyData, "客户端密钥")
		if err != nil {
			return Connection{}, err
		}
		pair, err := tls.X509KeyPair(cert, key)
		if err != nil {
			return Connection{}, errors.New("Kubeconfig 客户端证书与密钥无效或不匹配")
		}
		config.Certificates = []tls.Certificate{pair}
	}
	switch settings["tlsMode"] {
	case "verify":
		config.InsecureSkipVerify = false
	case "skip":
		config.InsecureSkipVerify = true
	}
	namespace := text(settings["namespace"])
	if namespace == "" {
		namespace = selectedContext.Namespace
	}
	if namespace == "" {
		namespace = "default"
	}
	if err := ValidateNamespace(namespace); err != nil {
		return Connection{}, err
	}
	return Connection{endpoint: strings.TrimRight(strings.TrimSpace(cluster.Server), "/"), selectedContext: selected, namespace: namespace, token: user.Token, username: user.Username, password: user.Password, tls: config}, nil
}
