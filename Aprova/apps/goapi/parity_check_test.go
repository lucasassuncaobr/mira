package main

import (
	"encoding/json"
	"fmt"
	"os"
	"testing"
)

type w struct {
	Text string `json:"text"`
}
type pg struct {
	Text string `json:"text"`
}

func loadMarked(t *testing.T, path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var d struct {
		Pages []pg `json:"pages"`
	}
	if err := json.Unmarshal(b, &d); err != nil {
		t.Fatal(err)
	}
	marked := ""
	for i, p := range d.Pages {
		marked += fmt.Sprintf("[[PAGE:%d]]\n%s", i+1, p.Text) + "\n"
	}
	_ = w{}
	return marked
}

func TestParity(t *testing.T) {
	for _, f := range []string{"/tmp/e17.json", "/tmp/e18.json"} {
		marked := loadMarked(t, f)
		qs := ParseQuestions(marked)
		var withAlts []ParsedQuestion
		for _, q := range qs {
			if len(q.Alternatives) >= 2 {
				withAlts = append(withAlts, q)
			}
		}
		nums := []int{}
		for _, q := range withAlts {
			nums = append(nums, q.Number)
		}
		fmt.Printf("%s => total:%d nums:%v\n", f, len(withAlts), nums)
	}
}
