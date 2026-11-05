package ai

import (
	"encoding/binary"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
)

// Real go-sql-driver/mysql traffic, with a minimal loopback protocol server.
// It intentionally does not implement writes or a general SQL engine.
func fixedMySQLMetadataServer(t *testing.T, ddl bool) (Asset, func() []string) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	var mu sync.Mutex
	queries := []string{}
	done := make(chan struct{})
	go func() {
		defer close(done)
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		conn.SetDeadline(time.Now().Add(10 * time.Second))
		write := func(sequence byte, payload []byte) bool {
			header := []byte{byte(len(payload)), byte(len(payload) >> 8), byte(len(payload) >> 16), sequence}
			_, err := conn.Write(append(header, payload...))
			return err == nil
		}
		read := func() ([]byte, error) {
			header := make([]byte, 4)
			if _, err := io.ReadFull(conn, header); err != nil {
				return nil, err
			}
			size := int(header[0]) | int(header[1])<<8 | int(header[2])<<16
			if size > 8192 {
				return nil, io.ErrShortBuffer
			}
			payload := make([]byte, size)
			_, err := io.ReadFull(conn, payload)
			return payload, err
		}
		lengthString := func(value string) []byte { return append([]byte{byte(len(value))}, value...) }
		ok := []byte{0, 0, 0, 2, 0, 0, 0}
		capabilities := uint32(1 | 4 | 8 | 512 | 8192 | 32768 | 1<<17 | 1<<19)
		hello := append([]byte{10}, []byte("8.4.0-fixture\x00")...)
		hello = append(hello, 1, 0, 0, 0)
		hello = append(hello, []byte("12345678\x00")...)
		hello = binary.LittleEndian.AppendUint16(hello, uint16(capabilities))
		hello = append(hello, 45, 2, 0)
		hello = binary.LittleEndian.AppendUint16(hello, uint16(capabilities>>16))
		hello = append(hello, 21)
		hello = append(hello, make([]byte, 10)...)
		hello = append(hello, []byte("abcdefghijkl\x00mysql_native_password\x00")...)
		if !write(0, hello) {
			return
		}
		if _, err := read(); err != nil || !write(2, ok) {
			return
		}
		for {
			command, err := read()
			if err != nil || len(command) == 0 || command[0] == 1 {
				return
			}
			if command[0] != 3 {
				return // Unregistered command; never pretend it executed.
			}
			query := string(command[1:])
			mu.Lock()
			queries = append(queries, strings.ToLower(query))
			mu.Unlock()
			if strings.HasPrefix(query, "SELECT ") || strings.HasPrefix(query, "SHOW CREATE TABLE ") {
				columns, values := []string{"name", "type"}, []string{"fixture", "schema"}
				if ddl {
					columns, values = []string{"Table", "Create Table"}, []string{"sample", "CREATE TABLE `sample` (`id` int)"}
				}
				write(1, []byte{2})
				for i, name := range columns {
					column := []byte{}
					for _, part := range []string{"def", "", "", "", name, name} {
						column = append(column, lengthString(part)...)
					}
					column = append(column, 12, 45, 0, 255, 0, 0, 0, 253, 0, 0, 0, 0, 0)
					write(byte(i+2), column)
				}
				write(4, []byte{254, 0, 0, 2, 0})
				row := append(lengthString(values[0]), lengthString(values[1])...)
				write(5, row)
				write(6, []byte{254, 0, 0, 2, 0})
			} else if query == "START TRANSACTION READ ONLY" || query == "SET SESSION MAX_EXECUTION_TIME=5000" || query == "ROLLBACK" {
				write(1, ok)
			} else {
				return
			}
		}
	}()
	as := Asset{ID: "resource", Kind: "database", Settings: map[string]any{"driver": "mysql", "host": "127.0.0.1", "port": listener.Addr().(*net.TCPAddr).Port, "database": "fixture", "username": "fixture", "tls": false}}
	return as, func() []string {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("metadata adapter did not close connection")
		}
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), queries...)
	}
}

func TestSecurityMySQLMetadataUsesReadOnlyOriginalPermit(t *testing.T) {
	for _, tool := range []string{"list_db_objects", "db_table_ddl"} {
		t.Run(tool, func(t *testing.T) {
			as, transcript := fixedMySQLMetadataServer(t, tool == "db_table_ddl")
			limits := security.ScopeLimits{DatabaseID: "fixture", Schemas: []string{"information_schema", "app"}, MaxRows: 1000, MaxDurationMS: 5000}
			e, c := fixedReadManagedFixture(t, as, security.Rule{Capability: "db.read", Effect: security.EffectAllow, Limits: limits})
			store, _ := e.adkStore()
			if err := store.DB.Create(&nativeOperation{ID: "old-ssh", SessionID: "old", Tool: "open_ssh_terminal", Risk: "dangerous", Status: "unknown"}).Error; err != nil {
				t.Fatal(err)
			}
			a := map[string]any{"asset_ref": assetAlias(as.ID), "query_type": "database"}
			if tool == "db_table_ddl" {
				a = map[string]any{"asset_ref": assetAlias(as.ID), "schema": "app", "table": "a`;DROP TABLE x;--"}
			}
			result, err := runFixedReadPermit(t, e, c, Call{ID: "mysql-metadata", Name: tool, Arguments: js(a)})
			if err != nil || len(arr(obj(result)["rows"])) != 1 || obj(result)["truncated"] != false {
				t.Fatal(result, err)
			}
			queries := strings.Join(transcript(), "\n")
			for _, required := range []string{"start transaction read only", "set session max_execution_time=5000", "rollback"} {
				if !strings.Contains(queries, required) {
					t.Fatal("missing MySQL wire constraint", required, queries)
				}
			}
			if strings.Contains(queries, "commit") || tool == "db_table_ddl" && !strings.Contains(queries, "show create table `app`.`a``;drop table x;--`") {
				t.Fatal("invalid MySQL metadata query", queries)
			}
			if err := CheckResourceWriteBlock(store.DB, as.ID); err != ErrUnresolvedResourceEffect {
				t.Fatal("metadata cleared old write risk", err)
			}
		})
	}
}
