package security

import (
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"sort"
	"sync"
	"testing"
	"time"
)

func kernelFixture() EvaluationInput {
	now := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	r := ResourceRevision{ID: "r1", ConnectionRevision: 1, ConnectionDigest: ContentDigest([]byte("connection")), State: "ready"}
	o := PreparedOperation{FormatVersion: DescriptorVersion, ID: "op1", Actor: "agent", StoreID: "store1", RecoveryEpoch: "epoch1", ProjectID: "p1", SessionID: "s1", GoalID: "g1", GoalRevision: 1, PlanRevision: 1, StepID: "step1", StepRevision: 1, AttemptID: "a1", TaskID: "t1", ExecutionRevision: 1, RootTurnID: "turn1", CallID: "call1", Tool: "read", RegistryVersion: RegistryVersion, TargetKind: TargetResource, Resources: []ResourceRevision{r}, Capabilities: []string{"file.read"}, Proof: ProofStructured, ArgumentsDigest: ContentDigest([]byte("args")), PreviewDigest: ContentDigest([]byte("preview")), TargetRevision: 1, PolicyRevision: 1, OwnerID: "owner1", OwnerGeneration: 1, Scope: OperationScope{FilePath: "/var/log/syslog"}}
	task := SecurityTask{ID: "t1", GoalID: "g1", ProjectID: "p1", SessionID: "s1", StoreID: "store1", RecoveryEpoch: "epoch1", State: TaskActive, StateRevision: 1, ExecutionRevision: 1, CreatedAt: now.Add(-time.Minute), ExpiresAt: now.Add(time.Hour)}
	return EvaluationInput{Now: now, StoreID: "store1", RecoveryEpoch: "epoch1", GateOpen: true, Operation: o, Task: task, Policy: ProjectPolicy{ProjectID: "p1", StoreID: "store1", RecoveryEpoch: "epoch1", Mode: "restricted", SchemaVersion: 1, Revision: 1, Confirmed: true, ResourceIDs: []string{"r1"}, Rules: []Rule{{Capability: "file.read", Effect: EffectAllow, Limits: ScopeLimits{FileRoots: []string{"/var/log"}}}}}, Resources: []ResourceRevision{r}, Owner: ExecutionOwner{ID: "owner1", Generation: 1, LeaseUntil: now.Add(15 * time.Second)}, TargetRevision: 1, GoalReady: true, RootTurnCurrent: true}
}

func fixtureGrant(in *EvaluationInput) {
	in.Policy.Rules[0] = Rule{Capability: "file.read", Effect: EffectAsk, Grantable: true, Confirmation: ConfirmEither, Limits: ScopeLimits{FileRoots: []string{"/var/log"}}}
	in.Operation.GrantRevisions = []RevisionRef{{ID: "grant1", Revision: 1}}
	in.Grants = []TaskGrant{{ID: "grant1", StoreID: in.StoreID, RecoveryEpoch: in.RecoveryEpoch, ProjectID: in.Task.ProjectID, SessionID: in.Task.SessionID, GoalID: in.Task.GoalID, TaskID: in.Task.ID, Revision: 1, Resources: slices.Clone(in.Resources), Capabilities: []string{"file.read"}, CreatedAt: in.Now, ExpiresAt: in.Now.Add(30 * time.Minute), RemainingUses: 50, Limits: ScopeLimits{FileRoots: []string{"/var/log"}}}}
}

func fixtureApproval(in *EvaluationInput) {
	digest, err := OperationDigest(in.Operation)
	if err != nil {
		panic(err)
	}
	in.Approvals = []SingleApproval{{ID: "approval1", StoreID: in.StoreID, RecoveryEpoch: in.RecoveryEpoch, TaskID: in.Task.ID, SessionID: in.Task.SessionID, RootTurnID: in.Operation.RootTurnID, ChildScopeID: in.Operation.ChildScopeID, ExecutionRevision: in.Operation.ExecutionRevision, DescriptorDigest: digest, Authorized: true, CreatedAt: in.Now.Add(-time.Minute), ExpiresAt: in.Now.Add(time.Minute)}}
}

func TestKernelHardChecksPrecedeAuthority(t *testing.T) {
	cases := []struct {
		name   string
		change func(*EvaluationInput)
		reason ReasonCode
	}{
		{"gate", func(in *EvaluationInput) { in.GateOpen = false }, ReasonRecoveryRequired},
		{"epoch", func(in *EvaluationInput) { in.RecoveryEpoch = "restored" }, ReasonRecoveryRequired},
		{"paused", func(in *EvaluationInput) { in.Task.State = TaskPaused }, ReasonTaskNotActive},
		{"deadline", func(in *EvaluationInput) { in.Now = in.Task.ExpiresAt }, ReasonTaskEnded},
		{"stale execution", func(in *EvaluationInput) { in.Task.ExecutionRevision++ }, ReasonOperationStale},
		{"old turn", func(in *EvaluationInput) { in.RootTurnCurrent = false }, ReasonOperationStale},
		{"cancelled", func(in *EvaluationInput) { in.Cancelled = true }, ReasonOperationStale},
		{"owner expired", func(in *EvaluationInput) { in.Owner.LeaseUntil = in.Now }, ReasonOrphanedExecution},
		{"owner fenced", func(in *EvaluationInput) { in.Owner.Generation++ }, ReasonOrphanedExecution},
		{"unresolved", func(in *EvaluationInput) { in.UnresolvedEffects = true }, ReasonSideEffectUnresolved},
		{"step not ready", func(in *EvaluationInput) { in.GoalReady = false }, ReasonStepNotReady},
		{"policy revision", func(in *EvaluationInput) { in.Policy.Revision++ }, ReasonOperationStale},
		{"connection revision", func(in *EvaluationInput) { in.Resources[0].ConnectionRevision++ }, ReasonOperationStale},
		{"resource ceiling", func(in *EvaluationInput) { in.Policy.ResourceIDs = nil }, ReasonTargetOutsideBoundary},
		{"boundary", func(in *EvaluationInput) {
			in.Boundaries = []ExecutionBoundary{{ID: "b", Revision: 1}}
			in.Operation.BoundaryRevisions = []RevisionRef{{ID: "b", Revision: 1}}
		}, ReasonTargetOutsideBoundary},
		{"role", func(in *EvaluationInput) { in.RoleCapabilities = []string{} }, ReasonCapabilityDenied},
		{"deny beats allow", func(in *EvaluationInput) {
			in.Policy.Rules = append(in.Policy.Rules, Rule{Capability: "file.read", Effect: EffectDeny})
		}, ReasonCapabilityDenied},
		{"unknown tool", func(in *EvaluationInput) { in.Operation.Tool = "new_unregistered_tool" }, ReasonUnregisteredTool},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := kernelFixture()
			fixtureGrant(&in)
			fixtureApproval(&in)
			tc.change(&in)
			got := Evaluate(in)
			if got.Effect != EffectDeny || got.ReasonCode != tc.reason {
				t.Fatalf("got %+v, want %s", got, tc.reason)
			}
		})
	}
}

func TestKernelAuthorityFormulaAndGrantRevocation(t *testing.T) {
	in := kernelFixture()
	if got := Evaluate(in); got.Effect != EffectAllow || got.Authorities[0].Kind != "project" {
		t.Fatalf("project allow needs no grant: %+v", got)
	}
	fixtureGrant(&in)
	if got := Evaluate(in); got.Effect != EffectAllow || got.Authorities[0].Kind != "task_grant" {
		t.Fatalf("grant: %+v", got)
	}
	in.Grants[0].Revoked = true
	if got := Evaluate(in); got.Effect != EffectApprovalRequired {
		t.Fatalf("revoked: %+v", got)
	}
	fixtureApproval(&in)
	if got := Evaluate(in); got.Effect != EffectAllow || got.Authorities[0].Kind != "single_approval" {
		t.Fatalf("single: %+v", got)
	}
	in.Policy.Rules[0].Confirmation = ConfirmTask
	if got := Evaluate(in); got.Effect != EffectApprovalRequired {
		t.Fatalf("single cannot override task-only: %+v", got)
	}
	in.Policy.Rules[0].Confirmation = ConfirmEither
	in.Approvals[0].Consumed = true
	if got := Evaluate(in); got.Effect != EffectApprovalRequired {
		t.Fatalf("consumed: %+v", got)
	}
	in.Approvals[0].Consumed = false
	in.Operation.ArgumentsDigest = ContentDigest([]byte("changed"))
	if got := Evaluate(in); got.Effect != EffectApprovalRequired {
		t.Fatalf("changed args: %+v", got)
	}
}

func TestKernelPauseKeepsGrantButInvalidatesPreparedApproval(t *testing.T) {
	in := kernelFixture()
	fixtureGrant(&in)
	fixtureApproval(&in)
	paused, err := in.Task.Transition(TaskPaused, 1, in.Now, "")
	if err != nil {
		t.Fatal(err)
	}
	active, err := paused.Transition(TaskActive, paused.StateRevision, in.Now, "")
	if err != nil {
		t.Fatal(err)
	}
	in.Task = active
	if got := Evaluate(in); got.ReasonCode != ReasonOperationStale {
		t.Fatalf("old prepared %+v", got)
	}
	in.Operation.ExecutionRevision = active.ExecutionRevision
	if got := Evaluate(in); got.Effect != EffectAllow || got.Authorities[0].Kind != "task_grant" {
		t.Fatalf("new prepared may use original TTL grant: %+v", got)
	}
	in.Grants = nil
	if got := Evaluate(in); got.Effect != EffectApprovalRequired {
		t.Fatalf("old approval: %+v", got)
	}
}

func TestKernelWaitingStateDoesNotChangeDigest(t *testing.T) {
	in := kernelFixture()
	fixtureGrant(&in)
	in.Grants = nil
	fixtureApproval(&in)
	waiting, err := in.Task.Transition(TaskWaiting, 1, in.Now, "")
	if err != nil {
		t.Fatal(err)
	}
	in.Task, err = waiting.Transition(TaskActive, waiting.StateRevision, in.Now, "")
	if err != nil {
		t.Fatal(err)
	}
	if got := Evaluate(in); got.Effect != EffectAllow || got.Authorities[0].Kind != "single_approval" {
		t.Fatalf("normal waiting invalidated approval: %+v", got)
	}
}

func TestKernelChildProjectAllowAndCurrentParent(t *testing.T) {
	in := kernelFixture()
	in.Operation.Actor, in.Operation.ChildScopeID = "child", "child1"
	in.ChildScopeCurrent = true
	in.Task.ParentTaskID = "parent1"
	parent := in.Task
	parent.ID, parent.ParentTaskID = "parent1", ""
	in.Parents = []ParentRestriction{{Task: parent, RoleCapabilities: []string{"file.read"}, AuthorityValid: true}}
	in.Operation.Parents = FreezeParentBindings(in.Parents)
	if got := Evaluate(in); got.Effect != EffectAllow {
		t.Fatalf("allow child without grant: %+v", got)
	}
	in.Policy.Rules[0] = Rule{Capability: "file.read", Effect: EffectAsk, Grantable: true, Confirmation: ConfirmEither, Limits: ScopeLimits{FileRoots: []string{"/var/log"}}}
	if got := Evaluate(in); got.Effect != EffectApprovalRequired {
		t.Fatalf("ask child needs authority: %+v", got)
	}
	in.Policy.Rules[0].Effect = EffectAllow
	in.Parents[0].AuthorityValid = false
	if got := Evaluate(in); got.Effect != EffectDeny {
		t.Fatalf("revoked parent: %+v", got)
	}
	in.Parents[0].AuthorityValid = true
	in.Parents[0].Task.ExecutionRevision++
	if got := Evaluate(in); got.ReasonCode != ReasonOperationStale {
		t.Fatalf("parent pause/resume did not fence old child call: %+v", got)
	}
}

func TestKernelEnvelopeDoesNotBypassHardDeny(t *testing.T) {
	in := kernelFixture()
	in.Envelope = &TaskEnvelope{Revision: 1, ResourceIDs: []string{"r2"}, Capabilities: []string{"file.read"}}
	in.Operation.EnvelopeRevision = 1
	if got := Evaluate(in); got.ReasonCode != ReasonTaskScopeExtensionRequired {
		t.Fatalf("scope %+v", got)
	}
	fixtureApproval(&in)
	in.Approvals[0].EnvelopeException = true
	if got := Evaluate(in); got.Effect != EffectAllow {
		t.Fatalf("exact exception %+v", got)
	}
	in.Policy.Rules[0].Effect = EffectDeny
	if got := Evaluate(in); got.Effect != EffectDeny {
		t.Fatalf("hard deny %+v", got)
	}
	in.Policy.Rules[0].Effect = EffectAllow
	in.Envelope.Revision++
	if got := Evaluate(in); got.ReasonCode != ReasonOperationStale {
		t.Fatalf("stale envelope %+v", got)
	}
}

func TestKernelOpaqueOnlyCompatibleSingle(t *testing.T) {
	in := kernelFixture()
	in.Operation.Tool, in.Operation.Proof, in.Operation.Capabilities = "shell", ProofOpaque, []string{"terminal.execute"}
	in.Policy.Rules = []Rule{{Capability: "terminal.execute", Effect: EffectAllow}}
	if got := Evaluate(in); got.ReasonCode != ReasonUnverifiableEffect {
		t.Fatalf("restricted %+v", got)
	}
	in.Policy.Mode = "compatible"
	if got := Evaluate(in); got.Effect != EffectApprovalRequired {
		t.Fatalf("compatible allow still needs single %+v", got)
	}
	fixtureApproval(&in)
	if got := Evaluate(in); got.Effect != EffectAllow {
		t.Fatalf("compatible single %+v", got)
	}
	in.Policy.Rules[0] = Rule{Capability: "terminal.execute", Effect: EffectAsk, Grantable: true, Confirmation: ConfirmTask}
	if got := Evaluate(in); got.Effect != EffectDeny {
		t.Fatalf("must not widen task-only to single %+v", got)
	}
}

func TestKernelMultiCapabilityAllRequired(t *testing.T) {
	in := kernelFixture()
	in.Operation.Capabilities = append(in.Operation.Capabilities, "local.execute")
	if got := Evaluate(in); got.Effect != EffectDeny {
		t.Fatalf("missing second rule %+v", got)
	}
	in.Policy.Rules = append(in.Policy.Rules, Rule{Capability: "local.execute", Effect: EffectAllow})
	if got := Evaluate(in); got.Effect != EffectAllow {
		t.Fatalf("all allowed %+v", got)
	}
}

func TestKernelCanonicalSetsAndVersionBinding(t *testing.T) {
	in := kernelFixture()
	o := in.Operation
	o.Capabilities = []string{"file.read", "local.execute"}
	o.GrantRevisions = []RevisionRef{{ID: "z", Revision: 1}, {ID: "a", Revision: 1}}
	digest, err := OperationDigest(o)
	if err != nil {
		t.Fatal(err)
	}
	slices.Reverse(o.Capabilities)
	slices.Reverse(o.GrantRevisions)
	got, err := OperationDigest(o)
	if err != nil || got != digest {
		t.Fatalf("set order changed digest %s %v", got, err)
	}
	before := slices.Clone(o.Capabilities)
	_, _ = CanonicalOperation(o)
	if !slices.Equal(before, o.Capabilities) {
		t.Fatal("mutated original slice")
	}
	for _, change := range []func(*PreparedOperation){func(o *PreparedOperation) { o.ExecutionRevision++ }, func(o *PreparedOperation) { o.Resources[0].ConnectionRevision++ }, func(o *PreparedOperation) { o.RootTurnID = "next" }, func(o *PreparedOperation) { o.OwnerGeneration++ }, func(o *PreparedOperation) { o.EnvelopeRevision++ }} {
		copy := o
		copy.Resources = slices.Clone(o.Resources)
		change(&copy)
		next, err := OperationDigest(copy)
		if err != nil || next == digest {
			t.Fatalf("safety change not bound: %v", err)
		}
	}
}

func TestKernelRegistryCoversInventory(t *testing.T) {
	raw, err := os.ReadFile("../../docs/security/tool-entrypoints.json")
	if err != nil {
		t.Fatal(err)
	}
	var inventory struct {
		Tools []struct {
			Name string `json:"name"`
		}
	}
	if err = json.Unmarshal(raw, &inventory); err != nil {
		t.Fatal(err)
	}
	for _, entry := range inventory.Tools {
		spec, ok := LookupTool(entry.Name)
		if !ok || len(spec.Capabilities) == 0 {
			t.Errorf("unregistered %s", entry.Name)
		}
	}
	if len(RegisteredTools()) != len(inventory.Tools) {
		t.Fatalf("catalog size differs: %d/%d", len(RegisteredTools()), len(inventory.Tools))
	}
	if _, ok := LookupTool("new_tool"); ok {
		t.Fatal("unknown tool registered")
	}
}

func performanceFixture() EvaluationInput {
	in := kernelFixture()
	in.Policy.Rules = nil
	for i := 0; i < 20; i++ {
		in.Policy.Rules = append(in.Policy.Rules, Rule{Capability: "file.read", ResourceIDs: []string{fmt.Sprintf("r%d", i+1)}, Effect: EffectAsk, Grantable: true, Confirmation: ConfirmEither, Limits: ScopeLimits{FileRoots: []string{"/var/log"}}})
	}
	in.Policy.ResourceIDs = nil
	for i := 1; i <= 100; i++ {
		in.Policy.ResourceIDs = append(in.Policy.ResourceIDs, fmt.Sprintf("r%d", i))
	}
	for i := 0; i < 20; i++ {
		id := fmt.Sprintf("grant%d", i)
		in.Grants = append(in.Grants, TaskGrant{ID: id, StoreID: in.StoreID, RecoveryEpoch: in.RecoveryEpoch, ProjectID: in.Task.ProjectID, SessionID: in.Task.SessionID, GoalID: in.Task.GoalID, TaskID: in.Task.ID, Revision: 1, Resources: slices.Clone(in.Resources), Capabilities: []string{"file.read"}, CreatedAt: in.Now, ExpiresAt: in.Now.Add(30 * time.Minute), RemainingUses: 50, Limits: ScopeLimits{FileRoots: []string{"/var/log"}}})
		in.Operation.GrantRevisions = append(in.Operation.GrantRevisions, RevisionRef{ID: id, Revision: 1})
	}
	return in
}

func TestKernelEvaluateConcurrentP95(t *testing.T) {
	in := performanceFixture()
	var wg sync.WaitGroup
	durations := make([]time.Duration, 8*256)
	for worker := 0; worker < 8; worker++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for i := 0; i < 256; i++ {
				start := time.Now()
				got := Evaluate(in)
				durations[worker*256+i] = time.Since(start)
				if got.Effect != EffectAllow {
					t.Errorf("unexpected %+v", got)
					return
				}
			}
		}(worker)
	}
	wg.Wait()
	sort.Slice(durations, func(i, j int) bool { return durations[i] < durations[j] })
	p95 := durations[len(durations)*95/100]
	t.Logf("Evaluate fixture: 100 resources, 20 rules, 20 grants, concurrency 8; p95=%s", p95)
	// Race instrumentation and overloaded hosts can exceed the product target;
	// report rather than assert a timing-dependent security test. Acceptance uses
	// the benchmark without -race and records the actual result.
}

func BenchmarkKernelEvaluate(b *testing.B) {
	in := performanceFixture()
	b.ReportAllocs()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			if Evaluate(in).Effect != EffectAllow {
				b.Fatal("denied")
			}
		}
	})
}

func TestKernelTypedScopeLimits(t *testing.T) {
	t.Run("path components", func(t *testing.T) {
		limits := ScopeLimits{FileRoots: []string{"/var/log"}}
		if !withinLimits(OperationScope{FilePath: "/var/log/app.log"}, limits, "file.read") {
			t.Fatal("valid path denied")
		}
		for _, path := range []string{"/var/log-other/app.log", "/var/log/../secret", "relative"} {
			if withinLimits(OperationScope{FilePath: path}, limits, "file.read") {
				t.Fatalf("unsafe path %s", path)
			}
		}
		if LimitsSubset(ScopeLimits{FileRoots: []string{"/var"}}, limits, "file.read") {
			t.Fatal("wider root grant")
		}
	})
	t.Run("database budgets", func(t *testing.T) {
		limits := ScopeLimits{DatabaseID: "db1", Schemas: []string{"public"}, MaxRows: 1000, MaxDurationMS: 30000}
		scope := OperationScope{DatabaseID: "db1", Schema: "public", MaxRows: 1000, MaxDurationMS: 30000}
		if !withinLimits(scope, limits, "db.read") {
			t.Fatal("valid database denied")
		}
		scope.MaxRows++
		if withinLimits(scope, limits, "db.read") {
			t.Fatal("row budget exceeded")
		}
		scope.MaxRows = 10
		scope.Schema = "private"
		if withinLimits(scope, limits, "db.read") {
			t.Fatal("wrong schema")
		}
	})
	t.Run("cluster logs", func(t *testing.T) {
		limits := ScopeLimits{ClusterID: "k1", Namespaces: []string{"n1"}, ResourceKinds: []string{"pods"}, Verbs: []string{"get"}, MaxLogLines: 500, MaxLogSeconds: 900}
		scope := OperationScope{ClusterID: "k1", Namespace: "n1", ResourceKind: "pods", Verb: "get", LogLines: 500, LogSeconds: 900}
		if !withinLimits(scope, limits, "cluster.logs") {
			t.Fatal("valid logs denied")
		}
		scope.LogSeconds = 901
		if withinLimits(scope, limits, "cluster.logs") {
			t.Fatal("unbounded time")
		}
		scope.LogSeconds = 0
		if withinLimits(scope, limits, "cluster.logs") {
			t.Fatal("missing window")
		}
	})
	t.Run("every DNS address", func(t *testing.T) {
		limits := ScopeLimits{NetworkTargets: []NetworkLimit{{Scheme: "https", Host: "example.test", Port: 443, AddressCIDRs: []string{"192.0.2.0/24"}}}}
		scope := OperationScope{NetworkScheme: "https", NetworkHost: "example.test", NetworkPort: 443, ResolvedAddresses: []string{"192.0.2.1"}}
		if !withinLimits(scope, limits, "network.fetch") {
			t.Fatal("valid network denied")
		}
		scope.ResolvedAddresses = append(scope.ResolvedAddresses, "127.0.0.1")
		if withinLimits(scope, limits, "network.fetch") {
			t.Fatal("partial DNS match accepted")
		}
		if LimitsSubset(ScopeLimits{NetworkTargets: []NetworkLimit{{Scheme: "https", Host: "example.test", Port: 443, AddressCIDRs: []string{"0.0.0.0/0"}}}}, limits, "network.fetch") {
			t.Fatal("CIDR expansion")
		}
	})
}

func TestKernelEquallySpecificRulesIntersectLimits(t *testing.T) {
	in := kernelFixture()
	in.Policy.Rules = append(in.Policy.Rules, Rule{Capability: "file.read", Effect: EffectAllow, Limits: ScopeLimits{FileRoots: []string{"/var/log/private"}}})
	if got := Evaluate(in); got.Effect != EffectDeny {
		t.Fatalf("permissive equal-priority rule won: %+v", got)
	}
	slices.Reverse(in.Policy.Rules)
	if got := Evaluate(in); got.Effect != EffectDeny {
		t.Fatalf("rule ordering changed limit: %+v", got)
	}
}

func TestKernelScopePathsFollowResourcePlatform(t *testing.T) {
	limits := ScopeLimits{FileRoots: []string{`C:\logs`}}
	if !withinLimits(OperationScope{FilePath: `c:\logs\app.log`}, limits, "file.read") {
		t.Fatal("drive path denied")
	}
	for _, file := range []string{`C:\logs-other\app.log`, `C:\logs\..\secret`, `D:\logs\app.log`, `\\server\share\app.log`, `/logs/..\secret`} {
		if withinLimits(OperationScope{FilePath: file}, limits, "file.read") {
			t.Fatalf("unconfined drive path %q", file)
		}
	}
}

func TestKernelIORevisionsAreRevalidated(t *testing.T) {
	in := kernelFixture()
	in.Operation.Credentials = []CredentialRevision{{Reference: "secret-ref", Revision: 1}}
	in.CredentialRevisions = []CredentialRevision{{Reference: "secret-ref", Revision: 1}}
	if got := Evaluate(in); got.Effect != EffectAllow {
		t.Fatal(got)
	}
	in.CredentialRevisions[0].Revision++
	if got := Evaluate(in); got.ReasonCode != ReasonOperationStale {
		t.Fatal("credential revision not checked", got)
	}
	in.CredentialRevisions[0].Revision--
	in.Operation.TerminalGeneration = "generation1"
	in.Operation.TerminalContextRevision = 1
	in.TerminalGeneration = "generation1"
	in.TerminalContextRevision = 1
	if got := Evaluate(in); got.Effect != EffectAllow {
		t.Fatal(got)
	}
	in.TerminalGeneration = "generation2"
	if got := Evaluate(in); got.ReasonCode != ReasonOperationStale {
		t.Fatal("terminal generation not checked", got)
	}
}

func TestKernelFileWritesNeedHashAndExactSingleApproval(t *testing.T) {
	in := kernelFixture()
	in.Operation.Tool = "write"
	in.Operation.Capabilities = []string{"file.write"}
	in.Policy.Rules = []Rule{{Capability: "file.write", Effect: EffectAsk, Grantable: true, Confirmation: ConfirmEither, Limits: ScopeLimits{FileRoots: []string{"/var/log"}}}}
	if got := Evaluate(in); got.Effect != EffectDeny {
		t.Fatal("missing content version accepted", got)
	}
	in.Operation.Scope.ExpectedContentHash = ContentDigest([]byte("old content"))
	if got := Evaluate(in); got.Effect != EffectApprovalRequired {
		t.Fatal(got)
	}
	fixtureApproval(&in)
	if got := Evaluate(in); got.Effect != EffectAllow || got.Authorities[0].Kind != "single_approval" {
		t.Fatal(got)
	}
	in.Operation.Scope.FilePath = "/etc/config"
	in.Operation.Proof = ProofOpaque
	in.Policy.Mode = "compatible"
	fixtureApproval(&in)
	if got := Evaluate(in); got.Effect != EffectDeny {
		t.Fatal("opaque single bypassed project path ceiling", got)
	}
}

func TestKernelSharedTaskChildScopeUsesLiveCeilingAndExplicitGrant(t *testing.T) {
	in := kernelFixture()
	in.Operation.Actor = "child"
	in.Operation.ChildScopeID = "child-1"
	in.ChildScopeCurrent = true
	parent := ParentRestriction{SharedTaskScope: true, ScopeID: "child-1", OwnerBindingID: "root-binding", OwnerGeneration: 1, Task: in.Task, AuthorityValid: true, AuthorityID: "project:p1", AuthorityRevision: 1, RoleCapabilities: []string{"file.read"}, Boundary: &ExecutionBoundary{ID: "scope:child-1", Revision: 1, ResourceIDs: []string{"r1"}}}
	in.Parents = []ParentRestriction{parent}
	in.Operation.Parents = FreezeParentBindings(in.Parents)
	if got := Evaluate(in); got.Effect != EffectAllow {
		t.Fatalf("project allow child: %+v", got)
	}
	fixtureGrant(&in)
	if got := Evaluate(in); got.Effect == EffectAllow {
		t.Fatalf("ambient task grant inherited: %+v", got)
	}
	in.Grants[0].AllowedChildScopes = []string{"child-1"}
	if got := Evaluate(in); got.Effect != EffectAllow {
		t.Fatalf("explicit delegation: %+v", got)
	}
	in.Parents[0].OwnerGeneration++
	if got := Evaluate(in); got.Effect != EffectDeny || got.ReasonCode != ReasonOperationStale {
		t.Fatalf("stale parent generation: %+v", got)
	}
	in.Operation.Parents = FreezeParentBindings(in.Parents)
	in.Parents[0].Boundary.ResourceIDs = []string{}
	if got := Evaluate(in); got.Effect != EffectDeny {
		t.Fatalf("empty child resource ceiling: %+v", got)
	}
}

func TestKernelProjectAllowRespectsIndependentTaskBudget(t *testing.T) {
	in := kernelFixture()
	fixtureGrant(&in)
	in.Policy.Rules[0].Effect = EffectAllow
	in.Envelope = &TaskEnvelope{Revision: 1, BudgetGrantIDs: []string{"grant1"}, ResourceIDs: []string{"r1"}, Resources: in.Resources, Capabilities: []string{"file.read"}, Limits: ScopeLimits{FileRoots: []string{"/var/log"}}}
	in.Operation.EnvelopeRevision = 1
	got := Evaluate(in)
	if got.Effect != EffectAllow {
		t.Fatal(got)
	}
	budget := false
	for _, source := range got.Authorities {
		if source.Kind == "task_budget" && source.ID == "grant1" {
			budget = true
		}
	}
	if !budget {
		t.Fatal("project allow omitted explicit budget")
	}
	in.Grants[0].RemainingUses = 0
	if got = Evaluate(in); got.Effect == EffectAllow {
		t.Fatal("exhausted budget accepted")
	}
	in.Envelope.BudgetGrantIDs = []string{"unrelated"}
	in.Grants[0].RemainingUses = 50
	if got = Evaluate(in); got.Effect == EffectAllow {
		t.Fatal("unbound candidate grant refilled budget")
	}
}

func TestKernelPureTaskControlsDoNotSpendResourceBudgetOrExpandScope(t *testing.T) {
	in := kernelFixture()
	fixtureGrant(&in)
	in.Envelope = &TaskEnvelope{Revision: 1, BudgetGrantIDs: []string{"grant1"}, ResourceIDs: []string{"r1"}, Resources: in.Resources, Capabilities: []string{"file.read"}}
	in.Operation.EnvelopeRevision = 1
	in.Operation.Tool = "todo_read"
	in.Operation.TargetKind = TargetSession
	in.Operation.Resources = nil
	in.Resources = nil
	in.Operation.Capabilities = []string{"task.read"}
	in.Policy.Rules = append(in.Policy.Rules, Rule{Capability: "task.read", Effect: EffectAllow})
	in.Grants[0].RemainingUses = 0
	got := Evaluate(in)
	if got.Effect != EffectAllow {
		t.Fatalf("local control blocked by unrelated resource budget %+v", got)
	}
	for _, source := range got.Authorities {
		if source.Kind == "task_budget" {
			t.Fatal("local control spent resource budget")
		}
	}
	in.Policy.Rules = append(in.Policy.Rules, Rule{Capability: "task.read", Effect: EffectDeny})
	if got = Evaluate(in); got.Effect != EffectDeny {
		t.Fatal("envelope exemption bypassed hard project deny")
	}
	in.Policy.Rules = in.Policy.Rules[:len(in.Policy.Rules)-1]
	in.Operation.Tool = "list_mcp_servers"
	in.Operation.Capabilities = []string{"mcp.discover"}
	in.Policy.Rules = append(in.Policy.Rules, Rule{Capability: "mcp.discover", Effect: EffectAllow})
	if got = Evaluate(in); got.Effect == EffectAllow {
		t.Fatal("MCP discovery bypassed resource envelope")
	}
}

func TestKernelCommandRegistryAndLegacyRevisionsAreAuthorityBindings(t *testing.T) {
	for _, source := range []string{"command", "legacy"} {
		in := kernelFixture()
		if source == "command" {
			in.Operation.CommandTargetRevision = 1
			in.CommandTargetRevision = 2
		} else {
			in.Operation.LegacyPolicyRevision = 1
			in.LegacyPolicyRevision = 2
		}
		if got := Evaluate(in); got.Effect != EffectDeny || got.ReasonCode != ReasonOperationStale {
			t.Fatalf("changed %s source accepted %+v", source, got)
		}
	}
}

func TestKernelServiceRegistryRemapCannotReuseConfirmedGrantOrEnvelope(t *testing.T) {
	in := kernelFixture()
	fixtureGrant(&in)
	compiled, err := CompileCommand(CommandRequest{ProfileID: "service_restart", Version: 1, OS: "linux", ResourceID: "r1", Arguments: CommandArguments{ServiceID: "web"}, Services: []ServiceDefinition{{ID: "web", ResourceID: "r1", Unit: "nginx.service"}}})
	if err != nil {
		t.Fatal(err)
	}
	profile := compiled.Profile()
	caps := []string{"terminal.execute", "service.restart"}
	in.Operation.Tool = "shell"
	in.Operation.Proof = ProofCommandProfile
	in.Operation.Capabilities = caps
	in.Operation.CommandProfileID, in.Operation.CommandProfileVersion, in.Operation.CommandArgumentsDigest = profile.ID, profile.Version, profile.ArgumentsDigest
	in.Operation.ServiceID = "web"
	in.Operation.CommandTargetRevision = 1
	in.CommandTargetRevision = 1
	in.Policy.Rules = []Rule{{Capability: "terminal.execute", Effect: EffectAsk, Grantable: true, Confirmation: ConfirmTask}, {Capability: "service.restart", Effect: EffectAsk, Grantable: true, Confirmation: ConfirmTask}}
	in.Grants[0].Capabilities = caps
	in.Grants[0].CommandProfiles = []CommandProfileScope{profile}
	in.Grants[0].ServiceIDs = []string{"web"}
	in.Grants[0].CommandTargetRevisions = []RevisionRef{{ID: "r1", Revision: 1}}
	in.Grants[0].Limits = ScopeLimits{}
	in.Envelope = &TaskEnvelope{Revision: 1, BudgetGrantIDs: []string{"grant1"}, Resources: in.Resources, ResourceIDs: []string{"r1"}, Capabilities: caps, CommandProfiles: []CommandProfileScope{profile}, ServiceIDs: []string{"web"}, CommandTargetRevisions: []RevisionRef{{ID: "r1", Revision: 1}}}
	in.Operation.EnvelopeRevision = 1
	if got := Evaluate(in); got.Effect != EffectAllow {
		t.Fatal(got)
	}
	// Re-preparing the same service ID under a newly registered unit is a new
	// authority scope even though command arguments and asset connection match.
	in.Operation.CommandTargetRevision = 2
	in.CommandTargetRevision = 2
	if got := Evaluate(in); got.Effect == EffectAllow {
		t.Fatal("new unit reused original service ID grant", got)
	}
	in.Envelope = nil
	in.Operation.EnvelopeRevision = 0
	if got := Evaluate(in); got.Effect == EffectAllow {
		t.Fatal("new unit reused old scoped grant without envelope", got)
	}
}

func TestKernelMandatoryExactSingleSurvivesProjectAllow(t *testing.T) {
	in := kernelFixture()
	in.Operation.RequireSingleConfirmation = true
	if got := Evaluate(in); got.Effect != EffectApprovalRequired {
		t.Fatal("mandatory single bypassed", got)
	}
	fixtureApproval(&in)
	got := Evaluate(in)
	if got.Effect != EffectAllow {
		t.Fatal(got)
	}
	found := false
	for _, source := range got.Authorities {
		if source.Kind == "single_approval" {
			found = true
		}
	}
	if !found {
		t.Fatal("mandatory exact approval was not consumed")
	}
	in.Operation.ArgumentsDigest = ContentDigest([]byte("different target"))
	if got = Evaluate(in); got.Effect != EffectApprovalRequired {
		t.Fatal("changed arguments reused catastrophic confirmation", got)
	}
}
