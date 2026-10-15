package web

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/Clean-Lakes/Lake/internal/ai"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/creack/pty"
	"golang.org/x/crypto/ssh"
)

func TestMain(m *testing.M) {
	if os.Getenv("LAKE_SSH_ASKPASS") == "1" {
		code := 1
		func() {
			defer func() { recover() }()
			if len(os.Args) == 2 && SSHAskpass(os.Args[1], os.Stdout) == nil {
				code = 0
			}
		}()
		if code != 0 {
			fmt.Fprintln(os.Stderr, SSHAskpassFailureMessage)
		}
		os.Exit(code)
	}
	os.Exit(m.Run())
}

func TestSSHCredentialStorageAndDirectory(t *testing.T) {
	b, h := fixture(t)
	sid, _ := newSession(t, h)
	project := stringOf(b.Store.Session(sid)["projectId"])
	dir := t.TempDir()
	must(os.Chmod(dir, 0700))
	key := filepath.Join(dir, "id_fixture")
	if exec.Command("/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key).Run() != nil {
		t.Fatal("synthetic key generation failed")
	}
	must(os.WriteFile(filepath.Join(dir, "config"), []byte("Host fixture"), 0600))
	must(os.WriteFile(filepath.Join(dir, "insecure"), []byte("-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic"), 0644))
	must(os.Symlink(key, filepath.Join(dir, "linked")))
	listing := apiTest(t, h, "POST", "/api/settings/ssh/keys", Object{"directory": dir}, 200)
	keys := objects(listing["keys"])
	if len(keys) != 1 || keys[0]["name"] != "id_fixture" || strings.Contains(jsonText(listing), "BEGIN") {
		t.Fatal("listing must expose only eligible filenames")
	}
	input := Object{"host": "127.0.0.1", "username": "fixture", "identityFile": key}
	resource := apiTest(t, h, "POST", "/api/projects/"+project+"/resources", Object{"kind": "ssh", "name": "selected key", "ssh": input}, 201)
	imported := stringOf(object(resource["ssh"])["identityFile"])
	expectedRoot, _ := filepath.EvalSymlinks(filepath.Join(b.Models.Home, "secrets"))
	if imported == key || !strings.HasPrefix(imported, expectedRoot+string(filepath.Separator)) {
		t.Fatal("selected key was not imported")
	}
	original, _ := os.ReadFile(key)
	copy, _ := os.ReadFile(imported)
	if !bytes.Equal(original, copy) {
		t.Fatal("import changed key")
	}
	info, _ := os.Stat(imported)
	if info.Mode().Perm() != 0600 {
		t.Fatal("imported key permissions")
	}
	input = Object{"host": "127.0.0.1", "username": "fixture", "authMethod": "password", "password": "Synthetic-password-storage-123"}
	resource = apiTest(t, h, "POST", "/api/projects/"+project+"/resources", Object{"kind": "ssh", "name": "password", "ssh": input}, 201)
	cfg := object(resource["ssh"])
	if strings.Contains(jsonText(resource), stringOf(input["password"])) || cfg["password"] != nil || cfg["credentialRef"] == nil || cfg["identityFile"] != nil {
		t.Fatal("password leaked into resource")
	}
	raw := b.Store.read(func() any {
		return b.Store.row("SELECT config FROM resourceConnections WHERE resourceId=?", resource["id"])
	}).(Object)
	if strings.Contains(jsonText(raw), stringOf(input["password"])) {
		t.Fatal("password persisted in SQLite")
	}
	ref := stringOf(cfg["credentialRef"])
	if readSSHSecret(filepath.Join(b.Models.Home, "secrets"), ref) != input["password"] {
		t.Fatal("private credential missing")
	}
	expectPanic(t, 400, func() {
		prepareSSH(b.Models.Home, Object{"host": "127.0.0.1", "username": "fixture", "identityFile": filepath.Join(dir, "insecure")})
	})
	expectPanic(t, 400, func() {
		prepareSSH(b.Models.Home, Object{"host": "127.0.0.1", "username": "fixture", "identityFile": filepath.Join(dir, "linked")})
	})
	must(os.Chmod(dir, 0755))
	apiTest(t, h, "POST", "/api/settings/ssh/keys", Object{"directory": dir}, 400)
	must(os.Chmod(dir, 0700))
	entries, _ := os.ReadDir(filepath.Join(b.Models.Home, "secrets"))
	before := len(entries)
	apiTest(t, h, "POST", "/api/projects/"+project+"/resources", Object{"kind": "ssh", "name": "", "ssh": input}, 400)
	entries, _ = os.ReadDir(filepath.Join(b.Models.Home, "secrets"))
	if len(entries) != before {
		t.Fatal("failed resource left credentials")
	}
}

// Uploaded material must remain in private files, including on failed creation.
func TestSSHPrivateKeyUpload(t *testing.T) {
	b, h := fixture(t)
	sid, _ := newSession(t, h)
	project := stringOf(b.Store.Session(sid)["projectId"])
	dir := t.TempDir()
	key := filepath.Join(dir, "upload_fixture")
	if exec.Command("/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key).Run() != nil {
		t.Fatal("synthetic key generation failed")
	}
	raw, err := os.ReadFile(key)
	if err != nil {
		t.Fatal("synthetic key unavailable")
	}
	// Exercise uploads larger than the old 16 KB request limit.
	uploaded := string(raw) + strings.Repeat("\n", 20000)
	request := func(name string, input Object, status int) Object {
		t.Helper()
		r, err := http.NewRequest("POST", h.URL+"/api/projects/"+project+"/resources", strings.NewReader(jsonText(Object{"kind": "ssh", "name": name, "ssh": input})))
		if err != nil {
			t.Fatal("request creation failed")
		}
		r.Host = "localhost:4177"
		r.Header.Set("Authorization", "Bearer synthetic-test-auth-token")
		r.Header.Set("Content-Type", "application/json")
		resp, err := h.Client().Do(r)
		if err != nil {
			t.Fatal("upload request failed")
		}
		defer resp.Body.Close()
		data, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != status {
			t.Fatalf("unexpected upload status: %d, expected %d", resp.StatusCode, status)
		}
		if bytes.Contains(data, []byte("PRIVATE KEY")) {
			t.Fatal("response exposed private key material")
		}
		var result Object
		if json.Unmarshal(data, &result) != nil {
			t.Fatal("invalid upload response")
		}
		return result
	}
	input := Object{"host": "127.0.0.1", "username": "fixture", "shell": "bash", "privateKey": uploaded}
	resource := request("uploaded key", input, 201)
	cfg := object(resource["ssh"])
	if cfg["privateKey"] != nil || cfg["shell"] != "bash" {
		t.Fatal("upload configuration was not sanitized")
	}
	path := stringOf(cfg["identityFile"])
	data, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(data, []byte(uploaded)) {
		t.Fatal("uploaded key was not saved correctly")
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("uploaded key permissions")
	}
	root := filepath.Join(b.Models.Home, "secrets")
	info, err = os.Stat(root)
	if err != nil || info.Mode().Perm() != 0700 {
		t.Fatal("credential directory permissions")
	}
	stored := b.Store.read(func() any {
		return b.Store.row("SELECT config FROM resourceConnections WHERE resourceId=?", resource["id"])
	}).(Object)
	if strings.Contains(jsonText(stored), "PRIVATE KEY") {
		t.Fatal("key material persisted in SQLite")
	}
	before, _ := os.ReadDir(root)
	request("", input, 400)
	input["privateKey"] = "-----BEGIN OPENSSH PRIVATE KEY-----\ninvalid\n-----END OPENSSH PRIVATE KEY-----"
	request("invalid", input, 400)
	pub, err := os.ReadFile(key + ".pub")
	if err != nil {
		t.Fatal("public fixture unavailable")
	}
	input["privateKey"] = string(pub)
	request("public key", input, 400)
	input["privateKey"] = strings.Repeat("x", 1024*1024+1)
	request("oversized", input, 400)
	after, _ := os.ReadDir(root)
	if len(after) != len(before) {
		t.Fatal("failed uploads left credentials")
	}
	encrypted := filepath.Join(dir, "encrypted_fixture")
	if exec.Command("/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "synthetic-upload-passphrase", "-f", encrypted).Run() != nil {
		t.Fatal("encrypted synthetic generation failed")
	}
	raw, err = os.ReadFile(encrypted)
	if err != nil {
		t.Fatal("encrypted fixture unavailable")
	}
	input["privateKey"] = string(raw)
	input["passphrase"] = "synthetic-upload-passphrase"
	resource = request("encrypted key", input, 201)
	cfg = object(resource["ssh"])
	if cfg["privateKey"] != nil || cfg["passphrase"] != nil || cfg["credentialRef"] == nil {
		t.Fatal("encrypted upload not sanitized")
	}
}

// Isolated SSH protocol server: genuine password/public-key authentication and
// PTY shell, but no macOS accounts, production hosts or production credentials.
func credentialSSHServer(t *testing.T, password string, public ssh.PublicKey, configure ...func(*ssh.ServerConfig)) (int, string) {
	t.Helper()
	_, key, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	signer, e := ssh.NewSignerFromKey(key)
	if e != nil {
		t.Fatal(e)
	}
	config := &ssh.ServerConfig{
		PasswordCallback: func(meta ssh.ConnMetadata, p []byte) (*ssh.Permissions, error) {
			if meta.User() == "fixture" && string(p) == password {
				return nil, nil
			}
			return nil, errors.New("authentication rejected")
		},
		PublicKeyCallback: func(meta ssh.ConnMetadata, k ssh.PublicKey) (*ssh.Permissions, error) {
			if meta.User() == "fixture" && public != nil && bytes.Equal(k.Marshal(), public.Marshal()) {
				return nil, nil
			}
			return nil, errors.New("authentication rejected")
		},
	}
	for _, apply := range configure {
		apply(config)
	}
	config.AddHostKey(signer)
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	known := filepath.Join(t.TempDir(), "known_hosts")
	must(os.WriteFile(known, []byte(fmt.Sprintf("[127.0.0.1]:%d %s", port, ssh.MarshalAuthorizedKey(signer.PublicKey()))), 0600))
	var mu sync.Mutex
	connections := []net.Conn{}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			socket, e := listener.Accept()
			if e != nil {
				return
			}
			mu.Lock()
			connections = append(connections, socket)
			mu.Unlock()
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer socket.Close()
				connection, channels, requests, e := ssh.NewServerConn(socket, config)
				if e != nil {
					return
				}
				defer connection.Close()
				go ssh.DiscardRequests(requests)
				for newChannel := range channels {
					if newChannel.ChannelType() != "session" {
						newChannel.Reject(ssh.UnknownChannelType, "session only")
						continue
					}
					channel, requests, e := newChannel.Accept()
					if e != nil {
						continue
					}
					wg.Add(1)
					go func() {
						defer wg.Done()
						defer channel.Close()
						var shell *exec.Cmd
						var terminal *os.File
						ptyRequested := false
						defer func() {
							if terminal != nil {
								terminal.Close()
							}
							if shell != nil && shell.Process != nil {
								killTerminal(shell.Process.Pid)
							}
						}()
						for request := range requests {
							switch request.Type {
							case "pty-req", "window-change":
								ptyRequested = true
								request.Reply(true, nil)
							case "exec":
								if shell != nil {
									request.Reply(false, nil)
									continue
								}
								var payload struct{ Command string }
								ssh.Unmarshal(request.Payload, &payload)
								shell = exec.Command("/bin/sh", "-c", payload.Command)
								shell.Env = []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "TERM=xterm-256color", "PS1=", "PS2="}
								if ptyRequested {
									var startErr error
									terminal, startErr = pty.Start(shell)
									if startErr != nil {
										request.Reply(false, nil)
										return
									}
									request.Reply(true, nil)
									go io.Copy(terminal, channel)
									go func() { io.Copy(channel, terminal); channel.Close() }()
									go func() { shell.Wait(); channel.Close() }()
								} else {
									shell.Stdin = channel
									shell.Stdout = channel
									shell.Stderr = channel.Stderr()
									if shell.Start() != nil {
										request.Reply(false, nil)
										return
									}
									request.Reply(true, nil)
									go func() {
										shell.Wait()
										channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{uint32(shell.ProcessState.ExitCode())}))
										channel.Close()
									}()
								}
							default:
								request.Reply(false, nil)
							}
						}
					}()
				}
			}()
		}
	}()
	t.Cleanup(func() {
		listener.Close()
		mu.Lock()
		for _, c := range connections {
			c.Close()
		}
		mu.Unlock()
		wg.Wait()
	})
	return port, known
}

func TestPasswordAndEncryptedKeyPersistentSSH(t *testing.T) {
	clientHome := t.TempDir()
	must(os.Chmod(clientHome, 0700))
	t.Setenv("HOME", clientHome)
	b, h := fixture(t)
	id, _ := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	dir := t.TempDir()
	must(os.Chmod(dir, 0700))
	key := filepath.Join(dir, "encrypted")
	passphrase := "Synthetic-passphrase-789"
	if exec.Command("/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", passphrase, "-f", key).Run() != nil {
		t.Fatal("synthetic encrypted key generation failed")
	}
	pubData, e := os.ReadFile(key + ".pub")
	if e != nil {
		t.Fatal(e)
	}
	pub, _, _, _, e := ssh.ParseAuthorizedKey(pubData)
	if e != nil {
		t.Fatal(e)
	}
	password := "Synthetic-password-456"
	port, known := credentialSSHServer(t, password, pub)
	b.Terminals.KnownHosts = known
	must(os.MkdirAll(filepath.Join(clientHome, ".ssh"), 0700))
	trusted, _ := os.ReadFile(known)
	must(os.WriteFile(filepath.Join(clientHome, ".ssh", "known_hosts"), trusted, 0600))
	if path := os.Getenv("LAKE_TEST_SIGNED_BINARY"); path != "" {
		b.Terminals.askpassProgram = path
	}
	for _, mode := range []string{"password", "key"} {
		t.Run(mode, func(t *testing.T) {
			config := Object{"host": "127.0.0.1", "port": port, "username": "fixture", "authMethod": mode}
			if mode == "key" {
				config["identityFile"] = key
				config["passphrase"] = passphrase
			} else {
				config["password"] = password
			}
			resource := apiTest(t, h, "POST", "/api/projects/"+project+"/resources", Object{"name": mode, "kind": "ssh", "ssh": config}, 201)
			rid := stringOf(resource["id"])
			session := b.Store.CreateSession(project, mode, []string{rid})
			sid := stringOf(session["id"])
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			term := b.Terminals.Open(ctx, sid, rid)
			tid := stringOf(term["id"])
			entry := b.Terminals.Execute(sid, tid, "user", "cd /tmp; export LAKE_AUTH_FIXTURE=persistent", "")
			b.Terminals.Wait(ctx, sid, tid, stringOf(entry["id"]))
			entry = b.Terminals.Execute(sid, tid, "user", "printf '%s:%s' \"$PWD\" \"$LAKE_AUTH_FIXTURE\"", "")
			result := b.Terminals.Wait(ctx, sid, tid, stringOf(entry["id"]))
			if !strings.Contains(stringOf(result["output"]), "/tmp:persistent") {
				t.Fatal("authenticated PTY did not preserve shell state")
			}
			live := b.Terminals.get(sid, tid)
			for _, arg := range append(live.cmd.Args, live.cmd.Env...) {
				if strings.Contains(arg, password) || strings.Contains(arg, passphrase) {
					t.Fatal("secret exposed in arguments/environment")
				}
			}
			if strings.Contains(b.Terminals.redact("before "+password+" "+passphrase+" after"), map[string]string{"password": password, "key": passphrase}[mode]) {
				t.Fatal("auth output not redacted")
			}
			b.Terminals.Close(sid, tid)
			reopened := b.Terminals.Open(ctx, sid, rid)
			if reopened["id"] == term["id"] {
				t.Fatal("reconnect reused closed terminal")
			}
			b.Terminals.Close(sid, stringOf(reopened["id"]))
			// A model-issued remote read uses the same password/passphrase reference.
			remote := filepath.Join(dir, "remote-status.txt")
			must(os.WriteFile(remote, []byte("REMOTE_AUTH_FILE_EVIDENCE"), 0600))
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				var body Object
				json.NewDecoder(request.Body).Decode(&body)
				resultFound := false
				for _, message := range objects(body["messages"]) {
					if message["role"] == "tool" && message["name"] == "read" {
						resultFound = strings.Contains(stringOf(message["content"]), "REMOTE_AUTH_FILE_EVIDENCE")
					}
				}
				if resultFound {
					emitModel(w, "远程文件已读取", nil)
				} else {
					emitModel(w, "", []ai.Call{{ID: "remote-read", Name: "read", Arguments: jsonText(Object{"runtime": "ssh", "path": remote})}})
				}
			}))
			defer provider.Close()
			b.Models.Save(&ai.Model{URL: provider.URL + "/v1/chat/completions", Name: "SSH auth fixture", Protocol: "openai"})
			allowFixtureHost(b, sid)
			apiTest(t, h, "POST", "/api/sessions/"+sid+"/messages", Object{"text": "读取远程文件", "resourceIds": []string{rid}}, 202)
			b.workers.Wait()
			view, err := b.Engine.Snapshot(sid)
			if err != nil || view.Status != "completed" || !strings.Contains(jsonText(view), "REMOTE_AUTH_FILE_EVIDENCE") {
				t.Fatal("model remote file read did not authenticate")
			}
			// A model-selected file read may use direct SSH without creating a PTY.
			if bound := stringOf(b.Store.Options(sid)["terminal_id"]); bound != "" {
				b.Terminals.Close(sid, bound)
			}
		})
	}
	bad := Object{"host": "127.0.0.1", "port": port, "username": "fixture", "authMethod": "password", "password": "Synthetic-wrong-password"}
	resource := apiTest(t, h, "POST", "/api/projects/"+project+"/resources", Object{"name": "wrong password", "kind": "ssh", "ssh": bad}, 201)
	rid := stringOf(resource["id"])
	session := b.Store.CreateSession(project, "reject", []string{rid})
	sid := stringOf(session["id"])
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	expectPanic(t, 503, func() { b.Terminals.Open(ctx, sid, rid) })
	if len(b.Store.ResourceTerminals(rid)) != 0 {
		t.Fatal("wrong password left active terminal")
	}
	empty := filepath.Join(dir, "empty-known_hosts")
	must(os.WriteFile(empty, nil, 0600))
	b.Terminals.KnownHosts = empty
	expectPanic(t, 503, func() { b.Terminals.Open(ctx, sid, rid) })
}

func TestKeyboardInteractivePasswordPersistentSSH(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	password := "Synthetic-PAM-password"
	port, known := credentialSSHServer(t, password, nil, func(config *ssh.ServerConfig) {
		config.PasswordCallback, config.PublicKeyCallback = nil, nil
		config.KeyboardInteractiveCallback = func(meta ssh.ConnMetadata, challenge ssh.KeyboardInteractiveChallenge) (*ssh.Permissions, error) {
			answers, err := challenge(meta.User(), "", []string{"Password: "}, []bool{false})
			if err != nil || meta.User() != "fixture" || len(answers) != 1 || answers[0] != password {
				return nil, errors.New("fixture authentication rejected")
			}
			return nil, nil
		}
	})
	b.Terminals.KnownHosts = known
	config, cleanup := prepareSSH(b.Models.Home, Object{"host": "127.0.0.1", "port": port, "username": "fixture", "authMethod": "password", "password": password})
	defer cleanup()
	resource := b.Store.CreateResource(stringOf(b.Store.Session(id)["projectId"]), "PAM-only fixture", "ssh", config)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	term := b.Terminals.Open(ctx, id, stringOf(resource["id"]))
	tid := stringOf(term["id"])
	defer b.Terminals.Close(id, tid)
	entry := b.Terminals.Execute(id, tid, "user", "printf PAM_AUTHENTICATED", "")
	result := b.Terminals.Wait(ctx, id, tid, stringOf(entry["id"]))
	if !strings.Contains(stringOf(result["output"]), "PAM_AUTHENTICATED") {
		t.Fatal("keyboard-interactive password did not establish a usable terminal")
	}
}

func TestSSHAskpassPromptBoundaries(t *testing.T) {
	root := t.TempDir()
	must(os.Chmod(root, 0700))
	must(os.WriteFile(filepath.Join(root, "fixture"), []byte("Synthetic-helper-secret"), 0600))
	t.Setenv("LAKE_SSH_SECRET_ROOT", root)
	t.Setenv("LAKE_SSH_SECRET_REF", "fixture")
	t.Setenv("LAKE_SSH_ASKPASS_MODE", "password")
	var out bytes.Buffer
	for _, prompt := range []string{"Are you sure you want to continue connecting (yes/no)?", "One-time password:", "New password:", "Retype new password:", "Verification code:", "(fixture@host) One-time password:", "(fixture@host) New password:", "(One-time password) Password:"} {
		out.Reset()
		if SSHAskpass(prompt, &out) == nil || out.Len() != 0 {
			t.Fatal("non-password challenge exposed a saved password")
		}
	}
	for _, prompt := range []string{"fixture@host's password:", "Password: ", "(fixture@host) Password:", "密码："} {
		out.Reset()
		if SSHAskpass(prompt, &out) != nil || out.String() != "Synthetic-helper-secret\n" {
			t.Fatal("password helper failed")
		}
	}
	out.Reset()
	t.Setenv("LAKE_SSH_ASKPASS_MODE", "key")
	if SSHAskpass("fixture@host's password:", &out) == nil || out.Len() != 0 {
		t.Fatal("key must not fall back to password")
	}
}
