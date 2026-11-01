package ai

import (
	"encoding/binary"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"github.com/jackc/pgx/v5/pgproto3"
)

// Protocol fixture uses the real pgx database/sql driver. It verifies the
// runtime actually sends a read-only BEGIN, bounded setup and fixed SELECT,
// rather than only testing a query string classifier.
func TestSecurityFixedPostgresProbeUsesReadOnlyOriginalPermit(t *testing.T) {
	t.Setenv("PGPASSWORD", "SYNTHETIC_UNRELATED_ENV_PASSWORD")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	var mu sync.Mutex
	queries := []string{}
	emptyPassword := false
	done := make(chan struct{})
	go func() {
		defer close(done)
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		defer connection.Close()
		connection.SetDeadline(time.Now().Add(10 * time.Second))
		backend := pgproto3.NewBackend(connection, connection)
		if _, err = backend.ReceiveStartupMessage(); err != nil {
			return
		}
		backend.SetAuthType(pgproto3.AuthTypeCleartextPassword)
		backend.Send(&pgproto3.AuthenticationCleartextPassword{})
		if backend.Flush() != nil {
			return
		}
		passwordMessage, err := backend.Receive()
		if err != nil {
			return
		}
		password, ok := passwordMessage.(*pgproto3.PasswordMessage)
		if !ok {
			return
		}
		mu.Lock()
		emptyPassword = password.Password == ""
		mu.Unlock()
		backend.Send(&pgproto3.AuthenticationOk{})
		backend.Send(&pgproto3.ParameterStatus{Name: "server_version", Value: "16.0"})
		backend.Send(&pgproto3.ParameterStatus{Name: "client_encoding", Value: "UTF8"})
		backend.Send(&pgproto3.ParameterStatus{Name: "standard_conforming_strings", Value: "on"})
		backend.Send(&pgproto3.BackendKeyData{ProcessID: 1, SecretKey: 2})
		backend.Send(&pgproto3.ReadyForQuery{TxStatus: 'I'})
		if backend.Flush() != nil {
			return
		}
		query := ""
		status := byte('I')
		format := int16(0)
		record := func(q string) { mu.Lock(); queries = append(queries, strings.ToLower(q)); mu.Unlock() }
		description := func() {
			backend.Send(&pgproto3.RowDescription{Fields: []pgproto3.FieldDescription{{Name: []byte("healthy"), DataTypeOID: 23, DataTypeSize: 4, TypeModifier: -1, Format: format}}})
		}
		complete := func(q string) {
			switch {
			case strings.HasPrefix(strings.ToLower(q), "begin"):
				status = 'T'
				backend.Send(&pgproto3.CommandComplete{CommandTag: []byte("BEGIN")})
			case strings.HasPrefix(strings.ToLower(q), "set"):
				backend.Send(&pgproto3.CommandComplete{CommandTag: []byte("SET")})
			case strings.HasPrefix(strings.ToLower(q), "rollback"):
				status = 'I'
				backend.Send(&pgproto3.CommandComplete{CommandTag: []byte("ROLLBACK")})
			case strings.HasPrefix(strings.ToLower(q), "select"):
				value := []byte("1")
				if format == 1 {
					value = make([]byte, 4)
					binary.BigEndian.PutUint32(value, 1)
				}
				backend.Send(&pgproto3.DataRow{Values: [][]byte{value}})
				backend.Send(&pgproto3.CommandComplete{CommandTag: []byte("SELECT 1")})
			default:
				backend.Send(&pgproto3.ErrorResponse{Severity: "ERROR", Code: "42501", Message: "unregistered fixture query"})
			}
		}
		for {
			message, err := backend.Receive()
			if err != nil {
				return
			}
			switch m := message.(type) {
			case *pgproto3.Query:
				record(m.String)
				if strings.HasPrefix(strings.ToLower(m.String), "select") {
					format = 0
					description()
				}
				complete(m.String)
				backend.Send(&pgproto3.ReadyForQuery{TxStatus: status})
			case *pgproto3.Parse:
				query = m.Query
				record(query)
				backend.Send(&pgproto3.ParseComplete{})
			case *pgproto3.Describe:
				if m.ObjectType == 'S' {
					backend.Send(&pgproto3.ParameterDescription{})
				}
				if strings.HasPrefix(strings.ToLower(query), "select") {
					description()
				} else {
					backend.Send(&pgproto3.NoData{})
				}
			case *pgproto3.Bind:
				format = 0
				if len(m.ResultFormatCodes) > 0 {
					format = m.ResultFormatCodes[0]
				}
				backend.Send(&pgproto3.BindComplete{})
			case *pgproto3.Execute:
				complete(query)
			case *pgproto3.Sync:
				backend.Send(&pgproto3.ReadyForQuery{TxStatus: status})
			case *pgproto3.Close:
				backend.Send(&pgproto3.CloseComplete{})
			case *pgproto3.Terminate:
				return
			}
			if backend.Flush() != nil {
				return
			}
		}
	}()
	as := Asset{ID: "resource", Kind: "database", Settings: map[string]any{"driver": "postgres", "host": "127.0.0.1", "port": listener.Addr().(*net.TCPAddr).Port, "database": "fixture", "username": "fixture", "sslmode": "disable"}}
	limits := security.ScopeLimits{DatabaseID: "fixture", Schemas: []string{"pg_catalog"}, MaxRows: 64, MaxDurationMS: 5000}
	e, c := fixedReadManagedFixture(t, as, security.Rule{Capability: "db.read", Effect: security.EffectAllow, Limits: limits})
	result, err := runFixedReadPermit(t, e, c, Call{ID: "pg-health", Name: "observe_data", Arguments: js(map[string]any{"asset_ref": assetAlias(as.ID), "metric": "health"})})
	if err != nil || !strings.Contains(js(result), `"healthy":1`) {
		t.Fatal(result, err)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("diagnostic did not close database connection")
	}
	mu.Lock()
	defer mu.Unlock()
	if !emptyPassword {
		t.Fatal("fixed probe inherited unrelated environment password")
	}
	joined := strings.Join(queries, "\n")
	for _, required := range []string{"begin read only", "set local statement_timeout = 5000", "set local lock_timeout = 1000", "select 1 as healthy", "rollback"} {
		if !strings.Contains(joined, required) {
			t.Fatalf("missing %s in actual wire queries %s", required, joined)
		}
	}
	if strings.Contains(joined, "commit") {
		t.Fatal("read probe committed transaction")
	}
}
