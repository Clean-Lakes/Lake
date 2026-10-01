package sshtransport

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"net"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

func TestOpenConnectionReusesSSHTransport(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, hostKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	hostSigner, err := ssh.NewSignerFromKey(hostKey)
	if err != nil {
		t.Fatal(err)
	}
	_, clientKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	clientSigner, err := ssh.NewSignerFromKey(clientKey)
	if err != nil {
		t.Fatal(err)
	}
	privateBlock, err := ssh.MarshalPrivateKey(clientKey, "lake-test")
	if err != nil {
		t.Fatal(err)
	}
	serverConfig := &ssh.ServerConfig{
		PublicKeyCallback: func(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if string(key.Marshal()) != string(clientSigner.PublicKey().Marshal()) {
				return nil, errors.New("unauthorized public key")
			}
			return nil, nil
		},
	}
	serverConfig.AddHostKey(hostSigner)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	var accepts atomic.Int32
	go func() {
		for {
			raw, err := listener.Accept()
			if err != nil {
				return
			}
			accepts.Add(1)
			go serveTestSSH(raw, serverConfig)
		}
	}()
	knownHostsPath := filepath.Join(t.TempDir(), "known_hosts")
	if err := os.WriteFile(knownHostsPath, []byte(knownhosts.Line([]string{listener.Addr().String()}, hostSigner.PublicKey())+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	connection, err := (Client{KnownHostsPath: knownHostsPath, Timeout: 2 * time.Second}).Open(ctx,
		Target{Host: "127.0.0.1", Port: listener.Addr().(*net.TCPAddr).Port, Username: "root"},
		pem.EncodeToMemory(privateBlock))
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	for _, command := range []string{"hostname", "uptime"} {
		result, err := connection.Run(ctx, command)
		if err != nil || result.Stdout != command || result.ExitCode != 0 {
			t.Fatalf("command %q result=%+v err=%v", command, result, err)
		}
	}
	if accepts.Load() != 1 || connection.IsClosed() {
		t.Fatalf("connection not reused: accepts=%d closed=%t", accepts.Load(), connection.IsClosed())
	}
	if err := connection.Close(); err != nil || !connection.IsClosed() {
		t.Fatalf("connection not closed: err=%v closed=%t", err, connection.IsClosed())
	}
	_, wrongHostKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	wrongSigner, err := ssh.NewSignerFromKey(wrongHostKey)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(knownHostsPath, []byte(knownhosts.Line([]string{listener.Addr().String()}, wrongSigner.PublicKey())+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if unexpected, err := (Client{KnownHostsPath: knownHostsPath, Timeout: 2 * time.Second}).Open(ctx,
		Target{Host: "127.0.0.1", Port: listener.Addr().(*net.TCPAddr).Port, Username: "root"},
		pem.EncodeToMemory(privateBlock)); err == nil {
		_ = unexpected.Close()
		t.Fatal("accepted a mismatched SSH host key")
	}
}

func serveTestSSH(raw net.Conn, config *ssh.ServerConfig) {
	defer raw.Close()
	_, channels, requests, err := ssh.NewServerConn(raw, config)
	if err != nil {
		return
	}
	go ssh.DiscardRequests(requests)
	for channel := range channels {
		if channel.ChannelType() != "session" {
			_ = channel.Reject(ssh.UnknownChannelType, "session only")
			continue
		}
		ch, reqs, err := channel.Accept()
		if err != nil {
			return
		}
		go func() {
			defer ch.Close()
			for req := range reqs {
				if req.Type != "exec" {
					_ = req.Reply(false, nil)
					continue
				}
				var payload struct{ Command string }
				if err := ssh.Unmarshal(req.Payload, &payload); err != nil {
					_ = req.Reply(false, nil)
					return
				}
				_ = req.Reply(true, nil)
				_, _ = ch.Write([]byte(payload.Command))
				_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
				return
			}
		}()
	}
}

func TestFreshConnectionRetriesOnlyBeforeExecution(t *testing.T) {
	for _, scenario := range []string{"transient_handshake", "host_key_mismatch", "lost_exec_response"} {
		t.Run(scenario, func(t *testing.T) {
			_, hostKey, _ := ed25519.GenerateKey(rand.Reader)
			hostSigner, _ := ssh.NewSignerFromKey(hostKey)
			_, clientKey, _ := ed25519.GenerateKey(rand.Reader)
			privateBlock, _ := ssh.MarshalPrivateKey(clientKey, "test")
			config := &ssh.ServerConfig{PublicKeyCallback: func(ssh.ConnMetadata, ssh.PublicKey) (*ssh.Permissions, error) { return nil, nil }}
			config.AddHostKey(hostSigner)
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			var accepts, executions atomic.Int32
			go func() {
				for {
					raw, err := listener.Accept()
					if err != nil {
						return
					}
					attempt := accepts.Add(1)
					if scenario == "transient_handshake" && attempt <= 2 {
						raw.Close()
						continue
					}
					go func(raw net.Conn) {
						defer raw.Close()
						_, channels, requests, err := ssh.NewServerConn(raw, config)
						if err != nil {
							return
						}
						go ssh.DiscardRequests(requests)
						for channel := range channels {
							ch, reqs, err := channel.Accept()
							if err != nil {
								return
							}
							for req := range reqs {
								if req.Type != "exec" {
									req.Reply(false, nil)
									continue
								}
								executions.Add(1)
								if scenario == "lost_exec_response" {
									return
								}
								req.Reply(true, nil)
								ch.Write([]byte("done"))
								ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
								ch.Close()
								return
							}
						}
					}(raw)
				}
			}()
			knownKey := hostSigner.PublicKey()
			if scenario == "host_key_mismatch" {
				_, wrongKey, _ := ed25519.GenerateKey(rand.Reader)
				wrongSigner, _ := ssh.NewSignerFromKey(wrongKey)
				knownKey = wrongSigner.PublicKey()
			}
			known := filepath.Join(t.TempDir(), "known_hosts")
			if err := os.WriteFile(known, []byte(knownhosts.Line([]string{listener.Addr().String()}, knownKey)+"\n"), 0600); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
			defer cancel()
			result, err := (Client{KnownHostsPath: known, Timeout: 3 * time.Second}).Run(ctx, Target{Host: "127.0.0.1", Port: listener.Addr().(*net.TCPAddr).Port, Username: "test"}, pem.EncodeToMemory(privateBlock), "write-once")
			switch scenario {
			case "transient_handshake":
				if err != nil || result.Stdout != "done" || accepts.Load() != 3 || executions.Load() != 1 {
					t.Fatalf("safe setup retry: %+v %v accepts=%d executions=%d", result, err, accepts.Load(), executions.Load())
				}
			case "host_key_mismatch":
				if !errors.Is(err, ErrNotStarted) || accepts.Load() != 1 || executions.Load() != 0 {
					t.Fatalf("host key retry/bypass: %v accepts=%d executions=%d", err, accepts.Load(), executions.Load())
				}
			case "lost_exec_response":
				if err == nil || errors.Is(err, ErrNotStarted) || accepts.Load() != 1 || executions.Load() != 1 {
					t.Fatalf("unknown execution replayed: %v accepts=%d executions=%d", err, accepts.Load(), executions.Load())
				}
			}
		})
	}
}
