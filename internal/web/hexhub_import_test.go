package web

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func mockHexHubMCP(t *testing.T, assets string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request Object
		if json.NewDecoder(r.Body).Decode(&request) != nil {
			http.Error(w, "bad request", 400)
			return
		}
		w.Header().Set("Mcp-Session-Id", "synthetic-session")
		switch stringOf(request["method"]) {
		case "initialize":
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, jsonText(Object{"jsonrpc": "2.0", "id": request["id"], "result": Object{"protocolVersion": "2025-03-26", "capabilities": Object{"tools": Object{}}, "serverInfo": Object{"name": "synthetic-hexhub-mcp"}}}))
		case "notifications/initialized":
			w.WriteHeader(202)
		case "tools/call":
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprintf(w, "event: message\ndata: %s\n\n", jsonText(Object{"jsonrpc": "2.0", "id": request["id"], "result": Object{"content": []Object{{"type": "text", "text": assets}}}}))
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func TestHexHubMCPImportPreviewCommitAndSkip(t *testing.T) {
	b, h := fixture(t)
	b.HexHubLocalAssets = func(context.Context) ([]Object, error) { return nil, errors.New("synthetic unavailable storage") }
	id, _ := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	assets := `[
		{"name":"web-01","host":"10.9.8.7:22","path":"/生产/应用/","type":"ssh","asset_ref":"RAAAAAAAAA"},
		{"name":"pg-main","host":"10.9.8.8:5432","path":"/生产/","type":"db","db_type":"PostgreSQL","asset_ref":"RBBBBBBBBB"},
		{"name":"cache","host":"10.9.8.9:6379","path":"/","type":"redis","asset_ref":"RCCCCCCCCC"},
		{"name":"jumped","host":"10.9.8.10:22","path":"/","type":"ssh","jump_asset_ref":"RDDDDDDDDD"},
		{"name":"tunnel-db","host":"10.9.8.11:3306","path":"/","type":"db","db_type":"MySQL","ssh_asset_ref":"REEEEEEEEE"}
	]`
	b.HexHubMCP = mockHexHubMCP(t, assets).URL
	// 同端点已存在带用户名的连接：缺用户名的 MCP 条目应按端点跳过。
	b.Store.CreateResource(project, "web-01 existing", "ssh", Object{"host": "10.9.8.7", "port": 22, "username": "deploy"})

	preview := apiTest(t, h, "POST", "/api/projects/"+project+"/resource-import-preview", Object{"hexhub": true}, 200)
	if stringOf(preview["name"]) != "HexHub 资产" {
		t.Fatal("preview name")
	}
	rows := objects(preview["resources"])
	if len(rows) != 5 {
		t.Fatalf("preview rows %d", len(rows))
	}
	if stringOf(rows[0]["kind"]) != "ssh" || stringOf(rows[0]["folder"]) != "生产/应用" || stringOf(rows[0]["host"]) != "10.9.8.7" || integer(rows[0]["port"]) != 22 {
		t.Fatal("ssh row mapping")
	}
	if stringOf(rows[1]["kind"]) != "database" || stringOf(rows[1]["driver"]) != "postgres" || stringOf(rows[1]["folder"]) != "生产" {
		t.Fatal("database row mapping")
	}
	if stringOf(rows[2]["kind"]) != "redis" || integer(rows[2]["port"]) != 6379 {
		t.Fatal("redis row mapping")
	}
	if stringOf(rows[3]["error"]) == "" || stringOf(rows[4]["error"]) == "" {
		t.Fatal("jump and tunnel rows must surface import errors")
	}
	if rows[0]["hasCredential"] != false {
		t.Fatal("hexhub preview must not claim credentials")
	}
	if strings.Contains(jsonText(preview), "asset_ref") || strings.Contains(jsonText(preview), "RAAAAAAAAA") {
		t.Fatal("preview leaked asset_ref")
	}
	if len(objects(b.Store.Catalog()["resources"])) != 2 {
		t.Fatal("preview created resources")
	}

	commit := apiTest(t, h, "POST", "/api/projects/"+project+"/resource-import", Object{"planId": preview["planId"]}, 201)
	if integer(commit["createdCount"]) != 2 || integer(commit["skippedCount"]) != 1 {
		t.Fatalf("commit counts %v", commit)
	}
	for _, resource := range objects(b.Store.Catalog()["resources"]) {
		if stringOf(resource["name"]) == "web-01" {
			t.Fatal("endpoint dedupe failed")
		}
	}
	folder := false
	for _, node := range objects(b.Store.Catalog()["resourceTree"]) {
		folder = folder || (stringOf(node["kind"]) == "folder" && stringOf(node["name"]) == "生产")
	}
	if !folder {
		t.Fatal("folder not materialized")
	}

	replay := apiTest(t, h, "POST", "/api/projects/"+project+"/resource-import", Object{"planId": preview["planId"]}, 201)
	if integer(replay["createdCount"]) != 0 || integer(replay["skippedCount"]) != 3 {
		t.Fatal("replay duplicated resources")
	}

	other := apiTest(t, h, "POST", "/api/projects", Object{"name": "Other"}, 201)
	apiTest(t, h, "POST", "/api/projects/"+stringOf(other["id"])+"/resource-import", Object{"planId": preview["planId"]}, 403)
}

func TestHexHubMCPImportUnavailable(t *testing.T) {
	b, h := fixture(t)
	b.HexHubLocalAssets = func(context.Context) ([]Object, error) { return nil, errors.New("synthetic unavailable storage") }
	id, _ := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	b.HexHubMCP = "http://127.0.0.1:1/mcp"
	expectPanic(t, 400, func() { b.previewResourceImport(context.Background(), project, id, Object{"hexhub": true}) })
	apiTest(t, h, "POST", "/api/projects/"+project+"/resource-import-preview", Object{"hexhub": true}, 400)
}
