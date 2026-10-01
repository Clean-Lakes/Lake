package scheduler

import (
	"testing"
	"time"
)

func TestCronNextInTimezoneAndFieldValidation(t *testing.T) {
	plan, err := Parse("cron", "30 9 * * 1-5", "Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, 10, 2, 1, 31, 0, 0, time.UTC) // Friday 09:31 CST
	next, err := plan.Next(start)
	if err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 10, 5, 1, 30, 0, 0, time.UTC)
	if !next.Equal(want) {
		t.Fatalf("next=%v want=%v", next, want)
	}
	for _, bad := range []string{"* * * *", "60 * * * *", "* * * * 9", "*/0 * * * *", "* * * * * *"} {
		if _, err := Parse("cron", bad, "UTC"); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}

func TestOnceScheduleRequiresFutureInstant(t *testing.T) {
	plan, err := Parse("once", "2026-10-01T10:00:00+08:00", "Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	next, err := plan.Next(time.Date(2026, 9, 30, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if next.UTC() != time.Date(2026, 10, 1, 2, 0, 0, 0, time.UTC) {
		t.Fatalf("next=%v", next)
	}
	if _, err := plan.Next(next); err == nil {
		t.Fatal("past once accepted")
	}
}
