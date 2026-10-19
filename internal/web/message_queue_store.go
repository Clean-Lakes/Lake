package web

// These helpers run inside Store.read or Store.update, never with a second lock.
func (s *Store) messageQueue(id string) Object {
	state := s.row("SELECT paused,revision,lastError FROM messageQueueState WHERE sessionId=?", id)
	if state == nil {
		state = Object{"paused": false, "revision": 0, "lastError": ""}
	} else {
		state["paused"] = integer(state["paused"]) != 0
	}
	items := []Object{}
	for _, row := range s.rows("SELECT id,payload,createdAt FROM queuedMessages WHERE sessionId=? ORDER BY position,rowid", id) {
		payload := object(parsed(stringOf(row["payload"])))
		images := []Object{}
		for _, image := range objects(payload["images"]) {
			images = append(images, Object{"id": image["id"], "name": image["name"], "mimeType": image["mimeType"]})
		}
		items = append(items, Object{"id": row["id"], "text": payload["text"], "resourceIds": stringsOf(payload["resourceIds"]), "references": objects(payload["references"]), "mentions": objects(payload["mentions"]), "images": images, "files": objects(payload["files"]), "createdAt": row["createdAt"]})
	}
	state["items"] = items
	return state
}
func (s *Store) MessageQueue(id string) Object {
	return s.read(func() any { s.session(id); return s.messageQueue(id) }).(Object)
}
func (s *Store) queueState(id string) {
	s.exec("INSERT OR IGNORE INTO messageQueueState(sessionId) VALUES(?)", id)
}
func (s *Store) queueChanged(id string) {
	s.queueState(id)
	s.exec("UPDATE messageQueueState SET revision=revision+1 WHERE sessionId=?", id)
	s.event(id, "session")
}
func (s *Store) queueRevision(id string, revision any) {
	switch revision.(type) {
	case int, int64, float64:
	default:
		fail(409, "队列版本无效，请刷新后重试")
	}
	state := s.row("SELECT revision FROM messageQueueState WHERE sessionId=?", id)
	if revision == nil || number(revision) != float64(integer(revision)) || integer(revision) != integer(state["revision"]) {
		fail(409, "待发送队列已变化，请刷新后重试")
	}
}
func (s *Store) EnqueueMessage(id string, payload Object) Object {
	return s.update(func() any {
		s.session(id)
		s.queueState(id)
		rows := s.rows("SELECT id,position FROM queuedMessages WHERE sessionId=? ORDER BY position DESC", id)
		if len(rows) >= 20 {
			fail(400, "最多挂起 20 条消息")
		}
		position := 0
		if len(rows) > 0 {
			position = integer(rows[0]["position"]) + 1
		}
		qid := ident()
		s.exec("INSERT INTO queuedMessages(id,sessionId,position,payload,createdAt) VALUES(?,?,?,?,?)", qid, id, position, jsonText(payload), now())
		s.queueChanged(id)
		return Object{"queued": true, "queuedMessageId": qid, "messageQueue": s.messageQueue(id)}
	}).(Object)
}
func (s *Store) MutateMessageQueue(id string, data Object) Object {
	return s.update(func() any {
		s.session(id)
		s.queueState(id)
		s.queueRevision(id, data["revision"])
		switch data["operation"] {
		case "pause", "resume":
			paused := data["operation"] == "pause"
			s.exec("UPDATE messageQueueState SET paused=?,lastError='' WHERE sessionId=?", paused, id)
		case "edit":
			qid := stringOf(data["id"])
			row := required(s.row("SELECT payload FROM queuedMessages WHERE id=? AND sessionId=?", qid, id), "Queued message")
			payload := object(parsed(stringOf(row["payload"])))
			payload["text"] = data["text"]
			payload["resourceIds"] = data["resourceIds"]
			if data["mentions"] != nil {
				payload["mentions"] = data["mentions"]
			}
			if data["references"] != nil {
				payload["references"] = data["references"]
			}
			s.exec("UPDATE queuedMessages SET payload=? WHERE id=? AND sessionId=?", jsonText(payload), qid, id)
			s.exec("UPDATE messageQueueState SET lastError='' WHERE sessionId=?", id)
		case "remove":
			qid := stringOf(data["id"])
			required(s.row("SELECT id FROM queuedMessages WHERE id=? AND sessionId=?", qid, id), "Queued message")
			s.exec("DELETE FROM queuedMessages WHERE id=? AND sessionId=?", qid, id)
			s.exec("UPDATE messageQueueState SET lastError='' WHERE sessionId=?", id)
		case "reorder":
			ids := stringsOf(data["ids"])
			rows := s.rows("SELECT id FROM queuedMessages WHERE sessionId=?", id)
			existing := map[string]bool{}
			for _, row := range rows {
				existing[stringOf(row["id"])] = true
			}
			if len(ids) != len(rows) {
				fail(409, "排序须包含当前所有待发送消息")
			}
			for position, qid := range ids {
				if !existing[qid] {
					fail(400, "队列排序标识重复或无效")
				}
				delete(existing, qid)
				s.exec("UPDATE queuedMessages SET position=? WHERE id=? AND sessionId=?", position, qid, id)
			}
		default:
			fail(400, "队列操作无效")
		}
		s.queueChanged(id)
		return s.messageQueue(id)
	}).(Object)
}
func (s *Store) PauseMessageQueue(id, reason string) {
	s.update(func() any {
		s.session(id)
		s.queueState(id)
		s.exec("UPDATE messageQueueState SET paused=1,lastError=? WHERE sessionId=?", reason, id)
		s.queueChanged(id)
		return nil
	})
}
func (s *Store) queuedHead(id string) Object {
	return s.read(func() any {
		return s.row("SELECT id,payload FROM queuedMessages WHERE sessionId=? ORDER BY position,rowid LIMIT 1", id)
	}).(Object)
}
func (s *Store) BeginQueuedMessage(id, qid, text string, images any, title string) Object {
	message, _ := s.BeginQueuedMessageWithNaming(id, qid, text, images, title)
	return message
}

func (s *Store) BeginQueuedMessageWithNaming(id, qid, text string, images any, title string, attachments ...[]Object) (Object, bool) {
	var files []Object
	if len(attachments) > 0 {
		files = attachments[0]
	}
	return s.BeginQueuedMessageWithMentions(id, qid, text, images, title, files, nil)
}
func (s *Store) BeginQueuedMessageWithMentions(id, qid, text string, images any, title string, files, mentions []Object) (Object, bool) {
	result := s.update(func() any {
		head := s.row("SELECT id FROM queuedMessages WHERE sessionId=? ORDER BY position,rowid LIMIT 1", id)
		if head["id"] != qid || integer(s.row("SELECT paused FROM messageQueueState WHERE sessionId=?", id)["paused"]) != 0 {
			fail(409, "队列已变化")
		}
		pendingTitle := s.row("SELECT 1 FROM sessionNaming WHERE sessionId=? AND generated=0", id) != nil
		message := s.begin(id, text, images, title)
		s.attachMessageFiles(id, message, files)
		s.attachMessageMentions(id, message, mentions)
		s.exec("DELETE FROM queuedMessages WHERE id=? AND sessionId=?", qid, id)
		s.queueChanged(id)
		return struct {
			message      Object
			pendingTitle bool
		}{message, pendingTitle}
	}).(struct {
		message      Object
		pendingTitle bool
	})
	return result.message, result.pendingTitle
}
func (s *Store) pauseMessageQueuesOnRestart() {
	for _, row := range s.rows("SELECT DISTINCT sessionId FROM queuedMessages") {
		id := stringOf(row["sessionId"])
		s.queueState(id)
		s.exec("UPDATE messageQueueState SET paused=1,lastError='服务已重启，确认后继续发送' WHERE sessionId=?", id)
		s.queueChanged(id)
	}
}
