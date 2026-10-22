package web

import (
	"encoding/json"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

type humanMessage struct {
	MessageID           string
	Text                string
	IgnoreProjectMemory bool
	Images              []ai.ImageAttachment
	References          []Object
	Mentions            []Object
	Files               []Object
	Reuse               any
}

func messageText(value any) string {
	message := text(value, "text", 400000)
	if utf8.RuneCountInString(message) > 100000 {
		fail(400, "text exceeds 100000 characters")
	}
	return message
}
func (b *Server) validateHumanMessage(id string, data Object) humanMessage {
	validateIDs(data["resourceIds"])
	rawText, ok := data["text"].(string)
	if !ok || utf8.RuneCountInString(rawText) > 100000 {
		fail(400, "text must be text (max 100000 characters)")
	}
	message := humanMessage{Text: strings.TrimSpace(rawText), Images: []ai.ImageAttachment{}, References: []Object{}, Files: []Object{}, Reuse: data["terminalReuse"]}
	if raw, exists := data["ignoreProjectMemory"]; exists {
		value, ok := raw.(bool)
		if !ok {
			fail(400, "Invalid memory option")
		}
		message.IgnoreProjectMemory = value
	}
	message.IgnoreProjectMemory = message.IgnoreProjectMemory || ignoreMemoryPhrase(message.Text)
	if value, exists := data["images"]; exists {
		if _, valid := value.([]any); !valid {
			fail(400, "Invalid image attachments")
		}
		if len(value.([]any)) == 0 {
			fail(400, "图片附件不能为空；无图片时请省略 images")
		}
		if len(objects(value)) != len(value.([]any)) {
			fail(400, "Invalid image attachments")
		}
		if len(objects(value)) == 0 {
			fail(400, "Invalid image attachments")
		}
		{
			cfg := b.Models.Active()
			if cfg == nil || !cfg.SupportsImageInput {
				fail(400, "所选模型未启用图片输入能力")
			}
			if json.Unmarshal([]byte(jsonText(value)), &message.Images) != nil {
				fail(400, "Invalid image attachments")
			}
			var err error
			message.Images, err = ai.ValidateImages(message.Images)
			if err != nil {
				fail(400, err.Error())
			}
		}
	}
	for _, ref := range stringsOf(data["resourceIds"]) {
		b.Store.AssertResource(id, ref)
		resource := b.Store.Resource(ref)
		message.References = append(message.References, Object{"asset_ref": ref, "name": resource["name"], "type": resource["kind"]})
	}
	message.References = append(message.References, b.contextReferences(id, message.Text, data["references"])...)
	message.Mentions = validatedMessageMentions(message.Text, data["mentions"], message.References)
	if value, exists := data["files"]; exists {
		if rows, valid := value.([]any); !valid || len(objects(value)) != len(rows) {
			fail(400, "附件须为数组")
		}
	}
	project := stringOf(b.Store.Session(id)["projectId"])
	if len(objects(data["files"])) > 8 {
		fail(400, "每条消息最多附加 8 个文件")
	}
	legacyCount := 0
	for _, file := range objects(data["files"]) {
		if attachmentID.MatchString(stringOf(file["sourceId"])) {
			attachment, _ := b.loadAttachment(project, id, stringOf(file["sourceId"]))
			message.Files = append(message.Files, Object{"source_id": attachment.SourceID, "name": attachment.Name, "kind": "file", "sizeBytes": attachment.Size, "sha256": attachment.SHA256, "mimeType": attachment.MIME})
			continue
		}
		legacyCount++
		if legacyCount > 4 {
			fail(400, "每条消息最多附加 4 个旧版文本文件")
		}
		source := b.loadImportSource(project, id, stringOf(file["sourceId"]))
		message.Files = append(message.Files, Object{"source_id": source.ID, "name": source.Name})
	}
	if message.Text == "" && len(message.Files) > 0 {
		message.Text = "请查看附件信息，并说明可以如何处理；执行或部署前先确认目标和需求。"
	}
	if message.Text == "" && len(message.Images) == 0 && len(message.Files) == 0 {
		fail(400, "请输入消息或添加附件")
	}
	return message
}
func (b *Server) humanMessageTitle(message humanMessage) string {
	title := b.Terminals.titleInput(message.Text)
	for _, reference := range message.References {
		name := stringOf(reference["name"])
		if name != "" && (strings.HasPrefix(title, "@"+name+" ") || strings.HasPrefix(title, "@"+name+"\n")) {
			title = strings.TrimSpace(strings.TrimPrefix(title, "@"+name))
		}
	}
	return title
}

// messageMu serializes admission and queue changes, including the gap between an
// engine's done event and runTurn's terminal/history cleanup.
func (b *Server) messageBusyLocked(id string) bool {
	if b.runningMessages[id] {
		return true
	}
	status := b.Store.Session(id)["status"]
	if status == "investigating" || status == "waiting_approval" || b.hostKeyPrompt(id) != nil {
		return true
	}
	view, err := b.Engine.Snapshot(id)
	aiFailure(err)
	return view.Status == "running" || view.Status == "waiting_approval" || view.Pending != nil
}
func (b *Server) launchMessageLocked(id string, message humanMessage) {
	if b.runningMessages == nil {
		b.runningMessages = map[string]bool{}
	}
	if b.runningMessages[id] {
		fail(409, "本轮仍在结束，请稍后发送")
	}
	b.runningMessages[id] = true
	b.workers.Add(1)
	go b.runTurn(id, message.MessageID, message.Text, message.Images, message.References, message.Files, message.IgnoreProjectMemory)
}
func (b *Server) submitHumanMessage(id string, data Object) Object {
	if b.Store.ActiveWorkflowRun(id) != "" {
		fail(409, "此会话正在执行工作流，请停止或等待工作流结束后再发送消息")
	}
	message := b.validateHumanMessage(id, data)
	b.messageMu.Lock()
	defer b.messageMu.Unlock()
	queue := b.Store.MessageQueue(id)
	if b.messageBusyLocked(id) || len(objects(queue["items"])) > 0 || data["enqueue"] == true {
		payload := Object{"text": message.Text, "resourceIds": stringsOf(data["resourceIds"]), "ignoreProjectMemory": message.IgnoreProjectMemory}
		if len(message.Images) > 0 {
			payload["images"] = message.Images
		}
		if len(message.Files) > 0 {
			files := []Object{}
			for _, file := range message.Files {
				files = append(files, publicMessageFile(file))
			}
			payload["files"] = files
		}
		if data["references"] != nil {
			_, _, selectedExtensions := separateExtensionReferences(message.Text, message.References)
			// Keep canonical extension metadata; resource references are already in
			// resourceIds and the remaining context references keep their old format.
			context := []Object{}
			for _, ref := range message.References {
				if ref["kind"] != nil && ref["kind"] != "skill" && ref["kind"] != "mcp" {
					context = append(context, ref)
				}
			}
			payload["references"] = append(context, selectedExtensions...)
		}
		payload["mentions"] = message.Mentions
		if message.Reuse != nil {
			payload["terminalReuse"] = message.Reuse
		}
		result := b.Store.EnqueueMessage(id, payload)
		b.dispatchMessageQueueLocked(id)
		result["messageQueue"] = b.Store.MessageQueue(id)
		return result
	}
	// A deliberate new message after stopping starts a fresh queue cycle.
	return b.beginHumanMessageLocked(id, message)
}

// Caller holds messageMu across mode selection, message admission and launch.
func (b *Server) beginHumanMessageLocked(id string, message humanMessage) Object {
	queue := b.Store.MessageQueue(id)
	if queue["paused"] == true {
		b.Store.MutateMessageQueue(id, Object{"operation": "resume", "revision": queue["revision"]})
	}
	b.bindManualTerminalForHuman(id, message.References, message.Reuse)
	titleInput := b.humanMessageTitle(message)
	result, pendingTitle := b.Store.BeginWithMentionsAndNaming(id, message.Text, message.Images, publicMessageFiles(message.Files), message.Mentions, titleInput)
	if pendingTitle && shouldGenerateSessionTitle(titleInput) {
		b.generateSessionTitle(id, titleInput)
	}
	message.MessageID = stringOf(result["id"])
	b.launchMessageLocked(id, message)
	return result
}
func (b *Server) dispatchMessageQueueLocked(id string) {
	if b.Context.Err() != nil || b.messageBusyLocked(id) {
		return
	}
	queue := b.Store.MessageQueue(id)
	if queue["paused"] == true || len(objects(queue["items"])) == 0 {
		return
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			reason := "待发送消息无法执行，请检查后继续"
			if failure, ok := recovered.(*Failure); ok {
				reason = failure.Message
			}
			b.Store.PauseMessageQueue(id, reason)
		}
	}()
	head := b.Store.queuedHead(id)
	data := object(parsed(stringOf(head["payload"])))
	message := b.validateHumanMessage(id, data)
	if b.Models.Active() == nil {
		fail(400, "尚未配置模型")
	}
	b.bindManualTerminalForHuman(id, message.References, message.Reuse)
	titleInput := b.humanMessageTitle(message)
	result, pendingTitle := b.Store.BeginQueuedMessageWithMentions(id, stringOf(head["id"]), message.Text, message.Images, titleInput, publicMessageFiles(message.Files), message.Mentions)
	if pendingTitle && shouldGenerateSessionTitle(titleInput) {
		b.generateSessionTitle(id, titleInput)
	}
	message.MessageID = stringOf(result["id"])
	b.launchMessageLocked(id, message)
}
func (b *Server) finishMessageQueue(id string) {
	defer func() { recover() }()
	b.messageMu.Lock()
	defer b.messageMu.Unlock()
	delete(b.runningMessages, id)
	if b.Context.Err() != nil {
		return
	}
	queue := b.Store.MessageQueue(id)
	if len(objects(queue["items"])) == 0 {
		return
	}
	view, err := b.Engine.Snapshot(id)
	aiFailure(err)
	if view.Status == "cancelled" || view.Status == "failed" || b.Store.Session(id)["status"] == "failed" {
		reason := "本轮回复失败，待发送队列已暂停"
		if view.Status == "cancelled" {
			reason = "已停止本轮，待发送队列已暂停"
		}
		b.Store.PauseMessageQueue(id, reason)
		return
	}
	b.dispatchMessageQueueLocked(id)
}
func (b *Server) pausePendingMessageQueue(id string) {
	b.messageMu.Lock()
	defer b.messageMu.Unlock()
	if len(objects(b.Store.MessageQueue(id)["items"])) > 0 {
		b.Store.PauseMessageQueue(id, "已停止本轮，待发送队列已暂停")
	}
}
func (b *Server) messageQueueRoute(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method == "GET" {
		reply(w, 200, b.Store.MessageQueue(id))
		return
	}
	if r.Method != "POST" {
		fail(405, "Method not allowed")
	}
	data := body(w, r, 1<<20)
	if data["operation"] == "edit" {
		data["text"] = messageText(data["text"])
		validateIDs(data["resourceIds"])
		for _, ref := range stringsOf(data["resourceIds"]) {
			b.Store.AssertResource(id, ref)
		}
		if data["references"] != nil {
			data["references"] = b.contextReferences(id, stringOf(data["text"]), data["references"])
		}
		refs := objects(data["references"])
		for _, ref := range stringsOf(data["resourceIds"]) {
			resource := b.Store.Resource(ref)
			refs = append(refs, Object{"asset_ref": ref, "name": resource["name"], "type": resource["kind"]})
		}
		data["mentions"] = validatedMessageMentions(stringOf(data["text"]), data["mentions"], refs)
	}
	if data["operation"] == "reorder" {
		if _, ok := data["ids"].([]any); !ok {
			fail(400, "排序须为消息标识数组")
		}
	}
	b.messageMu.Lock()
	defer b.messageMu.Unlock()
	b.Store.MutateMessageQueue(id, data)
	b.dispatchMessageQueueLocked(id)
	reply(w, 200, b.Store.MessageQueue(id))
}

func publicMessageFile(file Object) Object {
	out := Object{"sourceId": file["source_id"], "name": file["name"]}
	for _, key := range []string{"kind", "sizeBytes", "sha256", "mimeType"} {
		if file[key] != nil {
			out[key] = file[key]
		}
	}
	return out
}
func publicMessageFiles(files []Object) []Object {
	out := []Object{}
	for _, file := range files {
		out = append(out, publicMessageFile(file))
	}
	return out
}
