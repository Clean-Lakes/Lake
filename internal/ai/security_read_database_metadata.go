package ai

import (
	"errors"
	"regexp"
	"slices"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/security"
)

const securityMetadataRows int64 = 1000

func securityMetadataPattern(pattern string) (*regexp.Regexp, error) {
	if len(pattern) > 1024 {
		return nil, errors.New("security: metadata filter exceeds limit")
	}
	p, err := regexp.Compile("(?i)" + pattern)
	if err != nil {
		return nil, errors.New("security: invalid metadata filter")
	}
	return p, nil
}

// Only these host-generated catalog queries qualify as reads. Model SQL never
// enters this adapter. Identifiers are parameters, except SHOW CREATE's quoted
// MySQL identifiers. The original permit freezes the endpoint and arguments;
// the executor uses a new read-only transaction and rolls it back.
func prepareSecurityDatabaseMetadata(op *security.PreparedOperation, a map[string]any, as Asset) (*securityReadProbe, error) {
	if as.Kind != "database" || !slices.Contains([]string{"mysql", "postgres", "postgresql"}, str(as.Settings["driver"])) {
		return nil, nil // Unsupported drivers retain their existing opaque path.
	}
	allowed := []string{"asset_ref", "db", "schema", "query_type", "pattern", "timeout"}
	if op.Tool == "db_table_ddl" {
		allowed = []string{"asset_ref", "db", "schema", "table"}
	}
	if err := fixedProbeArguments(a, allowed...); err != nil {
		return nil, err
	}
	for _, key := range []string{"db", "schema", "table"} {
		if len(str(a[key])) > 1024 || strings.ContainsRune(str(a[key]), 0) {
			return nil, errors.New("security: invalid metadata identifier")
		}
	}
	p := &securityReadProbe{kind: "sql.metadata", metric: "objects", asset: as, driver: str(as.Settings["driver"]), database: str(as.Settings["database"]), pattern: str(a["pattern"])}
	if _, err := securityMetadataPattern(p.pattern); err != nil {
		return nil, err
	}
	postgres := p.driver != "mysql"
	schema := str(a["schema"])
	if postgres {
		if requested := str(a["db"]); requested != "" {
			p.database = requested
		}
		if p.database == "" {
			return nil, errors.New("security: metadata query needs an explicit db or saved database; use the intended database from the resource catalog")
		}
	} else {
		if schema == "" {
			schema = str(a["db"])
		}
		if p.database == "" {
			p.database = "information_schema"
		}
	}
	category := str(a["query_type"])
	if category == "" {
		category = "object"
	}
	if !slices.Contains([]string{"database", "schema", "table", "view", "function", "procedure", "object"}, category) {
		return nil, errors.New("security: unknown metadata category; use database, schema, table, view, function, procedure or object")
	}
	if op.Tool == "db_table_ddl" || category != "database" && category != "schema" {
		if schema == "" {
			return nil, errors.New("security: metadata query needs the intended schema")
		}
	}
	p.scope = security.OperationScope{DatabaseID: p.database, Schema: schema, MaxRows: securityMetadataRows, MaxDurationMS: 5000, ProbeVersion: securityProbeVersion, ProbeID: "sql.metadata.objects"}
	if op.Tool == "db_table_ddl" {
		if str(a["table"]) == "" {
			return nil, errors.New("security: metadata DDL needs the intended table")
		}
		p.metric, p.scope.ProbeID, p.scope.MaxRows = "ddl", "sql.metadata.ddl", 1
		driver := "mysql"
		if postgres {
			driver = "pgx"
		}
		query, parameters, err := tableQuery(driver, op.Tool, map[string]any{"schema": schema, "table": a["table"]})
		if err != nil {
			return nil, err
		}
		p.query, p.parameters = query, parameters
		if postgres {
			// The fresh transaction also pins search_path to pg_catalog, including
			// all built-in functions and operators used by the DDL formatter.
			p.query += " LIMIT 1"
		}
	} else {
		p.query, p.parameters = securityDatabaseMetadataQuery(postgres, category, schema)
		if category == "database" || category == "schema" {
			p.scope.Schema = "information_schema"
			if postgres && category == "database" {
				p.scope.Schema = "pg_catalog"
			}
		}
	}
	op.Scope, op.Proof = p.scope, security.ProofStructured
	return p, nil
}

func securityDatabaseMetadataQuery(postgres bool, category, schema string) (string, []any) {
	if category == "database" && postgres {
		return "SELECT datname AS name,'database' AS type FROM pg_catalog.pg_database WHERE datallowconn ORDER BY datname LIMIT 1000", nil
	}
	if category == "database" || category == "schema" {
		return "SELECT schema_name AS name,'schema' AS type FROM information_schema.schemata ORDER BY schema_name LIMIT 1000", nil
	}
	placeholder := "?"
	if postgres {
		placeholder = "$1"
	}
	parameters := []any{schema}
	tables := "SELECT table_name AS name,table_type AS type FROM information_schema.tables WHERE table_schema=" + placeholder
	routines := "SELECT routine_name AS name,routine_type AS type FROM information_schema.routines WHERE routine_schema=" + placeholder
	switch category {
	case "table":
		tables += " AND table_type='BASE TABLE'"
	case "view":
		tables += " AND table_type='VIEW'"
	case "function", "procedure":
		return routines + " AND routine_type='" + strings.ToUpper(category) + "' ORDER BY name LIMIT 1000", parameters
	case "object":
		if !postgres {
			parameters = append(parameters, schema)
		}
		return tables + " UNION ALL " + routines + " ORDER BY name,type LIMIT 1000", parameters
	}
	return tables + " ORDER BY name LIMIT 1000", parameters
}
