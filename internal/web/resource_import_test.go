package web

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestTextResourceImportLiveAndIdempotent(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	source := `{"resources":[{"name":"app","kind":"ssh","host":"10.1.2.3","port":2222,"username":"deploy","password":"synthetic-import-password","folder":"Production/App"},{"name":"pg","kind":"database","host":"10.1.2.4","driver":"postgres","username":"reader","password":"synthetic-db-password","folder":"Production/DB"},{"name":"bad","kind":"ssh","host":"10.1.2.5","port":99999,"username":"root","password":"synthetic-invalid-password"}]}`
	preview := apiTest(t, h, "POST", "/api/projects/"+project+"/resource-import-preview", Object{"name": "hosts.any-extension", "text": source}, 200)
	rows := objects(preview["resources"])
	if len(rows) != 3 || stringOf(rows[0]["error"]) != "" || stringOf(rows[2]["error"]) == "" {
		t.Fatal("unexpected import validation")
	}
	if strings.Contains(jsonText(preview), "synthetic-import-password") || strings.Contains(jsonText(preview), "synthetic-db-password") {
		t.Fatal("preview leaked credentials")
	}
	if len(objects(b.Store.Catalog()["resources"])) != 1 {
		t.Fatal("preview created resources")
	}
	apiTest(t, h, "POST", "/api/projects/"+project+"/resource-import", Object{"planId": preview["planId"], "indexes": []int{2}}, 400)
	apiTest(t, h, "POST", "/api/projects/"+project+"/resource-import", Object{"planId": preview["planId"], "indexes": []string{"invalid"}}, 400)
	commit := apiTest(t, h, "POST", "/api/projects/"+project+"/resource-import", Object{"planId": preview["planId"], "indexes": []int{0, 1}}, 201)
	if integer(commit["createdCount"]) != 2 {
		t.Fatal("import count")
	}
	replay := apiTest(t, h, "POST", "/api/projects/"+project+"/resource-import", Object{"planId": preview["planId"], "indexes": []int{0, 1}}, 201)
	if integer(replay["createdCount"]) != 0 || integer(replay["skippedCount"]) != 2 {
		t.Fatal("replay duplicated resources")
	}
	snapshot := apiTest(t, h, "GET", "/api/sessions/"+id+"/snapshot", nil, 200)
	if len(objects(snapshot["resources"])) != 3 || len(objects(snapshot["resourceTree"])) != 6 {
		t.Fatal("live snapshot did not refresh resource tree")
	}
	for _, resource := range objects(snapshot["resources"]) {
		if resource["kind"] == "local" {
			continue
		}
		config := object(resource["settings"])
		if resource["kind"] == "ssh" {
			config = object(resource["ssh"])
		}
		p := filepath.Join(b.Models.Home, "secrets", stringOf(config["credentialRef"]))
		info, err := os.Stat(p)
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatal("credential permissions")
		}
	}
	other := apiTest(t, h, "POST", "/api/projects", Object{"name": "Other"}, 201)
	apiTest(t, h, "POST", "/api/projects/"+stringOf(other["id"])+"/resource-import", Object{"planId": preview["planId"]}, 403)
}

func TestTextImportCSVFilesAndScope(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	file := apiTest(t, h, "POST", "/api/sessions/"+id+"/text-files", Object{"name": "connections.log", "text": "名称,地址,端口,用户名,密码,分组\n应用,10.2.3.4,22,root,synthetic-csv-password,组/应用\n"}, 201)
	preview := b.previewResourceImport(context.Background(), project, id, Object{"source_id": file["sourceId"]})
	if len(objects(preview["resources"])) != 1 || stringOf(objects(preview["resources"])[0]["error"]) != "" {
		t.Fatal("CSV extraction")
	}
	second := b.Store.CreateSession(project, "Second", nil)
	expectPanic(t, 403, func() { b.loadImportSource(project, stringOf(second["id"]), stringOf(file["sourceId"])) })
	expectPanic(t, 403, func() { b.commitResourceImport(project, stringOf(second["id"]), stringOf(preview["planId"]), nil) })
	expectPanic(t, 400, func() { validateImportText("binary\x00data") })
	expectPanic(t, 400, func() { validateImportText(strings.Repeat("x", importTextLimit+1)) })
	path := filepath.Join(t.TempDir(), "hosts.custom")
	os.WriteFile(path, []byte(`[{"host":"10.2.3.5","username":"root","password":"synthetic-local-password"}]`), 0600)
	local := b.previewResourceImport(context.Background(), project, id, Object{"path": path})
	if len(objects(local["resources"])) != 1 {
		t.Fatal("local text path")
	}
}

func TestHexHubImportKeepsKeysLocal(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	path := filepath.Join(t.TempDir(), "synthetic_import_key")
	if exec.Command("/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", path).Run() != nil {
		t.Fatal("synthetic key generation failed")
	}
	key, err := os.ReadFile(path)
	if err != nil {
		t.Fatal("synthetic key unavailable")
	}
	encrypt := func(value string) string {
		data := []byte(value)
		padding := aes.BlockSize - len(data)%aes.BlockSize
		for i := 0; i < padding; i++ {
			data = append(data, byte(padding))
		}
		block, _ := aes.NewCipher([]byte("CsN#&Uc!aOUQbh&B"))
		cipher.NewCBCEncrypter(block, []byte("w6KQ^MPlEx*mfHcb")).CryptBlocks(data, data)
		return base64.StdEncoding.EncodeToString(data)
	}
	doc := Object{"version": 2, "list": []Object{
		{"type": 2, "name": "Key Host", "dirPath": "/Servers/", "data": jsonText(Object{"host": "192.0.2.20", "port": 22, "user": "root", "authType": 1, "privateKey": encrypt(jsonText(Object{"name": "Key", "privateKey": string(key)}))})},
		{"type": 21, "name": "Model provider", "data": jsonText(Object{"apiKey": "synthetic-model-key"})},
	}}
	preview := b.previewResourceImport(context.Background(), project, id, Object{"name": "HexHub-Assets.json", "text": jsonText(doc)})
	rows := objects(preview["resources"])
	if len(rows) != 1 || rows[0]["error"] != "" || strings.Contains(jsonText(preview), "PRIVATE KEY") || strings.Contains(jsonText(preview), "synthetic-model-key") {
		t.Fatal("HexHub preview validation or credential isolation")
	}
	result := b.commitResourceImport(project, id, stringOf(preview["planId"]), nil)
	if integer(result["createdCount"]) != 1 {
		t.Fatal("HexHub import failed")
	}
	for _, resource := range objects(b.Store.Catalog()["resources"]) {
		if resource["kind"] != "ssh" {
			continue
		}
		data, err := os.ReadFile(stringOf(object(resource["ssh"])["identityFile"]))
		if err != nil || string(data) != string(key) {
			t.Fatal("imported key content mismatch")
		}
	}
}

func TestHexHubV4ExportUsesDataKeyAndNestedConfig(t *testing.T) {
	// HexHub v4 exports keep the connection list under "data" and nest each
	// connection's config as an object (not a JSON string). Synthesise credentials.
	b, h := fixture(t)
	id, _ := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	path := filepath.Join(t.TempDir(), "synthetic_v4_key")
	if exec.Command("/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", path).Run() != nil {
		t.Fatal("synthetic key generation failed")
	}
	key, err := os.ReadFile(path)
	if err != nil {
		t.Fatal("synthetic key unavailable")
	}
	encrypt := func(value string) string {
		data := []byte(value)
		padding := aes.BlockSize - len(data)%aes.BlockSize
		for i := 0; i < padding; i++ {
			data = append(data, byte(padding))
		}
		block, _ := aes.NewCipher([]byte("CsN#&Uc!aOUQbh&B"))
		cipher.NewCBCEncrypter(block, []byte("w6KQ^MPlEx*mfHcb")).CryptBlocks(data, data)
		return base64.StdEncoding.EncodeToString(data)
	}
	doc := Object{"version": 4, "time": "Date(1791791576386)", "sign": "synthetic-sign", "data": []Object{
		{
			"id": "0e63c6e9-284c-4063-b58b-57a07a1187a3", "memberId": "synthetic-member",
			"type": 2, "dirPath": "/", "name": "京东云主机", "keyword": "京东云主机 36.151.150.63 root",
			"data": Object{
				"host": "36.151.150.63", "port": 22, "user": "root", "authType": 1,
				"privateKey":   encrypt(jsonText(Object{"name": "Key", "privateKey": string(key)})),
				"privateKeyId": "51b74989-1137-4f90-b3ba-b83cedfcabba",
				"agentType":    "auto", "charset": "UTF-8", "terminalType": "xterm-256color",
				"proxy": Object{"method": 0}, "tunnels": []Object{},
			},
			"updated": "Date(1787133481294)", "created": "Date(1787133481293)",
		},
	}}
	preview := b.previewResourceImport(context.Background(), project, id, Object{"name": "HexHub-连接配置.json", "text": jsonText(doc)})
	rows := objects(preview["resources"])
	if len(rows) != 1 {
		t.Fatalf("HexHub v4 preview: want 1 candidate, got %d", len(rows))
	}
	if rows[0]["error"] != "" {
		t.Fatalf("HexHub v4 candidate rejected: %v", rows[0]["error"])
	}
	if strings.Contains(jsonText(preview), "PRIVATE KEY") {
		t.Fatal("HexHub v4 preview leaked a private key")
	}
	result := b.commitResourceImport(project, id, stringOf(preview["planId"]), nil)
	if integer(result["createdCount"]) != 1 {
		t.Fatalf("HexHub v4 import failed: %v", result)
	}
	for _, resource := range objects(b.Store.Catalog()["resources"]) {
		if resource["kind"] != "ssh" {
			continue
		}
		data, err := os.ReadFile(stringOf(object(resource["ssh"])["identityFile"]))
		if err != nil || string(data) != string(key) {
			t.Fatal("imported v4 key content mismatch")
		}
	}
}

func TestLocalTextImportDecodingAndMasking(t *testing.T) {
	for _, data := range [][]byte{{0xff, 0xfe, 0x41, 0}, {0xfe, 0xff, 0, 0x41}, {0x41}} {
		if decodeImportFile(data) != "A" {
			t.Fatal("text decoding failed")
		}
	}
	if decodeImportFile([]byte{0xd6, 0xd0, 0xce, 0xc4}) != "中文" {
		t.Fatal("GB18030 decoding failed")
	}
	masked, secrets := maskImportText("password=synthetic-pass\n-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic-key-body\n-----END OPENSSH PRIVATE KEY-----\napiKey=synthetic-api-key\nssh://root:synthetic%40url@192.0.2.10")
	if strings.Contains(masked, "synthetic") || strings.Contains(masked, "PRIVATE KEY") || len(secrets) != 4 {
		t.Fatal("credential masking failed")
	}
}

func TestImportApprovalShowsOnlySelectedRows(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	preview := b.previewResourceImport(context.Background(), project, id, Object{"text": `[{"name":"First","host":"192.0.2.30","username":"root","password":"synthetic-first"},{"name":"Second","host":"192.0.2.31","username":"root","password":"synthetic-second"}]`})
	policy := b.importBridgePolicy(id, "import_resources", Object{"plan_id": preview["planId"], "indexes": []any{float64(1)}})
	rows := objects(object(policy["importPreview"])["resources"])
	if len(rows) != 1 || rows[0]["name"] != "Second" {
		t.Fatal("approval included unselected candidates")
	}
	if importConnectionKey("database", Object{"host": "192.0.2.20", "driver": "postgres"}) != importConnectionKey("database", Object{"host": "192.0.2.20", "driver": "postgres", "port": 5432}) {
		t.Fatal("default ports create duplicate connections")
	}
}

func TestTextImportModelSeesOnlyCredentialTokens(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request Object
		json.NewDecoder(r.Body).Decode(&request)
		payload := jsonText(request)
		for _, value := range []string{"synthetic-prose-password", "synthetic-api-key", "PRIVATE KEY"} {
			if strings.Contains(payload, value) {
				t.Error("model received sensitive input")
			}
		}
		emitModel(w, `{"resources":[{"name":"prose","kind":"ssh","host":"10.3.4.5","username":"root","password":"LAKE_IMPORT_SECRET_1"}]}`, nil)
	}))
	defer provider.Close()
	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": provider.URL + "/v1/chat/completions", "name": "fixture"}, 200)
	preview := b.previewResourceImport(context.Background(), project, id, Object{"text": "Please import app host 10.3.4.5 username root\npassword=synthetic-prose-password\napiKey=synthetic-api-key"})
	plan := b.loadImportPlan(project, id, stringOf(preview["planId"]))
	ref := stringOf(plan.Candidates[0].Config["credentialRef"])
	data, err := os.ReadFile(filepath.Join(b.Models.Home, "secrets", ref))
	if err != nil || string(data) != "synthetic-prose-password" {
		t.Fatal("credential token did not resolve")
	}
}

func TestAIImportApprovalAndCurrentTurnAssets(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	file := b.saveImportSource(project, id, "source.txt", `[{"name":"Imported SSH","host":"10.4.5.6","username":"root","password":"synthetic-ai-import-password"}]`)
	var step atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request Object
		json.NewDecoder(r.Body).Decode(&request)
		switch step.Add(1) {
		case 1:
			emitModel(w, "", []ai.Call{{ID: "preview", Name: "preview_resource_import", Arguments: jsonText(Object{"source_id": file["sourceId"]})}})
		case 2:
			messages := objects(request["messages"])
			var preview Object
			json.Unmarshal([]byte(stringOf(messages[len(messages)-1]["content"])), &preview)
			emitModel(w, "", []ai.Call{{ID: "commit", Name: "import_resources", Arguments: jsonText(Object{"plan_id": preview["planId"]})}})
		case 3:
			emitModel(w, "", []ai.Call{{ID: "assets", Name: "list_assets", Arguments: `{"pattern":"Imported SSH"}`}})
		default:
			messages := objects(request["messages"])
			if !strings.Contains(stringOf(messages[len(messages)-1]["content"]), "Imported SSH") {
				t.Error("imported asset unavailable in same turn")
			}
			emitModel(w, "导入完成", nil)
		}
	}))
	defer provider.Close()
	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": provider.URL + "/v1/chat/completions", "name": "fixture"}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "读取文件并导入", "files": []Object{file}}, 202)
	view := waitAI(t, b, id, "waiting_approval")
	if view.Pending == nil || view.Pending.Kind != "resource_import" {
		t.Fatal("import approval missing")
	}
	if len(objects(b.Store.Catalog()["resources"])) != 1 {
		t.Fatal("resources created before approval")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/decision", Object{"id": view.Pending.ID, "accept": true}, 200)
	view = waitAI(t, b, id, "completed")
	if strings.Contains(jsonText(view), "synthetic-ai-import-password") {
		t.Fatal("AI cards leaked credentials")
	}
	if len(objects(b.Store.Catalog()["resources"])) != 2 {
		t.Fatal("AI did not import")
	}
}
