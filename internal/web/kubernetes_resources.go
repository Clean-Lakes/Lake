package web

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"

	kube "github.com/Clean-Lakes/Lake/internal/kubernetes"
)

const kubeconfigLimit = kube.ConfigLimit

func validateKubeNamespace(namespace string) {
	if err := kube.ValidateNamespace(namespace); err != nil {
		fail(400, err.Error())
	}
}
func normalizeKubernetesSettings(settings, secrets Object) Object {
	if settings["authMethod"] == "kubeconfig" {
		connection, err := kube.Resolve(stringOf(secrets["kubeconfig"]), settings)
		if err != nil {
			fail(400, err.Error())
		}
		for key, value := range connection.Metadata() {
			settings[key] = value
		}
	}
	return validateService("kubernetes", settings)
}
func stringSecrets(values Object) map[string]string {
	result := map[string]string{}
	for key, value := range values {
		result[key] = stringOf(value)
	}
	return result
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
	client, err := kube.New(settings, stringSecrets(secrets))
	if err != nil {
		fail(400, err.Error())
	}
	defer client.Close()
	result, err := client.Query(ctx, kube.Query{Metric: "version"})
	if err != nil {
		if errors.Is(err, kube.ErrTimeout) {
			fail(504, err.Error())
		}
		fail(400, err.Error())
	}
	result["success"], result["message"] = true, "连接成功"
	return result
}
