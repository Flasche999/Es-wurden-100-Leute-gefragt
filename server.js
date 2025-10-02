// server.js – Quiz "100 Leute gefragt" – Team-Style (v2.2 – neues Punktesystem + Gewinner-Animation + Hintergrundmusik)
// NEUES PUNKTESYSTEM & TILE-LABELS:
// - Kacheln zeigen nur noch 1..5 (kein 10/20/30/40/50).
// - Punkte = SUMME der aufgedeckten Prozente.
//   • Start-Team löst ALLE Antworten → bekommt GESAMTSUMME (i. d. R. 100).
//   • Start-Team macht 3 Fehler → Abstauber-Phase startet:
//       - Abstauber-Team hat GENAU 1 Chance:
//           · Richtig → Abstauber-Team bekommt die BIS DAHIN aufgedeckte Prozentsumme.
//           · Falsch  → Start-Team bekommt die BIS DAHIN aufgedeckte Prozentsumme.
// - Admin deckt Antworten manuell auf (oder optional per Tipp-Eingabe).
// - Bonus: Startteam auslosen, Nächste Runde (Startteam wechseln), SFX-Fallback, Team-Chats.
// - NEU: Admin-Event „admin:celebrate” → broadcast „celebrate:winner” (Konfetti/Krone bei allen Clients)
// - NEU: Hintergrundmusik /music/bgm.mp3 mit Silent-Fallback (verhindert 416-Logs)
// - NEU: Lock-in/Select-Sound /sfx/select.mp3 bei Feldwahl (Silent-Fallback)

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.json());

// ─────────────────────────────────────────────────────────────
// Audio-Fallback (vermeidet 416-Logs bei leeren/fehlenden Dateien)
// ─────────────────────────────────────────────────────────────
const SILENCE_WAV_BASE64 =
  "UklGRl4RAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YToRAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function sendMediaOrSilent(subdir, name, res) {
  const p = path.join(__dirname, "public", subdir, name);
  try {
    const st = fs.statSync(p);
    if (st.isFile() && st.size > 0) {
      return res.sendFile(p);
    }
  } catch (_) { /* ignore */ }
  res.set("Content-Type", "audio/wav");
  res.set("Cache-Control", "public, max-age=86400");
  return res.end(Buffer.from(SILENCE_WAV_BASE64, "base64"));
}

// Audio-Routen MÜSSEN vor express.static kommen:
app.get("/sfx/correct.mp3", (_req, res) => sendMediaOrSilent("sfx",   "correct.mp3", res));
app.get("/sfx/wrong.mp3",   (_req, res) => sendMediaOrSilent("sfx",   "wrong.mp3",   res));
// NEU: Lock-in/Select-Sound bei Feldwahl
app.get("/sfx/select.mp3",  (_req, res) => sendMediaOrSilent("sfx",   "select.mp3",  res));
// NEU: Hintergrundmusik
app.get("/music/bgm.mp3",   (_req, res) => sendMediaOrSilent("music", "bgm.mp3",     res));

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req,res)=>res.status(200).type('text').send('OK'));

// ─────────────────────────────────────────────────────────────
// Daten laden / normalisieren
// ─────────────────────────────────────────────────────────────
const DATA_PATH = path.join(__dirname, 'public', 'fragen.json');

function loadData(){
  const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  raw.categories.forEach(cat=>{
    cat.items.forEach((it, idx)=>{
      it.answers = (it.answers||[]).slice(0,5).map(a=>{
        const obj = typeof a === 'string' ? { text:a, percent:0 } : a;
        return {
          text: obj.text || '',
          percent: Number(obj.percent)||0,
          alts: Array.isArray(obj.alts) ? obj.alts : [],
          revealed: false,
          byTeam: null // 'A'|'B' – nur Historie/Anzeige
        };
      });
      it.answers.sort((x,y)=> (y.percent - x.percent)); // Top → Bottom

      // Kachel-Label 1..5 (statt 10..50). 'points' ist NUR Anzeige.
      it.points   = (idx+1);
      it.q        = it.q || '';
      it.revealed = false;
      it.answered = false;
      it.meta = {
        originalTeam: null, // Team, das Feld gewählt hat (Start-Team)
        turnTeam: null,     // Team, das aktuell rät
        wrongA: 0,
        wrongB: 0,
        stealActive: false, // Abstauberphase aktiv?
        stealTeam: null,    // Team mit 1 Chance
        stealUsed: false    // Sicherheit
      };
    });
  });
  return raw;
}

let db = loadData();

// ─────────────────────────────────────────────────────────────
// Globaler State
// ─────────────────────────────────────────────────────────────
const state = {
  players: {},            // socketId -> { id,name,team:'A'|'B', score }
  board: db,              // Daten aus fragen.json
  activePlayer: null,     // optional
  turnTeam: null          // globaler Start-Zug, pro Feld in item.meta.turnTeam
};

// ─────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────
function publicBoard(){
  return {
    categories: state.board.categories.map(c=>({
      name: c.name,
      items: c.items.map(it=>({
        points:   it.points,   // Anzeige 1..5
        revealed: it.revealed,
        answered: it.answered,
        answers: it.answers.map(a=>({
          text:     a.revealed ? a.text    : '',
          percent:  a.revealed ? a.percent : 0,
          revealed: a.revealed
        }))
      }))
    }))
  };
}
function adminBoard(){ return state.board; }
function playersList(){
  return Object.values(state.players).map(p=>({ id:p.id, name:p.name, team:p.team, score:p.score }));
}
function emitState(){
  io.emit('state:update', { board: publicBoard(), players: playersList(), activePlayer: state.activePlayer });
  io.to('admins').emit('state:admin', { board: adminBoard(), players: playersList(), activePlayer: state.activePlayer });
}
function otherTeam(t){ return t==='A' ? 'B' : 'A'; }
function sanitize(s){ return String(s||'').trim().toLowerCase(); }
function allFound(item){ return item.answers.every(a=>a.revealed); }

// Punkte nach Prozentsumme
function getRevealedPercent(item){
  return item.answers.reduce((acc,a)=> acc + (a.revealed ? Number(a.percent)||0 : 0), 0);
}
function getTotalPercent(item){
  return item.answers.reduce((acc,a)=> acc + (Number(a.percent)||0), 0);
}

function matchAnswer(item, guess){
  const g = sanitize(guess);
  for (let i=0;i<item.answers.length;i++){
    const a = item.answers[i];
    if (a.revealed) continue;
    const pool = [a.text, ...(a.alts||[])].map(sanitize);
    if (pool.includes(g)) return i; // Index
  }
  return -1;
}

function awardTeamPoints(team, points){
  const members = Object.values(state.players).filter(p=>p.team===team);
  if (members.length===0) return;
  const per = Math.floor(points / members.length) || points; // bei 1 Spieler: volle Punkte
  members.forEach(m=>{
    m.score += per;
    io.emit('score:update', { playerId:m.id, score:m.score, delta:per });
  });
}

function startStealPhase(item){
  item.meta.stealActive = true;
  item.meta.stealTeam   = otherTeam(item.meta.turnTeam || item.meta.originalTeam || 'A');
  item.meta.stealUsed   = false;
  item.meta.turnTeam    = item.meta.stealTeam; // Anzeige: Abstauber-Team ist „am Zug“
  io.emit('turn:changed', { turnTeam: item.meta.turnTeam });
}

function endStealWithResult(catIndex,itemIndex,item, wasCorrect){
  // Punkte = bis dahin aufgedeckte Prozentsumme
  const pts = getRevealedPercent(item);
  const winner = wasCorrect ? (item.meta.stealTeam || otherTeam(item.meta.originalTeam||'A'))
                            : (item.meta.originalTeam || otherTeam(item.meta.stealTeam||'A'));

  item.meta.stealUsed = true;

  awardTeamPoints(winner, pts);

  // Feld beenden & alles zeigen
  item.answers.forEach(a => a.revealed = true);
  item.answered = true;
  item.revealed = true;

  io.emit('tile:closed', { catIndex,itemIndex,winnerTeam:winner,reason: wasCorrect?'steal-correct':'steal-wrong', pointsAwarded: pts });
  emitState();
}

function closeField(catIndex,itemIndex,winnerTeam,reason, pointsAwarded=null){
  const item = state.board.categories[catIndex].items[itemIndex];
  item.answered = true;
  item.revealed = true;
  item.answers.forEach(a=> a.revealed = true); // alle Antworten sichtbar
  io.emit('tile:closed', { catIndex,itemIndex,winnerTeam,reason, pointsAwarded });
  emitState();
}

// ─────────────────────────────────────────────────────────────
// Socket.IO
// ─────────────────────────────────────────────────────────────
io.on('connection', socket => {
  // Rollen
  socket.on('role:admin', () => {
    socket.join('admins');
    socket.emit('state:admin', { board: adminBoard(), players: playersList(), activePlayer: state.activePlayer });
  });
  socket.on('role:player', () => { /* noop */ });

  // Spieler beitreten
  socket.on('player:join', ({ name, team }) => {
    const clean = String(name||'').trim().slice(0,24) || 'Spieler';
    const t = (team === 'B') ? 'B' : 'A';
    state.players[socket.id] = { id:socket.id, name:clean, team:t, score:0 };
    socket.join('team-'+t);
    socket.emit('welcome', { id:socket.id, name:clean, team:t });
    socket.emit('board:init', publicBoard());
    emitState();
  });

  // Team-Chat
  socket.on('chat:team', ({ msg }) => {
    const p = state.players[socket.id]; if (!p) return;
    const payload = { from:{ id:p.id, name:p.name, team:p.team }, msg:String(msg||'').slice(0,400), ts:Date.now() };
    io.to('team-'+p.team).emit('chat:team', payload);
    io.to('admins').emit('chat:spy', payload);
  });

  // Startteam auslosen (Admin)
  socket.on('admin:drawStartTeam', () => {
    const start = Math.random() < 0.5 ? 'A' : 'B';
    state.turnTeam = start;
    io.emit('turn:global', { team:start });
  });

  // Nächste Runde (Admin)
  socket.on('admin:nextRound', () => {
    const curr = state.turnTeam || 'A';
    const next = curr === 'A' ? 'B' : 'A';
    state.turnTeam = next;
    io.emit('turn:global', { team: next });
  });

  // Gewinner-Animation (Admin → Alle)
  socket.on('admin:celebrate', ({ team }) => {
    if (team !== 'A' && team !== 'B') return;
    io.emit('celebrate:winner', { team, ts: Date.now() });
  });

  // Feld wählen (nur Team am Zug)
  socket.on('player:pickTile', ({ catIndex, itemIndex }) => {
    const p = state.players[socket.id]; if (!p) return;
    const cat = state.board.categories[catIndex]; if (!cat) return;
    const item = cat.items[itemIndex]; if (!item || item.revealed || item.answered) return;

    const teamAtTurn = state.turnTeam || p.team; // falls noch nicht ausgelost
    if (p.team !== teamAtTurn) return;

    item.revealed = true;
    item.meta.originalTeam = p.team;
    item.meta.turnTeam     = p.team;
    item.meta.wrongA = 0; item.meta.wrongB = 0;
    item.meta.stealActive = false;
    item.meta.stealTeam   = null;
    item.meta.stealUsed   = false;

    io.emit('tile:revealed', { catIndex,itemIndex, question:item.q, points:item.points, turnTeam:item.meta.turnTeam });
    emitState();
  });

  // Optional: Tipp-Antworten (Standard bleibt: Admin deckt auf)
  socket.on('player:guess', ({ catIndex, itemIndex, guess }) => {
    const p = state.players[socket.id]; if (!p) return;
    const cat = state.board.categories[catIndex]; if (!cat) return;
    const item = cat.items[itemIndex]; if (!item || !item.revealed || item.answered) return;

    // STEAL-PHASE: 1 Chance
    if (item.meta.stealActive){
      if (p.team !== item.meta.stealTeam) return; // nur Abstauber-Team
      const idx = matchAnswer(item, guess);
      if (idx >= 0){
        item.answers[idx].revealed = true;
        item.answers[idx].byTeam   = p.team;
        io.emit('sfx:correct');
        io.emit('answer:revealed', { catIndex,itemIndex, index:idx, text:item.answers[idx].text, percent:item.answers[idx].percent, byTeam:p.team });
        endStealWithResult(catIndex,itemIndex,item,true);
      } else {
        io.emit('sfx:wrong');
        endStealWithResult(catIndex,itemIndex,item,false);
      }
      return;
    }

    // NORMALE PHASE (Start-Team muss ALLES finden)
    if (p.team !== item.meta.turnTeam) return; // nur Team am Zug

    const idx = matchAnswer(item, guess);
    if (idx >= 0){
      item.answers[idx].revealed = true;
      item.answers[idx].byTeam   = p.team;
      io.emit('sfx:correct');
      io.emit('answer:revealed', { catIndex,itemIndex, index:idx, text:item.answers[idx].text, percent:item.answers[idx].percent, byTeam:p.team });

      if (allFound(item)){
        const pts = getTotalPercent(item);               // meist 100
        const winner = item.meta.originalTeam || p.team; // Start-Team
        awardTeamPoints(winner, pts);
        closeField(catIndex,itemIndex,winner,'all-found', pts);
      } else {
        emitState();
      }
      return;
    }

    // falsch in normaler Phase
    io.emit('sfx:wrong');
    if (item.meta.turnTeam === 'A') item.meta.wrongA++; else item.meta.wrongB++;
    const wrongs = (item.meta.turnTeam === 'A') ? item.meta.wrongA : item.meta.wrongB;

    io.emit('guess:wrong', { catIndex,itemIndex, team:item.meta.turnTeam, wrongs });

    if (wrongs === 2){
      const next = otherTeam(item.meta.turnTeam);
      io.to('team-'+next).emit('team:prepare', { catIndex,itemIndex, note:'Ihr dürft euch beraten – Abstauber-Chance ist nah.' });
    }
    if (wrongs >= 3){
      // Abstauber-Phase starten
      startStealPhase(item);
    }

    emitState();
  });

  // Admin: Antwort manuell aufdecken
  socket.on('admin:revealAnswer', ({ catIndex,itemIndex, index }) => {
    const item = state.board.categories[catIndex]?.items[itemIndex]; if (!item) return;
    if (item.answered) return; // Schutz
    const a = item.answers[index]; if (!a || a.revealed) return;

    // Attribution für Anzeige
    const currentTeam = item.meta.stealActive
      ? (item.meta.stealTeam || otherTeam(item.meta.originalTeam||'A'))
      : (item.meta.turnTeam   || state.turnTeam || item.meta.originalTeam);

    a.revealed = true;
    a.byTeam   = currentTeam || null;

    io.emit('answer:revealed', { catIndex,itemIndex, index, text:a.text, percent:a.percent, byTeam:a.byTeam });

    if (item.meta.stealActive){
      // Abstauber-Regel: 1 richtige Antwort reicht → sofort Wertung nach bis dahin aufgedeckter Summe
      endStealWithResult(catIndex,itemIndex,item,true);
      return;
    } else {
      // Normale Phase: nur wenn ALLE offen → Start-Team bekommt Gesamtsumme
      if (allFound(item)){
        const pts = getTotalPercent(item);
        const winner = item.meta.originalTeam || currentTeam || 'A';
        awardTeamPoints(winner, pts);
        closeField(catIndex,itemIndex,winner,'admin-full-reveal', pts);
        return;
      }
      emitState();
    }
  });

  // Admin – als falsch werten
  socket.on('admin:markWrong', ({ catIndex, itemIndex }) => {
    const cat  = state.board.categories[catIndex]; if (!cat) return;
    const item = cat.items[itemIndex];              if (!item || !item.revealed || item.answered) return;

    if (item.meta.stealActive){
      // In Steal-Phase: falsche Antwort → Punkte an Originalteam (bis dahin aufgedeckte Summe)
      io.emit('sfx:wrong');
      endStealWithResult(catIndex,itemIndex,item,false);
      return;
    }

    // Normale Phase: Fehlversuche zählen
    const team = item.meta.turnTeam || state.turnTeam || item.meta.originalTeam || 'A';
    io.emit('sfx:wrong');

    if (team === 'A') item.meta.wrongA++; else item.meta.wrongB++;
    const wrongs = (team === 'A') ? item.meta.wrongA : item.meta.wrongB;
    io.emit('guess:wrong', { catIndex, itemIndex, team, wrongs });

    if (wrongs === 2){
      const next = otherTeam(team);
      io.to('team-'+next).emit('team:prepare', { catIndex, itemIndex, note:'Ihr dürft euch beraten – Abstauber-Chance ist nah.' });
    }
    if (wrongs >= 3){
      startStealPhase(item);
    }

    emitState();
  });

  // Admin: Feld schließen (Zeit abgelaufen etc.)
  socket.on('admin:forceClose', ({ catIndex,itemIndex }) => {
    const item = state.board.categories[catIndex]?.items[itemIndex]; if (!item) return;
    if (item.answered) return;

    // Default laut neuem System:
    //  - In normaler Phase (kein Steal): Punkte = bis jetzt aufgedeckt → an Originalteam
    //  - In Steal-Phase ohne Versuch: Punkte = bis jetzt aufgedeckt → an Originalteam
    const pts = getRevealedPercent(item);
    const winner = item.meta.originalTeam || 'A';

    awardTeamPoints(winner, pts);
    closeField(catIndex,itemIndex,winner,'force-close', pts);
  });

  // Admin: Punkte direkt an Spieler
  socket.on('admin:awardPoints', ({ playerId, points }) => {
    const p = state.players[playerId]; if (!p) return;
    const val = Number(points)||0;
    p.score += val;
    io.emit('score:update', { playerId:p.id, score:p.score, delta:val });
    emitState();
  });

  // Disconnect
  socket.on('disconnect', () => {
    delete state.players[socket.id];
    if (state.activePlayer === socket.id) state.activePlayer = null;
    emitState();
  });
});

// Optional: 416 sauber schlucken (falls doch irgendwo auftritt)
app.use((err, req, res, next) => {
  if (err && (err.status === 416 || err.statusCode === 416)) {
    return res.status(204).end();
  }
  return next(err);
});

// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Quiz-Server läuft auf Port', PORT));
