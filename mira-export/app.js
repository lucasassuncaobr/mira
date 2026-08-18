document.addEventListener('DOMContentLoaded', function() {
    const totalQuestions = 10;
    let currentQuestion = 1;
    let selectedAnswer = null;
    let respondMode = 'answer';

    // Questões reais de Português
    const questions = {
        1: {
            text: 'Assinale a alternativa em que todas as palavras estão classificadas corretamente quanto aos tempos verbais indicados.',
            options: [
                { letter: 'A', text: 'presente do indicativo, imperativo, presente do indicativo, presente do indicativo, presente do indicativo, presente do indicativo, pretérito perfeito do indicativo, imperativo, presente do subjuntivo, infinitivo, imperfeito do indicativo.' },
                { letter: 'B', text: 'presente do indicativo, imperativo, presente do indicativo, presente do indicativo, presente do indicativo, presente do indicativo, pretérito imperfeito do indicativo, imperativo, presente do subjuntivo, infinitivo, imperfeito do indicativo.' },
                { letter: 'C', text: 'presente do subjuntivo, imperativo, presente do indicativo, presente do indicativo, presente do indicativo, presente do indicativo, pretérito perfeito do indicativo, imperativo, presente do subjuntivo, infinitivo, imperfeito do indicativo.' },
                { letter: 'D', text: 'presente do indicativo, imperativo, presente do indicativo, presente do indicativo, presente do indicativo, presente do indicativo, pretérito perfeito do indicativo, imperativo, presente do subjuntivo, infinitivo, futuro do pretérito.' },
                { letter: 'E', text: 'presente do subjuntivo, imperativo, presente do indicativo, presente do indicativo, presente do indicativo, presente do indicativo, pretérito perfeito do indicativo, imperativo, presente do subjuntivo, infinitivo, imperfeito do indicativo.' }
            ],
            correct: 'A'
        },
        2: {
            text: 'Assinale a alternativa em que a classificação dos tempos verbais está CORRETA.',
            options: [
                { letter: 'A', text: 'pretérito perfeito do indicativo, futuro do presente, presente do subjuntivo, imperativo afirmativo, condicional.' },
                { letter: 'B', text: 'pretérito imperfeito do indicativo, futuro do presente, presente do subjuntivo, imperativo afirmativo, condicional.' },
                { letter: 'C', text: 'pretérito perfeito do indicativo, futuro do pretérito, presente do subjuntivo, imperativo afirmativo, condicional.' },
                { letter: 'D', text: 'pretérito perfeito do indicativo, futuro do presente, pretérito imperfeito do subjuntivo, imperativo afirmativo, condicional.' },
                { letter: 'E', text: 'pretérito perfeito do indicativo, futuro do presente, presente do subjuntivo, imperativo negativo, condicional.' }
            ],
            correct: 'A'
        },
        3: {
            text: 'Em "Se eu pudesse, viajaria pelo mundo inteiro", os tempos verbais são, respectivamente:',
            options: [
                { letter: 'A', text: 'presente do subjuntivo e futuro do pretérito do indicativo.' },
                { letter: 'B', text: 'pretérito imperfeito do subjuntivo e condicional.' },
                { letter: 'C', text: 'presente do subjuntivo e condicional.' },
                { letter: 'D', text: 'pretérito imperfeito do subjuntivo e futuro do presente do indicativo.' },
                { letter: 'E', text: 'presente do indicativo e futuro do pretérito do indicativo.' }
            ],
            correct: 'B'
        },
        4: {
            text: 'Assinale a frase em que o verbo está no pretérito perfeito composto do indicativo.',
            options: [
                { letter: 'A', text: 'Eu estivera estudando para a prova.' },
                { letter: 'B', text: 'Eu estava estudando para a prova.' },
                { letter: 'C', text: 'Eu estudo para a prova.' },
                { letter: 'D', text: 'Eu havia estudado para a prova.' },
                { letter: 'E', text: 'Eu estarei estudando para a prova.' }
            ],
            correct: 'B'
        },
        5: {
            text: 'Em "Quando eu chegar, você já terá saído", os tempos verbais são:',
            options: [
                { letter: 'A', text: 'futuro do presente do indicativo e futuro perfeito do indicativo.' },
                { letter: 'B', text: 'presente do subjuntivo e futuro perfeito do indicativo.' },
                { letter: 'C', text: 'futuro do presente do indicativo e pretérito perfeito composto do indicativo.' },
                { letter: 'D', text: 'presente do subjuntivo e pretérito perfeito composto do indicativo.' },
                { letter: 'E', text: 'futuro do pretérito e futuro perfeito do indicativo.' }
            ],
            correct: 'A'
        },
        6: {
            text: 'Assinale a alternativa em que o verbo está no imperativo negativo.',
            options: [
                { letter: 'A', text: 'Não faça isso!' },
                { letter: 'B', text: 'Você não faz isso.' },
                { letter: 'C', text: 'Você não faria isso.' },
                { letter: 'D', text: 'Não faria isso!' },
                { letter: 'E', text: 'Você não fará isso.' }
            ],
            correct: 'A'
        },
        7: {
            text: 'Embora estivesse cansado, ele continuou trabalhando. O verbo "estivesse" está no:',
            options: [
                { letter: 'A', text: 'presente do subjuntivo.' },
                { letter: 'B', text: 'pretérito imperfeito do subjuntivo.' },
                { letter: 'C', text: 'futuro do subjuntivo.' },
                { letter: 'D', text: 'pretérito perfeito do subjuntivo.' },
                { letter: 'E', text: 'condicional.' }
            ],
            correct: 'B'
        },
        8: {
            text: 'Assinale a frase em que o verbo está no futuro do presente do indicativo.',
            options: [
                { letter: 'A', text: 'Quando chegar a hora, partirei.' },
                { letter: 'B', text: 'Quando cheguei a hora, parti.' },
                { letter: 'C', text: 'Quando chegar a hora, partiria.' },
                { letter: 'D', text: 'Quando chegar a hora, partisse.' },
                { letter: 'E', text: 'Quando chegar a hora, terei partido.' }
            ],
            correct: 'A'
        },
        9: {
            text: 'Se eu tivesse dinheiro, compraria uma casa. Os tempos verbais são:',
            options: [
                { letter: 'A', text: 'presente do subjuntivo e futuro do pretérito do indicativo.' },
                { letter: 'B', text: 'pretérito perfeito do subjuntivo e condicional.' },
                { letter: 'C', text: 'pretérito imperfeito do subjuntivo e condicional.' },
                { letter: 'D', text: 'presente do indicativo e futuro do presente do indicativo.' },
                { letter: 'E', text: 'pretérito imperfeito do subjuntivo e futuro do pretérito do indicativo.' }
            ],
            correct: 'C'
        },
        10: {
            text: 'Assinale a alternativa em que todos os verbos estão no pretérito imperfeito do indicativo.',
            options: [
                { letter: 'A', text: 'Eu caminhava, cantava e dançava.' },
                { letter: 'B', text: 'Eu caminhei, cantei e dancei.' },
                { letter: 'C', text: 'Eu caminharia, cantaria e dançaria.' },
                { letter: 'D', text: 'Eu caminhasse, cantasse e dançasse.' },
                { letter: 'E', text: 'Eu caminharei, cantarei e dançarei.' }
            ],
            correct: 'A'
        }
    };

    const correctAnswers = {};
    for (let i = 1; i <= totalQuestions; i++) {
        correctAnswers[i] = questions[i].correct;
    }

    const indexGrid = document.getElementById('index-grid');
    const questionResults = {};
    const COLS = 15;
    const ROW_HEIGHT = 22;

    function renderIndex() {
        indexGrid.innerHTML = '';
        for (let i = 1; i <= totalQuestions; i++) {
            const btn = document.createElement('button');
            btn.className = 'index-btn';
            btn.textContent = i;
            btn.dataset.question = i;

            if (i === currentQuestion) {
                btn.classList.add('active');
            } else if (questionResults[i] === 'correct') {
                btn.classList.add('correct-answer');
            } else if (questionResults[i] === 'wrong') {
                btn.classList.add('wrong-answer');
            } else {
                btn.classList.add('null');
            }

            btn.addEventListener('click', () => goToQuestion(i));
            indexGrid.appendChild(btn);
        }
        scrollToActive();
    }

    function scrollToActive() {
        const grid = document.getElementById('index-grid');
        if (!grid) return;
        const rowIndex = Math.floor((currentQuestion - 1) / COLS);
        const scrollTarget = rowIndex * ROW_HEIGHT;
        const maxScroll = grid.scrollHeight - grid.clientHeight;
        const start = grid.scrollTop;
        const change = Math.min(scrollTarget, maxScroll) - start;
        const duration = 400;
        let startTime = null;

        function animate(currentTime) {
            if (!startTime) startTime = currentTime;
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const easeOut = 1 - Math.pow(1 - progress, 3);
            grid.scrollTop = start + change * easeOut;
            if (progress < 1) requestAnimationFrame(animate);
        }
        requestAnimationFrame(animate);
    }

    function goToQuestion(num, animate = true) {
        if (num === currentQuestion) return;
        const answerSection = document.getElementById('answer-section');
        const feedback = document.getElementById('feedback');
        const questionIndex = document.querySelector('.question-index');
        const bottomNav = document.getElementById('bottom-nav');

        questionIndex.classList.remove('index-contrast');
        bottomNav.classList.remove('feedback-active');

        if (animate) {
            answerSection.classList.add('changing');
            setTimeout(() => {
                currentQuestion = num;
                selectedAnswer = null;
                updateQuestion();
                renderIndex();
                answerSection.classList.remove('changing');
            }, 200);
        } else {
            currentQuestion = num;
            selectedAnswer = null;
            updateQuestion();
            renderIndex();
        }
    }

    function updateQuestion() {
        const q = questions[currentQuestion];
        document.querySelector('.question-number').textContent = `Questão ${currentQuestion}`;
        document.querySelector('.pdf-title').textContent = `Questão ${currentQuestion} no PDF`;
        document.querySelector('.index-count').textContent = `${currentQuestion}/${totalQuestions}`;

        // Atualiza conteúdo do PDF
        const pdfContent = document.getElementById('pdf-content');
        pdfContent.innerHTML = `<p><strong>${currentQuestion}.</strong> ${q.text}</p>`;

        // Atualiza opções
        const options = document.querySelectorAll('.option');
        options.forEach((opt, i) => {
            opt.classList.remove('selected', 'disabled', 'correct-highlight', 'wrong-highlight');
            if (q.options[i]) {
                opt.querySelector('.option-text').textContent = q.options[i].text;
                opt.style.display = 'flex';
            } else {
                opt.style.display = 'none';
            }
        });

        const feedback = document.getElementById('feedback');
        feedback.className = 'feedback';
        feedback.style.display = 'none';

        respondMode = 'answer';
        document.getElementById('respond-btn').textContent = 'Responder';
        document.getElementById('respond-btn').disabled = false;
    }

    // Seleção de opção
    const options = document.querySelectorAll('.option');
    options.forEach(option => {
        option.addEventListener('click', function() {
            if (this.classList.contains('disabled')) return;
            options.forEach(opt => opt.classList.remove('selected'));
            this.classList.add('selected');
            selectedAnswer = this.dataset.option;
        });
    });

    // Botão Responder/Avançar
    document.getElementById('respond-btn').addEventListener('click', function() {
        if (respondMode === 'answer') {
            if (!selectedAnswer) {
                alert('Selecione uma opção antes de responder.');
                return;
            }

            const feedback = document.getElementById('feedback');
            const questionIndex = document.querySelector('.question-index');
            const bottomNav = document.getElementById('bottom-nav');
            const isCorrect = selectedAnswer === correctAnswers[currentQuestion];
            const correctLetter = correctAnswers[currentQuestion];

            feedback.style.display = 'block';
            feedback.className = `feedback ${isCorrect ? 'correct' : 'incorrect'}`;
            feedback.innerHTML = `
                <div class="feedback-label">Feedback:</div>
                <div class="feedback-text">${isCorrect ? 'Resposta correta!' : `Resposta incorreta. A correta é: ${correctLetter}`}</div>
            `;

            options.forEach(opt => {
                if (opt.dataset.option === correctLetter) {
                    opt.classList.add('correct-highlight');
                } else if (opt.classList.contains('selected')) {
                    opt.classList.add('wrong-highlight');
                }
                opt.classList.add('disabled');
            });

            questionResults[currentQuestion] = isCorrect ? 'correct' : 'wrong';
            questionIndex.classList.add('index-contrast');
            bottomNav.classList.add('feedback-active');

            // Animação no índice
            const btn = indexGrid.querySelector(`[data-question="${currentQuestion}"]`);
            if (btn) {
                btn.classList.add(isCorrect ? 'animate-correct' : 'animate-wrong');
                setTimeout(() => {
                    btn.classList.remove('animate-correct', 'animate-wrong', 'active');
                    btn.classList.add(isCorrect ? 'correct-answer' : 'wrong-answer');
                }, 500);
            }

            respondMode = 'next';
            this.textContent = 'Avançar';
        } else {
            if (currentQuestion < totalQuestions) {
                goToQuestion(currentQuestion + 1);
            }
            respondMode = 'answer';
            this.textContent = 'Responder';
        }
    });

    // Navegação
    document.getElementById('prev-btn').addEventListener('click', function() {
        if (currentQuestion > 1) goToQuestion(currentQuestion - 1);
    });

    document.getElementById('next-btn').addEventListener('click', function() {
        if (currentQuestion < totalQuestions) goToQuestion(currentQuestion + 1);
    });

    // Relógio
    let timeInSeconds = 2 * 60 * 60; // 2 horas
    const clockDisplay = document.getElementById('clock-time');

    function updateClock() {
        const h = Math.floor(timeInSeconds / 3600);
        const m = Math.floor((timeInSeconds % 3600) / 60);
        const s = timeInSeconds % 60;
        clockDisplay.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    setInterval(() => {
        if (timeInSeconds > 0) {
            timeInSeconds--;
            updateClock();
        }
    }, 1000);

    // Init
    renderIndex();
    updateQuestion();
    updateClock();
});