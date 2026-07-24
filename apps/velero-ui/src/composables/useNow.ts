import { onMounted, onUnmounted, ref } from 'vue';

const now = ref(Date.now());
let interval: ReturnType<typeof setInterval> | null = null;

export function useNow() {
  onMounted(() => {
    if (!interval) {
      interval = setInterval(() => {
        now.value = Date.now();
      }, 1000);
    }
  });

  onUnmounted(() => {
    clearInterval(interval);
    interval = null;
  });

  return { now };
}
