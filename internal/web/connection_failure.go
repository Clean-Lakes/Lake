package web

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"
)

type connectionRetryContextKey struct{}

type hostConnectionFailure struct {
	fingerprint string
	message     string
}

// Only public connection configuration and file metadata are fingerprinted.
// Credential contents and private keys never enter this retry state.
func (b *Server) connectionFingerprint(resource Object) string {
	config := object(resource["ssh"])
	metadata := []Object{}
	paths := b.connectionFiles(resource)
	for _, path := range paths {
		if path == "" {
			continue
		}
		value := Object{"path": path, "exists": false}
		if info, err := os.Stat(path); err == nil {
			value = Object{"path": path, "exists": true, "size": info.Size(), "mtime": info.ModTime().UnixNano(), "mode": uint32(info.Mode())}
		}
		metadata = append(metadata, value)
	}
	sum := sha256.Sum256([]byte(jsonText(Object{"ssh": config, "files": metadata})))
	return fmt.Sprintf("%x", sum)
}

func (b *Server) connectionFiles(resource Object) []string {
	config := object(resource["ssh"])
	home, _ := os.UserHomeDir()
	known := b.Terminals.KnownHosts
	if known == "" {
		known = filepath.Join(home, ".ssh", "known_hosts")
	}
	paths := []string{known, stringOf(config["identityFile"])}
	if b.Terminals.KnownHosts == "" {
		paths = append(paths, b.Terminals.hostKeyPath(config))
	}
	if ref := stringOf(config["credentialRef"]); ref != "" {
		paths = append(paths, filepath.Join(b.Models.Home, "secrets", ref))
	}
	return paths
}

func (b *Server) retainedConnectionFailure(id, ref string, resource Object) string {
	terminals := objects(b.Store.Snapshot(id)["terminals"])
	for i := len(terminals) - 1; i >= 0; i-- {
		terminal := terminals[i]
		if terminal["resourceId"] != ref {
			continue
		}
		// Only the most recent terminal matters; a successful later connection
		// must not resurrect an old failure after the user closes it.
		if terminal["status"] != "disconnected" {
			return ""
		}
		history := b.Store.History(id, stringOf(terminal["id"]))
		if len(objects(history["entries"])) != 0 {
			return ""
		}
		created, err := time.Parse(time.RFC3339Nano, stringOf(terminal["createdAt"]))
		if err != nil {
			return ""
		}
		for _, path := range b.connectionFiles(resource) {
			if info, err := os.Stat(path); err == nil && info.ModTime().After(created) {
				return ""
			}
		}
		message := retainedSSHStartupCause(stringOf(history["output"]))
		if message != terminalConnectionError("", "") {
			return message
		}
		return ""
	}
	return ""
}

func (b *Server) resetConnectionFailures(id string) {
	b.connectionMu.Lock()
	defer b.connectionMu.Unlock()
	for key := range b.connectionFailures {
		if strings.HasPrefix(key, id+":") {
			delete(b.connectionFailures, key)
		}
	}
}

func connectionRetryRequested(message string) bool {
	message = strings.ToLower(strings.TrimSpace(message))
	message = strings.TrimRight(message, "。.!！")
	for _, prefix := range []string{"please ", "请", "麻烦", "帮我", "帮忙", "现在", "允许"} {
		message = strings.TrimSpace(strings.TrimPrefix(message, prefix))
	}
	if message == "继续" {
		return true
	}
	for _, action := range []string{"重试", "重新连接", "重连", "再试一次", "再连一次"} {
		if strings.HasPrefix(message, action) {
			return true
		}
	}
	for _, action := range []string{"retry", "reconnect"} {
		if message == action || strings.HasPrefix(message, action+" ") {
			return true
		}
	}
	return false
}

func (b *Server) checkHostConnectionFailure(ctx context.Context, id, ref string) {
	resource := b.Store.Resource(ref)
	if resource["kind"] != "ssh" {
		return
	}
	key := id + ":" + ref
	fingerprint := b.connectionFingerprint(resource)
	// A successful manual connection is also evidence that the host is usable.
	ready := false
	for _, terminal := range objects(b.Store.Snapshot(id)["terminals"]) {
		if terminal["resourceId"] == ref && (terminal["status"] == "ready" || terminal["status"] == "busy") {
			ready = true
			break
		}
	}
	b.connectionMu.Lock()
	failure, failed := b.connectionFailures[key]
	b.connectionMu.Unlock()
	if !failed && !ready && ctx.Value(connectionRetryContextKey{}) != true {
		if message := b.retainedConnectionFailure(id, ref, resource); message != "" {
			failure = hostConnectionFailure{fingerprint, message}
			failed = true
		}
	}
	b.connectionMu.Lock()
	if failed && (ready || failure.fingerprint != fingerprint) {
		delete(b.connectionFailures, key)
		failed = false
	} else if failed {
		if b.connectionFailures == nil {
			b.connectionFailures = map[string]hostConnectionFailure{}
		}
		b.connectionFailures[key] = failure
	}
	b.connectionMu.Unlock()
	if failed {
		if b.Terminals.HostKeyApproval != nil && b.Terminals.KnownHosts == "" && strings.Contains(failure.message, "主机密钥") && (strings.Contains(failure.message, "未受信任") || strings.Contains(failure.message, "已变化")) {
			return
		}
		fail(503, failure.message+" 已暂停此会话对该主机的重复连接，不再重复申请终端授权。请先修正连接配置，或明确要求重试／重新连接；不要改用其他工具反复创建终端。")
	}
}

func (b *Server) openAgentTerminal(ctx context.Context, id, ref string) Object {
	b.Store.AssertResource(id, ref)
	b.checkHostConnectionFailure(ctx, id, ref)
	resource := b.Store.Resource(ref)
	fingerprint := ""
	if resource["kind"] == "ssh" {
		fingerprint = b.connectionFingerprint(resource)
	}
	defer func() {
		if p := recover(); p != nil {
			if failure, ok := p.(*Failure); ok && fingerprint != "" && ctx.Err() == nil && (failure.Status == 400 || failure.Status >= 500) {
				b.connectionMu.Lock()
				if b.connectionFailures == nil {
					b.connectionFailures = map[string]hostConnectionFailure{}
				}
				b.connectionFailures[id+":"+ref] = hostConnectionFailure{fingerprint, failure.Message}
				b.connectionMu.Unlock()
			}
			panic(p)
		}
	}()
	return b.Terminals.Open(ctx, id, ref)
}

// Classify bounded startup output into fixed messages, never return raw SSH
// stderr, passwords, key contents, banners, or credential paths to the model.
func terminalConnectionErrorWithExit(output, reason string, code *int) string {
	return terminalConnectionCauseWithExit(terminalConnectionError(output, reason), reason, code)
}

func terminalConnectionCauseWithExit(message, reason string, code *int) string {
	if code == nil || reason != "Terminal connection closed" {
		return message
	}
	switch uint32(*code) {
	case 0xc0000135:
		message = "SSH 运行环境缺少依赖 DLL，进程无法启动。请重新安装完整 Lake 包，并检查安全软件隔离记录。"
	case 0xc000007b:
		message = "SSH 运行环境的可执行文件或 DLL 架构不匹配。请重新安装完整 Windows x64 包。"
	case 0xc0000142:
		message = "SSH 运行环境初始化失败。请检查安全软件拦截或系统运行环境，并重新启动 Lake。"
	case 0xc0000005:
		message = "SSH 客户端启动时发生访问冲突。请检查运行环境冲突或安全软件隔离记录。"
	case 0:
		if message == terminalConnectionError("", "Terminal connection closed") || message == terminalConnectionError("", "") {
			message = "SSH 进程已退出，但远端终端初始化没有完成。请检查远端 Shell 和初始化配置。"
		}
	}
	return fmt.Sprintf("%s（SSH 退出码：%d / 0x%08X）。", strings.TrimSuffix(message, "。"), *code, uint32(*code))
}

var sshDiagnosticEscape = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)

func compactSSHDiagnostic(value string) string {
	value = sshDiagnosticEscape.ReplaceAllString(value, "")
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return unicode.ToLower(r)
	}, value)
}

func terminalConnectionError(output, reason string) string {
	// ConPTY inserts ANSI sequences and wraps text even inside an error word.
	// Normalize only for matching fixed categories; never expose raw output.
	output = compactSSHDiagnostic(output)
	has := func(value string) bool { return strings.Contains(output, compactSSHDiagnostic(value)) }
	switch {
	case has(SSHAskpassFailureMessage):
		return "SSH 登录凭据助手未能提供保存的凭据。请重新填写密码，或检查密钥口令与私有凭据目录权限。"
	case has("no matching mac found"), has("no matching host key type found"), has("no matching key exchange method found"), has("no matching cipher found"), has("no mutual signature algorithm"):
		return "SSH 加密算法协商失败，客户端与服务器支持的算法不匹配。请检查 SSH 版本和服务端算法配置。"
	case has("bad owner or permissions"), has("unprotected private key file"), has("permissions for") && has("too open"):
		return "SSH 配置或私钥文件权限不符合客户端要求，连接被拒绝。请检查当前用户的文件访问权限。"
	case has("ssh_askpass: exec"), has("ssh_askpass: posix_spawn"), has("exec(") && has("askpass"):
		return "SSH 登录凭据助手无法启动。请检查 Lake 安装是否完整，以及程序是否被系统或安全软件阻止。"
	case has("bad configuration option"), has("unsupported option"), has("unknown option"), has("can't open user config file"):
		return "SSH 客户端不支持连接所需的选项，请检查 Lake 随包 SSH 运行环境是否完整。"
	case has("remote host identification has changed"):
		return "SSH 主机密钥已变化，连接被拒绝。请核对服务器身份和可信主机记录。"
	case has("host key verification failed"), has("no ") && has("host key is known"):
		return "SSH 主机密钥尚未受信任，连接被拒绝。请先核对并信任正确的服务器密钥。"
	case has("permission denied"), has("authentication failed"):
		return "SSH 身份认证失败，请检查登录账号及密码或密钥配置。"
	case has("connection refused"):
		return "SSH 端口拒绝连接，请检查 SSH 服务是否启动及资源端口是否正确。"
	case has("could not resolve hostname"):
		return "SSH 主机名无法解析，请检查主机地址和 DNS。"
	case has("no route to host"), has("network is unreachable"):
		return "SSH 主机网络不可达，请检查网络、路由及跳板连接。"
	case has("connection timed out"), reason == "Connection timed out":
		return "SSH 连接超时，请检查主机、端口与防火墙可达性。"
	case has("pty allocation request failed"), has("shell request failed"), has("exec request failed"):
		return "SSH 服务器拒绝创建终端或执行 Shell。请检查账号权限、远端 Shell 和服务端会话策略。"
	case has("connection reset by"), has("connection closed by"), has("kex_exchange_identification"), has("banner exchange"), has("exceeded maxstartups"):
		return "SSH 服务器在认证或终端初始化前关闭了连接。请检查服务端连接限制、安全策略和 SSH 服务日志。"
	case reason == "Terminal connection closed":
		return "SSH 客户端在终端初始化完成前退出，尚未建立可用会话。请检查登录方式、客户端兼容性和连接配置。"
	default:
		return "终端连接未建立，请检查主机密钥信任、登录凭据和网络可达性。"
	}
}
