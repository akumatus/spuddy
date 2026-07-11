// Persistent app state — a JSON file in userData, replacing the renderer's
// localStorage (whose ~5MB per-origin quota forced trimming the chat log).
// The renderer owns the state shape and does all (de)serialization; main is
// just the disk. Load is synchronous (sendSync) because the renderer reads
// state exactly once, at boot, before anything renders.
import { app, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

// resolved lazily so the PP_USERDATA test redirect (set in main.ts) applies
const stateFile = () => path.join(app.getPath('userData'), 'state.json');

export function registerStoreIpc(): void {
  ipcMain.on('state-load', (e) => {
    try {
      e.returnValue = fs.readFileSync(stateFile(), 'utf8');
    } catch (err) {
      e.returnValue = null; // first run / unreadable — renderer falls back to localStorage
    }
  });

  // write tmp + rename: a crash mid-write leaves the previous file intact
  // rather than a truncated one
  ipcMain.on('state-save', (_e, json: string) => {
    try {
      const file = stateFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', json);
      fs.renameSync(file + '.tmp', file);
    } catch (err) {
      // disk full or locked — keep the previous state.json, drop this save
    }
  });

  ipcMain.on('state-reset', () => {
    try {
      fs.rmSync(stateFile(), { force: true });
    } catch (err) {}
  });
}
