package web

import (
	"testing"

	"github.com/Clean-Lakes/Lake/internal/strategy"
)

func TestStrategyLegacyOfflineQueueAlsoRequiresFreshExplicitDispatch(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	enableStrategyFixture(t, s)
	s.update(func() any {
		old := s.strategySettings(strategy.Scope{Kind: strategy.UserScope})
		old.RuntimePolicyVersion = 0
		s.strategySaveSettings("user", old)
		s.exec("INSERT INTO strategyJobs(id,scopeKey,accessProjectId,kind,expectedRevision,status,globalEpoch,projectEpoch,sourceSetHash,runtimeId,dispatchState,expiresAtMs,createdAt,updatedAt) VALUES('offline','user','','experiment',0,'queued',1,0,'hash','offline-runtime','none',9999999999999,?,?)", now(), now())
		return nil
	})
	s.Close()
	s, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	settings, _ := s.GetStrategySettings(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope})
	if settings.OnlineCorrectEnabled || settings.LegacyOnlineConsent != nil || settings.RuntimePolicyVersion != strategy.OnlineConsentVersion || !settings.LearnEnabled || !settings.ApplyEnabled {
		t.Fatal("offline migration changed independent choices", settings)
	}
	if row := s.row("SELECT status FROM strategyJobs WHERE id='offline'"); row["status"] != "cancelled" {
		t.Fatal("old offline work would dispatch automatically", row)
	}
}
