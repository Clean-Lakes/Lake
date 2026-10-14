package web

import (
	"net/http"
	"strings"
)

func (b *Server) providerRoute(w http.ResponseWriter, r *http.Request, name, method string) bool {
	const root = "/api/settings/providers"
	if name == "/api/settings/model/select" && method == "POST" {
		data := body(w, r, 2048)
		reply(w, 200, b.Models.ActivateProviderModel(stringOf(data["providerId"]), stringOf(data["modelId"])))
		return true
	}
	if name == root {
		switch method {
		case "GET":
			reply(w, 200, b.Models.Providers())
			return true
		case "POST":
			reply(w, 201, b.Models.SaveProvider("", body(w, r, 262144)))
			return true
		}
	}
	if !strings.HasPrefix(name, root+"/") {
		return false
	}
	parts := strings.Split(strings.TrimPrefix(name, root+"/"), "/")
	if len(parts) == 0 || !providerIDPattern.MatchString(parts[0]) {
		fail(400, "供应商标识无效")
	}
	id := parts[0]
	if len(parts) == 1 {
		switch method {
		case "PUT":
			reply(w, 200, b.Models.SaveProvider(id, body(w, r, 262144)))
			return true
		case "DELETE":
			reply(w, 200, b.Models.DeleteProvider(id))
			return true
		}
	}
	if len(parts) == 2 && method == "POST" && (parts[1] == "detect-capabilities" || parts[1] == "detect-images") {
		reply(w, 202, b.Models.StartProviderCapabilityDetection(id))
		return true
	}
	if len(parts) == 2 && method == "GET" && (parts[1] == "detect-capabilities" || parts[1] == "detect-images") {
		reply(w, 200, b.Models.ProviderCapabilityDetectionStatus(id))
		return true
	}
	if len(parts) == 2 && method == "POST" && (parts[1] == "test" || parts[1] == "discover") {
		cfg := b.Models.ProviderInput(id, body(w, r, 16384))
		operation := "testModel"
		if parts[1] == "discover" {
			operation = "models"
		}
		result, err := b.handleAI(r.Context(), operation, "", cfg)
		must(err)
		reply(w, 200, result)
		return true
	}
	fail(404, "模型供应商接口不存在")
	return true
}
