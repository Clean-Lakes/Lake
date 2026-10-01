package credential

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// FileVault keeps Lake credentials in files readable only by the current user.
// It never contacts the macOS Keychain. The files are not application-encrypted.
type FileVault struct{ Root string }

func (v FileVault) base() (string, error) {
	root := v.Root
	if root == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		root = filepath.Join(home, ".lake")
	}
	return filepath.Abs(filepath.Join(root, "secrets"))
}

func (v FileVault) secretPath(kind, id string) (string, error) {
	if !validSecretName(id) {
		return "", errors.New("无效的凭据名称")
	}
	base, err := v.base()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, kind, id), nil
}

func validSecretName(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, ch := range value {
		if ch < 'a' || ch > 'z' {
			if ch < '0' || ch > '9' {
				if ch != '-' && ch != '_' {
					return false
				}
			}
		}
	}
	return true
}

func ensurePrivateDir(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("凭据目录不是普通目录: %s", path)
	}
	return os.Chmod(path, 0700)
}

func writeSecret(path string, secret []byte) error {
	if len(secret) == 0 {
		return errors.New("凭据内容为空")
	}
	if err := ensurePrivateDir(filepath.Dir(filepath.Dir(filepath.Dir(path)))); err != nil {
		return err
	}
	if err := ensurePrivateDir(filepath.Dir(filepath.Dir(path))); err != nil {
		return err
	}
	if err := ensurePrivateDir(filepath.Dir(path)); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".lake-secret-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err := file.Chmod(0600); err != nil {
		file.Close()
		return err
	}
	if _, err := file.Write(secret); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}

func readSecret(path string) ([]byte, error) {
	for _, dir := range []string{filepath.Dir(filepath.Dir(filepath.Dir(path))), filepath.Dir(filepath.Dir(path)), filepath.Dir(path)} {
		info, err := os.Lstat(dir)
		if err != nil {
			return nil, err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0077 != 0 {
			return nil, fmt.Errorf("凭据目录权限不安全: %s", dir)
		}
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return nil, fmt.Errorf("凭据文件权限不安全: %s", path)
	}
	return os.ReadFile(path)
}

func (v FileVault) Import(privateKey []byte) (string, error) {
	return v.importKind("ssh", privateKey)
}

func (v FileVault) importKind(kind string, secret []byte) (string, error) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", err
	}
	name := hex.EncodeToString(id[:])
	path, err := v.secretPath(kind, name)
	if err != nil {
		return "", err
	}
	if err := writeSecret(path, secret); err != nil {
		return "", err
	}
	return "file:" + kind + "/" + name, nil
}

func (v FileVault) ImportKubeconfig(data []byte) (string, error) {
	if len(data) == 0 || len(data) > 4*1024*1024 {
		return "", errors.New("kubeconfig 为空或超过 4 MB")
	}
	return v.importKind("kubeconfig", data)
}

func (v FileVault) ImportDatabasePassword(data []byte) (string, error) {
	if len(data) == 0 || len(data) > 65536 {
		return "", errors.New("数据库密码为空或过长")
	}
	return v.importKind("database", data)
}

func (v FileVault) LoadDatabasePassword(ref string) ([]byte, error) {
	path, err := v.databasePasswordPath(ref)
	if err != nil {
		return nil, err
	}
	return readSecret(path)
}

func (v FileVault) DeleteDatabasePassword(ref string) error {
	path, err := v.databasePasswordPath(ref)
	if err != nil {
		return err
	}
	return os.Remove(path)
}

func (v FileVault) databasePasswordPath(ref string) (string, error) {
	if !strings.HasPrefix(ref, "file:database/") {
		return "", errors.New("无效的数据库凭据引用")
	}
	id := strings.TrimPrefix(ref, "file:database/")
	if len(id) != 32 || !validSecretName(id) {
		return "", errors.New("无效的数据库凭据引用")
	}
	return v.secretPath("database", id)
}

func (v FileVault) LoadKubeconfig(ref string) ([]byte, error) {
	path, err := v.kubeconfigPath(ref)
	if err != nil {
		return nil, err
	}
	return readSecret(path)
}

func (v FileVault) DeleteKubeconfig(ref string) error {
	path, err := v.kubeconfigPath(ref)
	if err != nil {
		return err
	}
	return os.Remove(path)
}

func (v FileVault) kubeconfigPath(ref string) (string, error) {
	if !strings.HasPrefix(ref, "file:kubeconfig/") {
		return "", errors.New("无效的 kubeconfig 凭据引用")
	}
	id := strings.TrimPrefix(ref, "file:kubeconfig/")
	if len(id) != 32 || !validSecretName(id) {
		return "", errors.New("无效的 kubeconfig 凭据引用")
	}
	return v.secretPath("kubeconfig", id)
}

func sshID(ref string) (string, error) {
	if !strings.HasPrefix(ref, "file:ssh/") {
		return "", errors.New("SSH 私钥仍在钥匙串；请先运行 lake secrets migrate")
	}
	id := strings.TrimPrefix(ref, "file:ssh/")
	if len(id) != 32 || !validSecretName(id) {
		return "", errors.New("无效的 SSH 凭据引用")
	}
	return id, nil
}

func (v FileVault) Load(ref string) ([]byte, error) {
	id, err := sshID(ref)
	if err != nil {
		return nil, err
	}
	path, err := v.secretPath("ssh", id)
	if err != nil {
		return nil, err
	}
	secret, err := readSecret(path)
	if err == nil && len(secret) == 0 {
		return nil, errors.New("SSH 私钥内容为空")
	}
	return secret, err
}

func (v FileVault) Delete(ref string) error {
	id, err := sshID(ref)
	if err != nil {
		return err
	}
	path, err := v.secretPath("ssh", id)
	if err != nil {
		return err
	}
	return os.Remove(path)
}

func (v FileVault) PutModelAPIKey(provider string, key []byte) error {
	if !validSecretName(provider) || len(key) == 0 || len(key) > 65536 {
		return errors.New("无效的模型提供方或 API Key")
	}
	path, err := v.secretPath("model", provider)
	if err != nil {
		return err
	}
	return writeSecret(path, key)
}

func (v FileVault) LoadModelAPIKey(provider string) ([]byte, error) {
	path, err := v.secretPath("model", provider)
	if err != nil {
		return nil, err
	}
	key, err := readSecret(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("模型 API Key 尚未迁移；请运行 lake secrets migrate 或 lake model login --provider %s", provider)
	}
	if err == nil && (len(key) == 0 || len(key) > 65536) {
		return nil, errors.New("本地模型 API Key 无效")
	}
	return key, err
}

func (v FileVault) HasModelAPIKey(provider string) (bool, error) {
	path, err := v.secretPath("model", provider)
	if err != nil {
		return false, err
	}
	secret, err := readSecret(path)
	for i := range secret {
		secret[i] = 0
	}
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

func (v FileVault) DeleteModelAPIKey(provider string) error {
	path, err := v.secretPath("model", provider)
	if err != nil {
		return err
	}
	return os.Remove(path)
}

// MCPSecrets keeps server environment variables and HTTP headers out of settings.json.
func (v FileVault) PutMCPSecrets(name string, data []byte) error {
	if len(data) > 65536 {
		return errors.New("MCP 凭据过大")
	}
	path, err := v.secretPath("mcp", name)
	if err != nil {
		return err
	}
	return writeSecret(path, data)
}

func (v FileVault) LoadMCPSecrets(name string) ([]byte, error) {
	path, err := v.secretPath("mcp", name)
	if err != nil {
		return nil, err
	}
	data, err := readSecret(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return data, err
}

func (v FileVault) DeleteMCPSecrets(name string) error {
	path, err := v.secretPath("mcp", name)
	if err != nil {
		return err
	}
	err = os.Remove(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
