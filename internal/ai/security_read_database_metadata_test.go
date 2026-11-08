package ai

import (
	"strings"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/security"
)

func TestSecurityDatabaseMetadataReadsPreserveLegacyWriteBlock(t *testing.T) {
	for _, tool := range []string{"list_db_objects", "db_table_ddl"} {
		t.Run(tool, func(t *testing.T) {
			column, value := "name", "sample"
			if tool == "db_table_ddl" {
				column, value = "ddl", "CREATE TABLE public.sample (id integer);"
			}
			as, transcript := fixedPostgresReadServer(t, column, value)
			limits := security.ScopeLimits{DatabaseID: "fixture", Schemas: []string{"public"}, MaxRows: 1000, MaxDurationMS: 5000}
			e, c := fixedReadManagedFixture(t, as, security.Rule{Capability: "db.read", Effect: security.EffectAllow, Limits: limits})
			store, _ := e.adkStore()
			prior := nativeOperation{ID: "legacy-risk", SessionID: "old", Tool: "open_ssh_terminal", Risk: "dangerous", Status: "unknown", Handle: "original-handle"}
			if err := store.DB.Create(&prior).Error; err != nil {
				t.Fatal(err)
			}
			a := map[string]any{"asset_ref": assetAlias(as.ID), "schema": "public", "table": "sample"}
			if tool == "list_db_objects" {
				delete(a, "table")
				a["query_type"] = "table"
			}
			result, err := runFixedReadPermit(t, e, c, Call{ID: "metadata", Name: tool, Arguments: js(a)})
			if err != nil || !strings.Contains(js(result), value) || obj(result)["truncated"] != false {
				t.Fatal(result, err)
			}
			queries := strings.Join(transcript(), "\n")
			for _, required := range []string{"begin read only", "set local search_path = pg_catalog", "set local statement_timeout = 5000", "rollback"} {
				if !strings.Contains(queries, required) {
					t.Fatal("missing wire constraint", required, queries)
				}
			}
			if strings.Contains(queries, "commit") || strings.Contains(queries, "'public'") || strings.Contains(queries, "'sample'") {
				t.Fatal("metadata was not read-only and parameterized", queries)
			}
			var current nativeOperation
			if err = store.DB.First(&current, "id = ?", prior.ID).Error; err != nil || current.Status != "unknown" || current.Handle != prior.Handle || current.RiskResolvedAt != nil {
				t.Fatal("read changed unresolved operation", err)
			}
			if err = CheckResourceWriteBlock(store.DB, as.ID); err != ErrUnresolvedResourceEffect {
				t.Fatal("legacy write block lost", err)
			}
			// Arbitrary SQL does not inherit a metadata profile, even a SELECT.
			a = map[string]any{"asset_ref": assetAlias(as.ID), "schema": "public", "sql": "SELECT 1"}
			if prepared, _, err := e.PrepareCatalogOperation(t.Context(), "case", c, Call{ID: "raw", Name: "execute_sql", Arguments: js(a)}, a); err == nil || prepared != nil {
				t.Fatal("opaque SQL bypassed unknown write protection")
			}
		})
	}
}

func TestSecurityDatabaseMetadataPreparationRejectsOverridesAndKeepsScope(t *testing.T) {
	for _, driver := range []string{"mysql", "postgres"} {
		t.Run(driver, func(t *testing.T) {
			as := Asset{ID: "resource", Kind: "database", Settings: map[string]any{"driver": driver, "database": "fixture"}}
			op := security.PreparedOperation{Tool: "list_db_objects", Proof: security.ProofOpaque, Resources: []security.ResourceRevision{{ID: as.ID}}}
			for _, category := range []string{"database", "schema", "table", "view", "function", "procedure", "object"} {
				a := map[string]any{"schema": "a'`$1;--", "query_type": category}
				p, err := prepareSecurityDatabaseMetadata(&op, a, as)
				if err != nil || p == nil || securityOperationMayMutate(op) || !strings.Contains(p.query, "LIMIT 1000") || strings.Contains(p.query, str(a["schema"])) {
					t.Fatal("metadata compilation", category, p, err)
				}
				if category != "database" && category != "schema" && (op.Scope.Schema != str(a["schema"]) || len(p.parameters) == 0 || p.parameters[0] != a["schema"]) {
					t.Fatal("schema scope or binding lost", category)
				}
			}
			for _, invalid := range []map[string]any{{"sql": "DELETE FROM secrets"}, {"query_type": "table;DROP"}, {"schema": "x", "pattern": "["}, {"schema": "x", "pattern": strings.Repeat(".", 1025)}, {"schema": "x", "host": "other"}, {"query_type": "table"}} {
				if _, err := prepareSecurityDatabaseMetadata(&op, invalid, as); err == nil {
					t.Fatal("invalid input became a metadata read", invalid)
				}
			}
			if driver == "postgres" {
				p, err := prepareSecurityDatabaseMetadata(&op, map[string]any{"db": "other", "schema": "public"}, as)
				if err != nil || p.database != "other" || op.Scope.DatabaseID != "other" {
					t.Fatal("database override escaped scope", err)
				}
			}
		})
	}
}

func TestSecurityDatabaseMetadataStillEnforcesCurrentPolicy(t *testing.T) {
	as := Asset{ID: "resource", Kind: "database", Settings: map[string]any{"driver": "mysql", "host": "127.0.0.1", "database": "fixture"}}
	e, c := fixedReadManagedFixture(t, as, security.Rule{Capability: "db.read", Effect: security.EffectAllow, Limits: security.ScopeLimits{DatabaseID: "fixture", Schemas: []string{"allowed"}, MaxRows: 1000, MaxDurationMS: 5000}})
	for _, a := range []map[string]any{{"schema": "private"}, {"query_type": "database"}} {
		a["asset_ref"] = assetAlias(as.ID)
		p, decision, err := e.PrepareCatalogOperation(t.Context(), "case", c, Call{ID: "outside", Name: "list_db_objects", Arguments: js(a)}, a)
		if err == nil && p != nil && decision.Effect == security.EffectAllow {
			t.Fatal("read profile widened project scope", a)
		}
	}
}
