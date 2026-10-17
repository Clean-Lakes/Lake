package web

import (
	"errors"
	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/platform"
	"golang.org/x/crypto/ssh"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func sshArguments(c Object, initialization ...string) []string {
	h, _ := os.UserHomeDir()
	known := filepath.Join(h, ".ssh", "known_hosts")
	args := []string{"-F", "/dev/null", "-tt", "-e", "none", "-a", "-x", "-o", "StrictHostKeyChecking=yes", "-o", "GlobalKnownHostsFile=/dev/null", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "AddKeysToAgent=no", "-o", "NumberOfPasswordPrompts=1", "-o", platform.SSHFileOption("UserKnownHostsFile", known), "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2"}
	if c["authMethod"] == "password" {
		args = append(args, "-o", "BatchMode=no", "-o", "PreferredAuthentications=password,keyboard-interactive", "-o", "KbdInteractiveAuthentication=yes", "-o", "PasswordAuthentication=yes", "-o", "PubkeyAuthentication=no")
	} else {
		batch := "yes"
		if stringOf(c["credentialRef"]) != "" {
			batch = "no"
		}
		args = append(args, "-o", "BatchMode="+batch, "-o", "PreferredAuthentications=publickey", "-o", "KbdInteractiveAuthentication=no", "-o", "PasswordAuthentication=no", "-i", stringOf(c["identityFile"]))
	}
	remote := remoteShellCommand(shellName(c["shell"]))
	if len(initialization) > 0 {
		remote = "/bin/sh -c " + quote("export __lake_init="+quote(initialization[0])+"; "+remote)
	}
	return append(args, "-p", strconv.Itoa(integer(c["port"])), "-l", stringOf(c["username"]), stringOf(c["host"]), remote)
}

// SSHAskpassFailureMessage lets the client report helper failures on the
// private pipe without exposing prompt or credential text.
const SSHAskpassFailureMessage = "SSH credential helper could not provide saved credentials"

// SSHAskpass writes only to OpenSSH's private helper pipe, never the terminal.
// The environment contains a reference; it never contains password material.
func SSHAskpass(prompt string, out io.Writer) error { return ai.SSHAskpass(prompt, out) }

func readSSHSecret(root, ref string) string {
	path, e := privateFile(root, ref)
	if e != nil {
		fail(400, "SSH 凭据不可用，请重新添加资源")
	}
	f, e := os.Open(path)
	if e != nil {
		fail(400, "SSH 凭据不可用")
	}
	defer f.Close()
	data, e := io.ReadAll(io.LimitReader(f, 4097))
	if e != nil || len(data) == 0 || len(data) > 4096 || strings.ContainsAny(string(data), "\r\n\x00") {
		fail(400, "SSH 凭据文件无效")
	}
	return string(data)
}

func expandSSHPath(path string) string {
	if path == "~" || strings.HasPrefix(path, "~/") {
		home, e := os.UserHomeDir()
		must(e)
		if path == "~" {
			return home
		}
		return filepath.Join(home, strings.TrimPrefix(path, "~/"))
	}
	return path
}

func localKeyPath(path string) string {
	path = expandSSHPath(path)
	if !filepath.IsAbs(path) {
		fail(400, "请输入本机密钥的绝对路径")
	}
	info, e := os.Lstat(path)
	if e != nil || info.Mode()&os.ModeSymlink != 0 {
		fail(400, "密钥文件不存在或是符号链接")
	}
	resolved, e := privateFile(filepath.Dir(path), path)
	if e != nil {
		fail(400, "密钥及目录须归当前用户所有；目录权限为 0700，文件权限为 0600 或 0400")
	}
	return resolved
}

func privateKeyHeader(path string) bool {
	f, e := os.Open(path)
	if e != nil {
		return false
	}
	defer f.Close()
	data := make([]byte, 256)
	n, _ := f.Read(data)
	header := strings.SplitN(string(data[:n]), "\n", 2)[0]
	return strings.HasPrefix(header, "-----BEGIN ") && strings.HasSuffix(strings.TrimSpace(header), "PRIVATE KEY-----")
}

func listSSHKeys(directory string) Object {
	if directory == "" {
		directory = "~/.ssh"
	}
	directory = expandSSHPath(directory)
	if !filepath.IsAbs(directory) || len(directory) > 1000 || strings.ContainsAny(directory, "\r\n\x00") {
		fail(400, "请输入本机密钥目录的绝对路径")
	}
	real, e := filepath.EvalSymlinks(directory)
	if os.IsNotExist(e) {
		return Object{"directory": directory, "keys": []Object{}}
	}
	if e != nil {
		fail(400, "无法读取密钥目录")
	}
	info, e := os.Stat(real)
	if e != nil || !info.IsDir() || !platform.Private(real, info) {
		fail(400, "密钥目录须归当前用户所有，权限为 0700")
	}
	entries, e := os.ReadDir(real)
	if e != nil {
		fail(400, "无法读取密钥目录")
	}
	keys := []Object{}
	for _, entry := range entries {
		if len(keys) >= 200 {
			break
		}
		if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		path, e := privateFile(real, entry.Name())
		if e == nil && privateKeyHeader(path) {
			keys = append(keys, Object{"name": entry.Name(), "path": path})
		}
	}
	return Object{"directory": real, "keys": keys}
}

// prepareSSH is exclusively the human-facing resource input path. Models cannot
// list/import credentials. Return cleanup so failed resource creation leaves no orphan.
func prepareSSH(home string, input Object) (config Object, cleanup func()) {
	allowed := set("host port username shell authMethod identityFile privateKey password passphrase credentialRef")
	for key := range input {
		if !allowed[key] {
			fail(400, "不支持的 SSH 配置字段")
		}
	}
	config = Object{}
	for key, value := range input {
		config[key] = value
	}
	mode := stringOf(config["authMethod"])
	if mode == "" {
		mode = "key"
	}
	config["authMethod"] = mode
	if mode != "key" && mode != "password" {
		fail(400, "SSH 登录方式须为密钥或密码")
	}
	created := []string{}
	cleanup = func() {
		for _, path := range created {
			os.Remove(path)
		}
	}
	defer func() {
		if p := recover(); p != nil {
			cleanup()
			panic(p)
		}
	}()
	root := filepath.Join(home, "secrets")
	save := func(prefix string, data []byte) string {
		must(platform.MkdirAll(root, 0700))
		info, e := os.Stat(root)
		if e != nil || !platform.Private(root, info) {
			fail(400, "Lake 凭据目录权限须为 0700")
		}
		ref := prefix + ident()
		path := filepath.Join(root, ref)
		must(atomicFile(path, data))
		created = append(created, path)
		return ref
	}
	field := "passphrase"
	if mode == "password" {
		field = "password"
	}
	if secret, exists := config[field]; exists && stringOf(secret) != "" {
		value, ok := secret.(string)
		if !ok || len(value) > 4096 || strings.ContainsAny(value, "\r\n\x00") {
			fail(400, "密码或密钥口令格式无效")
		}
		config["credentialRef"] = save("ssh-secret-", []byte(value))
	}
	delete(config, "password")
	delete(config, "passphrase")
	if mode == "key" {
		if uploaded, exists := config["privateKey"]; exists {
			value, ok := uploaded.(string)
			if !ok || len(value) == 0 || len(value) > 1024*1024 || strings.ContainsRune(value, '\x00') {
				fail(400, "请选择有效的 SSH 私钥文件（最大 1 MB）")
			}
			_, e := ssh.ParsePrivateKey([]byte(value))
			var encrypted *ssh.PassphraseMissingError
			if e != nil && !errors.As(e, &encrypted) {
				fail(400, "文件不是有效的 SSH 私钥，请选择私钥而非公钥")
			}
			config["identityFile"] = save("ssh-key-", []byte(value))
		}
		source := stringOf(config["identityFile"])
		if _, e := privateFile(root, source); e != nil {
			source = localKeyPath(source)
			info, e := os.Stat(source)
			if e != nil || info.Size() > 1024*1024 || !privateKeyHeader(source) {
				fail(400, "请选择有效的 SSH 私钥文件")
			}
			data, e := os.ReadFile(source)
			must(e)
			config["identityFile"] = save("ssh-key-", data)
		}
	}
	delete(config, "privateKey")
	config = validateSSH(home, config)
	return config, cleanup
}
