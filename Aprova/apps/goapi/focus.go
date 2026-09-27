package main

// Porte de apps/api/src/focus.ts — mesmos ranks, mesmas fórmulas.
// Regexes sem lookahead: port direto para RE2.

import (
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"golang.org/x/text/runes"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"
)

type FocusEntry struct {
	Page        int     `json:"page"`
	YInicio     float64 `json:"y_inicio"`
	XCenter     float64 `json:"x_center"`
	FocusHeight float64 `json:"focus_height"`
	FocusScale  float64 `json:"focus_scale"`
}

type FocusHint struct {
	Number     int
	PageNumber *int
}

type candidate struct {
	number    int
	page      int
	yMin      float64
	xMin      float64
	xMax      float64
	pageW     float64
	pageH     float64
	rank      int
	lineStart bool
}

type bboxLine struct {
	page  int
	text  string
	xMin  float64
	xMax  float64
	yMin  float64
	yMax  float64
	pageW float64
	pageH float64
}

func round2(v float64) float64 {
	return math.Round(v*100) / 100
}

func stripDiacritics(s string) string {
	t, _, _ := transform.String(transform.Chain(norm.NFD, runes.Remove(runes.In(unicode.Mn)), norm.NFC), s)
	return t
}

func lowerNoDiacritics(s string) string {
	return strings.ToLower(stripDiacritics(s))
}

var bboxTokenRe = regexp.MustCompile(`<page\s+width="([\d.]+)"\s+height="([\d.]+)"|<word\s+xMin="([\d.]+)"\s+yMin="([\d.]+)"\s+xMax="([\d.]+)"\s+yMax="([\d.]+)">([^<]*)</word>`)
var numericWordRe = regexp.MustCompile(`^(\d{1,3})([.)])?$`)

func parseBboxCandidates(bboxText string) []candidate {
	var out []candidate
	page := 0
	var pageW, pageH float64
	previousWord := ""
	previousLineY := math.NaN()
	for _, m := range bboxTokenRe.FindAllStringSubmatch(bboxText, -1) {
		if m[1] != "" {
			page++
			pageW, _ = strconv.ParseFloat(m[1], 64)
			pageH, _ = strconv.ParseFloat(m[2], 64)
			previousWord = ""
			previousLineY = math.NaN()
			continue
		}
		xMin, _ := strconv.ParseFloat(m[3], 64)
		yMin, _ := strconv.ParseFloat(m[4], 64)
		xMax, _ := strconv.ParseFloat(m[5], 64)
		yMax, _ := strconv.ParseFloat(m[6], 64)
		word := strings.TrimSpace(m[7])
		if word == "" || pageW == 0 || pageH == 0 {
			continue
		}
		lineH := yMax - yMin
		tol := 2.5
		if lineH*0.65 > tol {
			tol = lineH * 0.65
		}
		lineStart := math.IsNaN(previousLineY) || math.Abs(yMin-previousLineY) > tol
		inBody := yMin > pageH*0.03 && yMax < pageH*0.97
		nm := numericWordRe.FindStringSubmatch(word)
		label := ""
		if !lineStart {
			label = lowerNoDiacritics(previousWord)
		}
		if nm != nil && inBody {
			hasSeparator := nm[2] != ""
			fromLabel := label == "questao" || label == "questão" || label == "q"
			nearQuestionColumn := xMin < pageW*0.24
			rank := 0
			if fromLabel {
				rank += 120
			}
			if lineStart {
				rank += 90
			}
			if nearQuestionColumn {
				rank += 20
			}
			if hasSeparator {
				rank += 35
			}
			if lineStart || fromLabel || hasSeparator {
				rank += 20
			}
			n, _ := strconv.Atoi(nm[1])
			out = append(out, candidate{number: n, page: page, yMin: yMin, xMin: xMin, xMax: xMax, pageW: pageW, pageH: pageH, rank: rank, lineStart: lineStart})
		}
		previousWord = word
		previousLineY = yMin
	}
	return out
}

func parseBboxLines(bboxText string) []bboxLine {
	var lines []bboxLine
	page := 0
	var pageW, pageH float64
	var current *bboxLine
	flush := func() {
		if current != nil && strings.TrimSpace(current.text) != "" {
			c := *current
			c.text = strings.TrimSpace(c.text)
			lines = append(lines, c)
		}
		current = nil
	}
	for _, m := range bboxTokenRe.FindAllStringSubmatch(bboxText, -1) {
		if m[1] != "" {
			flush()
			page++
			pageW, _ = strconv.ParseFloat(m[1], 64)
			pageH, _ = strconv.ParseFloat(m[2], 64)
			continue
		}
		xMin, _ := strconv.ParseFloat(m[3], 64)
		yMin, _ := strconv.ParseFloat(m[4], 64)
		xMax, _ := strconv.ParseFloat(m[5], 64)
		yMax, _ := strconv.ParseFloat(m[6], 64)
		word := strings.TrimSpace(m[7])
		if word == "" || pageW == 0 || pageH == 0 {
			continue
		}
		lineH := yMax - yMin
		tol := 2.5
		if lineH*0.65 > tol {
			tol = lineH * 0.65
		}
		sameLine := current != nil && current.page == page && math.Abs(yMin-current.yMin) <= tol
		if !sameLine {
			flush()
			current = &bboxLine{page: page, text: word, xMin: xMin, xMax: xMax, yMin: yMin, yMax: yMax, pageW: pageW, pageH: pageH}
		} else {
			current.text += " " + word
			if xMin < current.xMin {
				current.xMin = xMin
			}
			if xMax > current.xMax {
				current.xMax = xMax
			}
			if yMin < current.yMin {
				current.yMin = yMin
			}
			if yMax > current.yMax {
				current.yMax = yMax
			}
		}
	}
	flush()
	return lines
}

var nonLetterRe = regexp.MustCompile(`[^\p{L}]`)

func isSectionHeading(line bboxLine) bool {
	letters := nonLetterRe.ReplaceAllString(stripDiacritics(line.text), "")
	if len([]rune(letters)) < 6 {
		return false
	}
	upper := 0
	for _, r := range letters {
		if unicode.IsUpper(r) {
			upper++
		}
	}
	uppercase := float64(upper) / float64(len([]rune(letters)))
	centered := line.xMin > line.pageW*0.08 && line.xMax < line.pageW*0.92
	return centered && uppercase > 0.86
}

var textoBaseRe = regexp.MustCompile(`^\s*Texto\s+base\s+para\s+as\s+quest`)

func estimateQuestionBottom(best candidate, next *candidate, lines []bboxLine) float64 {
	var samePageNext *candidate
	if next != nil && next.page == best.page {
		samePageNext = next
	}
	limit := best.yMin + best.pageH*0.48
	if samePageNext != nil {
		limit = samePageNext.yMin - best.pageH*0.012
	}
	nextPage := best.page
	if next != nil {
		nextPage = next.page
	}
	var relevant []bboxLine
	for _, line := range lines {
		if line.page < best.page || line.page > nextPage {
			continue
		}
		if line.page == best.page && line.yMax < best.yMin-2 {
			continue
		}
		if line.page == best.page && line.yMin >= limit {
			continue
		}
		if line.page > best.page && samePageNext != nil {
			continue
		}
		relevant = append(relevant, line)
	}
	sort.Slice(relevant, func(i, j int) bool {
		if relevant[i].page != relevant[j].page {
			return relevant[i].page < relevant[j].page
		}
		return relevant[i].yMin < relevant[j].yMin
	})
	startsRe := regexp.MustCompile(`^\s*` + strconv.Itoa(best.number) + `(?:[.)]\s*|\s+)`)
	nextQRe := regexp.MustCompile(`^\s*\d{1,3}(?:[.)]\s*|\s+)`)
	splitRe := regexp.MustCompile(`[.)\s]`)
	started := false
	lastY := best.yMin
	lastPage := best.page
	for _, line := range relevant {
		startsQuestion := startsRe.MatchString(line.text)
		if !started && !startsQuestion {
			continue
		}
		if !started {
			started = true
			lastY = line.yMax
			lastPage = line.page
			continue
		}
		if nextQRe.MatchString(line.text) && !startsQuestion && line.page == best.page {
			maybeNext, err := strconv.Atoi(splitRe.Split(strings.TrimSpace(line.text), 2)[0])
			if err == nil && maybeNext != best.number && line.yMin > best.yMin+10 {
				break
			}
		}
		if isSectionHeading(line) {
			break
		}
		if textoBaseRe.MatchString(line.text) && line.yMin > lastY+5 {
			break
		}
		if line.yMax > lastY {
			lastY = line.yMax
		}
		lastPage = line.page
	}
	if lastPage == best.page && samePageNext == nil {
		return math.Min(best.pageH, math.Max(best.yMin+best.pageH*0.14, lastY+best.pageH*0.028))
	}
	return math.Min(best.pageH, math.Max(best.yMin+best.pageH*0.12, lastY+best.pageH*0.022))
}

func isAlternativeStart(line bboxLine) bool {
	t := strings.TrimSpace(line.text)
	if regexp.MustCompile(`^\([A-E]\)\s+`).MatchString(t) {
		return true
	}
	if regexp.MustCompile(`^[A-E][\)\.\-—]\s+`).MatchString(t) {
		return true
	}
	if regexp.MustCompile(`^[A-E]\s+[a-zà-ú]`).MatchString(t) && len(strings.Fields(t)) >= 3 && len(t) > 6 {
		return true
	}
	return false
}

func estimateStatementBottom(best candidate, lines []bboxLine) float64 {
	limit := best.yMin + best.pageH*0.42
	var relevant []bboxLine
	for _, line := range lines {
		if line.page == best.page && line.yMin >= best.yMin-2 && line.yMin < limit {
			relevant = append(relevant, line)
		}
	}
	sort.Slice(relevant, func(i, j int) bool { return relevant[i].yMin < relevant[j].yMin })
	startsRe := regexp.MustCompile(`^\s*` + strconv.Itoa(best.number) + `(?:[.)]\s*|\s+)`)
	started := false
	lastY := best.yMin
	var firstAltY *float64
	for _, line := range relevant {
		startsQuestion := startsRe.MatchString(line.text)
		if !started && !startsQuestion {
			continue
		}
		if !started {
			started = true
			lastY = line.yMax
			continue
		}
		if isAlternativeStart(line) {
			y := line.yMin
			firstAltY = &y
			break
		}
		if isSectionHeading(line) {
			break
		}
		if textoBaseRe.MatchString(line.text) {
			break
		}
		if line.yMax > lastY {
			lastY = line.yMax
		}
	}
	var bottom float64
	if firstAltY != nil {
		bottom = *firstAltY - best.pageH*0.008
	} else {
		bottom = lastY + best.pageH*0.012
	}
	minBottom := best.yMin + best.pageH*0.06
	if bottom < minBottom {
		bottom = minBottom
	}
	if bottom > best.pageH {
		bottom = best.pageH
	}
	return bottom
}

func selectEntries(candidates []candidate, lines []bboxLine, hints []FocusHint) map[int]FocusEntry {
	entries := map[int]FocusEntry{}
	for _, hint := range hints {
		if _, ok := entries[hint.Number]; ok {
			continue
		}
		var found []candidate
		for _, c := range candidates {
			if c.number == hint.Number {
				found = append(found, c)
			}
		}
		if len(found) == 0 {
			continue
		}
		var onPage []candidate
		if hint.PageNumber != nil {
			for _, c := range found {
				if c.page == *hint.PageNumber {
					onPage = append(onPage, c)
				}
			}
		}
		pool := found
		if len(onPage) > 0 {
			pool = onPage
		}
		best := pool[0]
		for _, c := range pool[1:] {
			if c.rank > best.rank || (c.rank == best.rank && (c.page < best.page || (c.page == best.page && c.yMin < best.yMin))) {
				best = c
			}
		}
		var next *candidate
		for i, c := range candidates {
			if c.page == best.page && c.yMin > best.yMin+4 && math.Abs(c.xMin-best.xMin) < best.pageW*0.12 {
				if next == nil || c.yMin < next.yMin {
					cp := candidates[i]
					next = &cp
				}
			}
		}
		top := best.yMin - best.pageH*0.01
		if top < 0 {
			top = 0
		}
		// Faixa cobre a questão inteira (igual ao TS atual).
		bottom := estimateQuestionBottom(best, next, lines)
		var columnLeft, columnRight float64
		if best.xMin < best.pageW/2 {
			columnLeft = best.xMin - best.pageW*0.03
			if columnLeft < 0 {
				columnLeft = 0
			}
			columnRight = best.pageW / 2
		} else {
			columnLeft = best.pageW / 2
			if v := best.xMin - best.pageW*0.03; v > columnLeft {
				columnLeft = v
			}
			columnRight = best.pageW
		}
		width := (columnRight - columnLeft) / best.pageW
		if width < 0.28 {
			width = 0.28
		}
		height := (bottom - top) / best.pageH
		if height < 0.12 {
			height = 0.12
		}
		fh := (bottom - top) / best.pageH * 100
		if fh < 4 {
			fh = 4
		}
		fs := 0.94 / width
		if v := 0.86 / height; v < fs {
			fs = v
		}
		if fs < 1.65 {
			fs = 1.65
		}
		if fs > 3.2 {
			fs = 3.2
		}
		entries[hint.Number] = FocusEntry{
			Page:        best.page,
			YInicio:     round2(top / best.pageH * 100),
			XCenter:     round2(((best.xMin + best.xMax) / 2 / best.pageW) * 100),
			FocusHeight: round2(fh),
			FocusScale:  fs,
		}
	}
	return entries
}
