import { TauriServices } from './tauri-services';
import { TauriOcr } from './tauri-ocr';
// Separate from dictionary imports/Kuromoji CPU work so HTTP timers and results stay responsive.
let nextId = 1;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
const native = (channel: string, ...args: unknown[]) => new Promise<any>((resolve, reject) => {
  const id = nextId++; pending.set(id, { resolve, reject }); self.postMessage({ kind: 'native', id, channel, args });
});
const services = new TauriServices(native);
const ocr = new TauriOcr(native);
self.onmessage = event => {
  const message = event.data;
  if (message.kind === 'native-result') {
    const item = pending.get(message.id); pending.delete(message.id);
    if (message.error !== undefined) item?.reject(new Error(message.error)); else item?.resolve(message.value);
    return;
  }
  void (message.channel === 'ocr:initialize' || message.channel === 'ocr:finalize' ? ocr.finalize() : services.request(message.channel, message.args)).then(
    value => self.postMessage({ kind: 'result', id: message.id, value }),
    error => self.postMessage({ kind: 'result', id: message.id, error: String(error) }),
  );
};
