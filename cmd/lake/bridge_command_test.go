package main

import (
	"context"
	"github.com/cloudwego/eino/lake/store"
	"testing"
	"time"
)

func TestCommandGateWaitsForMatchingHandoffAndCloses(t *testing.T) {
	g := newBridgeCommandGate()
	defer g.close()
	proposals := make(chan string, 1)
	done := make(chan store.ExecutionRecord, 1)
	go func() {
		r, _ := g.request(context.Background(), "local", "project", "pwd", func(id string) { proposals <- id })
		done <- r
	}()
	id := <-proposals
	if g.respond("stale", commandReply{}) {
		t.Fatal("stale response accepted")
	}
	select {
	case <-done:
		t.Fatal("gate did not wait for handoff")
	default:
	}
	if !g.respond(id, commandReply{Record: store.ExecutionRecord{Sequence: 8, Stdout: "manual result", Actor: "user"}}) {
		t.Fatal("valid reply rejected")
	}
	select {
	case result := <-done:
		if result.Sequence != 8 || result.Stdout != "manual result" {
			t.Fatal("handoff result lost")
		}
	case <-time.After(time.Second):
		t.Fatal("gate did not continue")
	}
	closed := make(chan error, 1)
	go func() {
		_, err := g.request(context.Background(), "local", "project", "pwd", func(id string) { proposals <- id })
		closed <- err
	}()
	<-proposals
	g.close()
	select {
	case err := <-closed:
		if err == nil {
			t.Fatal("closed gate succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("gate leaked")
	}
}
