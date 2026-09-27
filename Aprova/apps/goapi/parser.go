package main

// Porte de apps/api/src/parser.ts — mesma semântica, mesmos regexes.
// Go/RE2 não tem lookahead: os dois pontos com (?=...) são emulados
// verificando o próximo rune manualmente após o match.

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"golang.org/x/text/runes"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"
)

type Alternative struct {
	Label string `json:"label"`
	Text  string `json:"text"`
}

type ParsedQuestion struct {
	Number       int           `json:"number"`
	Statement    string        `json:"statement"`
	Alternatives []Alternative `json:"alternatives"`
	PageNumber   int           `json:"pageNumber,omitempty"`
	Context      *string       `json:"context,omitempty"`
}

type ParsedAnswer struct {
	Number int    `json:"number"`
	Answer string `json:"answer"`
}

// Cabeça da questão SEM lookahead (emulado em matchQuestionStarts).
// Grupo 1 = com rótulo QUESTÃO N (aceita quebra de linha e minúscula).
// Grupo 2 = sem rótulo (só mesma linha).
var questionHeadRe = regexp.MustCompile(`(?:^|\s)[ \t]*(?:[Qq][Uu][Ee][Ss][Tt][AaãÃ][Oo][ \t]*(\d{1,3})[ \t]*(?:[.\-–):][ \t]*)?(?:\n[ \t]*)?|(\d{1,3})(?:[ \t]*[.\-–):][ \t]*|[ \t]+))`)

var alternativeStartRe = regexp.MustCompile(`(?im)(?:^|\n)\s*\(?([A-E])\s*[).\-–]\s+`)

func isStmtStartLabeled(r rune) bool {
	if r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= 0xC0 && r <= 0xFF {
		return true
	}
	switch r {
	case '"', '\'', '“', '‘', '(', '§':
		return true
	}
	return false
}

func isStmtStartStrict(r rune) bool {
	switch {
	case r >= 'A' && r <= 'Z':
		return true
	case strings.ContainsRune("ÁÉÍÓÚÂÊÔÃÕÇN", r):
		return true
	case r == '"' || r == '\'' || r == '“' || r == '‘' || r == '(' || r == '§':
		return true
	}
	return false
}

type qmatch struct {
	index int // byte offset do início do match (inclui \s consumido)
	end   int // byte offset do fim do match
	num   int
}

// nextRune devolve o primeiro rune em s[pos:] (bytes).
func nextRune(s string, pos int) (rune, bool) {
	if pos >= len(s) {
		return 0, false
	}
	for _, r := range s[pos:] {
		return r, true
	}
	return 0, false
}

func matchQuestionStarts(normalized string) []qmatch {
	var out []qmatch
	locs := questionHeadRe.FindAllStringSubmatchIndex(normalized, -1)
	for _, loc := range locs {
		if loc[0] < 0 {
			continue
		}
		var num int
		var labeled bool
		if loc[2] >= 0 {
			num, _ = strconv.Atoi(normalized[loc[2]:loc[3]])
			labeled = true
		} else {
			num, _ = strconv.Atoi(normalized[loc[4]:loc[5]])
		}
		r, ok := nextRune(normalized, loc[1])
		if !ok {
			continue
		}
		if labeled {
			if !isStmtStartLabeled(r) {
				continue
			}
		} else if !isStmtStartStrict(r) {
			continue
		}
		out = append(out, qmatch{index: loc[0], end: loc[1], num: num})
	}
	return out
}

var pageMarkerRe = regexp.MustCompile(`\[\[PAGE:(\d+)\]\]`)

func ParseQuestions(text string) []ParsedQuestion {
	normalized := strings.ReplaceAll(text, "\r", "")
	normalized = regexp.MustCompile(`[ \t]+`).ReplaceAllString(normalized, " ")
	matches := matchQuestionStarts(normalized)

	pageContexts := map[int]string{}
	var parts []string
	last := 0
	for _, loc := range pageMarkerRe.FindAllStringIndex(normalized, -1) {
		if loc[0] > last {
			parts = append(parts, normalized[last:loc[0]])
		}
		last = loc[0]
	}
	parts = append(parts, normalized[last:])
	for _, page := range parts {
		m := pageMarkerRe.FindStringSubmatch(page)
		if m == nil {
			continue
		}
		content := page[len(m[0]):]
		first := -1
		for _, q := range matchQuestionStarts(content) {
			first = q.index
			break
		}
		var context string
		if first >= 0 {
			context = cleanExtractedText(content[:first])
		} else {
			context = cleanExtractedText(content)
		}
		if len(context) >= 30 {
			n, _ := strconv.Atoi(m[1])
			pageContexts[n] = context
		}
	}

	// Fase 1+2 — mesmas regras do TS.
	lastNumber := 0
	var ordered []qmatch
	for i, match := range matches {
		start := match.end
		end := len(normalized)
		if i+1 < len(matches) {
			end = matches[i+1].index
		}
		block := strings.TrimSpace(normalized[start:end])
		if len(alternativeStartRe.FindAllString(block, -1)) < 2 {
			continue
		}
		if match.num <= lastNumber {
			continue
		}
		lastNumber = match.num
		ordered = append(ordered, match)
	}

	var out []ParsedQuestion
	for _, match := range ordered {
		var pageNumber int = 1
		for _, pm := range pageMarkerRe.FindAllStringSubmatch(normalized[:match.index], -1) {
			if n, err := strconv.Atoi(pm[1]); err == nil {
				pageNumber = n
			}
		}
		end := len(normalized)
		for _, candidate := range matches {
			if candidate.index > match.index {
				end = candidate.index
				break
			}
		}
		block := strings.TrimSpace(normalized[match.end:end])
		alts := alternativeStartRe.FindAllStringSubmatchIndex(block, -1)
		if block == "" {
			continue
		}
		ctx, hasCtx := pageContexts[pageNumber]
		if len(alts) == 0 {
			q := ParsedQuestion{Number: match.num, Statement: normalizeQuestionFlow(cleanExtractedText(block)), PageNumber: pageNumber}
			if hasCtx {
				c := ctx
				q.Context = &c
			}
			out = append(out, q)
			continue
		}
		statement := normalizeQuestionFlow(cleanExtractedText(block[:alts[0][0]]))
		var options []Alternative
		for oi, a := range alts {
			oStart := a[1]
			oEnd := len(block)
			if oi+1 < len(alts) {
				oEnd = alts[oi+1][0]
			}
			label := strings.ToUpper(block[a[2]:a[3]])
			options = append(options, Alternative{Label: label, Text: cleanAlternativeText(block[oStart:oEnd])})
		}
		q := ParsedQuestion{Number: match.num, Statement: statement, Alternatives: options, PageNumber: pageNumber}
		if hasCtx {
			c := ctx
			q.Context = &c
		}
		out = append(out, q)
	}
	return out
}

func stripTrailingOcrNoise(value string) string {
	tokens := strings.Fields(value)
	start := len(tokens)
	for start > 0 {
		token := tokens[start-1]
		if regexp.MustCompile(`[.,;:!?…)\]]$`).MatchString(token) {
			break
		}
		letters := regexp.MustCompile(`[^A-Za-zÀ-ÿ]`).ReplaceAllString(token, "")
		compact := regexp.MustCompile(`[^A-Za-zÀ-ÿ0-9]`).ReplaceAllString(token, "")
		lowerRe := regexp.MustCompile(`[a-záéíóúâêôãõç]`)
		suspicious := (letters != "" && !lowerRe.MatchString(token)) || len([]rune(compact)) <= 2
		if !suspicious {
			break
		}
		start--
	}
	if start == len(tokens) {
		return value
	}
	last := tokens[len(tokens)-1]
	lastLetters := regexp.MustCompile(`[^A-Za-zÀ-ÿ]`).ReplaceAllString(last, "")
	runes := []rune(lastLetters)
	isCaps := len(runes) >= 1 && len(runes) <= 4 && strings.ToUpper(lastLetters) == lastLetters
	if !isCaps {
		return value
	}
	return strings.TrimRight(strings.Join(tokens[:start], " "), " ")
}

var (
	cutRe1           = regexp.MustCompile(`(?i)(?:\b(?:TEXTO|QUADRO|TABELA|GR[ÁA]FICO|FIGURA)\s+[IVX\d]+\b|\btextos?[\s-]*base\b|\bdispon[íi]vel\s+em\s*[:：]|\bAcesso\s+em\s*[:：]|\bCONHECIMENTOS\s+[A-ZÁÉÍÓÚÇ ]+|\bCreate\s+table\b|\bselect\s+[A-Z_]+\s*\()`)
	cutRe2           = regexp.MustCompile(`(?i)(?:https?://|www\.|https?%3A|%2Fwww|\.com(?:\.br)?\b)`)
	embeddedNoiseRe  = regexp.MustCompile(`[A-Za-z0-9+/=_-]{24,}`)
	mergedQuestionRe = regexp.MustCompile(`(?i)\s+\d{1,3}\s+a\s+\d{1,3}\b.*$`)
	urlFragRe        = regexp.MustCompile(`%[0-9A-Fa-f]{2}|twsrc|twcamp|tweetembed|ref_url`)
	longFragRe       = regexp.MustCompile(`\s+[A-Za-z0-9%_\-]{20,}[^\s]*\s*$`)
)

func cleanAlternativeText(value string) string {
	cleaned := cleanExtractedText(value)
	cut := cutRe1.Split(cleaned, 2)[0]
	cut = cutRe2.Split(cut, 2)[0]
	cut = embeddedNoiseRe.Split(cut, 2)[0]
	cut = mergedQuestionRe.ReplaceAllString(cut, "")
	cut = longFragRe.ReplaceAllStringFunc(cut, func(m string) string {
		if urlFragRe.MatchString(m) {
			return ""
		}
		return m
	})
	var kept []string
	for _, line := range strings.Split(cut, "\n") {
		t := strings.TrimSpace(line)
		if t == "" {
			continue
		}
		if regexp.MustCompile(`%[0-9A-Fa-f]{2}`).MatchString(t) && len([]rune(regexp.MustCompile(`[^A-Za-z0-9%]`).ReplaceAllString(t, ""))) > 20 {
			continue
		}
		if regexp.MustCompile(`^(?:https?://|www\.)`).MatchString(t) {
			continue
		}
		if regexp.MustCompile(`twsrc|twcamp|tweetembed|ref_url`).MatchString(t) {
			continue
		}
		kept = append(kept, line)
	}
	return normalizeQuestionFlow(strings.Join(kept, "\n"))
}

func normalizeQuestionFlow(value string) string {
	// -\n + minúscula → junta com hífen (emula /-\n(?=\p{Ll})/u).
	var b strings.Builder
	runes := []rune(value)
	for i := 0; i < len(runes); i++ {
		if runes[i] == '-' && i+1 < len(runes) && runes[i+1] == '\n' {
			if i+2 < len(runes) && unicode.IsLower(runes[i+2]) {
				b.WriteRune('-')
				i++
				continue
			}
		}
		b.WriteRune(runes[i])
	}
	s := regexp.MustCompile(`\n+`).ReplaceAllString(b.String(), " ")
	s = regexp.MustCompile(`\s{2,}`).ReplaceAllString(s, " ")
	s = regexp.MustCompile(`\s+([,.;:!?])`).ReplaceAllString(s, "$1")
	s = regexp.MustCompile(`(?i)([.!?])\s+[A-D]$`).ReplaceAllString(s, "$1")
	return strings.TrimSpace(s)
}

var noiseRes = []*regexp.Regexp{
	regexp.MustCompile(`(?i)^\[\[PAGE:\d+\]\]$`),
	regexp.MustCompile(`^~?\s*\d+\s*~?$`),
	regexp.MustCompile(`(?i)^(?:https?://|www\.)\S+`),
	regexp.MustCompile(`(?i)^pci(?:markpci|concursos)`),
	regexp.MustCompile(`(?i)^cargo\s*:`),
	regexp.MustCompile(`(?i)^p[aá]gina\s+\d+`),
	regexp.MustCompile(`^[A-Za-z0-9+/=_-]{35,}$`),
	regexp.MustCompile(`(?i)(?:www\.|https?://|\.com\.br\b)`),
}

func cleanExtractedText(value string) string {
	var kept []string
	for _, line := range strings.Split(value, "\n") {
		t := strings.TrimSpace(line)
		if t == "" {
			continue
		}
		bad := false
		for _, re := range noiseRes {
			if re.MatchString(t) {
				bad = true
				break
			}
		}
		if !bad {
			kept = append(kept, t)
		}
	}
	s := strings.Join(kept, "\n")
	s = strings.TrimSpace(s)
	s = regexp.MustCompile(`[ \t]+([,.;:!?])`).ReplaceAllString(s, "$1")
	s = regexp.MustCompile(`([“‘(])\s+`).ReplaceAllString(s, "$1")
	s = regexp.MustCompile(`\s+([”’])`).ReplaceAllString(s, "$1")
	return s
}

func normalizedMatchText(value string) string {
	t, _, _ := transform.String(transform.Chain(norm.NFD, runes.Remove(runes.In(unicode.Mn)), norm.NFC), value)
	t = strings.ToLower(t)
	t = regexp.MustCompile(`[^a-z0-9]+`).ReplaceAllString(t, " ")
	return strings.TrimSpace(t)
}

// normalizeOcrDigits — porte manual (regex original usa lookbehind, sem RE2).
func normalizeOcrDigits(value string) string {
	r := []rune(value)
	isDigit := func(c rune) bool { return c >= '0' && c <= '9' }
	for i := 0; i < len(r); i++ {
		if (r[i] == 'O' || r[i] == 'o') && i+1 < len(r) && isDigit(r[i+1]) {
			r[i] = '0'
			continue
		}
		if (r[i] == 'l' || r[i] == 'L') && i > 0 && isDigit(r[i-1]) {
			if i+1 >= len(r) || r[i+1] == ' ' || r[i+1] == '\t' || r[i+1] == '\n' {
				r[i] = '1'
				continue
			}
		}
	}
	// Q…<letras> → 1 (ex.: "Ql 1" vira "Q1 1"): trata prefixo QUESTÃO/Q.
	s := string(r)
	s = regexp.MustCompile(`(?i)\b(Q(?:uest[aã]o)?\s*)[lL]+`).ReplaceAllStringFunc(s, func(m string) string {
		return regexp.MustCompile(`[lL]`).ReplaceAllString(m, "1")
	})
	s = replaceQO(s)
	return s
}

// replaceQO emula \b(Q(?:uest[aã]o)?\s*)O+(?=\s) sem lookahead.
func replaceQO(s string) string {
	re := regexp.MustCompile(`(?i)\bQ(?:uest[aã]o)?\s*O+`)
	var b strings.Builder
	last := 0
	for _, loc := range re.FindAllStringIndex(s, -1) {
		after := s[loc[1]:]
		if after == "" {
			continue
		}
		c := after[0]
		if c != ' ' && c != '\t' && c != '\n' && c != '\r' && c != '\f' && c != '\v' {
			continue
		}
		b.WriteString(s[last:loc[0]])
		frag := s[loc[0]:loc[1]]
		frag = strings.ReplaceAll(strings.ReplaceAll(frag, "O", "0"), "o", "0")
		b.WriteString(frag)
		last = loc[1]
	}
	b.WriteString(s[last:])
	return b.String()
}

var sameLinePairRe = regexp.MustCompile(`(?i)\b(\d{1,3})\s+([A-E])\b`)

func extractSameLinePairs(line string) []ParsedAnswer {
	cleaned := normalizeOcrDigits(line)
	var out []ParsedAnswer
	for _, m := range sameLinePairRe.FindAllStringSubmatch(cleaned, -1) {
		n, _ := strconv.Atoi(m[1])
		out = append(out, ParsedAnswer{Number: n, Answer: strings.ToUpper(m[2])})
	}
	return out
}

// removeQBorda — emula cleanLine.replace(/\bQ(?=\s*\d)/gi, "").
func removeQBeforeDigit(line string) string {
	re := regexp.MustCompile(`(?i)\bQ`)
	var b strings.Builder
	last := 0
	for _, loc := range re.FindAllStringIndex(line, -1) {
		rest := line[loc[1]:]
		i := 0
		for i < len(rest) && (rest[i] == ' ' || rest[i] == '\t' || rest[i] == '\n' || rest[i] == '\r') {
			i++
		}
		if i < len(rest) && rest[i] >= '0' && rest[i] <= '9' {
			b.WriteString(line[last:loc[0]])
			last = loc[1]
		}
	}
	b.WriteString(line[last:])
	return b.String()
}

func ParseAnswerKey(text, examHint string) []ParsedAnswer {
	rawLines := strings.Split(strings.ReplaceAll(text, "\r", ""), "\n")
	var lines []string
	for _, l := range rawLines {
		t := strings.TrimSpace(l)
		if t == "" {
			continue
		}
		lines = append(lines, regexp.MustCompile(`\s+`).ReplaceAllString(t, " "))
	}
	type section struct {
		title   string
		cargo   string
		answers []ParsedAnswer
	}
	var tabular []section
	currentCargo := ""
	digitRe := regexp.MustCompile(`\b(\d{1,3})\b`)
	letterRe := regexp.MustCompile(`(?i)\b([A-E])\b`)
	headerRe := regexp.MustCompile(`(?i)(?:quest[aã]o|prova\s+tipo|tipo\s+\d)`)
	for index := 0; index < len(lines); index++ {
		if regexp.MustCompile(`(?i)^gabarito oficial`).MatchString(lines[index]) {
			for back := index - 1; back >= 0 && back >= index-6; back-- {
				candidate := lines[back]
				if candidate == "" || regexp.MustCompile(`(?i)^(?:prova\s+|concurso\s+|prefeitura\s+|n[ií]vel\s+)`).MatchString(candidate) {
					continue
				}
				currentCargo = candidate
				break
			}
			continue
		}
		cleanLine := removeQBeforeDigit(lines[index])
		var lineDigits []int
		for _, m := range digitRe.FindAllStringSubmatch(cleanLine, -1) {
			n, _ := strconv.Atoi(m[1])
			lineDigits = append(lineDigits, n)
		}
		var lineLetters []string
		for _, m := range letterRe.FindAllStringSubmatch(lines[index], -1) {
			lineLetters = append(lineLetters, strings.ToUpper(m[1]))
		}
		var nextLetters []string
		if index < len(lines)-1 {
			for _, m := range letterRe.FindAllStringSubmatch(lines[index+1], -1) {
				nextLetters = append(nextLetters, strings.ToUpper(m[1]))
			}
		}
		isHeader := headerRe.MatchString(lines[index])
		sameLinePairs := extractSameLinePairs(lines[index])

		allGe := true
		for _, n := range lineDigits {
			if n < 1 || n > 99 {
				allGe = false
			}
		}
		hasSplitPairs := len(lineDigits) >= 3 && len(nextLetters) >= 2 && allGe
		hasMixedPairs := len(sameLinePairs) >= 2 && len(lineDigits) >= 2 && len(lineLetters) >= 2
		hasSoloPair := len(sameLinePairs) == 1 && len(lineDigits) >= 1 && len(lineLetters) >= 2
		hasAnswerRow := len(lineLetters) >= 4 && len(nextLetters) == 0 && len(lineDigits) == 0

		if isHeader {
			continue
		}
		if !hasSplitPairs && !hasMixedPairs && !hasSoloPair && !hasAnswerRow {
			continue
		}

		var answers []ParsedAnswer
		if hasSplitPairs {
			cells := nextLetters
			if len(cells) == 0 {
				cells = lineLetters
			}
			for i, num := range lineDigits {
				if i < len(cells) && cells[i] != "" {
					answers = append(answers, ParsedAnswer{Number: num, Answer: cells[i]})
				}
			}
		} else if hasMixedPairs || hasSoloPair {
			answers = sameLinePairs
		}

		need := 1
		if !hasSoloPair {
			need = 2
		}
		if len(answers) < need {
			continue
		}

		heading := ""
		for cursor := index - 1; cursor >= 0; cursor-- {
			if regexp.MustCompile(`(?i)^[A-E\s]+$`).MatchString(lines[cursor]) && !regexp.MustCompile(`[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-z]`).MatchString(lines[cursor]) {
				continue
			}
			if regexp.MustCompile(`(?i)^Q\s*\d+`).MatchString(lines[cursor]) {
				continue
			}
			if regexp.MustCompile(`(?i)^(?:www\.|pcimarkpci|concurso|prefeitura|gabarito|n[ií]vel\b)`).MatchString(lines[cursor]) {
				continue
			}
			if regexp.MustCompile(`^[A-Za-z0-9+/=_-]{20,}`).MatchString(lines[cursor]) {
				continue
			}
			if regexp.MustCompile(`^[a-zà-ú]`).MatchString(lines[cursor]) {
				continue
			}
			if regexp.MustCompile(`^\d+\s+a\s+\d+$`).MatchString(lines[cursor]) {
				continue
			}
			if regexp.MustCompile(`(?i)^quest[õo]es\s*\(`).MatchString(lines[cursor]) {
				continue
			}
			if regexp.MustCompile(`^\d`).MatchString(lines[cursor]) {
				continue
			}
			heading = lines[cursor]
			break
		}
		found := -1
		for i, s := range tabular {
			if s.title == heading && s.cargo == currentCargo {
				found = i
				break
			}
		}
		if found < 0 {
			tabular = append(tabular, section{title: heading, cargo: currentCargo})
			found = len(tabular) - 1
		}
		tabular[found].answers = append(tabular[found].answers, answers...)
	}

	if len(tabular) > 0 {
		var cargo string
		if m := regexp.MustCompile(`(?i)(?:^|\n)\s*CARGO\s*:\s*([^\n]+)`).FindStringSubmatch(examHint); m != nil {
			cargo = m[1]
		} else {
			parts := strings.Split(examHint, "\n")
			if len(parts) > 80 {
				parts = parts[:80]
			}
			cargo = strings.Join(parts, " ")
		}
		hint := normalizedMatchText(cargo)
		htok := strings.Fields(hint)
		hintSet := map[string]bool{}
		for _, t := range htok {
			t = strings.TrimSuffix(t, "s")
			if len([]rune(t)) >= 4 {
				hintSet[t] = true
			}
		}
		examTipo := ""
		if m := regexp.MustCompile(`(?i)\bTIPO\s*([A-D])\b`).FindStringSubmatch(examHint); m != nil {
			examTipo = strings.ToUpper(m[1])
		}
		tipoOf := func(name string) string {
			if m := regexp.MustCompile(`(?i)\(TIPO\s*([A-D])\)\s*$`).FindStringSubmatch(name); m != nil {
				return strings.ToUpper(m[1])
			}
			return ""
		}
		baseOf := func(name string) string {
			return strings.TrimSpace(regexp.MustCompile(`(?i)\s*\(TIPO\s*[A-D]\)\s*$`).ReplaceAllString(name, ""))
		}
		type group struct {
			name    string
			answers []ParsedAnswer
		}
		cargoGroups := map[string]*group{}
		var order []string
		for _, s := range tabular {
			key := s.cargo
			if key == "" {
				key = s.title
			}
			g := cargoGroups[key]
			if g == nil {
				g = &group{name: key}
				cargoGroups[key] = g
				order = append(order, key)
			}
			seen := map[int]bool{}
			for _, it := range g.answers {
				seen[it.Number] = true
			}
			for _, it := range s.answers {
				if !seen[it.Number] {
					g.answers = append(g.answers, it)
					seen[it.Number] = true
				}
			}
		}
		var entries []*group
		for _, k := range order {
			entries = append(entries, cargoGroups[k])
		}
		if examTipo != "" {
			var matching []*group
			for _, g := range entries {
				if t := tipoOf(g.name); t == "" || t == examTipo {
					matching = append(matching, g)
				}
			}
			if len(matching) > 0 {
				entries = matching
			}
		}
		type ranked struct {
			name    string
			answers []ParsedAnswer
			score   int
		}
		var rankedList []ranked
		for _, g := range entries {
			toks := strings.Fields(normalizedMatchText(g.name))
			var kept []string
			for _, t := range toks {
				t = strings.TrimSuffix(t, "s")
				if len([]rune(t)) >= 4 {
					kept = append(kept, t)
				}
			}
			matches := 0
			for _, t := range kept {
				if hintSet[t] {
					matches++
				}
			}
			rankedList = append(rankedList, ranked{name: g.name, answers: g.answers, score: matches*10 - abs(len(kept)-len(hintSet))})
		}
		for i := 0; i < len(rankedList); i++ {
			for j := i + 1; j < len(rankedList); j++ {
				aj, bj := rankedList[i], rankedList[j]
				if bj.score > aj.score || (bj.score == aj.score && len(bj.answers) > len(aj.answers)) {
					rankedList[i], rankedList[j] = rankedList[j], rankedList[i]
				}
			}
		}
		if len(rankedList) > 0 {
			if examTipo == "" {
				topBase := baseOf(rankedList[0].name)
				tipos := map[string]bool{}
				for _, g := range entries {
					if baseOf(g.name) == topBase {
						if t := tipoOf(g.name); t != "" {
							tipos[t] = true
						}
					}
				}
				if len(tipos) > 1 {
					return []ParsedAnswer{}
				}
			}
			return rankedList[0].answers
		}
	}

	normalized := regexp.MustCompile(`\s+`).ReplaceAllString(strings.ReplaceAll(normalizeOcrDigits(text), "\r", " "), " ")
	patterns := []*regexp.Regexp{
		regexp.MustCompile(`(?i)(?:quest[aã]o\s*)?(\d{1,3})\s*[.\-–):]?\s*([A-E])\b`),
		regexp.MustCompile(`(?i)\b(\d{1,3})\s+([A-E])\b`),
	}
	for _, pattern := range patterns {
		var answers []ParsedAnswer
		for _, m := range pattern.FindAllStringSubmatch(normalized, -1) {
			n, _ := strconv.Atoi(m[1])
			answers = append(answers, ParsedAnswer{Number: n, Answer: strings.ToUpper(m[2])})
		}
		if len(answers) > 0 {
			// Última ocorrência vence por número (Map do TS sobrescreve,
			// mantendo a ordem da primeira aparição).
			byNum := map[int]ParsedAnswer{}
			var nums []int
			for _, a := range answers {
				if _, ok := byNum[a.Number]; !ok {
					nums = append(nums, a.Number)
				}
				byNum[a.Number] = a
			}
			res := make([]ParsedAnswer, 0, len(nums))
			for _, n := range nums {
				res = append(res, byNum[n])
			}
			return res
		}
	}
	return []ParsedAnswer{}
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

func InferExamTitle(text, filename string) string {
	lines := strings.Split(strings.ReplaceAll(text, "\r", ""), "\n")
	var filtered []string
	for _, line := range lines {
		t := strings.TrimSpace(regexp.MustCompile(`\s+`).ReplaceAllString(line, " "))
		if len([]rune(t)) >= 4 && len([]rune(t)) <= 100 && regexp.MustCompile(`[A-Za-zÀ-ÿ]`).MatchString(t) {
			filtered = append(filtered, t)
		}
	}
	ignored := regexp.MustCompile(`(?i)^(p[aá]gina|quest[aã]o|instru[cç][oõ]es|leia|nome|assinatura|dura[cç][aã]o|marque|aguarde)\b`)
	signals := regexp.MustCompile(`(?i)\b(prefeitura|munic[ií]pio|estado|tribunal|universidade|instituto|concurso|processo seletivo|vestibular|gurupi|palmas|cargo|analista|professor|t[eé]cnico|agente)\b`)
	type cand struct {
		line  string
		score int
	}
	var best *cand
	for i, line := range filtered {
		if ignored.MatchString(line) {
			continue
		}
		score := 0
		if signals.MatchString(line) {
			score += 5
		}
		if regexp.MustCompile(`\b20\d{2}\b`).MatchString(line) {
			score += 2
		}
		if i < 12 {
			score += 2
		}
		if len([]rune(line)) < 65 {
			score += 1
		}
		// TS usa sort instável com [0] — primeiro de maior score na ordem filtrada;
		// aqui: mantém o primeiro em caso de empate (score estritamente maior troca).
		if best == nil || score > best.score {
			best = &cand{line, score}
		}
	}
	fallback := strings.TrimSpace(regexp.MustCompile(`\s+`).ReplaceAllString(strings.ReplaceAll(strings.ReplaceAll(filename, ".pdf", ""), "_", " "), " "))
	fallback = strings.ReplaceAll(fallback, "-", " ")
	fallback = strings.TrimSpace(regexp.MustCompile(`\s+`).ReplaceAllString(fallback, " "))
	if best == nil {
		if fallback == "" {
			fallback = "Prova sem título"
		}
		return FormatExamTitleFallback(fallback)
	}
	return FormatExamTitleFallback(best.line)
}

// FormatExamTitleFallback preserva a capitalização original do texto extraído.
func FormatExamTitleFallback(title string) string {
	title = strings.ReplaceAll(title, "_", " ")
	return strings.Join(strings.Fields(title), " ")
}

func InferExamBoard(text string) string {
	normalized := regexp.MustCompile(`[ \t]+`).ReplaceAllString(strings.ReplaceAll(text, "\r", "\n"), " ")
	if m := regexp.MustCompile(`(?i)\b(?:banca|organizadora|institui[cç][aã]o\s+organizadora|executor[ao]|respons[aá]vel)\s*[:\-–]\s*([^\n]{2,80})`).FindStringSubmatch(normalized); m != nil {
		if c := cleanBoardName(m[1]); c != "" {
			return c
		}
	}
	knownBoards := []string{
		"CEBRASPE", "CESPE", "FGV", "FCC", "VUNESP", "IBFC", "INSTITUTO AOCP", "AOCP", "IDECAN",
		"QUADRIX", "FUNDATEC", "FADESP", "CONSULPLAN", "IBADE", "FUNCERN", "CETAP", "SELECON",
		"IESES", "OBJETIVA", "LEGALLE", "AVANÇA SP", "FUMARC", "CONSULPAM", "INSTITUTO MAIS",
		"FEPESE", "COPESE", "COPEVE", "NC-UFPR", "FAUEL", "AUJURI",
	}
	searchable := strings.ToUpper(normalized)
	for _, board := range knownBoards {
		idx := 0
		for {
			pos := strings.Index(searchable[idx:], board)
			if pos < 0 {
				break
			}
			pos += idx
			if isBoardBoundary(searchable, pos-1, false) && isBoardBoundary(searchable, pos+len(board), true) {
				return board
			}
			idx = pos + 1
		}
	}
	return ""
}

func isBoardBoundary(s string, pos int, after bool) bool {
	var r rune
	if after {
		if pos >= len(s) {
			return true
		}
		for _, c := range s[pos:] {
			r = c
			break
		}
	} else {
		if pos < 0 {
			return true
		}
		for _, c := range s[:pos+1] {
			r = c
		}
		// último rune antes de pos+1
		rs := []rune(s[:pos+1])
		r = rs[len(rs)-1]
	}
	if r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
		return false
	}
	if r >= 0xC0 && r <= 0xDA {
		return false
	}
	return true
}

func cleanBoardName(value string) string {
	s := regexp.MustCompile(`(?i)\s{2,}|(?:\s+-\s+)|(?:\s+–\s+)|\b(?:prova|cargo|edital|concurso|data)\b`).Split(value, 2)[0]
	s = strings.TrimRight(s, ".;,")
	s = strings.TrimSpace(regexp.MustCompile(`\s+`).ReplaceAllString(s, " "))
	s = strings.ToUpper(s)
	if len([]rune(s)) > 40 {
		s = string([]rune(s)[:40])
	}
	return s
}

func escapeRegExp(value string) string {
	var b strings.Builder
	for _, r := range value {
		if strings.ContainsRune(`.*+?^${}()|[]\`, r) {
			b.WriteRune('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

func MissingNumbers(numbers []int) []int {
	if len(numbers) == 0 {
		return []int{}
	}
	present := map[int]bool{}
	max := numbers[0]
	for _, n := range numbers {
		present[n] = true
		if n > max {
			max = n
		}
	}
	var out []int
	for n := 1; n <= max; n++ {
		if !present[n] {
			out = append(out, n)
		}
	}
	if out == nil {
		return []int{}
	}
	return out
}
