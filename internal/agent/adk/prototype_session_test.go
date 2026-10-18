package lakeadk

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"google.golang.org/adk/v2/session"
	sessiondb "google.golang.org/adk/v2/session/database"
)

// NewSQLiteSessionService stores ADK sessions/events in a private SQLite file.
// An empty path selects the in-memory service for tests.
func NewSQLiteSessionService(path string) (session.Service, error) {
	if strings.TrimSpace(path) == "" {
		return session.InMemoryService(), nil
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return nil, err
	}
	service, err := sessiondb.NewSessionService(sqlite.Open(path), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		return nil, fmt.Errorf("open ADK session database: %w", err)
	}
	if err := sessiondb.AutoMigrate(service); err != nil {
		return nil, fmt.Errorf("migrate ADK session database: %w", err)
	}
	if err := os.Chmod(path, 0600); err != nil {
		return nil, err
	}
	return service, nil
}
