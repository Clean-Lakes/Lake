package web

import (
	"net/http"
	"strconv"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

// Stored with the channel so opening Lake on a new loopback port preserves read state.
func (b *Server) populateSpecialistReads(project string, channels []ai.SpecialistChannel) {
	b.Store.read(func() any {
		seen := map[string]string{}
		for _, row := range b.Store.rows("SELECT r.channelId,r.completionCursor FROM superagentChannelReads r JOIN superagentRoleChannels c ON c.channelId=r.channelId WHERE c.projectId=?", project) {
			seen[stringOf(row["channelId"])] = stringOf(row["completionCursor"])
		}
		for i := range channels {
			channels[i].SeenCompletionCursor = seen[channels[i].ID]
		}
		return nil
	})
}

func (b *Server) readSpecialistCompletion(w http.ResponseWriter, r *http.Request, session string) {
	if r.Method != "PUT" {
		fail(405, "Method not allowed")
	}
	if b.Store.superSessionKind(session) != "role" {
		fail(404, "Specialist channel required")
	}
	cursor := text(body(w, r, 1024)["cursor"], "cursor", 128)
	count, err := strconv.ParseUint(cursor, 10, 64)
	if err != nil || count == 0 || len(cursor) != 20 {
		fail(400, "Invalid completion cursor")
	}
	project := stringOf(b.Store.Session(session)["projectId"])
	ch, err := b.Engine.SpecialistChannelForSession(r.Context(), project, session)
	aiFailure(err)
	// A late click must not acknowledge a completion that arrived since the menu was rendered.
	latest, err := b.Engine.SpecialistCompletionCursor(r.Context(), project, ch.RoleID)
	aiFailure(err)
	if cursor > latest {
		fail(409, "专员的完成记录已更新")
	}
	reply(w, 200, Object{"cursor": b.Store.markSpecialistRead(ch.ID, cursor)})
}

func (s *Store) markSpecialistRead(channelID, cursor string) string {
	return s.update(func() any {
		row := s.row("INSERT INTO superagentChannelReads(channelId,completionCursor) VALUES(?,?) ON CONFLICT(channelId) DO UPDATE SET completionCursor=MAX(completionCursor,excluded.completionCursor) RETURNING completionCursor", channelID, cursor)
		return stringOf(row["completionCursor"])
	}).(string)
}
