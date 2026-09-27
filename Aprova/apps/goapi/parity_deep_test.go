package main

import (
	"encoding/json"
	"fmt"
	"os"
	"testing"
)

func TestDeepParity(t *testing.T) {
	b, _ := os.ReadFile("/tmp/e18.json")
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
	qs := ParseQuestions(marked)
	var q4 *ParsedQuestion
	for i := range qs {
		if qs[i].Number == 4 {
			q4 = &qs[i]
		}
	}
	if q4 == nil {
		t.Fatal("Q4 missing")
	}
	fmt.Printf("Q4 stmt: %.60q\n", q4.Statement)
	for _, a := range q4.Alternatives {
		fmt.Printf("  %s: %.50q\n", a.Label, a.Text)
	}
	kb, _ := os.ReadFile("/tmp/e18k.json")
	var kd struct {
		Pages []pg `json:"pages"`
	}
	json.Unmarshal(kb, &kd)
	keyText := ""
	for _, p := range kd.Pages {
		keyText += p.Text + "\n"
	}
	ans := ParseAnswerKey(keyText, marked)
	fmt.Printf("key sem tipo: %d (esperado 0)\n", len(ans))
	ans2 := ParseAnswerKey(keyText, marked+"\nPROVA TIPO A")
	fmt.Printf("key +TIPO A: %d (esperado 21)\n", len(ans2))
}
