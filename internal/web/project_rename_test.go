package web

import "testing"

func TestProjectRenameRoute(t *testing.T) {
	_, h := fixture(t)
	created := apiTest(t, h, "POST", "/api/projects", Object{"name": "Initial Project"}, 201)
	id := stringOf(created["id"])

	renamed := apiTest(t, h, "PATCH", "/api/projects/"+id, Object{"name": "  Renamed Project  "}, 200)
	if stringOf(renamed["name"]) != "Renamed Project" {
		t.Fatalf("expected renamed name, got %v", renamed["name"])
	}

	catalog := apiTest(t, h, "GET", "/api/catalog", nil, 200)
	projects := objects(catalog["projects"])
	if len(projects) != 1 || stringOf(projects[0]["name"]) != "Renamed Project" {
		t.Fatalf("expected catalog project name updated, got %v", projects)
	}

	apiTest(t, h, "PATCH", "/api/projects/"+id, Object{"name": "   "}, 400)
	apiTest(t, h, "PATCH", "/api/projects/missing-project", Object{"name": "Other"}, 404)
}
