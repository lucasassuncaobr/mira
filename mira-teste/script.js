document.addEventListener('DOMContentLoaded', function() {
    const totalQuestions = 100;
    let currentQuestion = 1;
    let selectedAnswer = null;
    let currentProva = null;

    const provas = [
        {
            id: 1,
            title: 'Português - Tempos Verbais',
            subject: 'Português',
            questions: 10,
            totalQuestions: 10,
            color: '#095B83',
            bgColor: '#063d58',
            description: 'Complete a prova de tempos verbais. São 10 questões de múltipla escolha.',
            status: 'in_progress',
            progress: 3
        },
        {
            id: 2,
            title: 'Matemática - Conjuntos',
            subject: 'Matemática',
            questions: 10,
            totalQuestions: 10,
            color: '#7C3AED',
            bgColor: '#5B21B6',
            description: 'Operações com conjuntos, diagramas e notações.',
            status: 'not_started',
            progress: 0
        },
        {
            id: 3,
            title: 'Informática - Redes',
            subject: 'Informática',
            questions: 10,
            totalQuestions: 10,
            color: '#059669',
            bgColor: '#047857',
            description: 'Protocolos, topologias e modelos de rede.',
            status: 'completed',
            progress: 10
        }
    ];

    function renderCards() {
        const grid = document.getElementById('cards-grid');
        grid.innerHTML = '';
        let activeIndex = 0;

        provas.forEach((prova, index) => {
            if (prova.status === 'in_progress') activeIndex = index;

            const card = document.createElement('div');
            card.className = 'prova-card';
            card.dataset.provaId = prova.id;
            card.style.setProperty('--card-color', prova.color);
            card.style.setProperty('--card-bg', prova.bgColor);

            const statusLabel = prova.status === 'in_progress' ? 'Em andamento' :
                prova.status === 'completed' ? 'Concluída' : 'Não iniciada';
            const progressPct = Math.round((prova.progress / prova.totalQuestions) * 100);

            card.innerHTML = `
                <div class="prova-card-top" style="background-color: ${prova.color}">
                    <div class="prova-card-status">${statusLabel}</div>
                </div>
                <div class="prova-card-bottom">
                    <div class="prova-card-bg" style="background-color: ${prova.bgColor}"></div>
                    <span class="prova-card-title" style="color: ${prova.color}">${prova.title}</span>
                    <span class="prova-card-subject">${prova.subject}</span>
                    <div class="prova-card-meta">
                        <span>${prova.questions} questões</span>
                    </div>
                    <div class="prova-card-progress">
                        <div class="prova-card-progress-bar">
                            <div class="prova-card-progress-fill" style="width: ${progressPct}%; background-color: ${prova.color}"></div>
                        </div>
                        <span class="prova-card-progress-text">${prova.progress}/${prova.totalQuestions}</span>
                    </div>
                    <p class="prova-card-desc">${prova.description}</p>
                </div>
            `;

            card.addEventListener('click', () => enterProva(prova.id));
            grid.appendChild(card);
        });

        // Scroll para prova ativa
        setTimeout(() => {
            const cards = grid.querySelectorAll('.prova-card');
            if (cards[activeIndex]) {
                cards[activeIndex].scrollIntoView({ behavior: 'smooth', inline: 'center' });
            }
        }, 100);
    }

    function enterProva(provaId) {
        currentProva = provaId;
        const prova = provas.find(p => p.id === provaId);
        if (!prova) return;

        document.getElementById('cards-section').style.display = 'none';
        document.getElementById('pdf-panel').style.display = 'flex';
        document.getElementById('question-panel').style.display = 'flex';
    }

    function showCards() {
        document.getElementById('cards-section').style.display = 'flex';
        document.getElementById('pdf-panel').style.display = 'none';
        document.getElementById('question-panel').style.display = 'none';
        renderCards();
    }

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
            text: 'Em "Embora estivesse cansado, ele continuou trabalhando", o verbo "estivesse" está no:',
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
            text: 'Em "Se eu tivesse dinheiro, compraria uma casa", os tempos verbais são:',
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

    // Respostas corretas
    const correctAnswers = {};
    for (let i = 1; i <= 10; i++) {
        correctAnswers[i] = questions[i].correct;
    }
    // Preencher o resto com alternativas aleatórias
    for (let i = 11; i <= totalQuestions; i++) {
        const options = ['A', 'B', 'C', 'D', 'E'];
        correctAnswers[i] = options[Math.floor(Math.random() * 5)];
    }

    // Preencher questões 11-100 com dados genéricos
    for (let i = 11; i <= totalQuestions; i++) {
        questions[i] = {
            text: `Questão ${i} - Analise as alternativas e escolha a correta.`,
            options: [
                { letter: 'A', text: 'Alternativa A - presente do indicativo.' },
                { letter: 'B', text: 'Alternativa B - pretérito perfeito do indicativo.' },
                { letter: 'C', text: 'Alternativa C - futuro do presente do indicativo.' },
                { letter: 'D', text: 'Alternativa D - pretérito imperfeito do subjuntivo.' },
                { letter: 'E', text: 'Alternativa E - imperativo afirmativo.' }
            ]
        };
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
        
        // Smooth gradual scroll
        const start = grid.scrollTop;
        const change = Math.min(scrollTarget, maxScroll) - start;
        const duration = 400;
        let startTime = null;
        
        function animate(currentTime) {
            if (!startTime) startTime = currentTime;
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            
            // Ease out cubic for smooth deceleration
            const easeOut = 1 - Math.pow(1 - progress, 3);
            
            grid.scrollTop = start + change * easeOut;
            
            if (progress < 1) {
                requestAnimationFrame(animate);
            }
        }
        
        requestAnimationFrame(animate);
    }
    
    function goToQuestion(num, animate = true) {
        if (num === currentQuestion) return;
        
        const answerSection = document.querySelector('.answer-section');
        const feedback = document.querySelector('.feedback');
        const questionIndex = document.querySelector('.question-index');
        const bottomNav = document.querySelector('.bottom-nav');
        
        // Remove contraste do índice e estado do feedback
        questionIndex.classList.remove('index-contrast');
        bottomNav.classList.remove('feedback-active');
        
        if (animate) {
            answerSection.classList.add('changing');
            feedback.style.animation = 'none';
            feedback.offsetHeight;
            feedback.style.animation = '';
            
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
        document.querySelector('.question-number').textContent = `Questão ${currentQuestion}`;
        document.querySelector('.pdf-title').textContent = `Questão ${currentQuestion} no PDF`;
        document.querySelector('.index-count').textContent = `${currentQuestion}/${totalQuestions}`;

        const q = questions[currentQuestion];
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

        const feedback = document.querySelector('.feedback');
        feedback.className = 'feedback';
        feedback.style.display = 'none';

        respondMode = 'answer';
        document.getElementById('respond-btn').textContent = 'Responder';
        document.getElementById('respond-btn').disabled = false;
    }
    
    // Option selection
    const options = document.querySelectorAll('.option');
    options.forEach(option => {
        option.addEventListener('click', function() {
            if (this.classList.contains('disabled')) return;
            options.forEach(opt => opt.classList.remove('selected'));
            this.classList.add('selected');
            selectedAnswer = this.dataset.option;
        });
    });
    
    // Respond button
    let respondMode = 'answer'; // 'answer' ou 'next'
    
    document.getElementById('respond-btn').addEventListener('click', function() {
        if (respondMode === 'answer') {
            if (!selectedAnswer) {
                alert('Selecione uma opção antes de responder.');
                return;
            }
            
            const feedback = document.querySelector('.feedback');
            const questionIndex = document.querySelector('.question-index');
            const bottomNav = document.querySelector('.bottom-nav');
            const options = document.querySelectorAll('.option');
            const isCorrect = selectedAnswer === correctAnswers[currentQuestion];
            const correctLetter = correctAnswers[currentQuestion];
            
            feedback.style.display = 'block';
            feedback.className = `feedback ${isCorrect ? 'correct' : 'incorrect'}`;
            feedback.innerHTML = `
                <div class="feedback-label">Feedback:</div>
                <div class="feedback-text">${isCorrect ? 'Resposta correta!' : `Resposta incorreta. A correta é: ${correctLetter}`}</div>
            `;
            
            // Destaca opção correta e errada
            options.forEach(opt => {
                if (opt.dataset.option === correctLetter) {
                    opt.classList.add('correct-highlight');
                } else if (opt.classList.contains('selected')) {
                    opt.classList.add('wrong-highlight');
                }
                opt.classList.add('disabled');
            });
            
            // Aumenta contraste do índice quando feedback abre
            questionIndex.classList.add('index-contrast');
            
            // Minimiza setas e destaca botão responder
            bottomNav.classList.add('feedback-active');
            
            // Muda para modo avançar
            respondMode = 'next';
            this.textContent = 'Avançar';
        } else {
            // Avança para próxima questão
            if (currentQuestion < totalQuestions) {
                goToQuestion(currentQuestion + 1);
            }
            // Restaura modo responder
            respondMode = 'answer';
            this.textContent = 'Responder';
        }
    });
    
    // Navigation arrows
    document.getElementById('prev-btn').addEventListener('click', function() {
        if (currentQuestion > 1) goToQuestion(currentQuestion - 1);
    });
    
    document.getElementById('next-btn').addEventListener('click', function() {
        if (currentQuestion < totalQuestions) goToQuestion(currentQuestion + 1);
    });
    
    // Clock
    let timeInSeconds = 23 * 60 + 8;
    const clockDisplay = document.getElementById('clock-time');
    
    function updateClock() {
        const h = Math.floor(timeInSeconds / 3600);
        const m = Math.floor((timeInSeconds % 3600) / 60);
        const s = timeInSeconds % 60;
        clockDisplay.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    
    // Floating badge drag
    const badge = document.querySelector('.floating-badge');
    let isDragging = false, offsetX, offsetY;
    
    badge.addEventListener('mousedown', function(e) {
        isDragging = true;
        offsetX = e.clientX - badge.getBoundingClientRect().left;
        offsetY = e.clientY - badge.getBoundingClientRect().top;
        badge.style.cursor = 'grabbing';
        e.preventDefault();
    });
    
    document.addEventListener('mousemove', function(e) {
        if (!isDragging) return;
        const rect = document.querySelector('.pdf-viewer').getBoundingClientRect();
        badge.style.position = 'absolute';
        badge.style.left = Math.max(0, Math.min(e.clientX - rect.left - offsetX, rect.width - badge.offsetWidth)) + 'px';
        badge.style.top = Math.max(0, Math.min(e.clientY - rect.top - offsetY, rect.height - badge.offsetHeight)) + 'px';
        badge.style.right = 'auto';
    });
    
    document.addEventListener('mouseup', function() {
        isDragging = false;
        badge.style.cursor = 'move';
    });
    
    // Navigation between views
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', function(e) {
            e.preventDefault();
            document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
            this.classList.add('active');

            if (this.textContent.trim() === 'Provas') {
                showCards();
            } else {
                // Desempenho - mostra painel vazio por enquanto
            }
        });
    });

    // Init
    showCards();
});