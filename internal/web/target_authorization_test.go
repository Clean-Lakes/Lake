package web

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestTrashMoveRequiresApprovalWhenCommandSilenceOff(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	dir := t.TempDir()
	source := filepath.Join(dir, "fixture.rar")
	trash := filepath.Join(dir, ".Trash")
	must(os.Mkdir(trash, 0700))
	destination := filepath.Join(trash, "fixture.rar")
	must(os.WriteFile(source, []byte("synthetic file"), 0600))
	command := "mv -- " + quote(source) + " " + quote(destination)
	if p := CommandPolicy(command); p.Risk != "dangerous" || !p.Destructive {
		t.Fatal("trash move must be destructive")
	}
	var step atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := step.Add(1)
		if n == 1 || n == 3 {
			emitModel(w, "", []ai.Call{{ID: "trash-move", Name: "shell", Arguments: jsonText(Object{"command": command})}})
		} else {
			emitModel(w, "操作处理完成", nil)
		}
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "delete approval fixture", Protocol: "openai"})
	term := b.Terminals.Open(context.Background(), id, ref)
	tid := stringOf(term["id"])
	b.Terminals.Control(id, tid, "agent")
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"silentCommands": false, "silentWriteFiles": true, "asset_ref": ref, "terminal_id": tid}, 200)
	send := func() { apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "移到废纸篓"}, 202) }
	send()
	view := waitAI(t, b, id, "waiting_approval")
	if view.Pending == nil || view.Pending.Kind != "delete" || view.Pending.TerminalID != tid || view.Pending.Confirmation == "" {
		t.Fatal("missing destructive approval or exact terminal")
	}
	if _, err := os.Stat(source); err != nil {
		t.Fatal("effect before approval")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/decision", Object{"id": view.Pending.ID, "accept": false}, 200)
	waitAI(t, b, id, "completed")
	b.workers.Wait()
	if _, err := os.Stat(source); err != nil {
		t.Fatal("reject moved file")
	}
	send()
	view = waitAI(t, b, id, "waiting_approval")
	approval := view.Pending
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/decision", Object{"id": approval.ID, "accept": true}, 409)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/decision", Object{"id": approval.ID, "accept": true, "confirmation": approval.Confirmation}, 200)
	waitAI(t, b, id, "completed")
	b.workers.Wait()
	if _, err := os.Stat(source); !os.IsNotExist(err) {
		t.Fatal("approved source not moved")
	}
	if _, err := os.Stat(destination); err != nil {
		t.Fatal("approved destination missing")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/decision", Object{"id": approval.ID, "accept": true, "confirmation": approval.Confirmation}, 409)
}

func TestSilentCommandsExecuteMoveAndDeleteWithoutApproval(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	dir := t.TempDir()
	source, destination := filepath.Join(dir, "source.txt"), filepath.Join(dir, "moved.txt")
	must(os.WriteFile(source, []byte("disposable silence fixture"), 0600))
	commands := []string{"mv -- " + quote(source) + " " + quote(destination), "rm -- " + quote(destination)}
	var step atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := int(step.Add(1))
		if n%2 == 1 {
			emitModel(w, "", []ai.Call{{ID: "silent-deletion", Name: "shell", Arguments: jsonText(Object{"command": commands[(n-1)/2]})}})
		} else {
			emitModel(w, "done", nil)
		}
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "silent delete fixture", Protocol: "openai"})
	term := b.Terminals.Open(context.Background(), id, ref)
	tid := stringOf(term["id"])
	b.Terminals.Control(id, tid, "agent")
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"silentCommands": true, "asset_ref": ref, "terminal_id": tid}, 200)
	for round := range commands {
		apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "操作测试临时文件"}, 202)
		view := waitAI(t, b, id, "completed")
		b.workers.Wait()
		if view.Pending != nil {
			t.Fatal("silent deletion requested approval")
		}
		if _, err := os.Stat(source); !os.IsNotExist(err) {
			t.Fatal("source did not move")
		}
		_, err := os.Stat(destination)
		if round == 0 && err != nil || round == 1 && !os.IsNotExist(err) {
			t.Fatal("silent move/delete effect missing")
		}
		actions := objects(b.Store.Snapshot(id)["actions"])
		last := actions[len(actions)-1]
		if last["status"] != "succeeded" || last["terminalId"] != tid || last["resourceId"] != ref {
			t.Fatal("silent operation lost audit or exact target")
		}
	}
}

func TestDestructiveSilenceDoesNotCoverOtherDangerousEffects(t *testing.T) {
	for _, command := range []string{"rm -- /tmp/fixture", "mv /tmp/a /tmp/b", "find /tmp/fixture -type f -delete"} {
		p := CommandPolicy(command)
		if !p.DestructiveOnly || p.Risk != "dangerous" {
			t.Fatalf("deletion classification missing: %s", command)
		}
	}
	for _, command := range []string{"rm -- /tmp/fixture; sh -c 'true'", "rm /tmp/fixture; cat ~/.ssh/id_ed25519", "rm $(echo /tmp/fixture)", "rm /tmp/fixture; reboot"} {
		if CommandPolicy(command).DestructiveOnly {
			t.Fatal("mixed danger inherited silent deletion permission")
		}
	}
}

func TestMultiTerminalBindingDoesNotGuessOrSwitch(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	ctx := context.Background()
	termA := b.Terminals.Open(ctx, id, ref)
	termB := b.Terminals.Open(ctx, id, ref)
	a := stringOf(termA["id"])
	z := stringOf(termB["id"])
	for tid, directory := range map[string]string{a: "/tmp", z: "/"} {
		entry := b.Terminals.Execute(id, tid, "user", "cd "+quote(directory), "")
		b.Terminals.Wait(ctx, id, tid, stringOf(entry["id"]))
	}
	b.Terminals.Control(id, a, "agent")
	b.Terminals.Control(id, z, "agent")
	expectPanic(t, 409, func() { b.reusableHostTerminal(id, ref) })
	expectPanic(t, 409, func() { b.reusableHostTerminal(id, ref, a) }) // Model-supplied ID alone does not pick between unbound candidates.
	options := Object{"asset_ref": ref, "runtime": "local", "terminal_id": a}
	b.Store.SaveOptions(id, options)
	if b.reusableHostTerminal(id, ref)["id"] != a {
		t.Fatal("binding ignored")
	}
	expectPanic(t, 409, func() { b.reusableHostTerminal(id, ref, z) })
	result, err := b.bridge(ctx, id, "runtimeCommandExec", Object{"command": "pwd", "runtime": "local", "asset_ref": ref}, false)
	if err != nil || strings.TrimSpace(stringOf(object(result)["output"])) != "/tmp" {
		t.Fatal("command executed in wrong directory")
	}
	b.Terminals.Close(id, a)
	if b.reusableHostTerminal(id, ref) != nil {
		t.Fatal("closed binding switched to another ready terminal")
	}
	expectPanic(t, 403, func() { b.hostTerminal(ctx, id, ref, false) })
	replacement := b.hostTerminal(ctx, id, ref, true)
	if replacement["id"] == z || replacement["id"] == a {
		t.Fatal("reopen borrowed a different shell")
	}
	// Explicit terminal context from the UI is a trusted, inspectable selection.
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { emitModel(w, "fixture", nil) }))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "targets", Protocol: "openai"})
	b.Store.SaveOptions(id, Object{"asset_ref": ref, "runtime": "local", "terminal_id": a})
	b.bindReferenceTargets(id, []Object{{"asset_ref": ref, "terminal_id": z}}, b.sessionOptions(id))
	if b.Store.Options(id)["terminal_id"] != z {
		t.Fatal("explicit terminal reference did not bind")
	}
}

func TestUnqualifiedMultipleHostsRequiresTargetConfirmation(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	other := b.Store.CreateResource(project, "second host fixture", "local", Object{})
	session := b.Store.CreateSession(project, "ambiguous hosts", []string{ref, stringOf(other["id"])})
	sid := stringOf(session["id"])
	expectPanic(t, 409, func() { b.hostResource(sid, "") })
	b.bindReferenceTargets(sid, nil, b.sessionOptions(sid))
	if b.Store.Options(sid)["asset_ref"] != nil && b.Store.Options(sid)["asset_ref"] != "" {
		t.Fatal("multiple resources chose an implicit primary")
	}
	result, err := b.bridge(context.Background(), sid, "policy", Object{"name": "inspect_host", "arguments": Object{"asset_ref": ref, "runtime": "local"}}, false)
	if err != nil || object(result)["needsTarget"] != true {
		t.Fatal("model selected multi-host target without confirmation flag")
	}
	if len(b.Store.ResourceTerminals(ref)) != 0 {
		t.Fatal("policy created a terminal")
	}
}

func TestMultiHostModelSelectionCannotBypassTargetApproval(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	other := b.Store.CreateResource(project, "second local fixture", "local", Object{})
	session := b.Store.CreateSession(project, "target approval", []string{ref, stringOf(other["id"])})
	sid := stringOf(session["id"])
	var step atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := step.Add(1)
		if n%3 == 1 {
			emitModel(w, "", []ai.Call{{ID: "list-targets", Name: "list_assets", Arguments: `{"pattern":""}`}})
			return
		}
		if n%3 == 2 {
			var body Object
			json.NewDecoder(r.Body).Decode(&body)
			alias := ""
			for _, message := range objects(body["messages"]) {
				if message["role"] == "tool" && message["name"] == "list_assets" {
					var resources []Object
					json.Unmarshal([]byte(stringOf(message["content"])), &resources)
					if len(resources) > 0 {
						alias = stringOf(resources[0]["asset_ref"])
					}
				}
			}
			emitModel(w, "", []ai.Call{{ID: "choose-target", Name: "inspect_host", Arguments: jsonText(Object{"asset_ref": alias, "runtime": "local"})}})
			return
		}
		emitModel(w, "目标选择处理结束", nil)
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "target selection fixture", Protocol: "openai"})
	apiTest(t, h, "POST", "/api/sessions/"+sid+"/ai/configure", Object{"silentCommands": true, "silentTerminalCreation": true}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+sid+"/messages", Object{"text": "看看主机状态"}, 202)
	view := waitAI(t, b, sid, "waiting_approval")
	if view.Pending == nil || view.Pending.Kind != "resource_select" || view.Pending.ResourceID == "" {
		t.Fatal("model-selected target silently accepted")
	}
	if len(objects(b.Store.Snapshot(sid)["terminals"])) != 0 {
		t.Fatal("ambiguous target created a terminal before selection")
	}
	apiTest(t, h, "POST", "/api/sessions/"+sid+"/ai/decision", Object{"id": view.Pending.ID, "accept": false}, 200)
	waitAI(t, b, sid, "completed")
	b.workers.Wait()
	if len(objects(b.Store.Snapshot(sid)["terminals"])) != 0 || stringOf(b.Store.Options(sid)["asset_ref"]) != "" {
		t.Fatal("reject changed binding or created terminal")
	}
	apiTest(t, h, "POST", "/api/sessions/"+sid+"/messages", Object{"text": "选择目标后检查"}, 202)
	view = waitAI(t, b, sid, "waiting_approval")
	selected := view.Pending.ResourceID
	apiTest(t, h, "POST", "/api/sessions/"+sid+"/ai/decision", Object{"id": view.Pending.ID, "accept": true}, 200)
	waitAI(t, b, sid, "completed")
	b.workers.Wait()
	options := b.Store.Options(sid)
	if options["asset_ref"] != selected || stringOf(options["terminal_id"]) == "" {
		t.Fatal("confirmed target was not retained")
	}
	var state ai.State
	data, err := os.ReadFile(filepath.Join(b.Engine.Dir, sid+".json"))
	if err != nil {
		t.Fatal(err)
	}
	json.Unmarshal(data, &state)
	if state.Config.AssetRef != selected || state.Config.TerminalID != options["terminal_id"] {
		t.Fatal("engine configuration differs from confirmed target")
	}
}
