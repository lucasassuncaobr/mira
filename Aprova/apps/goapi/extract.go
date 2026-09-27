package main

// Porte de apps/api/python/pdf_extract.py (group_lines, find_gutter,
// reading_order_text) — mesma ordem de leitura, mesmos limiares.
// O pdftool entrega só palavras brutas; a inteligência mora aqui em Go.

import (
	"math"
	"sort"
	"strings"
)

type rawWord struct {
	x0, top, x1, bottom float64
	text                string
}

func groupLines(raw []rawWord) [][]rawWord {
	if len(raw) == 0 {
		return nil
	}
	ordered := append([]rawWord{}, raw...)
	sort.Slice(ordered, func(i, j int) bool {
		if ordered[i].top != ordered[j].top {
			return ordered[i].top < ordered[j].top
		}
		return ordered[i].x0 < ordered[j].x0
	})
	hs := make([]float64, len(ordered))
	for i, w := range ordered {
		hs[i] = w.bottom - w.top
	}
	sort.Float64s(hs)
	medianH := hs[len(hs)/2]
	tol := medianH * 0.6
	if tol < 2.0 {
		tol = 2.0
	}
	var lines [][]rawWord
	for _, w := range ordered {
		if len(lines) > 0 && math.Abs(w.top-lines[len(lines)-1][0].top) <= tol {
			lines[len(lines)-1] = append(lines[len(lines)-1], w)
		} else {
			lines = append(lines, []rawWord{w})
		}
	}
	for _, ln := range lines {
		sort.Slice(ln, func(i, j int) bool { return ln[i].x0 < ln[j].x0 })
	}
	return lines
}

func splitFragments(line []rawWord, minGap float64) [][]rawWord {
	var frags [][]rawWord
	current := []rawWord{line[0]}
	for i := 1; i < len(line); i++ {
		if line[i].x0-line[i-1].x1 > minGap {
			frags = append(frags, current)
			current = []rawWord{line[i]}
		} else {
			current = append(current, line[i])
		}
	}
	return append(frags, current)
}

func findGutter(raw []rawWord, pageW, pageH float64) *float64 {
	if len(raw) < 20 {
		return nil
	}
	var best *float64
	var bestScore int
	first := true
	for x := pageW * 0.35; x <= pageW*0.65; x += 5 {
		straddle := 0
		left, right := false, false
		for _, w := range raw {
			if w.x0 < x && x < w.x1 {
				straddle++
			}
			if w.x1 <= x {
				left = true
			}
			if w.x0 >= x {
				right = true
			}
		}
		if left && right && (first || straddle < bestScore) {
			v := x
			best, bestScore, first = &v, straddle, false
		}
	}
	if best == nil {
		return nil
	}
	bandY := 0.0
	for _, w := range raw {
		if w.x0 < *best-12 && w.x1 > *best+12 {
			lo := w.top
			if lo < 0 {
				lo = 0
			}
			hi := w.bottom
			if hi > pageH {
				hi = pageH
			}
			if hi > lo {
				bandY += hi - lo
			}
		}
	}
	if bandY > pageH*0.25 {
		return nil
	}
	return best
}

func fragText(frag []rawWord) string {
	parts := make([]string, 0, len(frag))
	for _, w := range frag {
		parts = append(parts, w.text)
	}
	return strings.Join(parts, " ")
}

func readingOrderText(lines [][]rawWord, gutter *float64, pageH float64) string {
	if gutter == nil {
		out := make([]string, 0, len(lines))
		for _, ln := range lines {
			out = append(out, fragText(ln))
		}
		return strings.Join(out, "\n")
	}
	g := *gutter
	var header, left, middle, right, footer []string
	pushSides := func(frag []rawWord) {
		var lpart, rpart, cross []rawWord
		for _, w := range frag {
			switch {
			case w.x1 <= g+2:
				lpart = append(lpart, w)
			case w.x0 >= g-2:
				rpart = append(rpart, w)
			default:
				cross = append(cross, w)
			}
		}
		if len(cross) > 0 && len(lpart) == 0 && len(rpart) == 0 {
			top := frag[0].top
			for _, w := range frag {
				if w.top < top {
					top = w.top
				}
			}
			text := fragText(frag)
			switch {
			case top < pageH*0.12:
				header = append(header, text)
			case top > pageH*0.90:
				footer = append(footer, text)
			default:
				middle = append(middle, text)
			}
			return
		}
		var ls, rs []rawWord
		ls = append(ls, lpart...)
		rs = append(rs, rpart...)
		for _, w := range cross {
			if (w.x0+w.x1)/2 <= g {
				ls = append(ls, w)
			} else {
				rs = append(rs, w)
			}
		}
		if len(ls) > 0 {
			left = append(left, fragText(ls))
		}
		if len(rs) > 0 {
			right = append(right, fragText(rs))
		}
	}
	for _, ln := range lines {
		for _, frag := range splitFragments(ln, 40) {
			pushSides(frag)
		}
	}
	out := append(append(append(append(header, left...), middle...), right...), footer...)
	return strings.Join(out, "\n")
}

// orderedPageText reconstrói o texto de leitura de uma página do pdftool.
func orderedPageText(words []pdfWord, pageW, pageH float64) string {
	raw := make([]rawWord, 0, len(words))
	for _, w := range words {
		raw = append(raw, rawWord{x0: w.X0, top: w.Top, x1: w.X1, bottom: w.Bottom, text: w.Text})
	}
	return readingOrderText(groupLines(raw), findGutter(raw, pageW, pageH), pageH)
}
