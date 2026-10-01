package model

import (
	"sync"
	"time"
)

type wireUsage struct {
	InputTokens              int64 `json:"input_tokens"`
	OutputTokens             int64 `json:"output_tokens"`
	CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
}

// UsageSnapshot includes received model responses, including empty responses
// and their recovery attempts. Missing provider usage is estimated locally.
type UsageSnapshot struct {
	Calls                    int
	ReportedCalls            int
	EstimatedCalls           int
	ModelDuration            time.Duration
	InputTokens              int64
	OutputTokens             int64
	EstimatedInputTokens     int64
	EstimatedOutputTokens    int64
	CacheReadInputTokens     int64
	CacheCreationInputTokens int64
}

func (u UsageSnapshot) TotalInputTokens() int64 {
	return u.InputTokens + u.EstimatedInputTokens + u.CacheReadInputTokens + u.CacheCreationInputTokens
}

func (u UsageSnapshot) TotalTokens() int64 {
	return u.TotalInputTokens() + u.OutputTokens + u.EstimatedOutputTokens
}

func (u UsageSnapshot) Since(before UsageSnapshot) UsageSnapshot {
	return UsageSnapshot{
		Calls:                    u.Calls - before.Calls,
		ReportedCalls:            u.ReportedCalls - before.ReportedCalls,
		EstimatedCalls:           u.EstimatedCalls - before.EstimatedCalls,
		ModelDuration:            u.ModelDuration - before.ModelDuration,
		InputTokens:              u.InputTokens - before.InputTokens,
		OutputTokens:             u.OutputTokens - before.OutputTokens,
		EstimatedInputTokens:     u.EstimatedInputTokens - before.EstimatedInputTokens,
		EstimatedOutputTokens:    u.EstimatedOutputTokens - before.EstimatedOutputTokens,
		CacheReadInputTokens:     u.CacheReadInputTokens - before.CacheReadInputTokens,
		CacheCreationInputTokens: u.CacheCreationInputTokens - before.CacheCreationInputTokens,
	}
}

type UsageMeter struct {
	mu     sync.Mutex
	totals UsageSnapshot
}

func (m *UsageMeter) record(usage *wireUsage, duration time.Duration, estimatedInput, estimatedOutput int64) {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.totals.Calls++
	m.totals.ModelDuration += duration
	if usage == nil {
		m.totals.EstimatedCalls++
		m.totals.EstimatedInputTokens += estimatedInput
		m.totals.EstimatedOutputTokens += estimatedOutput
		return
	}
	m.totals.ReportedCalls++
	m.totals.InputTokens += usage.InputTokens
	m.totals.OutputTokens += usage.OutputTokens
	m.totals.CacheReadInputTokens += usage.CacheReadInputTokens
	m.totals.CacheCreationInputTokens += usage.CacheCreationInputTokens
}

func (m *UsageMeter) Snapshot() UsageSnapshot {
	if m == nil {
		return UsageSnapshot{}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.totals
}

// RecordExternal merges reported usage from an external Agent runtime into the
// same meter used by Lake specialists and conversation event persistence.
func (m *UsageMeter) RecordExternal(input, output, cacheRead, cacheWrite int64) {
	m.record(&wireUsage{InputTokens: input, OutputTokens: output, CacheReadInputTokens: cacheRead, CacheCreationInputTokens: cacheWrite}, 0, 0, 0)
}
