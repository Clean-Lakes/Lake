package store

import (
	"context"
	"encoding/json"
	"path/filepath"
	"reflect"
	"testing"
)

func TestWorkflowLibraryHierarchyOrderScopeAndPersistence(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	s, err := Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	lake, _ := s.CreateLake(ctx, "ops", "")
	other, _ := s.CreateLake(ctx, "other", "")
	first, _ := s.CreateWorkflow(ctx, lake.Name, "legacy", "", json.RawMessage(`{"steps":[]}`))
	second, _ := s.CreateWorkflowV2(ctx, lake.ID, "modern", "", json.RawMessage(`{"version":2}`))
	foreign, _ := s.CreateWorkflowV2(ctx, other.ID, "foreign", "", json.RawMessage(`{"version":2}`))
	change := func(req WorkflowLibraryRequest) WorkflowLibrary {
		t.Helper()
		if req.Lake == "" {
			req.Lake = lake.Name
		}
		result, err := s.ManageWorkflowLibrary(ctx, req)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	folder := change(WorkflowLibraryRequest{Action: "create_folder", Name: "日常维护"}).CreatedID
	child := change(WorkflowLibraryRequest{Action: "create_folder", ParentID: folder, Name: "数据库"}).CreatedID
	destination := change(WorkflowLibraryRequest{Action: "create_folder", Name: "生产环境"}).CreatedID
	change(WorkflowLibraryRequest{Action: "move", Kind: "v1", ID: first.ID, ParentID: child})
	change(WorkflowLibraryRequest{Action: "move", Kind: "v2", ID: second.ID, ParentID: child, BeforeKind: "v1", BeforeID: first.ID})
	change(WorkflowLibraryRequest{Action: "move", Kind: "folder", ID: folder, ParentID: destination})
	change(WorkflowLibraryRequest{Action: "rename_folder", ID: child, Name: "数据库巡检"})
	snapshot := change(WorkflowLibraryRequest{Action: "list"})
	var children []string
	for _, entry := range snapshot.Entries {
		if entry.ParentID == child {
			children = append(children, entry.ID)
		}
		if entry.ID == folder && entry.ParentID != destination {
			t.Fatal("folder did not move with its subtree")
		}
		if entry.ID == child && (entry.ParentID != folder || entry.Name != "数据库巡检") {
			t.Fatal("subfolder was detached or rename lost")
		}
	}
	if !reflect.DeepEqual(children, []string{second.ID, first.ID}) {
		t.Fatalf("sibling order=%v", children)
	}
	for _, invalid := range []WorkflowLibraryRequest{
		{Action: "move", Kind: "folder", ID: destination, ParentID: child},
		{Action: "move", Kind: "folder", ID: folder, ParentID: folder},
		{Action: "move", Kind: "v2", ID: foreign.ID, ParentID: child},
		{Action: "move", Lake: other.Name, Kind: "v1", ID: first.ID},
		{Action: "move", Kind: "v1", ID: first.ID, BeforeKind: "folder", BeforeID: child},
		{Action: "delete_folder", ID: child},
		{Action: "create_folder", ParentID: folder, Name: "数据库巡检"},
	} {
		if invalid.Lake == "" {
			invalid.Lake = lake.Name
		}
		if _, err := s.ManageWorkflowLibrary(ctx, invalid); err == nil {
			t.Fatalf("invalid organization accepted: %+v", invalid)
		}
	}
	if got := change(WorkflowLibraryRequest{Action: "list"}); !reflect.DeepEqual(snapshot.Entries, got.Entries) {
		t.Fatal("rejected mutation changed the library")
	}
	change(WorkflowLibraryRequest{Action: "move", Kind: "v1", ID: first.ID})
	change(WorkflowLibraryRequest{Action: "move", Kind: "v2", ID: second.ID})
	change(WorkflowLibraryRequest{Action: "delete_folder", ID: child})
	v1, _ := s.GetWorkflow(ctx, first.ID)
	v2, _ := s.GetWorkflowV2(ctx, second.ID)
	if v1.LakeID != lake.ID || v2.LakeID != lake.ID || v2.Revision != second.Revision || string(v1.Spec) != string(first.Spec) || string(v2.Spec) != string(second.Spec) {
		t.Fatal("organization changed workflow definitions")
	}
	before := change(WorkflowLibraryRequest{Action: "list"})
	s.Close()
	s, err = Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	if after := change(WorkflowLibraryRequest{Action: "list"}); !reflect.DeepEqual(before.Entries, after.Entries) {
		t.Fatal("organization lost on reopening")
	}
}

func TestWorkflowLibraryV18UpgradePreservesUnfiledDefinitions(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	s, err := Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	lake, _ := s.CreateLake(ctx, "old", "")
	definition, _ := s.CreateWorkflow(ctx, lake.Name, "existing", "", json.RawMessage(`{}`))
	if _, err := s.db.ExecContext(ctx, `DROP TABLE workflow_organization; PRAGMA user_version=17`); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	library, err := s.ManageWorkflowLibrary(ctx, WorkflowLibraryRequest{Action: "list"})
	if err != nil || len(library.Entries) != 1 || library.Entries[0].ID != definition.ID || library.Entries[0].ParentID != "" {
		t.Fatalf("legacy library=%+v err=%v", library, err)
	}
	backups, err := filepath.Glob(filepath.Join(root, "lake.db.pre-v18-*.bak"))
	if err != nil || len(backups) != 1 {
		t.Fatalf("upgrade backup=%v err=%v", backups, err)
	}
}

func TestConcurrentWorkflowFolderMovesCannotCreateCycle(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	first, err := Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	first.CreateLake(ctx, "ops", "")
	a, err := first.ManageWorkflowLibrary(ctx, WorkflowLibraryRequest{Action: "create_folder", Lake: "ops", Name: "a"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := first.ManageWorkflowLibrary(ctx, WorkflowLibraryRequest{Action: "create_folder", Lake: "ops", Name: "b"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	start, results := make(chan struct{}), make(chan error, 2)
	go func() {
		<-start
		_, err := first.ManageWorkflowLibrary(ctx, WorkflowLibraryRequest{Action: "move", Lake: "ops", Kind: "folder", ID: a.CreatedID, ParentID: b.CreatedID})
		results <- err
	}()
	go func() {
		<-start
		_, err := second.ManageWorkflowLibrary(ctx, WorkflowLibraryRequest{Action: "move", Lake: "ops", Kind: "folder", ID: b.CreatedID, ParentID: a.CreatedID})
		results <- err
	}()
	close(start)
	one, two := <-results, <-results
	if (one == nil) == (two == nil) {
		t.Fatalf("concurrent moves should accept exactly one: %v / %v", one, two)
	}
	library, err := first.ManageWorkflowLibrary(ctx, WorkflowLibraryRequest{Action: "list"})
	if err != nil {
		t.Fatal(err)
	}
	roots := 0
	for _, entry := range library.Entries {
		if entry.ParentID == "" {
			roots++
		}
	}
	if roots != 1 {
		t.Fatal("concurrent moves created a cycle or lost an entry")
	}
}
