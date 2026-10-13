package web

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/golang/snappy"
	"github.com/syndtr/goleveldb/leveldb/journal"
	"github.com/syndtr/goleveldb/leveldb/table"
)

func hexHubSyntheticCipher(value string) string {
	data := []byte(value)
	n := aes.BlockSize - len(data)%aes.BlockSize
	data = append(data, bytes.Repeat([]byte{byte(n)}, n)...)
	block, _ := aes.NewCipher([]byte("CsN#&Uc!aOUQbh&B"))
	cipher.NewCBCEncrypter(block, []byte("w6KQ^MPlEx*mfHcb")).CryptBlocks(data, data)
	return base64.StdEncoding.EncodeToString(data)
}
func hexHubSyntheticSSH(name, host, user, password string) Object {
	return Object{"id": name, "type": 2, "name": name, "dirPath": "/生产/", "data": jsonText(Object{"host": host, "port": 22, "user": user, "authType": 0, "password": hexHubSyntheticCipher(password)})}
}
func TestHexHubLocalLoginsMatchOnlyUniqueCurrentAssets(t *testing.T) {
	b, _ := fixture(t)
	local := []Object{hexHubSyntheticSSH("app", "10.1.1.1", "deploy", "synthetic-password"), hexHubSyntheticSSH("other-folder", "10.1.1.2", "deploy", "must-not-match"), hexHubSyntheticSSH("ambiguous", "10.1.1.3", "deploy", "first"), hexHubSyntheticSSH("ambiguous", "10.1.1.3", "root", "second")}
	b.HexHubLocalAssets = func(context.Context) ([]Object, error) { return local, nil }
	records, notice := b.hexHubRecordsWithLogins(context.Background(), []hexHubAsset{{Name: "app", Host: "10.1.1.1:22", Path: "生产", Type: "ssh"}, {Name: "other-folder", Host: "10.1.1.2:22", Path: "other", Type: "ssh"}, {Name: "ambiguous", Host: "10.1.1.3:22", Path: "生产", Type: "ssh"}, {Name: "app", Host: "10.1.1.1:22", Path: "生产", Type: "ssh", JumpAssetRef: "synthetic-jump"}})
	if notice == "" || records[0]["password"] != "synthetic-password" || records[0]["username"] != "deploy" {
		t.Fatal("matching login was not synchronized")
	}
	if records[1]["password"] != nil || records[2]["password"] != nil || records[3]["password"] != nil || records[3]["importError"] == nil {
		t.Fatal("copied login without an unambiguous direct target")
	}
	b.HexHubLocalAssets = func(context.Context) ([]Object, error) {
		return nil, errors.New("private source content must not be returned")
	}
	_, notice = b.hexHubRecordsWithLogins(context.Background(), nil)
	if strings.Contains(notice, "private source") {
		t.Fatal("storage errors exposed private data")
	}
}
func TestHexHubLocalReferencesPassphrasesAndServices(t *testing.T) {
	key := Object{"id": "key", "type": 1, "data": Object{"privateKey": hexHubSyntheticCipher("synthetic-key"), "password": hexHubSyntheticCipher("synthetic-phrase")}}
	pair := Object{"id": "pair", "type": 19, "data": Object{"username": "deploy", "password": "synthetic-pair-password"}}
	refs := map[string]Object{"key": key, "pair": pair}
	item := hexHubSyntheticSSH("key-app", "10.1.1.1", "root", "")
	item["data"] = Object{"host": "10.1.1.1", "user": "root", "authType": 1, "privateKeyId": "key", "privateKey": "broken old inline value"}
	record := hexHubLocalRecord(item, refs)
	if record["privateKey"] != "synthetic-key" || record["passphrase"] != "synthetic-phrase" || record["importError"] != nil {
		t.Fatal("saved private-key priority or passphrase failed")
	}
	item["data"] = Object{"host": "10.1.1.1", "user": "root", "authType": 1, "privateKey": hexHubSyntheticCipher(jsonText(Object{"privateKey": "inline-key", "password": "inline-phrase"}))}
	record = hexHubLocalRecord(item, refs)
	if record["privateKey"] != "inline-key" || record["passphrase"] != "inline-phrase" {
		t.Fatal("inline key wrapper was not decoded")
	}
	item["data"] = Object{"host": "10.1.1.1", "authType": 5, "passwordPairId": "pair"}
	record = hexHubLocalRecord(item, refs)
	if record["username"] != "deploy" || record["password"] != "synthetic-pair-password" {
		t.Fatal("password pair not resolved")
	}
	refs["pair"] = key
	record = hexHubLocalRecord(item, refs)
	if record["importError"] == nil {
		t.Fatal("accepted a wrong-type password reference")
	}
	item["data"] = Object{"host": "10.1.1.1", "authType": 0, "password": "broken-secret-do-not-echo"}
	record = hexHubLocalRecord(item, refs)
	if record["importError"] == nil || strings.Contains(stringOf(record["importError"]), "broken-secret") {
		t.Fatal("bad secret was not safely rejected")
	}
	db := hexHubLocalRecord(Object{"type": 4, "data": Object{"host": "10.1.1.5", "user": "reader", "dbType": 1, "password": "db-password", "defaultDb": "app", "sslConfig": Object{"mode": 0}}}, nil)
	if db["password"] != "db-password" || db["database"] != "app" || db["driver"] != "postgres" {
		t.Fatal("database fields not preserved")
	}
}
func TestHexHubLoginImportUpdatesMissingConnectionWithoutDuplicates(t *testing.T) {
	b, h := fixture(t)
	sid, _ := newSession(t, h)
	project := stringOf(b.Store.Session(sid)["projectId"])
	b.HexHubMCP = mockHexHubMCP(t, `[{"name":"app","host":"10.1.1.1:22","path":"/生产/","type":"ssh"}]`).URL
	b.HexHubLocalAssets = func(context.Context) ([]Object, error) {
		return []Object{hexHubSyntheticSSH("app", "10.1.1.1", "deploy", "synthetic-import-sync")}, nil
	}
	old := b.Store.CreateResource(project, "kept display name", "ssh", Object{"host": "10.1.1.1", "port": 22})
	id := stringOf(old["id"])
	before := jsonText(b.Store.Catalog()["resourceTree"])
	preview := apiTest(t, h, "POST", "/api/projects/"+project+"/resource-import-preview", Object{"hexhub": true}, 200)
	rows := objects(preview["resources"])
	if len(rows) != 1 || rows[0]["hasCredential"] != true || rows[0]["username"] != "deploy" {
		t.Fatal("preview does not report saved login")
	}
	plan := b.loadImportPlan(project, "", stringOf(preview["planId"]))
	if strings.Contains(jsonText(preview), "synthetic-import-sync") || strings.Contains(jsonText(plan), "synthetic-import-sync") {
		t.Fatal("preview or plan leaked login material")
	}
	secretPath := filepath.Join(b.Models.Home, "secrets", stringOf(plan.Candidates[0].Config["credentialRef"]))
	data, err := os.ReadFile(secretPath)
	info, _ := os.Stat(secretPath)
	if err != nil || string(data) != "synthetic-import-sync" || info.Mode().Perm() != 0600 {
		t.Fatal("private credential storage failed")
	}
	term := b.Store.CreateTerminal(sid, id)
	apiTest(t, h, "POST", "/api/projects/"+project+"/resource-import", Object{"planId": preview["planId"]}, 409)
	if importSSHHasLogin(object(b.Store.Resource(id)["ssh"])) {
		t.Fatal("online terminal target changed")
	}
	b.Store.TerminalStatus(sid, stringOf(term["id"]), "disconnected")
	b.Store.Status(sid, "investigating")
	apiTest(t, h, "POST", "/api/projects/"+project+"/resource-import", Object{"planId": preview["planId"]}, 409)
	b.Store.Status(sid, "completed")
	result := apiTest(t, h, "POST", "/api/projects/"+project+"/resource-import", Object{"planId": preview["planId"]}, 201)
	if integer(result["updatedCount"]) != 1 || integer(result["createdCount"]) != 0 {
		t.Fatal("login sync created a duplicate")
	}
	updated := b.Store.Resource(id)
	if updated["name"] != "kept display name" || object(updated["ssh"])["username"] != "deploy" || before != jsonText(b.Store.Catalog()["resourceTree"]) {
		t.Fatal("sync discarded resource identity or folder")
	}
	if b.Store.Terminal(sid, stringOf(term["id"]))["status"] != "disconnected" {
		t.Fatal("terminal history was lost")
	}
	replay := apiTest(t, h, "POST", "/api/projects/"+project+"/resource-import", Object{"planId": preview["planId"]}, 201)
	if integer(replay["updatedCount"]) != 0 || integer(replay["createdCount"]) != 0 || integer(replay["skippedCount"]) != 1 {
		t.Fatal("repeat import changed a complete login")
	}
	// A later import must preserve human-configured credentials.
	b.HexHubLocalAssets = func(context.Context) ([]Object, error) {
		return []Object{hexHubSyntheticSSH("app", "10.1.1.1", "deploy", "later-secret")}, nil
	}
	newer := apiTest(t, h, "POST", "/api/projects/"+project+"/resource-import-preview", Object{"hexhub": true}, 200)
	apiTest(t, h, "POST", "/api/projects/"+project+"/resource-import", Object{"planId": newer["planId"]}, 201)
	if object(b.Store.Resource(id)["ssh"])["credentialRef"] != object(updated["ssh"])["credentialRef"] {
		t.Fatal("complete login overwritten")
	}
}
func hexHubTestVarint(n uint64) []byte { return binary.AppendUvarint(nil, n) }
func hexHubTestField(b []byte) []byte  { return append(hexHubTestVarint(uint64(len(b))), b...) }
func hexHubTestUTF16(s string, order binary.ByteOrder) []byte {
	out := []byte{}
	for _, v := range utf16.Encode([]rune(s)) {
		buf := make([]byte, 2)
		order.PutUint16(buf, v)
		out = append(out, buf...)
	}
	return out
}
func hexHubTestV8(obj Object) []byte {
	out := []byte{1, 255, 21, 254}
	out = append(out, make([]byte, 12)...)
	out = append(out, 255, 15, 'o')
	keys := []string{}
	for k := range obj {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		out = append(out, 'S')
		out = append(out, hexHubTestField([]byte(k))...)
		switch v := obj[k].(type) {
		case string:
			out = append(out, 'S')
			out = append(out, hexHubTestField([]byte(v))...)
		case int:
			out = append(out, 'U')
			out = append(out, hexHubTestVarint(uint64(v))...)
		case bool:
			if v {
				out = append(out, 'T')
			} else {
				out = append(out, 'F')
			}
		case nil:
			out = append(out, '_')
		default:
			panic("unsupported synthetic V8 value")
		}
	}
	out = append(out, '{')
	return append(out, hexHubTestVarint(uint64(len(obj)))...)
}
func hexHubTestLog(t *testing.T, path string, records ...[]byte) {
	t.Helper()
	f, e := os.Create(path)
	if e != nil {
		t.Fatal(e)
	}
	w := journal.NewWriter(f)
	for _, data := range records {
		r, e := w.Next()
		if e != nil {
			t.Fatal(e)
		}
		if _, e = r.Write(data); e != nil {
			t.Fatal(e)
		}
	}
	if e = w.Close(); e != nil {
		t.Fatal(e)
	}
	if e = f.Close(); e != nil {
		t.Fatal(e)
	}
}
func hexHubTestTable(t *testing.T, path string, records map[string][]byte) {
	t.Helper()
	f, e := os.Create(path)
	if e != nil {
		t.Fatal(e)
	}
	w := table.NewWriter(f, nil)
	keys := []string{}
	for k := range records {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if e = w.Append([]byte(k), records[k]); e != nil {
			t.Fatal("synthetic table write failed")
		}
	}
	if e = w.Close(); e != nil {
		t.Fatal(e)
	}
	f.Close()
}
func hexHubTestInternal(key []byte, seq uint64) string {
	return string(binary.LittleEndian.AppendUint64(bytes.Clone(key), seq<<8|1))
}
func TestHexHubStorageUsesActiveManifestLatestSequenceAndTombstones(t *testing.T) {
	root := t.TempDir()
	metadata := []byte{0, 1, 0, 0, 50, 1, 0}
	a := []byte{0, 1, 1, 1, 1, 'a'}
	b := []byte{0, 1, 1, 1, 1, 'b'}
	old := hexHubSyntheticSSH("old", "10.1.1.1", "root", "old-password")
	newer := hexHubSyntheticSSH("new", "10.1.1.1", "deploy", "new-password")
	hexHubTestTable(t, filepath.Join(root, "000010.ldb"), map[string][]byte{hexHubTestInternal(metadata, 1): hexHubTestUTF16("assets", binary.BigEndian), hexHubTestInternal(a, 2): hexHubTestV8(old), hexHubTestInternal(b, 3): hexHubTestV8(old)})
	// This stale, physically present table is not in the active manifest.
	hexHubTestTable(t, filepath.Join(root, "000009.ldb"), map[string][]byte{hexHubTestInternal(a, 999): hexHubTestV8(old)})
	manifest := append([]byte{1}, hexHubTestField([]byte("idb_cmp1"))...)
	manifest = append(manifest, 2, 12, 7, 0, 10, 1)
	manifest = append(manifest, hexHubTestField([]byte("min"))...)
	manifest = append(manifest, hexHubTestField([]byte("max"))...)
	hexHubTestLog(t, filepath.Join(root, "MANIFEST-000001"), manifest)
	os.WriteFile(filepath.Join(root, "CURRENT"), []byte("MANIFEST-000001\n"), 0600)
	batch := binary.LittleEndian.AppendUint64(nil, 4)
	batch = binary.LittleEndian.AppendUint32(batch, 2)
	batch = append(batch, 1)
	batch = append(batch, hexHubTestField(a)...)
	batch = append(batch, hexHubTestField(hexHubTestV8(newer))...)
	batch = append(batch, 0)
	batch = append(batch, hexHubTestField(b)...)
	hexHubTestLog(t, filepath.Join(root, "000012.log"), batch)
	rows, e := hexHubAssetsFromStorage(context.Background(), root)
	if e != nil || len(rows) != 1 || rows[0]["name"] != "new" {
		t.Fatal("did not use the latest committed, nondeleted asset")
	}
	before, _ := os.ReadDir(root)
	rows, e = hexHubAssetsFromStorage(context.Background(), root)
	after, _ := os.ReadDir(root)
	if e != nil || len(rows) != 1 || len(before) != len(after) {
		t.Fatal("reader modified native storage")
	}
	// Corrupt WAL checksums must not silently expose stale credentials.
	logPath := filepath.Join(root, "000012.log")
	raw, _ := os.ReadFile(logPath)
	raw[0] ^= 1
	os.WriteFile(logPath, raw, 0600)
	if _, e = hexHubAssetsFromStorage(context.Background(), root); e == nil {
		t.Fatal("corrupt WAL returned stale data")
	}
}
func TestHexHubStorageCompressionAndUnsupportedEnvelope(t *testing.T) {
	value := hexHubTestV8(Object{"type": 2, "data": "synthetic", "name": "中文名称"})
	compressed := append([]byte{1, 255, 17, 2}, snappy.Encode(nil, value[1:])...)
	obj, e := hexHubDecodeAsset(compressed)
	if e != nil || obj["name"] != "中文名称" {
		t.Fatal("compressed V8 decoding failed")
	}
	for _, raw := range [][]byte{{1, 255, 17, 1, 1, 0}, {1, 255, 16, 255, 99, 'o'}, {1, 255, 15, 'o', 'S', 255}} {
		if _, e := hexHubDecodeAsset(raw); e == nil {
			t.Fatal("unsupported or malformed V8 accepted")
		}
	}
}

func TestHexHubLoginSyncPreservesDifferentAccountsAtSameEndpoint(t *testing.T) {
	b, h := fixture(t)
	sid, _ := newSession(t, h)
	project := stringOf(b.Store.Session(sid)["projectId"])
	b.HexHubMCP = mockHexHubMCP(t, `[{"name":"app","host":"10.1.1.1:22","path":"/生产/","type":"ssh"},{"name":"admin","host":"10.1.1.1:22","path":"/生产/","type":"ssh"}]`).URL
	b.HexHubLocalAssets = func(context.Context) ([]Object, error) {
		return []Object{hexHubSyntheticSSH("app", "10.1.1.1", "deploy", "synthetic-app"), hexHubSyntheticSSH("admin", "10.1.1.1", "root", "synthetic-admin")}, nil
	}
	old := b.Store.CreateResource(project, "app existing", "ssh", Object{"host": "10.1.1.1", "port": 22, "username": "deploy", "shell": "sh"})
	preview := apiTest(t, h, "POST", "/api/projects/"+project+"/resource-import-preview", Object{"hexhub": true}, 200)
	result := apiTest(t, h, "POST", "/api/projects/"+project+"/resource-import", Object{"planId": preview["planId"]}, 201)
	if integer(result["updatedCount"]) != 1 || integer(result["createdCount"]) != 1 || object(b.Store.Resource(stringOf(old["id"]))["ssh"])["shell"] != "sh" {
		t.Fatal("supplementing login removed another account or changed the shell")
	}
}
func TestHexHubServiceLoginsSupplementImportedMetadata(t *testing.T) {
	b, h := fixture(t)
	sid, _ := newSession(t, h)
	project := stringOf(b.Store.Session(sid)["projectId"])
	b.HexHubMCP = mockHexHubMCP(t, `[{"name":"db","host":"10.1.1.5:3306","path":"/生产/","type":"db","db_type":"MySQL"},{"name":"cache","host":"10.1.1.6:6379","path":"/生产/","type":"redis"}]`).URL
	b.HexHubLocalAssets = func(context.Context) ([]Object, error) {
		return []Object{{"id": "db", "type": 4, "name": "db", "dirPath": "/生产/", "data": Object{"host": "10.1.1.5", "port": 3306, "user": "reader", "dbType": 0, "password": "synthetic-db", "defaultDb": "app"}}, {"id": "cache", "type": 15, "name": "cache", "dirPath": "/生产/", "data": Object{"host": "10.1.1.6", "port": 6379, "password": "synthetic-redis"}}}, nil
	}
	db := b.Store.CreateResource(project, "kept db", "database", Object{"driver": "mysql", "host": "10.1.1.5", "port": 3306, "tls": false, "sslmode": "disable"})
	redis := b.Store.CreateResource(project, "kept cache", "redis", Object{"host": "10.1.1.6", "port": 6379, "tls": false})
	preview := apiTest(t, h, "POST", "/api/projects/"+project+"/resource-import-preview", Object{"hexhub": true}, 200)
	for _, row := range objects(preview["resources"]) {
		if stringOf(row["error"]) != "" {
			t.Fatalf("synthetic service preview error: %s", stringOf(row["error"]))
		}
	}
	result := apiTest(t, h, "POST", "/api/projects/"+project+"/resource-import", Object{"planId": preview["planId"]}, 201)
	if integer(result["updatedCount"]) != 2 || integer(result["createdCount"]) != 0 {
		t.Fatal("service login sync created duplicates or skipped saved passwords")
	}
	config := object(b.Store.Resource(stringOf(db["id"]))["settings"])
	if config["username"] != "reader" || config["database"] != "app" || config["credentialRef"] == nil || object(b.Store.Resource(stringOf(redis["id"]))["settings"])["credentialRef"] == nil {
		t.Fatal("service authentication or default database lost")
	}
}
func TestHexHubLoginSyncRejectsAmbiguousExistingResources(t *testing.T) {
	b, h := fixture(t)
	sid, _ := newSession(t, h)
	project := stringOf(b.Store.Session(sid)["projectId"])
	b.HexHubMCP = mockHexHubMCP(t, `[{"name":"app","host":"10.1.1.1:22","path":"/生产/","type":"ssh"}]`).URL
	b.HexHubLocalAssets = func(context.Context) ([]Object, error) {
		return []Object{hexHubSyntheticSSH("app", "10.1.1.1", "root", "synthetic-app")}, nil
	}
	for _, name := range []string{"old-a", "old-b"} {
		b.Store.CreateResource(project, name, "ssh", Object{"host": "10.1.1.1", "port": 22})
	}
	before := jsonText(b.Store.Catalog())
	preview := apiTest(t, h, "POST", "/api/projects/"+project+"/resource-import-preview", Object{"hexhub": true}, 200)
	apiTest(t, h, "POST", "/api/projects/"+project+"/resource-import", Object{"planId": preview["planId"]}, 409)
	if jsonText(b.Store.Catalog()) != before {
		t.Fatal("ambiguous login sync modified existing resources")
	}
}

func TestHexHubPasswordlessDatabaseSyncKeepsSavedUsername(t *testing.T) {
	b, h := fixture(t)
	sid, _ := newSession(t, h)
	project := stringOf(b.Store.Session(sid)["projectId"])
	b.HexHubMCP = mockHexHubMCP(t, `[{"name":"db","host":"10.1.1.5:3306","path":"/生产/","type":"db","db_type":"MySQL"}]`).URL
	b.HexHubLocalAssets = func(context.Context) ([]Object, error) {
		return []Object{{"type": 4, "name": "db", "dirPath": "/生产/", "data": Object{"host": "10.1.1.5", "port": 3306, "user": "reader", "dbType": 0}}}, nil
	}
	old := b.Store.CreateResource(project, "kept db", "database", Object{"driver": "mysql", "host": "10.1.1.5", "port": 3306, "tls": false, "sslmode": "disable"})
	preview := apiTest(t, h, "POST", "/api/projects/"+project+"/resource-import-preview", Object{"hexhub": true}, 200)
	result := apiTest(t, h, "POST", "/api/projects/"+project+"/resource-import", Object{"planId": preview["planId"]}, 201)
	if integer(result["updatedCount"]) != 1 || integer(result["createdCount"]) != 0 || object(b.Store.Resource(stringOf(old["id"]))["settings"])["username"] != "reader" {
		t.Fatal("passwordless saved username created a duplicate")
	}
	replay := apiTest(t, h, "POST", "/api/projects/"+project+"/resource-import", Object{"planId": preview["planId"]}, 201)
	if integer(replay["updatedCount"]) != 0 || integer(replay["skippedCount"]) != 1 {
		t.Fatal("repeat import changed a passwordless database")
	}
}
