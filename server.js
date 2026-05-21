const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const xlsx = require('xlsx');
const path = require('path');
const mongoose = require('mongoose'); // Yangi qo'shildi

const app = express();
app.use(express.static('PUBLIC'));
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const upload = multer({ dest: 'uploads/' });

// ================= MONGODB GA ULANISH =================
// Sizning tayyor havolangiz shu yerga joylashtirildi:
const MONGO_URI = "mongodb+srv://mangu_user:Kkhkmymomangu_1101@cluster0.9guqu8n.mongodb.net/quizdb?retryWrites=true&w=majority";

mongoose.connect(MONGO_URI)
    .then(() => console.log("MongoDB bazasiga muvaffaqiyatli ulandik!"))
    .catch((err) => console.error("Baza ulanishida xatolik:", err));

// ================= MA'LUMOTLAR MODELI (SCHEMAS) =================
const teacherSchema = new mongoose.Schema({
    login: { type: String, required: true, unique: true },
    password: { type: String, required: true }
});
const Teacher = mongoose.model('Teacher', teacherSchema);

const quizSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true }, 
    title: String,
    questions: Array,
    teacherLogin: String 
});
const Quiz = mongoose.model('Quiz', quizSchema);

// Jonli o'yinlar tezkor xotirada qoladi
let activeGames = {}; 

function generateKey(length, isLetters = true) {
    const chars = isLetters ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' : '0123456789';
    let result = '';
    for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

// ================= TEACHER AVTORIZATSIYASI =================
app.post('/api/register', async (req, res) => {
    try {
        const { login, password, secret } = req.body;
        if (secret !== 'MANGU_1101') return res.json({ success: false, msg: 'Muvaffaqiyatsiz: Maxfiy kod xato!' });
        
        const existingTeacher = await Teacher.findOne({ login });
        if (existingTeacher) return res.json({ success: false, msg: 'Bu login avval ro\'yxatdan o\'tgan!' });
        
        const newTeacher = new Teacher({ login, password });
        await newTeacher.save();

        res.json({ success: true, msg: "Muvaffaqiyatli ro'yxatdan o'tdingiz!" });
    } catch (err) {
        res.json({ success: false, msg: "Serverda xatolik yuz berdi!" });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { login, password } = req.body;
        const teacher = await Teacher.findOne({ login });
        
        if (!teacher) return res.json({ success: false, msg: "Siz teacher emassiz yoki ro'yxatdan o'tmagansiz!" });
        if (teacher.password !== password) return res.json({ success: false, msg: "Login yoki parol xato!" });
        
        const quizzes = await Quiz.find({ teacherLogin: login });
        res.json({ success: true, quizzes: quizzes });
    } catch (err) {
        res.json({ success: false, msg: "Serverda xatolik!" });
    }
});

// ================= EXCEL YUKLASH VA BO'LISH =================
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        const teacherLogin = req.body.login;
        const teacher = await Teacher.findOne({ login: teacherLogin });
        if (!teacher) return res.json({ success: false, msg: "Avtorizatsiyadan o'ting!" });

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

        for (let index = 0; index < chunks.length; index++) {
            let chunk = chunks[index];
            let key = generateKey(6); 
            
            let quizObj = new Quiz({
                id: key,
                title: `Test ${index + 1}-qism (${chunk.length} savol)`,
                questions: chunk.map(row => ({
                    question: row[0], correct: row[1], wrong1: row[2], wrong2: row[3], wrong3: row[4]
                })),
                teacherLogin: teacherLogin
            });

            await quizObj.save();
        }

        const allQuizzes = await Quiz.find({ teacherLogin: teacherLogin });
        res.json({ success: true, quizzes: allQuizzes });
    } catch (err) {
        res.json({ success: false, msg: "Faylni qayta ishlashda xatolik!" });
    }
});

app.get('/api/quiz/:id', async (req, res) => {
    try {
        const quiz = await Quiz.findOne({ id: req.params.id });
        if (quiz) res.json({ success: true, quiz });
        else res.json({ success: false, msg: "Kalit xato yoki test topilmadi!" });
    } catch (err) {
        res.json({ success: false, msg: "Xatolik yuz berdi!" });
    }
});

// ================= SOCKET.IO GURUH TIZIMI =================
io.on('connection', (socket) => {
    
    socket.on('create_game', async ({ quizId }) => {
        const quiz = await Quiz.findOne({ id: quizId });
        if(!quiz) return socket.emit('error', 'Test topilmadi!');

        const pin = 'K' + generateKey(4, false); 
        activeGames[pin] = { 
            quiz: quiz, 
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

    socket.on('join_game', ({ pin, name }) => {
        let game = activeGames[pin];
        if (game && game.status === 'waiting') {
            socket.join(pin);
            game.players.push({ 
                id: socket.id, 
                name: name, 
                score: 0, 
                timeSpent: 0,
                hasAnswered: false 
            });
            io.to(pin).emit('update_lobby', game.players);
            socket.emit('joined', { pin, name });
        } else {
            socket.emit('error', "PIN kod xato yoki test boshlab yuborilgan!");
        }
    });

    socket.on('start_game', (pin) => {
        let game = activeGames[pin];
        if(game && game.status === 'waiting') {
            game.status = 'playing';
            sendQuestion(pin);
        }
    });

    socket.on('force_end_game', (pin) => {
        let game = activeGames[pin];
        if (game && game.status === 'playing') {
            endGame(pin); 
        }
    });

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
            game.players.forEach(p => { p.hasAnswered = false; });

            socket.to(pin).emit('new_question', { 
                question: q.question, 
                answers: answers, 
                qIndex: game.currentQ,
                totalQ: game.quiz.questions.length
            });

            io.to(game.teacherId).emit('teacher_new_question', {
                question: q.question,
                correctAnswer: q.correct,
                qIndex: game.currentQ,
                totalQ: game.quiz.questions.length,
                players: game.players
            });
            
            if (game.timeoutId) clearTimeout(game.timeoutId);
            if (game.nextQuestionTimeoutId) clearTimeout(game.nextQuestionTimeoutId);
            
            game.timeoutId = setTimeout(() => {
                if (game.status !== 'playing') return;
                
                socket.to(pin).emit('show_answer', q.correct);
                io.to(game.teacherId).emit('teacher_show_answer', q.correct);
                
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

        if (game.timeoutId) clearTimeout(game.timeoutId);
        if (game.nextQuestionTimeoutId) clearTimeout(game.nextQuestionTimeoutId);

        game.players.sort((a, b) => b.score - a.score || a.timeSpent - b.timeSpent);
        game.status = 'finished';
        
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