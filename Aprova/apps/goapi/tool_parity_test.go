package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"testing"
)

func pdftoolPages(t *testing.T, pdf string) []pdfPage {
	cmd := exec.Command("/tmp/pdftool", "extract", pdf)
	cmd.Env = append(os.Environ(), "LD_LIBRARY_PATH=/tmp")
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		Pages []pdfPage `json:"pages"`
	}
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatal(err)
	}
	return parsed.Pages
}

func TestToolParity(t *testing.T) {
	for _, exam := range []string{"17", "18"} {
		pdf := fmt.Sprintf("/home/lucasassuncao/orca/mira/Aprova/apps/api/data/exam-assets/%s/source.pdf", exam)
		pages := pdftoolPages(t, pdf)
		marked := ""
		for i, p := range pages {
			marked += fmt.Sprintf("[[PAGE:%d]]\n%s\n", i+1, orderedPageText(p.Words, p.Width, p.Height))
		}
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
		fmt.Printf("pdftool exam %s => total:%d first:%v last:%v\n", exam, len(withAlts), nums[:3], nums[len(nums)-3:])
	}
}
