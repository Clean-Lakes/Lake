package ai

import "strings"

// A brief utterance skips automatic host sampling only. It still goes to the
// model with full conversation context and normal tools, so accepting a concrete
// proposal can continue that task rather than receiving a canned acknowledgement.
func IsBriefConversation(text string) bool {
	text = strings.ToLower(strings.Trim(strings.TrimSpace(text), "。.!！?？,，~～"))
	switch text {
	case "好的", "好", "好吧", "行", "可以", "ok", "okay", "收到", "明白", "了解", "知道了", "嗯", "嗯嗯",
		"谢谢", "谢谢你", "多谢", "感谢", "thanks", "thank you", "你好", "您好", "hello", "hi", "不用了", "不需要了", "就这样", "没事了":
		return true
	}
	return false
}

func (e *Engine) finishReply(s *session, content string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	message := Message{Role: "assistant", Content: content}
	s.state.History = append(s.state.History, message)
	s.state.View.Cards = append(s.state.View.Cards, Card{ID: uid(), Type: "message", Content: content, Status: "completed", At: timestamp()})
	err := e.save(s)
	e.notify(s, "historyMessage", message)
	return err
}
