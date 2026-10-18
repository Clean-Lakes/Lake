package lakeadk

import (
	"github.com/Clean-Lakes/Lake/internal/agent/storage"
	"google.golang.org/adk/v2/session"
	"strings"
)

type prototypeSQLiteService struct {
	session.Service
	store *storage.Store
}

func (s *prototypeSQLiteService) Close() error { return s.store.Close() }
func NewSQLiteSessionService(path string) (session.Service, error) {
	if strings.TrimSpace(path) == "" {
		return session.InMemoryService(), nil
	}
	store, err := storage.Open(path)
	if err != nil {
		return nil, err
	}
	return &prototypeSQLiteService{Service: store.Sessions, store: store}, nil
}
