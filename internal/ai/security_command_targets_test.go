package ai

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/security"
)

func TestSecurityCommandTargetRegistryBindsConnectionAndExactService(t *testing.T) {
	e, c := fixedReadManagedFixture(t, Asset{ID: "resource", Kind: "ssh", Settings: map[string]any{}}, security.Rule{Capability: "terminal.execute", Effect: security.EffectAllow})
	ctx := context.Background()
	if _, err := e.SecurityCommandTarget(ctx, "project", "resource"); err == nil {
		t.Fatal("unregistered SSH OS assumed")
	}
	action := SecurityCommandTargetAction{SecurityPolicyAction: SecurityPolicyAction{ActorID: "user", ActionID: "register", ProjectID: "project"}, ResourceID: "resource", OS: "linux", Enabled: true, Services: []security.ServiceDefinition{{ID: "web", ResourceID: "resource", Unit: "nginx.service"}}}
	registered, err := e.PutSecurityCommandTarget(ctx, action)
	if err != nil || registered.Revision != 1 || !registered.Configured {
		t.Fatal(registered, err)
	}
	repeated, err := e.PutSecurityCommandTarget(ctx, action)
	if err != nil || repeated.Revision != 1 {
		t.Fatal(repeated, err)
	}
	action.ActionID = "stale"
	if _, err = e.PutSecurityCommandTarget(ctx, action); !errors.Is(err, security.ErrConflict) {
		t.Fatal("stale config accepted", err)
	}
	spoof := map[string]any{"asset_ref": assetAlias("resource"), "runtime": "local", "command": "df -h"}
	if _, _, err = e.PrepareCatalogOperation(ctx, "case", c, Call{ID: "local-spoof", Name: "shell", Arguments: js(spoof)}, spoof); err == nil || !strings.Contains(err.Error(), "runtime does not match") {
		t.Fatal("SSH target borrowed local execution", err)
	}
	as := c.Assets[0]
	op := security.PreparedOperation{Tool: "shell", ProjectID: "project", Resources: []security.ResourceRevision{{ID: as.ID}}, Capabilities: []string{"terminal.execute"}}
	command, err := e.compileSecurityCommandProfile(ctx, c, &op, map[string]any{"profile_arguments": map[string]any{"serviceId": "web"}}, as, "service_restart")
	if err != nil || op.CommandTargetRevision != 1 || op.ServiceID != "web" || !slices.Equal(command.Arguments(), []string{"restart", "--", "nginx.service"}) {
		t.Fatal(command, op, err)
	}
	if _, err = e.compileSecurityCommandProfile(ctx, c, &op, map[string]any{"profile_arguments": map[string]any{"serviceId": "nginx.service; touch /tmp/outside"}}, as, "service_restart"); err == nil {
		t.Fatal("model supplied unit accepted")
	}
	action.ActionID = "bad-unit"
	action.ExpectedRevision = 1
	action.Services[0].Unit = "nginx.service; touch /tmp/outside"
	if _, err = e.PutSecurityCommandTarget(ctx, action); err == nil {
		t.Fatal("unbounded trusted unit accepted")
	}
	db, _, _, err := e.securityTaskDB()
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Model(&securityResourceRevisionRow{}).Where("resource_id = ?", as.ID).Update("connection_revision", 2).Error; err != nil {
		t.Fatal(err)
	}
	if _, err = e.SecurityCommandTarget(ctx, "project", as.ID); !errors.Is(err, security.ErrConflict) {
		t.Fatal("repointed endpoint inherited old OS/services", err)
	}
}
