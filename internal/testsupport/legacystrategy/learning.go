package legacystrategy

// Learning limits are independent of optional online correction/optimization.
// Input counts the complete UTF-8 prompt envelope, not an approximate token count.
type LearningLimits struct {
	Version            string `json:"version"`
	MaxInputBytes      int    `json:"maxInputBytes"`
	MaxOutputTokens    int    `json:"maxOutputTokens"`
	DeadlineSeconds    int    `json:"deadlineSeconds"`
	MaxDailyRequests   int    `json:"maxDailyRequests"`
	MaxDailyTokens     int    `json:"maxDailyTokens"`
	MaxQueueAgeSeconds int    `json:"maxQueueAgeSeconds"`
	MaxQueued          int    `json:"maxQueued"`
	MaxProjectQueued   int    `json:"maxProjectQueued"`
}

func DefaultLearningLimits() LearningLimits {
	return LearningLimits{Version: "learning-v1", MaxInputBytes: 8192, MaxOutputTokens: 2048, DeadlineSeconds: 30, MaxDailyRequests: 12, MaxDailyTokens: 61440, MaxQueueAgeSeconds: 48 * 60 * 60, MaxQueued: 100, MaxProjectQueued: 20}
}
