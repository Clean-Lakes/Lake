package security

import (
	"slices"
	"testing"
)

func TestKernelCommandProfilesRejectShellAndUntrustedServices(t *testing.T) {
	base := CommandRequest{ProfileID: "service_restart", Version: 1, OS: "linux", ResourceID: "r1", Arguments: CommandArguments{ServiceID: "nginx"}, Services: []ServiceDefinition{{ID: "nginx", ResourceID: "r1", Unit: "nginx.service"}}}
	cmd, err := CompileCommand(base)
	if err != nil {
		t.Fatal(err)
	}
	if cmd.Executable() != "/usr/bin/systemctl" || !slices.Equal(cmd.Arguments(), []string{"restart", "--", "nginx.service"}) || cmd.Capability() != "service.restart" {
		t.Fatalf("bad frozen command %+v", cmd)
	}
	args := cmd.Arguments()
	args[0] = "malicious"
	if cmd.Arguments()[0] != "restart" {
		t.Fatal("mutable frozen argv")
	}
	for _, change := range []func(*CommandRequest){func(r *CommandRequest) { r.ProfileID = "bash -c" }, func(r *CommandRequest) { r.Version = 2 }, func(r *CommandRequest) { r.Arguments.ServiceID = "nginx; id" }, func(r *CommandRequest) { r.ResourceID = "r2" }, func(r *CommandRequest) {
		r.Services = []ServiceDefinition{{ID: "nginx", ResourceID: "r1", Unit: "--root=/tmp.service"}}
	}, func(r *CommandRequest) { r.OS = "darwin" }} {
		copy := base
		change(&copy)
		if _, err := CompileCommand(copy); err == nil {
			t.Fatalf("unsafe request accepted %+v", copy)
		}
	}
	if TaskGrantable("file.write", ProofStructured) || TaskGrantable("terminal.input", ProofStructured) || TaskGrantable("mcp.call", ProofOpaque) || TaskGrantable("terminal.execute", ProofOpaque) {
		t.Fatal("opaque/writes accepted as task grant")
	}
}

func TestKernelCommandProfilesBoundLogsAndStableDigest(t *testing.T) {
	in := CommandRequest{ProfileID: "service_logs", Version: 1, OS: "linux", ResourceID: "r1", Arguments: CommandArguments{ServiceID: "nginx", LogMinutes: 15, LogLines: 500}, Services: []ServiceDefinition{{ID: "nginx", ResourceID: "r1", Unit: "nginx.service"}}}
	one, err := CompileCommand(in)
	if err != nil {
		t.Fatal(err)
	}
	two, err := CompileCommand(in)
	if err != nil || one.Profile() != two.Profile() {
		t.Fatal("unstable profile")
	}
	in.Arguments.LogLines = 501
	if _, err = CompileCommand(in); err == nil {
		t.Fatal("unbounded logs")
	}
	in.Arguments.LogLines = 10
	in.Arguments.LogMinutes = 0
	if _, err = CompileCommand(in); err == nil {
		t.Fatal("unbounded time")
	}
}
