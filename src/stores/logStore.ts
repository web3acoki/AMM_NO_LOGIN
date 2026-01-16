import { defineStore } from 'pinia';

export type LogItem = { time: number; message: string };

export const useLogStore = defineStore('log', {
  state: () => ({
    logs: [] as LogItem[],
  }),
  actions: {
    push(message: string) { this.logs.unshift({ time: Date.now(), message }); },
    clear() { this.logs = []; },
    exportJson() {
      const blob = new Blob([JSON.stringify(this.logs, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `logs-${Date.now()}.json`; a.click();
      URL.revokeObjectURL(url);
    },
  },
});


