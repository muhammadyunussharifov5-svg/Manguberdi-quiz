const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('PUBLIC'));

// Ma'lumotlarni doimiy saqlash uchun papka va fayllar (Butun umr saqlash uchun)
const DATA_DIR = path.join(__dirname, 'data');
const TEACHERS_FILE = path.join(DATA_DIR, 'teachers.json');
const SUBJECTS_FILE = path.join(DATA_DIR, 'subjects.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(TEACHERS_FILE)) fs.writeFileSync(TEACHERS_FILE, JSON.stringify([]));
if (!fs.existsSync(SUBJECTS_FILE)) fs.writeFileSync(SUBJECTS_FILE, JSON.stringify([]));

// Fayldan ma'lumotlarni o'qish funksiyalari
const getTeachers = () => JSON.parse(fs.readFileSync(TEACHERS_FILE, 'utf8'));
const saveTeachers = (data) => fs.writeFileSync(TEACHERS_FILE, JSON.stringify(data, null, 2));
const getSubjects = () => JSON.parse(fs.readFileSync(SUBJECTS_FILE, 'utf8'));
const saveSubjects = (data) => fs.writeFileSync(SUBJECTS_FILE, JSON.stringify(data, null, 2));

// Massivni aralashtirish (Random) funksiyasi
function shuffleArray(array) {
    let arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// Multer orqali Excel yuklash sozlamasi (Vaqtinchalik faylni xavfsiz saqlash)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// Guruhli o'yinlar holati (In-memory)
const activeSessions = {};

// Maxfiy kod (Faqat serverda tekshiriladi, xavfsiz)
const SECRET_REG_CODE = "MANGU_1101";

// --- API KANALLARI ---

// Bosh sahifa yo'nalishi (Cannot GET / xatoligini oldini olish)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'PUBLIC', 'index.html'));
});

// O'qituvchi ro'yxatdan o'tishi
app.post('/api/teacher/register', (req, res) => {
    const { username, password, secretCode } = req.body;
    if (secretCode !== SECRET_REG_CODE) {
        return res.status(400).json({ error: "Maxfiy kod noto'g'ri!" });
    }
    const teachers = getTeachers();
    if (teachers.find(t => t.username === username)) {
        return res.status(400).json({ error: "Bu login band!" });
    }
    teachers.push({ username, password });
    saveTeachers(teachers);
    res.json({ success: true });
});

// O'qituvchi kirishi
app.post('/api/teacher/login', (req, res) => {
    const { username, password } = req.body;
    const teachers = getTeachers();
    const teacher = teachers.find(t => t.username === username && t.password === password);
    if (!teacher) return res.status(400).json({ error: "Login yoki parol xato!" });
    res.json({ success: true, username });
});

// Excel faylni yuklash va USTUN TARTIBI bo'yicha o'qish (HATO BERMAYDIGAN METOD)
app.post('/api/quiz/upload', upload.single('file'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "Fayl yuklanmadi!" });
        
        const workbook = xlsx.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        
        // header: 1 orqali Excel sarlavhalariga qaramay, [0,1,2,3,4] ustun ko'rinishida olamiz
        const rows = xlsx.utils.sheet_to_json(worksheet, { header: 1 });
        fs.unlinkSync(req.file.path); // vaqtincha faylni darhol o'chirish

        let questions = [];
        
        // i=1 dan boshlaymiz, birinchi qator (sarlavha) tashlab ketiladi
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (!row || row.length === 0 || !row[0]) continue; // bo'sh qator bo'lsa o'tkazib yuborish

            // Ustunlar tartibi bo'yicha qat'iy tekshirish
            const savol = row[0];
            const togriJavob = row[1];
            const noto_g_ri1 = row[2] || "Javob yo'q";
            const noto_g_ri2 = row[3] || "Javob yo'q";
            const noto_g_ri3 = row[4] || "Javob yo'q";

            if (savol && togriJavob) {
                questions.push({
                    question: savol,
                    options: [togriJavob, noto_g_ri1, noto_g_ri2, noto_g_ri3],
                    answer: togriJavob
                });
            }
        }

        if (questions.length === 0) {
            return res.status(400).json({ error: "Excel formati noto'g'ri yoki savollar topilmadi!" });
        }

        const subjects = getSubjects();
        const subjectId = "sub_" + Date.now();
        const newSubject = {
            id: subjectId,
            name: "Yangi Fan (Tahrirlash uchun bosing)",
            sections: []
        };

        // Savollarni 50 tadan bo'laklarga bo'lish
        const chunkSize = 50;
        let secIndex = 1;
        for (let i = 0; i < questions.length; i += chunkSize) {
            const chunk = questions.slice(i, i + chunkSize);
            newSubject.sections.push({
                id: `sec_${subjectId}_${secIndex}`,
                name: `${i + 1}-${Math.min(i + chunkSize, questions.length)} bo'lim`,
                soloCode: `S-${Math.floor(1000 + Math.random() * 9000)}`,
                questions: chunk
            });
            secIndex++;
        }

        subjects.push(newSubject);
        saveSubjects(subjects);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Serverda xatolik yuz berdi!" });
    }
});

// Fanlar ro'yxatini olish
app.get('/api/subjects', (req, res) => {
    res.json(getSubjects());
});

// Fan nomini yangilash
app.post('/api/subject/rename', (req, res) => {
    const { id, newName } = req.body;
    let subjects = getSubjects();
    const sub = subjects.find(s => s.id === id);
    if (sub) {
        sub.name = newName;
        saveSubjects(subjects);
        return res.json({ success: true });
    }
    res.status(404).json({ error: "Fan topilmadi" });
});

// Fanni o'chirib tashlash
app.post('/api/subject/delete', (req, res) => {
    const { id } = req.body;
    let subjects = getSubjects();
    subjects = subjects.filter(s => s.id !== id);
    saveSubjects(subjects);
    res.json({ success: true });
});

// Guruh kodi yoki Solo kodni tekshirish (Savollar har doim aralashtiriladi)
app.post('/api/quiz/check-code', (req, res) => {
    const { code } = req.body;
    // 1. Aktiv guruh sessiyalaridan qidirish
    if (activeSessions[code]) {
        return res.json({ type: 'group', valid: true });
    }
    // 2. Solo kodlardan qidirish
    const subjects = getSubjects();
    for (const sub of subjects) {
        const sec = sub.sections.find(s => s.soloCode === code);
        if (sec) {
            return res.json({ type: 'solo', valid: true, questions: shuffleArray(sec.questions) });
        }
    }
    res.json({ valid: false });
});

// --- SOCKET.IO REALTIME TARMOQI ---
io.on('connection', (socket) => {
    // Guruhda test boshlash (Standart bo'lim yoki Random 20)
    socket.on('startGroupQuiz', ({ subjectId, sectionId, mode }) => {
        const subjects = getSubjects();
        const sub = subjects.find(s => s.id === subjectId);
        if (!sub) return;

        let quizQuestions = [];
        let codePrefix = "G-";

        if (mode === 'random20') {
            let allQuestions = [];
            sub.sections.forEach(sec => { allQuestions = allQuestions.concat(sec.questions); });
            quizQuestions = shuffleArray(allQuestions).slice(0, 20);
            codePrefix = "R" + Math.floor(10 + Math.random() * 90); // Masalan: R45
        } else {
            const sec = sub.sections.find(s => s.id === sectionId);
            if (!sec) return;
            quizQuestions = shuffleArray(sec.questions);
        }

        const sessionCode = codePrefix + Math.floor(1000 + Math.random() * 9000);
        activeSessions[sessionCode] = {
            code: sessionCode,
            questions: quizQuestions,
            currentIndex: 0,
            students: {},
            teacherSocketId: socket.id
        };

        socket.join(sessionCode);
        socket.emit('sessionCreated', { code: sessionCode });
    });

    // Talaba guruhga qo'shilishi
    socket.on('joinGroup', ({ code, name }) => {
        const session = activeSessions[code];
        if (!session) return socket.emit('errorMsg', 'Sessiya topilmadi!');

        session.students[name] = { name, score: 0, status: 'O\'ylamoqda... 🟡' };
        socket.join(code);
        socket.emit('studentJoinedSuccess', { code, name });

        io.to(session.code).emit('updateMonitor', Object.values(session.students));
    });

    // O'qituvchi birinchi/navbatdagi savolni chiqarishi
    socket.on('nextQuestion', ({ code }) => {
        const session = activeSessions[code];
        if (!session) return;

        if (session.currentIndex >= session.questions.length) {
            io.to(code).emit('quizFinished', Object.values(session.students));
            delete activeSessions[code];
            return;
        }

        const currentQ = session.questions[session.currentIndex];
        Object.keys(session.students).forEach(name => {
            session.students[name].status = 'O\'ylamoqda... 🟡';
        });

        io.to(code).emit('newQuestion', {
            question: currentQ.question,
            options: currentQ.options, 
            answer: currentQ.answer,
            index: session.currentIndex + 1,
            total: session.questions.length
        });
        io.to(code).emit('updateMonitor', Object.values(session.students));
        session.currentIndex++;
    });

    // Talaba javob berganda (To'g'ri/Noto'g'ri aniq status bilan ko'rsatish)
    socket.on('submitAnswer', ({ code, name, isCorrect }) => {
        const session = activeSessions[code];
        if (!session) return;

        if (session.students[name]) {
            if (isCorrect) {
                session.students[name].score += 10;
                session.students[name].status = 'To\'g\'ri javob berdi! 🟢';
            } else {
                session.students[name].status = 'Noto\'g\'ri javob berdi! 🔴';
            }
            io.to(code).emit('updateMonitor', Object.values(session.students));
        }
    });
});

// Portni xavfsiz sozlash
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serverimiz ${PORT}-portda muvaffaqiyatli ishga tushdi`);
});