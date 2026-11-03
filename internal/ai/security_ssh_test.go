//go:build darwin || linux

package ai

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"github.com/Clean-Lakes/Lake/internal/platform"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

func managedSSHFixture(t *testing.T, disconnect bool) (*Engine, Config, <-chan string) {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	root := t.TempDir()
	if err = os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	bytes, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	private := filepath.Join(root, "identity")
	if err = os.WriteFile(private, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: bytes}), 0600); err != nil {
		t.Fatal(err)
	}
	known := filepath.Join(root, "known_hosts")
	if err = os.WriteFile(known, []byte(knownhosts.Line([]string{listener.Addr().String()}, signer.PublicKey())+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	commands := make(chan string, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		// Bound the fixture even if a failed client leaves its transport open.
		_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
		serverConfig := &ssh.ServerConfig{NoClientAuth: true}
		serverConfig.AddHostKey(signer)
		server, channels, requests, err := ssh.NewServerConn(conn, serverConfig)
		if err != nil {
			return
		}
		defer server.Close()
		go ssh.DiscardRequests(requests)
		for incoming := range channels {
			if incoming.ChannelType() != "session" {
				incoming.Reject(ssh.UnknownChannelType, "session only")
				continue
			}
			ch, reqs, err := incoming.Accept()
			if err != nil {
				return
			}
			for req := range reqs {
				if req.Type != "exec" {
					req.Reply(false, nil)
					continue
				}
				var payload struct{ Command string }
				if ssh.Unmarshal(req.Payload, &payload) != nil {
					return
				}
				commands <- payload.Command
				req.Reply(true, nil)
				if disconnect {
					ch.Close()
					return
				}
				io.WriteString(ch, "owned-remote-profile\n")
				ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Code uint32 }{0}))
				ch.CloseWrite()
				ch.Close()
				// Keep the transport alive until OpenSSH consumes the exit status
				// and disconnects. Closing it immediately can turn a successful
				// fixture into client_loop EPIPE / exit 255 on Linux.
				_ = server.Wait()
				return
			}
		}
	}()
	as := Asset{ID: "resource", Kind: "ssh", SSH: &SSH{Host: "127.0.0.1", Port: listener.Addr().(*net.TCPAddr).Port, Username: "fixture", IdentityFile: private, KnownHosts: known}}
	e, c := fixedReadManagedFixture(t, as, security.Rule{Capability: "terminal.execute", Effect: security.EffectAllow})
	c.CredentialDir = root
	if _, err = e.PutSecurityProjectPolicy(t.Context(), SecurityPolicyAction{ActorID: "user", ActionID: "remote-compiled-policy", ProjectID: "project", ExpectedRevision: 3}, security.ProjectPolicy{ProjectID: "project", SchemaVersion: 1, Mode: "restricted", ResourceIDs: []string{as.ID}, Rules: []security.Rule{{Capability: "terminal.execute", Effect: security.EffectAllow}, {Capability: "command.diagnostics", Effect: security.EffectAllow}}}); err != nil {
		t.Fatal(err)
	}
	if _, err = e.PutSecurityCommandTarget(t.Context(), SecurityCommandTargetAction{SecurityPolicyAction: SecurityPolicyAction{ActorID: "user", ActionID: "remote-profile-target", ProjectID: "project"}, ResourceID: as.ID, OS: "linux", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	return e, c, commands
}

func TestSecurityManagedSSHProfileRealTransportAndUnknownDisconnect(t *testing.T) {
	for _, disconnect := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "disconnect"}[disconnect], func(t *testing.T) {
			e, c, commands := managedSSHFixture(t, disconnect)
			a := map[string]any{"asset_ref": assetAlias("resource"), "command": "df -h", "timeout_ms": 5000}
			call := Call{ID: "actual-ssh-profile", Name: "shell", Arguments: js(a)}
			prepared, decision, err := e.PrepareCatalogOperation(t.Context(), "case", c, call, a)
			if err != nil || prepared == nil || prepared.command == nil || decision.Effect != security.EffectAllow {
				t.Fatal(decision, err)
			}
			ctx := SecurityOperationContext(t.Context(), prepared)
			session, _ := e.get("case")
			operation, err := e.dispatchNativeOperation(ctx, session, prepared.executionConfig, call, "readonly", "remote profile", prepared.digest)
			if err != nil {
				t.Fatal(err)
			}
			ctx = securityPermitContext(ctx, operation.permit)
			if !disconnect {
				remote := append([]string{prepared.command.Executable()}, prepared.command.Arguments()...)
				target := prepared.executionConfig.Assets[0].SSH
				base, baseErr := sshBase(target, prepared.executionConfig.CredentialDir)
				if baseErr != nil {
					t.Fatal(baseErr)
				}
				transport := append([]string{platform.Executable("ssh")}, base...)
				command := "cd " + quote(prepared.command.Directory()) + " && exec " + joinArgs(append(append([]string{"/usr/bin/env", "-i"}, prepared.command.Environment()...), remote...))
				transport = append(transport, "-p", fmt.Sprint(target.Port), "-l", target.Username, target.Host, command+"; echo substituted")
				environment, envErr := sshEnvironment(target, prepared.executionConfig.CredentialDir)
				if envErr != nil {
					t.Fatal(envErr)
				}
				frozenContext := context.WithValue(ctx, frozenCommandContextKey{}, *prepared.command)
				_, mutatedErr := e.runManagedSSHProcess(frozenContext, prepared.executionConfig, prepared.executionArgs, remote, nil, target, transport, environment, prepared.command.Directory())
				var notStarted *ToolNotExecutedError
				if !errors.As(mutatedErr, &notStarted) || e.managedShellByOperation(operation.ID) != nil {
					t.Fatal("modified SSH command started a process", mutatedErr)
				}
				select {
				case <-commands:
					t.Fatal("modified SSH command reached server")
				default:
				}
			}
			value, runErr := e.executeFrozenCommand(ctx, prepared.executionConfig, prepared.executionArgs, *prepared.command)
			if err = e.finishNativeOperation(operation, prepared.executionConfig, value, runErr); err != nil {
				t.Fatal(err)
			}
			select {
			case actual := <-commands:
				expected := "cd " + quote(prepared.command.Directory()) + " && exec " + joinArgs(append(append([]string{"/usr/bin/env", "-i"}, prepared.command.Environment()...), append([]string{prepared.command.Executable()}, prepared.command.Arguments()...)...))
				if actual != expected {
					t.Fatal("remote command did not preserve exact compiled argv")
				}
			case <-time.After(3 * time.Second):
				t.Fatal("no actual SSH command", runErr)
			}
			job := e.managedShellByOperation(operation.ID)
			if job == nil || !job.remoteTransport {
				t.Fatal("remote transport had no original owned handle")
			}
			adapter := e.ManagedShellCleanupAdapter()
			observation, err := adapter.Observe(context.Background(), ExecutionCleanup{OperationID: operation.ID, Handle: job.id, OwnerID: job.ownerID, OwnerGeneration: job.ownerGeneration, DescriptorDigest: job.descriptorDigest})
			if err != nil || observation.Stopped || observation.EffectsKnown {
				t.Fatal("local SSH exit falsely proved remote stop/effects", observation, err)
			}
			if disconnect {
				if runErr == nil {
					t.Fatal("SSH transport disconnect claimed success")
				}
			} else if runErr != nil || !strings.Contains(str(obj(value)["stdout"]), "owned-remote-profile") {
				t.Fatal(value, runErr)
			}
		})
	}
}

func TestSecurityInspectHostUsesFixedSSHReadWithoutClearingLegacyWriteRisk(t *testing.T) {
	e, c, commands := managedSSHFixture(t, false)
	store, _ := e.adkStore()
	if err := store.DB.Create(&nativeOperation{ID: "legacy-risk", SessionID: "old", Tool: "shell", Risk: "write", Status: "unknown"}).Error; err != nil {
		t.Fatal(err)
	}
	a := map[string]any{"asset_ref": assetAlias("resource"), "runtime": "ssh"}
	result, err := runFixedReadPermit(t, e, c, Call{ID: "host-probe", Name: "inspect_host", Arguments: js(a)})
	if err != nil || !strings.Contains(str(obj(result)["stdout"]), "owned-remote-profile") {
		t.Fatal(result, err)
	}
	select {
	case command := <-commands:
		if !strings.Contains(command, "'/bin/ps' '-eo' 'pid,ppid,pcpu,pmem,comm'") {
			t.Fatal("inspection did not use exact fixed process diagnostic", command)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no SSH process diagnostic")
	}
	var prior nativeOperation
	if err = store.DB.First(&prior, "id = ?", "legacy-risk").Error; err != nil || prior.Status != "unknown" || prior.RiskResolvedAt != nil {
		t.Fatal("inspection changed old risk", err)
	}
	if err = CheckResourceWriteBlock(store.DB, "resource"); err != ErrUnresolvedResourceEffect {
		t.Fatal("old write restriction lost", err)
	}
}
