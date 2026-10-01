package scheduler

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

type field struct {
	allowed  map[int]bool
	wildcard bool
}
type Plan struct {
	Kind, Expression, Timezone string
	location                   *time.Location
	once                       time.Time
	fields                     [5]field
}

func Parse(kind, expression, timezone string) (Plan, error) {
	if timezone == "" {
		timezone = "Local"
	}
	loc, err := time.LoadLocation(timezone)
	if err != nil {
		return Plan{}, fmt.Errorf("无效时区 %q: %w", timezone, err)
	}
	plan := Plan{Kind: kind, Expression: expression, Timezone: timezone, location: loc}
	switch kind {
	case "once":
		plan.once, err = time.Parse(time.RFC3339, expression)
		if err != nil {
			return Plan{}, errors.New("一次性计划时间必须是 RFC3339")
		}
	case "cron":
		parts := strings.Fields(expression)
		if len(parts) != 5 {
			return Plan{}, errors.New("cron 需要分、时、日、月、周五个字段")
		}
		bounds := [5][2]int{{0, 59}, {0, 23}, {1, 31}, {1, 12}, {0, 7}}
		for i, part := range parts {
			plan.fields[i], err = parseField(part, bounds[i][0], bounds[i][1])
			if err != nil {
				return Plan{}, fmt.Errorf("cron 字段 %d: %w", i+1, err)
			}
		}
		if plan.fields[4].allowed[7] {
			plan.fields[4].allowed[0] = true
		}
	default:
		return Plan{}, errors.New("计划类型必须是 once 或 cron")
	}
	return plan, nil
}

func parseField(text string, min, max int) (field, error) {
	out := field{allowed: make(map[int]bool), wildcard: text == "*"}
	if text == "" {
		return out, errors.New("字段为空")
	}
	for _, part := range strings.Split(text, ",") {
		base, stepText, hasStep := strings.Cut(part, "/")
		step := 1
		if hasStep {
			var err error
			step, err = strconv.Atoi(stepText)
			if err != nil || step < 1 || step > max-min+1 {
				return out, errors.New("步长无效")
			}
		}
		start, end := min, max
		if base != "*" {
			left, right, hasRange := strings.Cut(base, "-")
			var err error
			start, err = strconv.Atoi(left)
			if err != nil {
				return out, errors.New("数值无效")
			}
			end = start
			if hasRange {
				end, err = strconv.Atoi(right)
				if err != nil {
					return out, errors.New("范围无效")
				}
			}
			if hasStep && !hasRange {
				end = max
			}
		}
		if start < min || end > max || start > end {
			return out, errors.New("数值超出范围")
		}
		for value := start; value <= end; value += step {
			out.allowed[value] = true
		}
	}
	return out, nil
}

func (p Plan) Next(after time.Time) (time.Time, error) {
	if p.Kind == "once" {
		if p.once.After(after) {
			return p.once, nil
		}
		return time.Time{}, errors.New("一次性计划时间已过去")
	}
	if p.Kind != "cron" || p.location == nil {
		return time.Time{}, errors.New("计划尚未解析")
	}
	candidate := after.UTC().Truncate(time.Minute).Add(time.Minute)
	// Searching absolute minutes handles skipped/repeated local minutes at DST
	// boundaries without manufacturing a nonexistent wall clock time.
	for i := 0; i < 2*366*24*60; i++ {
		local := candidate.In(p.location)
		f := p.fields
		day := f[2].allowed[local.Day()]
		week := f[4].allowed[int(local.Weekday())]
		dayMatch := day && week
		if f[2].wildcard {
			dayMatch = week
		}
		if f[4].wildcard {
			dayMatch = day
		}
		if !f[2].wildcard && !f[4].wildcard {
			dayMatch = day || week
		}
		if f[0].allowed[local.Minute()] && f[1].allowed[local.Hour()] && f[3].allowed[int(local.Month())] && dayMatch {
			return candidate, nil
		}
		candidate = candidate.Add(time.Minute)
	}
	return time.Time{}, errors.New("未来两年内无符合条件的 cron 时间")
}
