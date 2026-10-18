package web

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func uploadFixture(t *testing.T, h *httptest.Server, id, name string, raw []byte) Object {
	t.Helper()
	request, _ := http.NewRequest("POST", h.URL+"/api/sessions/"+id+"/attachments", bytes.NewReader(raw))
	request.Host = "localhost:4177"
	request.Header.Set("Authorization", "Bearer synthetic-test-auth-token")
	request.Header.Set("X-Lake-Filename", url.PathEscape(name))
	response, err := h.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var result Object
	if err = json.NewDecoder(response.Body).Decode(&result); err != nil || response.StatusCode != 201 {
		t.Fatal(response.StatusCode, err, result)
	}
	return result
}
func packageFixture(t *testing.T, name string) []byte {
	t.Helper()
	var out bytes.Buffer
	archive := zip.NewWriter(&out)
	file, err := archive.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	file.Write([]byte("DEPLOYMENT_FIXTURE\x00\xff"))
	if err = archive.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}
func TestAttachmentUploadDownloadAndIsolation(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	for _, raw := range [][]byte{packageFixture(t, "site/index.bin"), {}, {0, 255, 1, 128}} {
		attached := uploadFixture(t, h, id, "发布 包.zip", raw)
		source, filename := b.loadAttachment(project, id, stringOf(attached["sourceId"]))
		verifyAttachment(source, filename)
		if source.Size != int64(len(raw)) || strings.Contains(jsonText(attached), filename) {
			t.Fatal("bad attachment metadata")
		}
		request, _ := http.NewRequest("GET", h.URL+"/api/sessions/"+id+"/attachments/"+source.SourceID, nil)
		request.Host = "localhost:4177"
		request.Header.Set("Authorization", "Bearer synthetic-test-auth-token")
		response, err := h.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		got, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != 200 || !bytes.Equal(got, raw) || response.Header.Get("X-Content-Type-Options") != "nosniff" {
			t.Fatal("binary download changed")
		}
		other := apiTest(t, h, "POST", "/api/projects/"+project+"/sessions", Object{"title": "other"}, 201)
		expectPanic(t, 403, func() { b.loadAttachment(project, stringOf(other["id"]), source.SourceID) })
		expectPanic(t, 403, func() {
			b.validateHumanMessage(stringOf(other["id"]), Object{"text": "cross-session", "files": []any{attached}})
		})
	}
	before, _ := os.ReadDir(b.attachmentRoot())
	expectPanic(t, 413, func() { b.saveAttachment(project, id, "large.bin", bytes.NewReader([]byte{1, 2, 3}), 2) })
	after, _ := os.ReadDir(b.attachmentRoot())
	if len(before) != len(after) {
		t.Fatal("failed upload left files")
	}
	expectPanic(t, 400, func() { b.saveAttachment(project, id, "../escape", strings.NewReader("x"), 10) })
}
func TestAttachmentInspectionRejectsTraversalAndTampering(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	for _, name := range []string{"site/index.bin", "../escape", "/absolute", "C:/escape", "..\\escape"} {
		attached := uploadFixture(t, h, id, "package.zip", packageFixture(t, name))
		result := b.inspectAttachment(id, Object{"source_id": attached["sourceId"]})
		if result["safeToExtract"] != (name == "site/index.bin") {
			t.Fatal("unsafe archive accepted", name, result)
		}
	}
	attached := uploadFixture(t, h, id, "binary.bin", []byte{1, 2, 3})
	source, filename := b.loadAttachment(project, id, stringOf(attached["sourceId"]))
	os.WriteFile(filename, []byte{3, 2, 1}, 0600)
	expectPanic(t, 409, func() { verifyAttachment(source, filename) })
}
func TestAttachmentQueueAndMessageHistoryKeepCanonicalMetadata(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	attached := uploadFixture(t, h, id, "artifact.zip", packageFixture(t, "index.bin"))
	b.Store.PauseMessageQueue(id, "fixture")
	b.submitHumanMessage(id, Object{"text": "deploy later", "files": []any{attached}, "enqueue": true})
	queued := objects(b.Store.MessageQueue(id)["items"])
	if len(queued) != 1 || stringOf(objects(queued[0]["files"])[0]["sha256"]) == "" {
		t.Fatal("queue lost attachment metadata")
	}
	message := b.validateHumanMessage(id, Object{"text": "deploy later", "files": []any{Object{"sourceId": attached["sourceId"], "name": "forged.exe"}}})
	if message.Files[0]["name"] != "artifact.zip" {
		t.Fatal("untrusted attachment name accepted")
	}
	b.Store.BeginWithFilesAndNaming(id, message.Text, nil, publicMessageFiles(message.Files))
	stored := objects(b.Store.Snapshot(id)["messages"])
	if len(stored) != 1 || objects(stored[0]["files"])[0]["sourceId"] != attached["sourceId"] {
		t.Fatal("message history lost attachment")
	}
	if err := b.Store.Close(); err != nil {
		t.Fatal(err)
	}
	reloaded, err := OpenStore(b.options.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	b.Store = reloaded
	if len(objects(objects(reloaded.Snapshot(id)["messages"])[0]["files"])) != 1 || len(objects(reloaded.MessageQueue(id)["items"])) != 1 {
		t.Fatal("reopen lost attachment history or queue")
	}
}
func TestADKAttachmentStageApprovalAndActualArchiveDeployment(t *testing.T) {
	if _, err := exec.LookPath("unzip"); err != nil {
		t.Skip("unzip unavailable")
	}
	b, h := fixture(t)
	id, local := newSession(t, h)
	dir := t.TempDir()
	destination := filepath.Join(dir, "deployment.zip")
	deployed := filepath.Join(dir, "site", "index.bin")
	attached := uploadFixture(t, h, id, "deployment.zip", packageFixture(t, "site/index.bin"))
	var step atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body Object
		json.NewDecoder(r.Body).Decode(&body)
		if !strings.Contains(jsonText(body), "LAKE_SESSION_CONTEXT") {
			emitModel(w, "deployment fixture", nil)
			return
		}
		switch step.Add(1) {
		case 1:
			emitModel(w, "", []ai.Call{{ID: "inspect", Name: "inspect_attachment", Arguments: jsonText(Object{"source_id": attached["sourceId"]})}})
		case 2:
			emitModel(w, "", []ai.Call{{ID: "stage", Name: "stage_attachment", Arguments: jsonText(Object{"source_id": attached["sourceId"], "runtime": "local", "asset_ref": sreAliasForTest(local), "path": destination})}})
		case 3:
			emitModel(w, "", []ai.Call{{ID: "extract", Name: "shell", Arguments: jsonText(Object{"asset_ref": sreAliasForTest(local), "runtime": "local", "command": "unzip -q '" + destination + "' -d '" + dir + "'", "timeout_ms": 10000})}})
		default:
			emitModel(w, "附件部署完成，已保留原包。", nil)
		}
	}))
	defer provider.Close()
	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": provider.URL + "/v1/chat/completions", "name": "fixture"}, 200)
	allowFixtureHost(b, id)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "把附件传到明确的本机资源并解压到隔离测试目录", "resourceIds": []string{local}, "files": []Object{attached}}, 202)
	view := waitAI(t, b, id, "waiting_approval")
	if view.Pending == nil || view.Pending.Call.Name != "stage_attachment" {
		t.Fatal("file-write approval missing")
	}
	if _, err := os.Stat(destination); !os.IsNotExist(err) {
		t.Fatal("staged before approval")
	}
	if err := b.Engine.Decision(id, view.Pending.ID, true, view.Pending.Confirmation); err != nil {
		t.Fatal(err)
	}
	waitAI(t, b, id, "completed")
	raw, err := os.ReadFile(deployed)
	if err != nil || string(raw) != "DEPLOYMENT_FIXTURE\x00\xff" {
		t.Fatal("actual archive deployment failed", err)
	}
	original, _ := os.ReadFile(destination)
	if !bytes.Equal(original, packageFixture(t, "site/index.bin")) {
		t.Fatal("archive bytes changed")
	}
}
func TestADKAttachmentStageRejectionDoesNotWrite(t *testing.T) {
	b, h := fixture(t)
	id, local := newSession(t, h)
	destination := filepath.Join(t.TempDir(), "reject.bin")
	attached := uploadFixture(t, h, id, "binary.bin", []byte{0, 1, 255})
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body Object
		json.NewDecoder(r.Body).Decode(&body)
		if !strings.Contains(jsonText(body), "LAKE_SESSION_CONTEXT") {
			emitModel(w, "fixture", nil)
			return
		}
		if calls.Add(1) == 1 {
			emitModel(w, "", []ai.Call{{ID: "stage", Name: "stage_attachment", Arguments: jsonText(Object{"source_id": attached["sourceId"], "runtime": "local", "asset_ref": sreAliasForTest(local), "path": destination})}})
		} else {
			emitModel(w, "已取消", nil)
		}
	}))
	defer provider.Close()
	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": provider.URL + "/v1/chat/completions", "name": "fixture"}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "stage fixture", "resourceIds": []string{local}, "files": []Object{attached}}, 202)
	view := waitAI(t, b, id, "waiting_approval")
	if err := b.Engine.Decision(id, view.Pending.ID, false, ""); err != nil {
		t.Fatal(err)
	}
	waitAI(t, b, id, "completed")
	if _, err := os.Stat(destination); !os.IsNotExist(err) {
		t.Fatal("rejected attachment transfer wrote a file")
	}
}

func TestADKAttachmentTransferFollowsWritePermissionOnly(t *testing.T) {
	for _, write := range []bool{false, true} {
		for _, commands := range []bool{false, true} {
			t.Run(fmt.Sprintf("write=%v_commands=%v", write, commands), func(t *testing.T) {
				b, h := fixture(t)
				id, local := newSession(t, h)
				raw := []byte{0, 1, 255, 128}
				attached := uploadFixture(t, h, id, "permission.bin", raw)
				destination := filepath.Join(t.TempDir(), "permission.bin")
				var calls atomic.Int32
				provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					var input Object
					json.NewDecoder(r.Body).Decode(&input)
					if !strings.Contains(jsonText(input), "LAKE_SESSION_CONTEXT") {
						emitModel(w, "fixture", nil)
						return
					}
					if calls.Add(1) == 1 {
						emitModel(w, "", []ai.Call{{ID: "stage", Name: "stage_attachment", Arguments: jsonText(Object{"source_id": attached["sourceId"], "runtime": "local", "asset_ref": sreAliasForTest(local), "path": destination})}})
					} else {
						emitModel(w, "传输回合结束", nil)
					}
				}))
				defer provider.Close()
				apiTest(t, h, "PUT", "/api/settings/model", Object{"url": provider.URL + "/v1/chat/completions", "name": "fixture"}, 200)
				apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"silentWriteFiles": write, "silentCommands": commands, "silentTerminalCreation": false}, 200)
				apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "将附件传到明确的本机测试目录", "resourceIds": []string{local}, "files": []Object{attached}}, 202)
				if write {
					view := waitAI(t, b, id, "completed")
					if view.Pending != nil {
						t.Fatal("write permission still asks for upload confirmation")
					}
					got, err := os.ReadFile(destination)
					if err != nil || !bytes.Equal(got, raw) {
						t.Fatal("authorized transfer did not write original bytes", err)
					}
				} else {
					view := waitAI(t, b, id, "waiting_approval")
					if view.Pending == nil || view.Pending.Kind != "file_write" || view.Pending.Call.Name != "stage_attachment" {
						t.Fatal("upload did not use file-write permission")
					}
					if _, err := os.Stat(destination); !os.IsNotExist(err) {
						t.Fatal("upload wrote before file-write authorization")
					}
					if err := b.Engine.Decision(id, view.Pending.ID, false, ""); err != nil {
						t.Fatal(err)
					}
					waitAI(t, b, id, "completed")
				}
			})
		}
	}
}
