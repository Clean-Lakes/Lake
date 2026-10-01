package store

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestConversationHistoryScopedPaginationRedactionAndOriginalText(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "回查", "")
	if err != nil {
		t.Fatal(err)
	}
	one, _ := s.CreateConversation(ctx, lake.Name)
	two, _ := s.CreateConversation(ctx, lake.Name)
	long := strings.Repeat("历史中确认的目录层级。", 100)
	old, err := s.AppendConversationTurn(ctx, one.ID, "目录组织", long, "", "")
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.AppendConversationTurn(ctx, two.ID, "隔离的内容", "仅其他会话可见", "", "")
	if err != nil {
		t.Fatal(err)
	}
	data := base64.StdEncoding.EncodeToString([]byte("\x89PNG\r\n\x1a\nfixture"))
	if _, err := s.AppendConversationTurnWithImages(ctx, one.ID, "添加资源", "", "", "fixture failure", []ImageAttachment{{Name: "fixture.png", MIMEType: "image/png", Data: data}}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AppendConversationTurn(ctx, one.ID, "Authorization: Bearer fixture-private-value", "设置失败", "", "fixture failure"); err != nil {
		t.Fatal(err)
	}
	page, err := s.ReadConversationHistory(ctx, one.ID, ConversationHistoryQuery{Limit: 1}, 1800)
	if err != nil || len(page.Turns) != 1 || page.NextBefore == 0 {
		t.Fatal("latest page missing", err)
	}
	raw, _ := json.Marshal(page)
	if strings.Contains(string(raw), "fixture-private-value") {
		t.Fatal("credential was exposed by historical read")
	}
	next, err := s.ReadConversationHistory(ctx, one.ID, ConversationHistoryQuery{Limit: 1, Before: page.NextBefore}, 1800)
	if err != nil || len(next.Turns) != 1 || next.Turns[0].Status != "failed" || next.Turns[0].ImageCount != 1 || next.Turns[0].UserEventSeq == 0 {
		t.Fatal("failed request or attachment metadata missing", err)
	}
	raw, _ = json.Marshal(next)
	if strings.Contains(string(raw), data) || strings.Contains(string(raw), "仅其他会话可见") {
		t.Fatal("attachment data or other conversation escaped")
	}
	foreign, err := s.ReadConversationHistory(ctx, one.ID, ConversationHistoryQuery{TurnID: other.ID}, 1800)
	if err != nil || len(foreign.Turns) != 0 {
		t.Fatal("foreign turn was readable", err)
	}
	matched, err := s.ReadConversationHistory(ctx, one.ID, ConversationHistoryQuery{Query: "目录层级"}, 128)
	if err != nil || len(matched.Turns) != 1 || matched.Turns[0].TurnID != old.ID || !matched.Turns[0].Truncated {
		t.Fatal("keyword search lost older original", err)
	}
	var text strings.Builder
	offset := 0
	for {
		part, err := s.ReadConversationHistory(ctx, one.ID, ConversationHistoryQuery{TurnID: old.ID, Offset: offset}, 128)
		if err != nil || len(part.Turns) != 1 || !utf8.ValidString(part.Turns[0].Text) || utf8.RuneCountInString(part.Turns[0].Text) > 128 {
			t.Fatal("invalid text page", err)
		}
		entry := part.Turns[0]
		text.WriteString(entry.Text)
		if !entry.Truncated {
			break
		}
		if entry.NextOffset <= offset {
			t.Fatal("page cursor did not advance")
		}
		offset = entry.NextOffset
	}
	if text.String() != "[用户请求]\n目录组织\n[助手回复，仅作历史]\n"+long {
		t.Fatal("paged read changed original text")
	}
	_, err = s.ReadConversationHistory(ctx, one.ID, ConversationHistoryQuery{Offset: 1}, 128)
	if err == nil {
		t.Fatal("unscoped text offset accepted")
	}
}

func TestSummaryCanIncludeReleasedPendingSourcesAtSameWatermark(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, _ := s.CreateLake(ctx, "摘要来源", "")
	conversation, _ := s.CreateConversation(ctx, lake.Name)
	for i := 0; i < 2; i++ {
		if _, err := s.AppendConversationTurn(ctx, conversation.ID, "请求", "回复", "", ""); err != nil {
			t.Fatal(err)
		}
	}
	initial := ConversationSummaryInput{ThroughSeq: 4, SourceEventIDs: []uint64{3, 4}, Text: "较新内容", TokenEstimate: 10}
	if err := s.SaveConversationSummary(ctx, conversation.ID, initial); err != nil {
		t.Fatal(err)
	}
	revised := ConversationSummaryInput{ThroughSeq: 4, SourceEventIDs: []uint64{1, 2, 3, 4}, Text: "补入此前保留的未完成请求", TokenEstimate: 20}
	if err := s.SaveConversationSummary(ctx, conversation.ID, revised); err != nil {
		t.Fatal(err)
	}
	summary, err := s.LatestConversationSummary(ctx, conversation.ID)
	if err != nil || len(summary.SourceEventIDs) != 4 || summary.Text != revised.Text {
		t.Fatal("revised coverage lost", err)
	}
	if err := s.SaveConversationSummary(ctx, conversation.ID, initial); err == nil {
		t.Fatal("summary revision discarded sources")
	}
}
