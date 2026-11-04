package web

import (
	"net/http/httptest"
	"testing"
)

func TestSpecialistDeleteHTTPIsScopedRevisionedAndKeepsHistory(t *testing.T) {
	b, pid, pilot, worker, ch := roleWorkspaceFixture(t)
	h := httptest.NewServer(b)
	defer h.Close()
	path := "/api/projects/" + pid + "/superagent/specialists/" + ch.RoleID
	apiTest(t, h, "DELETE", path, Object{}, 400)
	apiTest(t, h, "DELETE", path, Object{"revision": -1}, 400)
	apiTest(t, h, "DELETE", path, Object{"revision": 1.5}, 400)
	apiTest(t, h, "DELETE", path, Object{"revision": "1"}, 400)
	apiTest(t, h, "DELETE", path, Object{"revision": ch.RoleRevision + 1}, 409)
	other := stringOf(b.Store.CreateProject("Other project")["id"])
	apiTest(t, h, "DELETE", "/api/projects/"+other+"/superagent/specialists/"+ch.RoleID, Object{"revision": ch.RoleRevision}, 404)
	b.Store.AddMessage(ch.SessionID, "user", "keep direct channel history", nil)
	before := b.Store.Snapshot(pilot)
	for range 2 {
		apiTest(t, h, "DELETE", path, Object{"revision": ch.RoleRevision}, 200)
	}
	view := apiTest(t, h, "GET", "/api/projects/"+pid+"/superagent", nil, 200)
	if len(objects(view["channels"])) != 0 {
		t.Fatal("deleted role remained visible", view)
	}
	if len(b.reconcileSpecialistChannels(t.Context(), pid)) != 0 {
		t.Fatal("reconciliation revived role")
	}
	page := b.roleChannelPage(t.Context(), ch.SessionID, "", 50)
	if len(page["entries"].([]roleChannelEntry)) == 0 {
		t.Fatal("history was removed")
	}
	after := b.Store.Snapshot(pilot)
	if jsonText(before["messages"]) != jsonText(after["messages"]) {
		t.Fatal("deletion rewrote Pilot messages")
	}
	task, err := b.Engine.SuperTask(worker.SessionID, worker.TaskID)
	if err != nil || task.State != "cancelled" {
		t.Fatal(task, err)
	}
	changed := false
	for _, event := range b.Store.Events(pilot, 0) {
		if event["type"] == "specialist" {
			changed = true
		}
	}
	if !changed {
		t.Fatal("no sidebar refresh event")
	}
	request := httptest.NewRequest("DELETE", path, nil)
	request.Host = "localhost:4177"
	response := httptest.NewRecorder()
	b.ServeHTTP(response, request)
	if response.Code != 401 {
		t.Fatal("unauthenticated deletion accepted", response.Code)
	}
}
