package web

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"errors"
	"fmt"
	"github.com/Clean-Lakes/Lake/internal/platform"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

type sshTrustPrompt struct {
	ID, SessionID, ResourceID, Host, ConfigHash, PinHash string
	Port                                                 int
	Key                                                  ssh.PublicKey
	Previous                                             []string
	Done                                                 chan struct{}
	Accepted                                             bool
	Resolved                                             bool
}

// Trust belongs to Lake home and the network peer, never to a project,
// resource ID, username or conversation. The credential directory also keeps
// Agent file tools from editing the trusted-host records.
func canonicalSSHHost(host string) string {
	host = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
	if ip := net.ParseIP(host); ip != nil {
		return ip.String()
	}
	return host
}

func lakeHostKeyPath(home, host string, port int) string {
	sum := sha256.Sum256([]byte(canonicalSSHHost(host) + ":" + strconv.Itoa(port)))
	return filepath.Join(home, "secrets", fmt.Sprintf("ssh-host-%x.known_hosts", sum))
}

func (t *Terminals) hostKeyPath(config Object) string {
	if t.KnownHosts != "" {
		return t.KnownHosts
	}
	return lakeHostKeyPath(t.models.Home, stringOf(config["host"]), integer(config["port"]))
}

func sshConfigHash(config Object) string {
	sum := sha256.Sum256([]byte(jsonText(config)))
	return fmt.Sprintf("%x", sum)
}

func hostPinHash(path string) string {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return ""
	}
	if err != nil {
		fail(503, "无法读取 Lake 主机信任记录")
	}
	sum := sha256.Sum256(data)
	return fmt.Sprintf("%x", sum)
}

func (b *Server) needsHostKeyPrompt(resource Object) bool {
	if b.Terminals.KnownHosts != "" || b.Terminals.HostKeyApproval == nil || resource["kind"] != "ssh" {
		return false
	}
	config := object(resource["ssh"])
	if _, err := os.Lstat(b.Terminals.hostKeyPath(config)); err == nil {
		return false
	}
	home, _ := os.UserHomeDir()
	system := filepath.Join(home, ".ssh", "known_hosts")
	if _, err := os.Stat(system); err != nil {
		return true
	}
	verify, err := knownhosts.New(system)
	if err != nil {
		return false
	}
	placeholder, _ := ssh.NewPublicKey(ed25519.PublicKey(make([]byte, 32)))
	peer := net.JoinHostPort(canonicalSSHHost(stringOf(config["host"])), strconv.Itoa(integer(config["port"])))
	err = verify(peer, &net.TCPAddr{Port: integer(config["port"])}, placeholder)
	var missing *knownhosts.KeyError
	return errors.As(err, &missing) && len(missing.Want) == 0
}

func hostPinMatches(path string, p *sshTrustPrompt) bool {
	if _, err := privateFile(filepath.Dir(path), path); err != nil {
		return false
	}
	verify, err := knownhosts.New(path)
	if err != nil {
		return false
	}
	peer := net.JoinHostPort(p.Host, strconv.Itoa(p.Port))
	return verify(peer, &net.TCPAddr{Port: p.Port}, p.Key) == nil
}

func (p *sshTrustPrompt) public() Object {
	return Object{"id": p.ID, "resourceId": p.ResourceID, "host": p.Host, "port": p.Port, "algorithm": p.Key.Type(), "fingerprint": ssh.FingerprintSHA256(p.Key), "previousFingerprints": p.Previous, "changed": len(p.Previous) > 0, "scope": "lake"}
}

func (b *Server) hostKeyPrompt(id string) Object {
	b.hostKeyMu.Lock()
	defer b.hostKeyMu.Unlock()
	for _, p := range b.hostKeyPrompts {
		if p.SessionID == id && !p.Resolved {
			return p.public()
		}
	}
	return nil
}

func (b *Server) saveHostPin(path, host string, port int, key ssh.PublicKey) {
	root := filepath.Dir(path)
	must(platform.MkdirAll(root, 0700))
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !platform.Private(root, info) {
		fail(403, "Lake 信任目录权限或所有者无效")
	}
	if _, err = os.Lstat(path); err == nil {
		if _, err = privateFile(root, path); err != nil {
			fail(403, "Lake 主机信任记录权限无效")
		}
	} else if !os.IsNotExist(err) {
		fail(503, "无法访问 Lake 主机信任记录")
	}
	peer := knownhosts.Normalize(net.JoinHostPort(host, strconv.Itoa(port)))
	must(atomicFile(path, []byte(knownhosts.Line([]string{peer}, key)+"\n")))
}

func (b *Server) ensureHostKey(ctx context.Context, id, ref string) string {
	b.Store.AssertResource(id, ref)
	r := b.Store.Resource(ref)
	config := object(r["ssh"])
	host, port := canonicalSSHHost(stringOf(config["host"])), integer(config["port"])
	if r["kind"] != "ssh" || host == "" || port < 1 || port > 65535 {
		fail(400, "SSH 目标无效")
	}
	path := lakeHostKeyPath(b.Models.Home, host, port)
	files := []string{}
	if _, err := os.Lstat(path); err == nil {
		if _, err = privateFile(filepath.Dir(path), path); err != nil {
			fail(403, "Lake 主机信任记录权限无效")
		}
		files = append(files, path) // A Lake pin overrides system records for this peer.
	} else if !os.IsNotExist(err) {
		fail(503, "无法读取 Lake 主机信任记录")
	} else {
		home, _ := os.UserHomeDir()
		system := filepath.Join(home, ".ssh", "known_hosts")
		if info, err := os.Stat(system); err == nil && info.Mode().IsRegular() {
			files = append(files, system)
		}
	}
	verify, err := knownhosts.New(files...)
	if err != nil {
		fail(503, "主机信任记录格式无效")
	}
	peer := net.JoinHostPort(host, strconv.Itoa(port))
	conn, err := (&net.Dialer{Timeout: 8 * time.Second}).DialContext(ctx, "tcp", peer)
	if err != nil {
		fail(503, terminalConnectionError(err.Error(), ""))
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(8 * time.Second))
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	var observed ssh.PublicKey
	var keyErr error
	probeDone := errors.New("host key observed; do not authenticate")
	client, _, _, _ := ssh.NewClientConn(conn, peer, &ssh.ClientConfig{User: stringOf(config["username"]), HostKeyCallback: func(name string, remote net.Addr, key ssh.PublicKey) error {
		observed = key
		keyErr = verify(name, remote, key)
		return probeDone
	}})
	if client != nil {
		client.Close()
	}
	if ctx.Err() != nil {
		panic(ctx.Err())
	}
	if observed == nil {
		fail(503, "无法读取 SSH 服务器指纹，请检查主机和端口是否为 SSH 服务")
	}
	if keyErr == nil {
		trusted := false
		func() {
			b.hostKeyMu.Lock()
			defer b.hostKeyMu.Unlock()
			if hostPinHash(path) != "" {
				candidate := &sshTrustPrompt{Host: host, Port: port, Key: observed}
				if !hostPinMatches(path, candidate) {
					current, e := knownhosts.New(path)
					if e != nil {
						fail(503, "Lake 主机信任记录格式无效")
					}
					keyErr = current(peer, conn.RemoteAddr(), observed)
					return
				}
			} else {
				b.saveHostPin(path, host, port, observed)
			}
			trusted = true
		}()
		if trusted {
			return path
		}
	}
	var mismatch *knownhosts.KeyError
	if !errors.As(keyErr, &mismatch) {
		fail(503, "SSH 主机密钥验证未完成")
	}
	previous := []string{}
	for _, want := range mismatch.Want {
		if len(previous) < 6 {
			previous = append(previous, ssh.FingerprintSHA256(want.Key))
		}
	}
	p := &sshTrustPrompt{ID: ident(), SessionID: id, ResourceID: ref, Host: host, Port: port, Key: observed, Previous: previous, ConfigHash: sshConfigHash(config), PinHash: hostPinHash(path), Done: make(chan struct{})}
	b.hostKeyMu.Lock()
	if hostPinMatches(path, p) {
		b.hostKeyMu.Unlock()
		return path
	}
	if b.hostKeyPrompts == nil {
		b.hostKeyPrompts = map[string]*sshTrustPrompt{}
	}
	for _, existing := range b.hostKeyPrompts {
		if existing.SessionID == id && !existing.Resolved {
			if existing.ResourceID == ref && existing.ConfigHash == p.ConfigHash && existing.Host == p.Host && existing.Port == p.Port && ssh.FingerprintSHA256(existing.Key) == ssh.FingerprintSHA256(p.Key) {
				b.hostKeyMu.Unlock()
				b.waitHostKeyDecision(ctx, existing)
				return path
			}
			b.hostKeyMu.Unlock()
			fail(409, "请先处理当前服务器指纹确认")
		}
	}
	b.hostKeyPrompts[p.ID] = p
	b.hostKeyMu.Unlock()
	b.Store.Touch(id)
	defer func() {
		b.hostKeyMu.Lock()
		if !p.Resolved {
			p.Resolved = true
			close(p.Done)
		}
		delete(b.hostKeyPrompts, p.ID)
		b.hostKeyMu.Unlock()
		b.Store.Touch(id)
	}()
	b.waitHostKeyDecision(ctx, p)
	return path
}

func (b *Server) decideHostKey(id, nonce string, accept bool, fingerprint string) {
	b.hostKeyMu.Lock()
	defer b.hostKeyMu.Unlock()
	p := b.hostKeyPrompts[nonce]
	if p == nil || p.SessionID != id || p.Resolved {
		fail(409, "服务器指纹确认已失效")
	}
	b.Store.AssertResource(id, p.ResourceID)
	config := object(b.Store.Resource(p.ResourceID)["ssh"])
	if accept && sshConfigHash(config) != p.ConfigHash {
		fail(409, "SSH 目标配置已变化，请重新连接核对指纹")
	}
	if accept {
		if fingerprint != ssh.FingerprintSHA256(p.Key) {
			fail(409, "指纹与待确认记录不一致")
		}
		path := lakeHostKeyPath(b.Models.Home, p.Host, p.Port)
		if hostPinHash(path) != p.PinHash && !hostPinMatches(path, p) {
			fail(409, "Lake 信任记录已变化，请重新连接核对指纹")
		}
		if !hostPinMatches(path, p) {
			b.saveHostPin(path, p.Host, p.Port, p.Key)
		}
		for _, other := range b.hostKeyPrompts {
			if other != p && !other.Resolved && other.Host == p.Host && other.Port == p.Port && ssh.FingerprintSHA256(other.Key) == ssh.FingerprintSHA256(p.Key) {
				other.Resolved = true
				other.Accepted = true
				close(other.Done)
			}
		}
	}
	p.Resolved = true
	p.Accepted = accept
	close(p.Done)
}

func (b *Server) cancelHostKeys(id string) {
	b.hostKeyMu.Lock()
	defer b.hostKeyMu.Unlock()
	for _, p := range b.hostKeyPrompts {
		if p.SessionID == id && !p.Resolved {
			p.Resolved = true
			p.Accepted = false
			close(p.Done)
		}
	}
}

func (b *Server) waitHostKeyDecision(ctx context.Context, p *sshTrustPrompt) {
	select {
	case <-ctx.Done():
		panic(ctx.Err())
	case <-p.Done:
	}
	b.hostKeyMu.Lock()
	accepted := p.Accepted
	b.hostKeyMu.Unlock()
	if !accepted {
		fail(503, "已取消服务器指纹信任，停止该主机的连接；明确重试后才会再次请求确认。")
	}
}
