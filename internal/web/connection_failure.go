package web

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
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
		message := terminalConnectionError(stringOf(history["output"]), "")
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
	message := terminalConnectionError(output, reason)
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
		message = "SSH 进程已退出，但远端终端初始化没有完成。请检查远端 Shell 和初始化配置。"
	}
	return fmt.Sprintf("%s（SSH 退出码：%d / 0x%08X）。", strings.TrimSuffix(message, "。"), *code, uint32(*code))
}

func terminalConnectionError(output, reason string) string {
	output = strings.ToLower(output)
	switch {
	case strings.Contains(output, "no matching host key type found"), strings.Contains(output, "no matching key exchange method found"), strings.Contains(output, "no matching cipher found"), strings.Contains(output, "no mutual signature algorithm"):
		return "SSH 加密算法协商失败，客户端与服务器支持的算法不匹配。请检查 SSH 版本和服务端算法配置。"
	case strings.Contains(output, "bad owner or permissions"), strings.Contains(output, "unprotected private key file"), strings.Contains(output, "permissions for") && strings.Contains(output, "too open"):
		return "SSH 配置或私钥文件权限不符合客户端要求，连接被拒绝。请检查当前用户的文件访问权限。"
	case strings.Contains(output, "ssh_askpass: exec"), strings.Contains(output, "ssh_askpass: posix_spawn"), strings.Contains(output, "exec(") && strings.Contains(output, "askpass"):
		return "SSH 登录凭据助手无法启动。请检查 Lake 安装是否完整，以及程序是否被系统或安全软件阻止。"
	case strings.Contains(output, "bad configuration option"), strings.Contains(output, "unsupported option"), strings.Contains(output, "unknown option"), strings.Contains(output, "can't open user config file"):
		return "SSH 客户端不支持连接所需的选项，请检查 Lake 随包 SSH 运行环境是否完整。"
	case strings.Contains(output, "remote host identification has changed"):
		return "SSH 主机密钥已变化，连接被拒绝。请核对服务器身份和可信主机记录。"
	case strings.Contains(output, "host key verification failed"), strings.Contains(output, "no ") && strings.Contains(output, "host key is known"):
		return "SSH 主机密钥尚未受信任，连接被拒绝。请先核对并信任正确的服务器密钥。"
	case strings.Contains(output, "permission denied"), strings.Contains(output, "authentication failed"):
		return "SSH 身份认证失败，请检查登录账号及密码或密钥配置。"
	case strings.Contains(output, "connection refused"):
		return "SSH 端口拒绝连接，请检查 SSH 服务是否启动及资源端口是否正确。"
	case strings.Contains(output, "could not resolve hostname"):
		return "SSH 主机名无法解析，请检查主机地址和 DNS。"
	case strings.Contains(output, "no route to host"), strings.Contains(output, "network is unreachable"):
		return "SSH 主机网络不可达，请检查网络、路由及跳板连接。"
	case strings.Contains(output, "connection timed out"), reason == "Connection timed out":
		return "SSH 连接超时，请检查主机、端口与防火墙可达性。"
	case reason == "Terminal connection closed":
		return "SSH 客户端在终端初始化完成前退出，尚未建立可用会话。请检查登录方式、客户端兼容性和连接配置。"
	default:
		return "终端连接未建立，请检查主机密钥信任、登录凭据和网络可达性。"
	}
}
