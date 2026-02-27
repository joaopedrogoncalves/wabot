const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

console.log = (...args: any[]) => {
  originalLog(`[${timestamp()}]`, ...args);
};

console.error = (...args: any[]) => {
  originalError(`[${timestamp()}]`, ...args);
};

console.warn = (...args: any[]) => {
  originalWarn(`[${timestamp()}]`, ...args);
};
