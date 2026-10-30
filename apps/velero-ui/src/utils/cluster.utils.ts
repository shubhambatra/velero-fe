import { ref } from 'vue';

const STORAGE_KEY = 'kube_context';

/** Header (and socket handshake field) the API uses to pick the cluster context. */
export const KUBE_CONTEXT_HEADER = 'X-Kube-Context';

const selected = ref<string | null>(localStorage.getItem(STORAGE_KEY));

/** Reactive name of the cluster being managed, null on the cluster dashboard. */
export const selectedCluster = selected;

export const getSelectedCluster = (): string | null =>
  localStorage.getItem(STORAGE_KEY);

export const setSelectedCluster = (name: string | null): void => {
  if (name) {
    localStorage.setItem(STORAGE_KEY, name);
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
  selected.value = name;
};
