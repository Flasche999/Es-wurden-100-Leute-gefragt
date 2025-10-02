js
});


// Admin: Antwort manuell aufdecken
socket.on('admin:revealAnswer', ({ catIndex,itemIndex, index }) => {
const item = state.board.categories[catIndex]?.items[itemIndex]; if (!item) return;
const a = item.answers[index]; if (!a || a.revealed) return;
a.revealed = true; a.byTeam = null; // manuell
io.emit('answer:revealed', { catIndex,itemIndex, index, text:a.text, percent:a.percent, byTeam:null });
if (allFound(item)){
// Wenn alles manuell aufgedeckt, Punkte standardmäßig an Originalteam
awardTeamPoints(item.meta.originalTeam || 'A', item.points);
closeField(catIndex,itemIndex,(item.meta.originalTeam||'A'),'admin-full-reveal');
} else {
emitState();
}
});


// Admin: Feld schließen (z. B. Zeit abgelaufen)
socket.on('admin:forceClose', ({ catIndex,itemIndex }) => {
const item = state.board.categories[catIndex]?.items[itemIndex]; if (!item) return;
if (item.answered) return;


// Gewinnerlogik laut Vorgabe, wenn offenes Feld beendet wird:
// · Wenn Gegenteam dran und schafft Rest nicht → Punkte an Originalteam
// · Wenn beide Teams 3x falsch hatten → Punkte an Team mit TOP-Antwort
const aDone = (item.meta.wrongA >= 3);
const bDone = (item.meta.wrongB >= 3);


let winner = null;
if (aDone && bDone){
winner = fieldWinnerOnDoubleFail(item);
} else if (item.meta.turnTeam !== item.meta.originalTeam){
// Steal misslungen → zurück an Originalteam
winner = item.meta.originalTeam;
} else {
// Default Fallback
winner = item.meta.originalTeam;
}


awardTeamPoints(winner, item.points);
closeField(catIndex,itemIndex,winner,'force-close');
});


// Admin: Punkte direkt an Spieler
socket.on('admin:awardPoints', ({ playerId, points }) => {
const p = state.players[playerId]; if (!p) return;
const val = Number(points)||0; p.score += val;
io.emit('score:update', { playerId:p.id, score:p.score, delta:val });
emitState();
});


socket.on('disconnect', () => {
delete state.players[socket.id];
if (state.activePlayer === socket.id) state.activePlayer = null;
emitState();
});
});


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Quiz-Server läuft auf Port', PORT));