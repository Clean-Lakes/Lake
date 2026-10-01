package main

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/cloudwego/eino/lake/scheduler"
	"github.com/cloudwego/eino/lake/store"
)

func TestScheduledWriteWaitsWithoutGrantAndUsesExactGrant(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "ops", "")
	if err != nil {
		t.Fatal(err)
	}
	host, err := s.CreateHost(ctx, store.ResourceInput{LakeID: lake.ID, Name: "web", SSH: store.SSHSpec{Host: "example.invalid", Port: 22, Username: "root"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetExecuteAuthz(ctx, host.ID, true); err != nil {
		t.Fatal(err)
	}
	definition := json.RawMessage(`{"version":2,"name":"write","nodes":[{"id":"write","kind":"ssh_command","target":{"type":"string","literal":"web"},"command":{"type":"string","literal":"echo ok"}}]}`)
	def, err := s.CreateWorkflowV2(ctx, lake.ID, "write", "", definition)
	if err != nil {
		t.Fatal(err)
	}
	due := time.Now().Add(-time.Minute)
	first, err := s.CreateSchedule(ctx, def.ID, "once", due.Format(time.RFC3339), "UTC", due)
	if err != nil {
		t.Fatal(err)
	}
	runner := scheduler.Runner{Store: s, Owner: "test", Execute: func(ctx context.Context, item store.Schedule, run store.ScheduleRun) (string, string, string, error) {
		return executeSchedule(ctx, s, item, run)
	}}
	if ran, err := runner.RunOne(ctx, time.Now()); err != nil || !ran {
		t.Fatalf("ran=%t err=%v", ran, err)
	}
	runs, err := s.ListScheduleRuns(ctx, first.ID)
	if err != nil || len(runs) != 1 || runs[0].Status != "waiting_approval" {
		t.Fatalf("runs=%+v err=%v", runs, err)
	}
	workflowRun, err := s.GetWorkflowV2Run(ctx, runs[0].WorkflowRunID)
	if err != nil || workflowRun.Nodes[0].Status != "waiting_approval" {
		t.Fatalf("workflow run=%+v err=%v", workflowRun, err)
	}
	second, err := s.CreateSchedule(ctx, def.ID, "once", due.Format(time.RFC3339), "UTC", due)
	if err != nil {
		t.Fatal(err)
	}
	grant, err := s.CreateScheduleGrant(ctx, second.ID, "write", host.ID, store.CommandSHA256("echo ok"), time.Now().Add(time.Hour), 1)
	if err != nil {
		t.Fatal(err)
	}
	if ran, err := runner.RunOne(ctx, time.Now()); err != nil || !ran {
		t.Fatalf("granted ran=%t err=%v", ran, err)
	}
	used, err := s.GetScheduleGrant(ctx, grant.ID)
	if err != nil || used.UsedRuns != 1 {
		t.Fatalf("grant=%+v err=%v", used, err)
	}
	runs, err = s.ListScheduleRuns(ctx, second.ID)
	if err != nil || len(runs) != 1 || runs[0].Status != "failed" {
		t.Fatalf("runs=%+v err=%v", runs, err)
	}
	paused, err := s.GetSchedule(ctx, second.ID)
	if err != nil || paused.Enabled {
		t.Fatalf("failed write schedule was not paused: %+v %v", paused, err)
	}
}

func TestScheduleAuthorizeRequiresCurrentCommandDigest(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "ops", "")
	if err != nil {
		t.Fatal(err)
	}
	host, err := s.CreateHost(ctx, store.ResourceInput{LakeID: lake.ID, Name: "web", SSH: store.SSHSpec{Host: "example.invalid", Port: 22, Username: "root"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetExecuteAuthz(ctx, host.ID, true); err != nil {
		t.Fatal(err)
	}
	def, err := s.CreateWorkflowV2(ctx, lake.ID, "write", "", json.RawMessage(`{"version":2,"name":"write","nodes":[{"id":"write","kind":"ssh_command","target":{"type":"string","literal":"web"},"command":{"type":"string","literal":"echo ok"}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	plan, err := s.CreateSchedule(ctx, def.ID, "once", time.Now().Add(time.Hour).Format(time.RFC3339), "UTC", time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	expires := time.Now().Add(2 * time.Hour).Format(time.RFC3339)
	base := []string{"authorize", plan.ID, "--node", "write", "--resource", "web", "--command-sha256"}
	var out, errOut bytes.Buffer
	if err := scheduleCommand(ctx, s, append(append([]string{}, base...), strings.Repeat("0", 64), "--expires", expires), &out, &errOut); err == nil {
		t.Fatal("wrong command digest accepted")
	}
	out.Reset()
	if err := scheduleCommand(ctx, s, append(append([]string{}, base...), store.CommandSHA256("echo ok"), "--expires", expires), &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "已授权节点 write") {
		t.Fatalf("output=%q", out.String())
	}
}
