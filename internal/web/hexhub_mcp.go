package web

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// MCP provides the import scope; login material is read separately from the
// current local HexHub asset store.
const defaultHexHubMCPURL = "http://127.0.0.1:17321/mcp"

type hexHubAsset struct {
	Name         string `json:"name"`
	Host         string `json:"host"`
	Path         string `json:"path"`
	Type         string `json:"type"`
	DBType       string `json:"db_type"`
	JumpAssetRef string `json:"jump_asset_ref"`
	SSHAssetRef  string `json:"ssh_asset_ref"`
}

func (b *Server) hexHubMCPURL() string {
	if b.HexHubMCP != "" {
		return b.HexHubMCP
	}
	if value := os.Getenv("LAKE_HEXHUB_MCP_URL"); value != "" {
		return value
	}
	return defaultHexHubMCPURL
}

// mcpResult decodes a Streamable HTTP response (single JSON message or SSE data
// events) and returns the result of the request with the given id.
func mcpResult(body []byte, id int) (json.RawMessage, *string) {
	type message struct {
		ID     any             `json:"id"`
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	decode := func(raw []byte) (json.RawMessage, *string, bool) {
		var msg message
		if json.Unmarshal(raw, &msg) != nil || msg.ID == nil || integer(msg.ID) != id {
			return nil, nil, false
		}
		if msg.Error != nil {
			return nil, &msg.Error.Message, true
		}
		return msg.Result, nil, true
	}
	trimmed := bytes.TrimSpace(body)
	if result, errMsg, ok := decode(trimmed); ok {
		return result, errMsg
	}
	for _, line := range bytes.Split(trimmed, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if !bytes.HasPrefix(line, []byte("data:")) {
			continue
		}
		if result, errMsg, ok := decode(bytes.TrimSpace(line[5:])); ok {
			return result, errMsg
		}
	}
	return nil, nil
}

func (b *Server) hexHubMCPRequest(ctx context.Context, session *string, payload []byte) []byte {
	url := b.hexHubMCPURL()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		fail(400, "HexHub MCP 地址无效")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if session != nil && *session != "" {
		req.Header.Set("Mcp-Session-Id", *session)
	}
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		fail(400, "无法连接本机 HexHub MCP（"+url+"），请确认 HexHub 已启动且 MCP 已开启")
	}
	defer resp.Body.Close()
	if session != nil {
		if value := resp.Header.Get("Mcp-Session-Id"); value != "" {
			*session = value
		}
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil || resp.StatusCode < 200 || resp.StatusCode >= 300 {
		fail(400, "HexHub MCP 响应无效")
	}
	return body
}

func (b *Server) hexHubMCPCall(ctx context.Context, session *string, id int, method string, params any) json.RawMessage {
	payload, err := json.Marshal(Object{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	must(err)
	result, errMsg := mcpResult(b.hexHubMCPRequest(ctx, session, payload), id)
	if errMsg != nil {
		fail(400, "HexHub MCP 调用失败："+*errMsg)
	}
	if result == nil {
		fail(400, "HexHub MCP 响应无效")
	}
	return result
}

func (b *Server) fetchHexHubAssets(ctx context.Context) []hexHubAsset {
	session := ""
	b.hexHubMCPCall(ctx, &session, 1, "initialize", Object{
		"protocolVersion": "2025-03-26",
		"capabilities":    Object{},
		"clientInfo":      Object{"name": "Lake", "version": "0.1"},
	})
	if payload, err := json.Marshal(Object{"jsonrpc": "2.0", "method": "notifications/initialized"}); err == nil {
		func() {
			defer func() { _ = recover() }()
			b.hexHubMCPRequest(ctx, &session, payload)
		}()
	}
	var call struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		IsError bool `json:"isError"`
	}
	result := b.hexHubMCPCall(ctx, &session, 2, "tools/call", Object{"name": "list_assets", "arguments": Object{"pattern": ""}})
	if json.Unmarshal(result, &call) != nil || call.IsError {
		fail(400, "HexHub MCP 读取资产清单失败")
	}
	raw := ""
	for _, item := range call.Content {
		if item.Type == "text" {
			raw += item.Text
		}
	}
	var assets []hexHubAsset
	if raw == "" || json.Unmarshal([]byte(raw), &assets) != nil {
		fail(400, "HexHub MCP 资产清单格式无效")
	}
	return assets
}

func hexHubDBDriver(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "mysql", "mariadb", "starrocks", "doris":
		return "mysql"
	case "postgres", "postgresql", "pg":
		return "postgres"
	case "sqlite", "sqlite3":
		return "sqlite"
	}
	return strings.ToLower(strings.TrimSpace(value))
}

// hexHubImportRecords 映射为导入候选记录；不携带 asset_ref 与任何凭据。
func hexHubImportRecords(assets []hexHubAsset) []Object {
	out := []Object{}
	for _, asset := range assets {
		record := Object{"name": asset.Name, "folder": strings.Trim(asset.Path, "/")}
		host := asset.Host
		if i := strings.LastIndex(host, ":"); i > 0 && !strings.Contains(host[:i], ":") {
			if port, err := strconv.Atoi(host[i+1:]); err == nil && port > 0 && port <= 65535 {
				record["host"], record["port"] = host[:i], port
			} else {
				record["host"] = host
			}
		} else {
			record["host"] = host
		}
		switch strings.ToLower(asset.Type) {
		case "ssh":
			record["kind"] = "ssh"
		case "db":
			record["kind"], record["driver"] = "database", hexHubDBDriver(asset.DBType)
			record["tls"], record["sslmode"] = false, "disable"
			if asset.SSHAssetRef != "" {
				record["importError"] = "当前导入不支持数据库 SSH 隧道配置"
			}
		case "redis":
			record["kind"], record["tls"] = "redis", false
		default:
			record["importError"] = "该 HexHub 资产类型暂不支持导入"
		}
		if asset.JumpAssetRef != "" {
			record["importError"] = "当前导入不支持跳板或代理配置"
		}
		out = append(out, record)
	}
	return out
}
