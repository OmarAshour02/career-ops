// Bridge: the only things the window can ask the main process to do.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('co', {
  load: () => ipcRenderer.invoke('data:load'),
  text: (rel) => ipcRenderer.invoke('file:text', rel),
  openPath: (rel) => ipcRenderer.invoke('open:path', rel),
  reveal: (rel) => ipcRenderer.invoke('open:reveal', rel),
  openUrl: (url) => ipcRenderer.invoke('open:url', url),
  setStatus: (id, state) => ipcRenderer.invoke('status:set', id, state),
  syncInbox: () => ipcRenderer.invoke('inbox:sync'),
  assign: (uid, id) => ipcRenderer.invoke('inbox:assign', uid, id),
  onChange: (fn) => ipcRenderer.on('data:changed', fn),
  root: () => ipcRenderer.invoke('root:get'),
  chooseRoot: () => ipcRenderer.invoke('root:choose'),
  settings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  saveEnv: (vals) => ipcRenderer.invoke('settings:env', vals),
  setPaused: (on) => ipcRenderer.invoke('settings:pause', on),
  setSchedule: (time) => ipcRenderer.invoke('settings:schedule', time),
  pickResume: () => ipcRenderer.invoke('settings:resume'),
  testEmail: () => ipcRenderer.invoke('settings:email-test'),
  saveCv: (text) => ipcRenderer.invoke('settings:cv', text),
  cvFromPdf: () => ipcRenderer.invoke('settings:cv-from-pdf'),
  aiCheck: () => ipcRenderer.invoke('settings:ai-check'),
  runState: () => ipcRenderer.invoke('run:state'),
  runStart: (dry) => ipcRenderer.invoke('run:start', dry),
  runStop: () => ipcRenderer.invoke('run:stop'),
});
