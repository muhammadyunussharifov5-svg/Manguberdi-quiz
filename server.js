const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const xlsx = require('xlsx');
const path = require('path');

const app = express();
app.use(express.static('PUBLIC'));
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const upload = multer({ dest: 'uploads/' });

let teachers = {}; 
let globalQuizzes = {}; 
let activeGames = {}; 

function generateKey(length, isLetters = true) {
    const chars = isLetters ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' : '0123456789';
    let result = '';
    for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

// ================= TEACHER AVTORIZATSIYASI =================
app.post('/api/register', (req, res) => {
    const { login, password, secret } = req.body;
    if (secret !== 'MANGU_1101') return res.json({ success: false, msg: 'Muvaffaqiyatsiz: Maxfiy kod xato!' });
    if (teachers[login]) return res.json({ success: false, msg: 'Bu login avval ro\'yxatdan o\'tgan!' });
    
    teachers[login] = { password, quizzes: [] };
    res.json({ success: true, msg: "Muvaffaqiyatli ro'yxatdan o'tdingiz!" });
});

app.post('/api/login', (req, res) => {
    const { login, password } = req.body;
    if (!teachers[login]) return res.json({ success: false, msg: "Siz teacher emassiz yoki ro'yxatdan o'tmagansiz!" });
    if (teachers[login].password !== password) return res.json({ success: false, msg: "Login yoki parol xato!" });
    
    res.json({ success: true, quizzes: teachers[login].quizzes });
});

// ================= EXCEL YUKLASH VA BO'LISH =================
app.post('/upload', upload.single('file'), (req, res) => {
    const teacherLogin = req.body.login;
    if (!teachers[teacherLogin]) return res.json({ success: false, msg: "Avtorizatsiyadan o'ting!" });

    const workbook = xlsx.readFile(req.file.path);
    const sheet_name_list = workbook.SheetNames;
    const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheet_name_list[0]], { header: 1 });
    data.shift(); 

    let chunks = [];
    let numChunks = Math.floor(data.length / 50);
    let remainder = data.length % 50;

    for (let i = 0; i < numChunks; i++) chunks.push(data.slice(i * 50, (i + 1) * 50));
    if (remainder > 0) {
        if (remainder >= 25) chunks.push(data.slice(numChunks * 50));
        else if (chunks.length > 0) chunks[chunks.length - 1] = chunks[chunks.length - 1].concat(data.slice(numChunks * 50));
        else chunks.push(data.slice(0)); 
    }

    let savedQuizzes = [];
    chunks.forEach((chunk, index) => {
        let key = generateKey(6); 
        let quizObj = {
            id: key,
            title: `Test ${index + 1}-qism (${chunk.length} savol)`,
            questions: chunk.map(row => ({
                question: row[0], correct: row[1], wrong1: row[2], wrong2: row[3], wrong3: row[4]
            }))
        };
        globalQuizzes[key] = quizObj;
        teachers[teacherLogin].quizzes.push(quizObj);
        savedQuizzes.push(quizObj);
    });

    res.json({ success: true, quizzes: teachers[teacherLogin].quizzes });
});

app.get('/api/quiz/:id', (req, res) => {
    const quiz = globalQuizzes[req.params.id];
    if (quiz) res.json({ success: true, quiz });
    else res.json({ success: false, msg: "Kalit xato yoki test topilmadi!" });
});

// ================= SOCKET.IO GURUH TIZIMI =================
io.on('connection', (socket) => {
    
    // O'qituvchi xona yaratadi
    socket.on('create_game', ({ quizId }) => {
        const pin = 'K' + generateKey(4, false); 
        activeGames[pin] = { 
            quiz: globalQuizzes[quizId], 
            players: [], 
            status: 'waiting', 
            currentQ: 0,
            teacherId: socket.id,
            timeoutId: null,
            nextQuestionTimeoutId: null
        };
        socket.join(pin);
        socket.emit('game_created', pin);
    });

    // O'quvchi xonaga PIN orqali kiradi
    socket.on('join_game', ({ pin, name }) => {
        let game = activeGames[pin];
        if (game && game.status === 'waiting') {
            socket.join(pin);
            // Yangi talaba obyektini qo'shish
            game.players.push({ 
                id: socket.id, 
                name: name, 
                score: 0, 
                timeSpent: 0,
                hasAnswered: false 
            });
            // Lobby dagi barchaga (O'qituvchi + Talabalar) yangilangan ro'yxatni uzatish
            io.to(pin).emit('update_lobby', game.players);
            socket.emit('joined', { pin, name });
        } else {
            socket.emit('error', "PIN kod xato yoki test boshlab yuborilgan!");
        }
    });

    // O'qituvchi testni start qiladi
    socket.on('start_game', (pin) => {
        let game = activeGames[pin];
        if(game && game.status === 'waiting') {
            game.status = 'playing';
            sendQuestion(pin);
        }
    });

    // O'qituvchi testni istalgan soniyada Ha tugmasi orqali to'xtatadi
    socket.on('force_end_game', (pin) => {
        let game = activeGames[pin];
        if (game && game.status === 'playing') {
            endGame(pin); // Darhol natijalar hisoblanib e'lon qilinadi
        }
    });

    // O'quvchi javob tanlaganda
    socket.on('submit_answer', ({ pin, selectedAnswer, time }) => {
        let game = activeGames[pin];
        if (game && game.status === 'playing') {
            let player = game.players.find(p => p.id === socket.id);
            if (player && !player.hasAnswered) {
                player.hasAnswered = true; 
                
                let currentQObj = game.quiz.questions[game.currentQ - 1];
                if (currentQObj && selectedAnswer === currentQObj.correct) {
                    player.score += 1;
                    player.timeSpent += time;
                }
                
                // O'qituvchining Live kuzatuv panelini real vaqtda yashil chiroq qilish uchun yangilaymiz
                io.to(game.teacherId).emit('teacher_monitor_update', {
                    players: game.players
                });
            }
        }
    });

    function sendQuestion(pin) {
        let game = activeGames[pin];
        if (!game || game.status !== 'playing') return;

        if (game.currentQ < game.quiz.questions.length) {
            let q = game.quiz.questions[game.currentQ];
            let answers = [q.correct, q.wrong1, q.wrong2, q.wrong3].sort(() => Math.random() - 0.5);
            
            game.currentQ++;

            // Har bir yangi savolda hamma o'quvchilarni "o'ylamoqda" holatiga o'tkazish
            game.players.forEach(p => { p.hasAnswered = false; });

            // Faqat xonadagi o'quvchilarga savol boradi (O'qituvchiga bormaydi)
            socket.to(pin).emit('new_question', { 
                question: q.question, 
                answers: answers, 
                qIndex: game.currentQ,
                totalQ: game.quiz.questions.length
            });

            // Faqat o'qituvchi monitoriga savol tafsilotlari va yangi o'quvchilar ro'yxati boradi
            io.to(game.teacherId).emit('teacher_new_question', {
                question: q.question,
                correctAnswer: q.correct,
                qIndex: game.currentQ,
                totalQ: game.quiz.questions.length,
                players: game.players
            });
            
            if (game.timeoutId) clearTimeout(game.timeoutId);
            if (game.nextQuestionTimeoutId) clearTimeout(game.nextQuestionTimeoutId);
            
            // 30 soniyadan keyin javoblarni ochish mantiqi
            game.timeoutId = setTimeout(() => {
                if (game.status !== 'playing') return;
                
                socket.to(pin).emit('show_answer', q.correct);
                io.to(game.teacherId).emit('teacher_show_answer', q.correct);
                
                // 3 soniya natija ko'rinib keyingi savol avtomat uzatiladi
                game.nextQuestionTimeoutId = setTimeout(() => {
                    sendQuestion(pin);
                }, 3000); 
            }, 30000); 

        } else {
            endGame(pin);
        }
    }

    function endGame(pin) {
        let game = activeGames[pin];
        if (!game) return;

        // Barcha faol taymerlar butkul bloklanadi
        if (game.timeoutId) clearTimeout(game.timeoutId);
        if (game.nextQuestionTimeoutId) clearTimeout(game.nextQuestionTimeoutId);

        // Reytingni hisoblash: To'g'ri javob ko'pligi, teng bo'lsa kam vaqt sarflagani ustun
        game.players.sort((a, b) => b.score - a.score || a.timeSpent - b.timeSpent);
        game.status = 'finished';
        
        // Butun guruhga (O'qituvchi va Studentlarga) bir vaqtda darhol natijalar jadvalini (Tablo) yuborish
        io.to(pin).emit('game_over', game.players);
    }

    socket.on('disconnect', () => {
        for (let pin in activeGames) {
            let game = activeGames[pin];
            let index = game.players.findIndex(p => p.id === socket.id);
            if (index !== -1) {
                game.players.splice(index, 1);
                io.to(pin).emit('update_lobby', game.players);
                if(game.status === 'playing') {
                    io.to(game.teacherId).emit('teacher_monitor_update', {
                        players: game.players
                    });
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server ${PORT}-portda muvaffaqiyatli ishga tushdi`);
});