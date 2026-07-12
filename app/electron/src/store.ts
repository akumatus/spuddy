// Persistent app state, split across two files in userData:
//  - state.json — everything small (day, cards, memory, settings). Rewritten
//    whole on every save, so it must stay bounded.
//  - chat.jsonl — the unbounded chat transcript, one JSON message per line.
//    Appended to as turns finish, never rewritten per message; boot reads only
//    the tail and the Book pages older lines in on demand (see src/store.ts).
// The renderer owns the state shape and does all (de)serialization; main is
// just the disk. Loads are synchronous (sendSync): state.json is read exactly
// once at boot before anything renders, and chat pages are a few ms of file IO.
import { app, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

// resolved lazily so the PP_USERDATA test redirect (set in main.ts) applies
const stateFile = () => path.join(app.getPath('userData'), 'state.json');
const chatFile = () => path.join(app.getPath('userData'), 'chat.jsonl');

// write tmp + rename: a crash mid-write leaves the previous file intact
// rather than a truncated one
function atomicWrite(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', data);
  fs.renameSync(file + '.tmp', file);
}

export function registerStoreIpc(): void {
  ipcMain.on('state-load', (e) => {
    try {
      e.returnValue = fs.readFileSync(stateFile(), 'utf8');
    } catch (err) {
      e.returnValue = null; // first run / unreadable — renderer falls back to localStorage
    }
  });

  ipcMain.on('state-save', (_e, json: string) => {
    try {
      atomicWrite(stateFile(), json);
    } catch (err) {
      // disk full or locked — keep the previous state.json, drop this save
    }
  });

  ipcMain.on('state-reset', () => {
    try {
      fs.rmSync(stateFile(), { force: true });
      fs.rmSync(chatFile(), { force: true });
    } catch (err) {}
  });

  // Read a window of the transcript: lines [before-limit, before), plus the
  // file's total line count so the renderer can track where its window sits.
  // before = null means "the tail". Lines go back raw — the renderer parses.
  ipcMain.on('chat-load', (e, arg: { before: number | null; limit: number }) => {
    try {
      const lines = fs.readFileSync(chatFile(), 'utf8').split('\n').filter((l) => l);
      const end = arg.before == null ? lines.length : Math.min(arg.before, lines.length);
      const start = Math.max(0, end - arg.limit);
      e.returnValue = { lines: lines.slice(start, end), total: lines.length };
    } catch (err) {
      e.returnValue = { lines: [], total: 0 }; // no transcript yet
    }
  });

  ipcMain.on('chat-append', (_e, lines: string[]) => {
    try {
      const file = chatFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, lines.map((l) => l + '\n').join(''));
    } catch (err) {
      // dropped lines are a few chat messages, not the whole save — accept
    }
  });

  // full rewrite — only for "clear chat" and the one-time state.json migration
  ipcMain.on('chat-rewrite', (_e, lines: string[]) => {
    try {
      atomicWrite(chatFile(), lines.map((l) => l + '\n').join(''));
    } catch (err) {}
  });
}
