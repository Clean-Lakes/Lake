package ai

import (
	"bufio"
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRedisWireAndBounds(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	done := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			done <- err
			return
		}
		defer conn.Close()
		request, err := respRead(bufio.NewReader(conn), 0)
		if err != nil {
			done <- err
			return
		}
		if js(request) != `["GET","key with spaces"]` {
			done <- fmt.Errorf("unexpected command %s", js(request))
			return
		}
		_, err = io.WriteString(conn, "$5\r\nvalue\r\n")
		done <- err
	}()
	e, _ := New(t.TempDir(), nil, nil)
	as := Asset{ID: "redis", Kind: "redis", Settings: map[string]any{"host": "127.0.0.1", "port": listener.Addr().(*net.TCPAddr).Port}}
	value, err := e.redis(context.Background(), Config{Assets: []Asset{as}}, map[string]any{"asset_ref": "redis", "command": `GET "key with spaces"`})
	if err != nil || value != "value" {
		t.Fatal(value, err)
	}
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"$999999\r\n", "*999999\r\n", "not resp\r\n"} {
		if _, err := respRead(bufio.NewReader(strings.NewReader(bad)), 0); err == nil {
			t.Fatal("unbounded response accepted")
		}
	}
}
func TestRealSSHFilesSCPAndBothTunnelDirections(t *testing.T) {
	if _, err := os.Stat("/usr/sbin/sshd"); err != nil {
		t.Skip("local sshd unavailable")
	}
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	secrets := filepath.Join(dir, ".lake", "secrets")
	if err := os.MkdirAll(secrets, 0700); err != nil {
		t.Fatal(err)
	}
	_ = os.Mkdir(filepath.Join(dir, ".ssh"), 0700)
	key := filepath.Join(secrets, "fixture")
	hostKey := filepath.Join(dir, "host-key")
	for _, file := range []string{key, hostKey} {
		if exec.Command("/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", file).Run() != nil {
			t.Fatal("synthetic key generation failed")
		}
	}
	probe, _ := net.Listen("tcp", "127.0.0.1:0")
	port := probe.Addr().(*net.TCPAddr).Port
	probe.Close()
	config := filepath.Join(dir, "sshd.conf")
	_ = os.WriteFile(config, []byte(fmt.Sprintf("Port %d\nListenAddress 127.0.0.1\nHostKey %s\nPidFile %s/pid\nAuthorizedKeysFile %s.pub\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nLogLevel ERROR\nSubsystem sftp internal-sftp\n", port, hostKey, dir, key)), 0600)
	server := exec.Command("/usr/sbin/sshd", "-D", "-e", "-f", config)
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { server.Process.Kill(); server.Wait() }()
	public, err := os.ReadFile(hostKey + ".pub")
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Fields(string(public))
	known := filepath.Join(dir, ".ssh", "known_hosts")
	_ = os.WriteFile(known, []byte(fmt.Sprintf("[127.0.0.1]:%d %s %s\n", port, parts[0], parts[1])), 0600)
	current, _ := user.Current()
	as := Asset{ID: "ssh", Name: "isolated ssh", Kind: "ssh", SSH: &SSH{Host: "127.0.0.1", Port: port, Username: current.Username, IdentityFile: key}}
	c := Config{Runtime: "ssh", AssetRef: as.ID, Assets: []Asset{as}}
	e, _ := New(filepath.Join(dir, "state"), nil, nil)
	defer e.Shutdown()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	time.Sleep(150 * time.Millisecond)
	value, err := e.command(ctx, c, map[string]any{}, "printf remote-fixture")
	if err != nil || !strings.Contains(js(value), "remote-fixture") {
		t.Fatal(value, err)
	}
	s, _ := e.get("case")
	s.state.Config = c
	remote := filepath.Join(dir, "remote config")
	if _, err = e.file(ctx, s, c, "write", map[string]any{"path": remote, "content": "remote content"}); err != nil {
		t.Fatal(err)
	}
	value, err = e.file(ctx, s, c, "read", map[string]any{"path": remote})
	if err != nil || str(obj(value)["content"]) != "remote content" {
		t.Fatal(value, err)
	}
	local := filepath.Join(dir, "download")
	if _, err = e.transfer(ctx, "case", c, "scp_transfer", map[string]any{"asset_ref": "ssh", "direction": "download", "local_path": local, "remote_path": remote}); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(local)
	if string(b) != "remote content" {
		t.Fatal(string(b))
	}
	if _, err = e.transfer(ctx, "case", c, "scp_transfer", map[string]any{"asset_ref": "ssh", "direction": "download", "local_path": local, "remote_path": remote}); err == nil {
		t.Fatal("implicit overwrite allowed")
	}
	attachmentBytes := []byte{0, 255, 7, 128, 42}
	attachmentSource := filepath.Join(dir, "attachment.bin")
	if err := os.WriteFile(attachmentSource, attachmentBytes, 0600); err != nil {
		t.Fatal(err)
	}
	e.Bridge = func(context.Context, string, string, map[string]any, bool) (any, error) {
		return map[string]any{"path": attachmentSource, "sha256": fmt.Sprintf("%x", sha256.Sum256(attachmentBytes)), "sizeBytes": len(attachmentBytes)}, nil
	}
	attachmentTarget := filepath.Join(dir, "remote attachment.bin")
	if _, err := e.stageAttachment(ctx, "case", c, map[string]any{"source_id": "fixture", "runtime": "ssh", "asset_ref": "ssh", "path": attachmentTarget}); err != nil {
		t.Fatal("SSH attachment transfer", err)
	}
	if got, err := os.ReadFile(attachmentTarget); err != nil || string(got) != string(attachmentBytes) {
		t.Fatal("SSH binary changed", err)
	}
	echo, _ := net.Listen("tcp", "127.0.0.1:0")
	defer echo.Close()
	go func() {
		for {
			conn, err := echo.Accept()
			if err != nil {
				return
			}
			go func() { defer conn.Close(); _, _ = io.Copy(conn, conn) }()
		}
	}()
	for _, direction := range []string{"local", "remote"} {
		value, err = e.transfer(ctx, "case", c, "open_ssh_tunnel", map[string]any{"asset_ref": "ssh", "target_host": "127.0.0.1", "target_port": echo.Addr().(*net.TCPAddr).Port, "direction": direction})
		if err != nil {
			t.Fatal(direction, err)
		}
		port := num(obj(value)["bind_port"], 0)
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), time.Second)
		if err != nil {
			t.Fatal(err)
		}
		conn.SetDeadline(time.Now().Add(time.Second))
		conn.Write([]byte("echo"))
		b := make([]byte, 4)
		_, err = io.ReadFull(conn, b)
		conn.Close()
		if err != nil || string(b) != "echo" {
			t.Fatal(string(b), err)
		}
		if _, err = e.transfer(ctx, "case", c, "close_ssh_tunnel", map[string]any{"tunnel_id": obj(value)["tunnel_id"]}); err != nil {
			t.Fatal(err)
		}
	}
	_ = os.WriteFile(known, nil, 0600)
	if _, err = e.command(ctx, c, map[string]any{}, "true"); err == nil {
		t.Fatal("untrusted SSH target accepted")
	}
}
func TestBackgroundShellAndCancellation(t *testing.T) {
	m, close := fakeModel(t, func(_ int, _ map[string]any) any { return response("done") })
	defer close()
	e := engineFor(t, m, nil)
	c := Config{Runtime: "local"}
	value, err := e.startShell(c, map[string]any{"__session": "case"}, "printf background")
	if err != nil {
		t.Fatal(err)
	}
	id := str(obj(value)["shell_id"])
	value, err = e.shellJob(context.Background(), "case", "waitShell", map[string]any{"shell_id": id})
	if err != nil || !strings.Contains(js(value), "background") {
		t.Fatal(value, err)
	}
	value, err = e.startShell(c, map[string]any{"__session": "case"}, "sleep 30")
	if err != nil {
		t.Fatal(err)
	}
	id = str(obj(value)["shell_id"])
	_ = e.Abort("case")
	value, err = e.shellJob(context.Background(), "case", "shellOutput", map[string]any{"shell_id": id})
	if err != nil || str(obj(value)["status"]) != "running" {
		t.Fatal("abort killed background command", value, err)
	}
	_, _ = e.shellJob(context.Background(), "case", "forceKillShell", map[string]any{"shell_id": id})
	value, err = e.shellJob(context.Background(), "case", "waitShell", map[string]any{"shell_id": id})
	if err != nil || str(obj(value)["status"]) != "failed" {
		t.Fatal(value, err)
	}
}
