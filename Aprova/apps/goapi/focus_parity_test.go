package main

import (
	"encoding/json"
	"fmt"
	"os"
	"testing"
)

func bboxOfFile(t *testing.T, path string) (string, string) {
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var d struct {
		Pages []struct {
			Text   string  `json:"text"`
			Width  float64 `json:"width"`
			Height float64 `json:"height"`
			Words  []struct {
				X0 float64 `json:"x0"`; Top float64 `json:"top"`
				X1 float64 `json:"x1"`; Bottom float64 `json:"bottom"`
				Text string `json:"text"`
			} `json:"words"`
		} `json:"pages"`
	}
	if err := json.Unmarshal(b, &d); err != nil {
		t.Fatal(err)
	}
	marked := ""
	bbox := ""
	for i, p := range d.Pages {
		marked += fmt.Sprintf("[[PAGE:%d]]\n%s\n", i+1, p.Text)
		bbox += fmt.Sprintf(`<page width="%v" height="%v">`, p.Width, p.Height)
		for _, w := range p.Words {
			esc := w.Text
			esc = replaceAll(esc, "&", "&amp;")
			esc = replaceAll(esc, "<", "&lt;")
			esc = replaceAll(esc, ">", "&gt;")
			bbox += fmt.Sprintf(`<word xMin="%v" yMin="%v" xMax="%v" yMax="%v">%s</word>`, w.X0, w.Top, w.X1, w.Bottom, esc)
		}
	}
	return marked, bbox
}

func replaceAll(s, o, n string) string {
	out := ""
	for {
		i := indexOf(s, o)
		if i < 0 {
			return out + s
		}
		out += s[:i] + n
		s = s[i+len(o):]
	}
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func TestFocusParity(t *testing.T) {
	for _, f := range []string{"/tmp/e17.json", "/tmp/e18.json"} {
		marked, bbox := bboxOfFile(t, f)
		qs := ParseQuestions(marked)
		var hints []FocusHint
		for _, q := range qs {
			if len(q.Alternatives) >= 2 {
				pn := q.PageNumber
				hints = append(hints, FocusHint{Number: q.Number, PageNumber: &pn})
			}
		}
		m := selectEntries(parseBboxCandidates(bbox), parseBboxLines(bbox), hints)
		fmt.Printf("%s => entries:%d q1:%+v\n", f, len(m), m[1])
	}
}
