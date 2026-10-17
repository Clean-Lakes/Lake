//go:build windows

package web

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"debug/pe"
	"errors"
	"fmt"
	"github.com/Clean-Lakes/Lake/internal/platform"
	"golang.org/x/crypto/ssh"
	"golang.org/x/sys/windows"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Exercise the bundled OpenSSH process, credential helper and ConPTY together.
// The isolated server emits the remote init frame without using Windows' local
// shell, so local-only initialization tests cannot hide an SSH transport gap.
func TestWindowsSSHPasswordConPTYHandshake(t *testing.T) {
	for _, tc := range []struct {
		name                                  string
		interactive, unusualPaths, rejectAuth bool
		challenge                             string
	}{
		{"managed", false, false, false, ""},
		{"interactive", true, false, false, ""},
		{"installed-paths", true, true, false, ""},
		{"authentication-failure", true, false, true, ""},
		{"pam-managed", false, false, false, "Password: "},
		{"pam-interactive", true, true, false, "Password: "},
		{"otp-does-not-receive-password", true, false, true, "One-time password: "},
	} {
		t.Run(tc.name, func(t *testing.T) {
			windowsSSHPasswordConPTYHandshake(t, tc.interactive, tc.unusualPaths, tc.rejectAuth, windowsSSHFixtureOptions{challenge: tc.challenge})
		})
	}
	t.Run("desktop-trusted-pin", func(t *testing.T) {
		windowsSSHPasswordConPTYHandshake(t, true, false, false, windowsSSHFixtureOptions{trustedPin: true})
	})
	t.Run("inherited-credential-helper", func(t *testing.T) {
		t.Setenv("SSH_ASKPASS", "0-stale-helper")
		t.Setenv("LAKE_SSH_SECRET_REF", "0-stale-reference")
		t.Setenv("LAKE_SSH_ASKPASS_MODE", "key")
		windowsSSHPasswordConPTYHandshake(t, true, false, false)
	})
	t.Run("edited-credentials", func(t *testing.T) {
		windowsSSHPasswordConPTYHandshake(t, true, false, false, windowsSSHFixtureOptions{editCredentials: true})
	})
}

func TestWindowsPackagedSSHCredentialHelper(t *testing.T) {
	desktop := os.Getenv("LAKE_TEST_DESKTOP_EXE")
	if desktop == "" {
		t.Skip("requires the packaged desktop artifact")
	}
	helper, err := platform.SSHAskpassProgram(desktop)
	if err != nil || strings.EqualFold(helper, desktop) {
		t.Fatal("packaged GUI is still the credential helper", err)
	}
	file, err := pe.Open(helper)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	header, ok := file.OptionalHeader.(*pe.OptionalHeader64)
	if !ok || header.Subsystem != 3 {
		t.Fatal("packaged credential helper is not a console-subsystem x64 executable")
	}
	for _, challenge := range []string{"", "Password: "} {
		for _, unusual := range []bool{false, true} {
			t.Run(fmt.Sprintf("pam-%t/unicode-and-spaces-%t", challenge != "", unusual), func(t *testing.T) {
				windowsSSHPasswordConPTYHandshake(t, true, unusual, false, windowsSSHFixtureOptions{desktop: desktop, challenge: challenge})
			})
		}
	}
	t.Run("inherited-credential-helper", func(t *testing.T) {
		t.Setenv("SSH_ASKPASS", "0-stale-helper")
		t.Setenv("LAKE_SSH_SECRET_REF", "0-stale-reference")
		t.Setenv("LAKE_SSH_ASKPASS_MODE", "key")
		windowsSSHPasswordConPTYHandshake(t, true, true, false, windowsSSHFixtureOptions{desktop: desktop})
	})
	t.Run("edited-credentials", func(t *testing.T) {
		windowsSSHPasswordConPTYHandshake(t, true, true, false, windowsSSHFixtureOptions{desktop: desktop, editCredentials: true})
	})
}

type windowsSSHFixtureOptions struct {
	desktop, challenge string
	editCredentials    bool
	// trustedPin leaves KnownHosts empty so the desktop host-trust branch runs.
	trustedPin bool
}

func windowsSSHPasswordConPTYHandshake(t *testing.T, interactive, unusualPaths, rejectAuth bool, options ...windowsSSHFixtureOptions) {
	var opts windowsSSHFixtureOptions
	if len(options) > 0 {
		opts = options[0]
	}
	b, h := fixture(t)
	id, _ := newSession(t, h)
	if opts.desktop != "" {
		b.Terminals.askpassProgram = opts.desktop
	}
	if unusualPaths {
		// Reproduce an installed backend/credential path, not only the ASCII
		// checkout path used by go test on a hosted runner.
		b.Models.Home = filepath.Join(t.TempDir(), "Lake 数据 with spaces")
		helper := filepath.Join(t.TempDir(), "Lake 安装 with spaces", "resources", "lake.exe")
		if err := os.MkdirAll(filepath.Dir(helper), 0700); err != nil {
			t.Fatal(err)
		}
		executable, err := os.Executable()
		if opts.desktop != "" {
			executable, err = platform.SSHAskpassProgram(opts.desktop)
		}
		if err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(executable)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(helper, data, 0700); err != nil {
			t.Fatal(err)
		}
		b.Terminals.askpassProgram = helper
		if opts.desktop != "" {
			// Match the desktop layout while keeping the test credentials private.
			gui := filepath.Join(filepath.Dir(filepath.Dir(helper)), "Lake.exe")
			data, err := os.ReadFile(opts.desktop)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(gui, data, 0700); err != nil {
				t.Fatal(err)
			}
			b.Terminals.askpassProgram = gui
		}
	}
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		t.Fatal(err)
	}
	var authenticated atomic.Bool
	config := &ssh.ServerConfig{PasswordCallback: func(meta ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
		if rejectAuth || meta.User() != "fixture" || string(password) != "synthetic-windows-password" {
			return nil, errors.New("fixture authentication rejected")
		}
		authenticated.Store(true)
		return nil, nil
	}}
	if opts.challenge != "" {
		config.PasswordCallback = nil
		config.KeyboardInteractiveCallback = func(meta ssh.ConnMetadata, challenge ssh.KeyboardInteractiveChallenge) (*ssh.Permissions, error) {
			answers, err := challenge(meta.User(), "", []string{opts.challenge}, []bool{false})
			if opts.challenge == "One-time password: " && len(answers) == 1 && answers[0] == "synthetic-windows-password" {
				t.Error("OTP challenge received the saved login password")
			}
			if err != nil || rejectAuth || meta.User() != "fixture" || len(answers) != 1 || answers[0] != "synthetic-windows-password" {
				return nil, errors.New("fixture authentication rejected")
			}
			authenticated.Store(true)
			return nil, nil
		}
	}
	config.AddHostKey(signer)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan struct{})
	// A real server takes every connection: the desktop host-trust probe arrives
	// before the terminal session that follows it.
	go func() {
		defer close(done)
		stop := context.AfterFunc(ctx, func() { listener.Close() })
		defer stop()
		for {
			socket, err := listener.Accept()
			if err != nil {
				return
			}
			go serveSSHFixture(t, ctx, socket, config, interactive)
		}
	}()
	port := listener.Addr().(*net.TCPAddr).Port
	// An installed client keeps its known-hosts record under the Lake home and
	// usually sees no space anywhere in that path. Both variants have to survive
	// command-line quoting, so only the unusual-path case forces a space here.
	known := filepath.Join(t.TempDir(), "known_hosts")
	if unusualPaths {
		known = filepath.Join(t.TempDir(), "known hosts")
	}
	if err := os.WriteFile(known, []byte(fmt.Sprintf("[127.0.0.1]:%d %s", port, ssh.MarshalAuthorizedKey(signer.PublicKey()))), 0600); err != nil {
		t.Fatal(err)
	}
	if opts.trustedPin {
		b.saveHostPin(lakeHostKeyPath(b.Models.Home, "127.0.0.1", port), "127.0.0.1", port, signer.PublicKey())
	} else {
		b.Terminals.KnownHosts = known
	}
	username, password := "fixture", "synthetic-windows-password"
	if opts.editCredentials {
		username, password = "old-fixture", "old-fixture-password"
	}
	settings, cleanup := prepareSSH(b.Models.Home, Object{"host": "127.0.0.1", "port": port, "username": username, "authMethod": "password", "password": password, "shell": "sh"})
	defer cleanup()
	resource := b.Store.CreateResource(stringOf(b.Store.Session(id)["projectId"]), "isolated SSH", "ssh", settings)
	if opts.editCredentials {
		resource = apiTest(t, h, "PATCH", "/api/resources/"+stringOf(resource["id"]), Object{"name": "edited SSH", "ssh": Object{"username": "fixture", "password": "synthetic-windows-password"}}, 200)
	}
	if rejectAuth {
		var failure *Failure
		func() {
			defer func() { failure, _ = recover().(*Failure) }()
			b.Terminals.OpenInteractive(ctx, id, stringOf(resource["id"]), "sh")
		}()
		if failure == nil || !(strings.Contains(failure.Message, "身份认证失败") || opts.challenge != "" && strings.Contains(failure.Message, "凭据助手")) || !strings.Contains(failure.Message, "255") || !strings.Contains(failure.Message, "fixture@127.0.0.1:") {
			t.Errorf("authentication rejection lost its cause and exit code: %v", failure)
		}
		if opts.challenge == "" {
			terminals := objects(b.Store.Snapshot(id)["terminals"])
			if len(terminals) != 1 {
				t.Fatal("failed SSH terminal is missing from history")
			}
			history := b.Store.History(id, stringOf(terminals[0]["id"]))
			if !strings.Contains(retainedSSHStartupCause(stringOf(history["output"])), "身份认证失败") {
				t.Error("ConPTY startup diagnostic was not retained safely")
			}
		}
		cancel()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("rejected SSH fixture did not stop")
		}
		return
	}
	var term Object
	if interactive {
		term = b.Terminals.OpenInteractive(ctx, id, stringOf(resource["id"]), "sh")
	} else {
		term = b.Terminals.Open(ctx, id, stringOf(resource["id"]))
	}
	// ConPTY can emit the ready title before the following cwd title. Observe
	// the asynchronously published cwd as in the local Windows shell test.
	deadline := time.Now().Add(2 * time.Second)
	for term["cwd"] != "/root/remote dir" && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
		term = b.Store.Terminal(id, stringOf(term["id"]))
	}
	if term["status"] != "ready" || !authenticated.Load() || term["cwd"] != "/root/remote dir" {
		t.Fatalf("Windows SSH session status=%v authenticated=%t cwd=%q", term["status"], authenticated.Load(), stringOf(term["cwd"]))
	}
	live := b.Terminals.get(id, stringOf(term["id"]))
	if len(live.cmd.Args) < 3 || live.cmd.Args[1] != "-E" {
		t.Fatal("Windows SSH silently skipped its independent startup diagnostic")
	}
	// OpenSSH parses the known-hosts value itself, and Go only preserves quotes in
	// an argument that also holds a space. Without that space the bundled ssh aborts
	// with "invalid quotes" before it can report anything.
	knownHosts := ""
	for _, arg := range live.cmd.Args {
		if strings.HasPrefix(arg, "UserKnownHostsFile=") {
			knownHosts = arg
		}
	}
	if !strings.HasPrefix(knownHosts, `UserKnownHostsFile= "`) || !strings.HasSuffix(knownHosts, `"`) {
		t.Errorf("known-hosts option does not survive command-line quoting: %q", knownHosts)
	}
	if info, err := os.Stat(live.cmd.Args[2]); err != nil || !platform.Private(live.cmd.Args[2], info) {
		t.Fatal("active Windows SSH startup diagnostic is not private")
	}
	b.Terminals.Close(id, stringOf(term["id"]))
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("isolated SSH server did not stop")
	}
	deadline = time.Now().Add(2 * time.Second)
	for {
		logs, err := filepath.Glob(filepath.Join(b.Models.Home, "secrets", "ssh-startup-*"))
		if err != nil {
			t.Fatal(err)
		}
		if len(logs) == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("private SSH startup diagnostics were not removed after exit")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// serveSSHFixture answers one accepted connection. The desktop host-trust probe
// stops after the handshake, so a connection without channels simply ends.
func serveSSHFixture(t *testing.T, ctx context.Context, socket net.Conn, config *ssh.ServerConfig, interactive bool) {
	defer socket.Close()
	stop := context.AfterFunc(ctx, func() { socket.Close() })
	defer stop()
	connection, channels, requests, err := ssh.NewServerConn(socket, config)
	if err != nil {
		return
	}
	defer connection.Close()
	go ssh.DiscardRequests(requests)
	for incoming := range channels {
		channel, requests, err := incoming.Accept()
		if err != nil {
			return
		}
		defer channel.Close()
		for request := range requests {
			if request.Type != "exec" {
				request.Reply(request.Type == "pty-req" || request.Type == "window-change", nil)
				continue
			}
			var payload struct{ Command string }
			if ssh.Unmarshal(request.Payload, &payload) != nil {
				request.Reply(false, nil)
				return
			}
			marker := regexp.MustCompile(`LAKE_FRAME_READY_([a-zA-Z0-9_-]+)`).FindStringSubmatch(payload.Command)
			if len(marker) != 2 {
				request.Reply(false, nil)
				return
			}
			ready := "\x1eLAKE_READY_" + marker[1] + "\x1f"
			expected := sshArguments(Object{"shell": "sh"}, terminalInit("sh", ready, interactive))
			if payload.Command != consoleTerminalScript(expected[len(expected)-1]) {
				t.Error("bundled Windows OpenSSH changed the remote initialization command in transit")
				request.Reply(false, nil)
				return
			}
			request.Reply(true, nil)
			frame := "\x1eLAKE_READY_" + marker[1] + "\x1f"
			if strings.Contains(payload.Command, "LAKE_FRAME_READY_") {
				frame = consoleFramePrefix + "READY_" + marker[1] + "\a"
				frame += consoleHookPrefix + "9003;0;/root/remote dir\a"
			}
			if strings.Contains(payload.Command, "LAKE_READY_HOOK_") {
				// A renderer may retain only the last title in this batch.
				frame = consoleReadyHookPrefix + marker[1] + ";9003;0;/root/remote dir\a"
			}
			channel.Write([]byte(frame))
		}
	}
}

func TestWindowsPrivateACLRejectsPublicAccess(t *testing.T) {
	root := filepath.Join(t.TempDir(), "private")
	if err := platform.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "credential")
	if err := os.WriteFile(path, []byte("synthetic-fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := platform.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := privateFile(root, path); err != nil {
		t.Fatal("private Windows ACL rejected", err)
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	acl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err = windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
		t.Fatal(err)
	}
	if _, err = privateFile(root, path); err == nil {
		t.Fatal("Everyone-readable credential accepted")
	}
}

func TestWindowsSQLiteLockAndRestart(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data with spaces")
	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	project := store.CreateProject("persisted fixture")
	if duplicate, err := OpenStore(dir); err == nil {
		duplicate.Close()
		t.Fatal("second backend acquired data directory")
	}
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if store.Project(stringOf(project["id"]))["name"] != "persisted fixture" {
		t.Fatal("SQLite restart lost data")
	}
}

func TestWindowsConPTYInteractiveAndManagedCommands(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	defer func() {
		if p := recover(); p != nil {
			for _, term := range objects(b.Store.Snapshot(id)["terminals"]) {
				t.Logf("isolated ConPTY startup output: %q", tail(stringOf(b.Store.History(id, stringOf(term["id"]))["output"]), 2000))
			}
			t.Fatalf("isolated ConPTY startup failed: %v", p)
		}
	}()
	term := b.Terminals.OpenInteractive(context.Background(), id, ref, "bash")
	tid := stringOf(term["id"])
	home, _ := os.UserHomeDir()
	deadline := time.Now().Add(2 * time.Second)
	for !strings.EqualFold(stringOf(b.Store.Terminal(id, tid)["cwd"]), home) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if !strings.EqualFold(stringOf(b.Store.Terminal(id, tid)["cwd"]), home) {
		t.Fatal("Git Bash working directory was not observed as a native path")
	}
	b.Terminals.Resize(id, tid, 90, 24)
	b.Terminals.Input(id, tid, "printf 'WINDOWS_TERMINAL_FIXTURE\\n'\r", false)
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(stringOf(b.Store.History(id, tid)["output"]), "WINDOWS_TERMINAL_FIXTURE\r\n") {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !strings.Contains(stringOf(b.Store.History(id, tid)["output"]), "WINDOWS_TERMINAL_FIXTURE") {
		t.Fatal("ConPTY input/output unavailable")
	}
	managed := b.Terminals.Open(context.Background(), id, ref)
	mid := stringOf(managed["id"])
	b.Terminals.Control(id, mid, "agent")
	entry := b.Terminals.Execute(id, mid, "agent", "printf 'WINDOWS_MANAGED_FIXTURE\\n'", "")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result := b.Terminals.Wait(ctx, id, mid, stringOf(entry["id"]))
	if !strings.Contains(stringOf(result["output"]), "WINDOWS_MANAGED_FIXTURE") {
		t.Fatal("managed command markers unavailable")
	}
	b.Terminals.Close(id, mid)
	b.Terminals.Close(id, tid)
}

func TestWindowsConPTYInputLineEndings(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{"eval \"$__lake_init\"\n", "eval \"$__lake_init\"\r"},
		{"pwd\r\nprintf 'ok'\n", "pwd\rprintf 'ok'\r"},
		{"\x1b[A\x03\r", "\x1b[A\x03\r"},
	} {
		if got := windowsTerminalInput(tc.input); got != tc.want {
			t.Fatalf("input = %q, want %q", got, tc.want)
		}
	}
}
