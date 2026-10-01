package agent

import "testing"

func TestUserQuestionBoundsAndSensitiveAnswers(t *testing.T) {
	in := UserQuestionInput{Questions: []UserQuestion{{ID: "target", Header: "目标", Prompt: "选择目标", Options: []UserQuestionOption{{Label: "宿主"}, {Label: "容器"}}}}}
	if err := in.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, answers := range []map[string]string{nil, {"target": ""}, {"other": "宿主"}, {"target": "API_KEY=fixture"}, {"target": "宿主", "extra": "yes"}} {
		if err := in.ValidateAnswer(UserQuestionAnswer{Answers: answers}); err == nil {
			t.Fatal("invalid answer accepted")
		}
	}
	if err := in.ValidateAnswer(UserQuestionAnswer{Answers: map[string]string{"target": "另一个实例，路径 /opt/nginx"}}); err != nil {
		t.Fatal("free answer rejected", err)
	}
	in.Questions = append(in.Questions, in.Questions[0])
	if err := in.Validate(); err == nil {
		t.Fatal("duplicate id accepted")
	}
}
