package web

import (
	"fmt"
	"sync"
	"testing"
)

func TestMemoryV2ConcurrentManualCASOnlyOneWriterWins(t *testing.T) {
	s, p := memoryV2Fixture(t)
	s.CommitMemoryV2(p, memoryV2Mutation("concurrent-rule"))
	var wg sync.WaitGroup
	results := make(chan bool, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			defer func() {
				if p := recover(); p != nil {
					f, ok := p.(*Failure)
					results <- ok && f.Status == 409
				}
			}()
			m := memoryV2Mutation("concurrent-rule")
			m.ExpectedRevision = 1
			m.Body = fmt.Sprintf("备份规则 %d", i)
			s.CommitMemoryV2(p, m)
			results <- false
		}(i)
	}
	wg.Wait()
	close(results)
	conflicts := 0
	for conflict := range results {
		if conflict {
			conflicts++
		}
	}
	if conflicts != 7 || integer(s.ReadProjectMemory(p, "concurrent-rule", false)["revision"]) != 2 {
		t.Fatalf("concurrent CAS: conflicts=%d", conflicts)
	}
}
