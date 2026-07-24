import { defineStore } from 'pinia';
import { changeLocale } from '@formkit/vue';
import { i18n } from '@velero-ui-app/plugins/i18n.plugin';
import {
  getDefaultLocal,
  getDefaultTimeFormat24h,
  getDefaultTimezone,
} from '@velero-ui-app/utils/config.utils';

export interface AppStore {
  hideSidebar: boolean;
  language: string;
  timezone: string;
  timeFormat24h: boolean;
}

export const useAppStore = defineStore('app', {
  state: () =>
    ({
      hideSidebar: true,
      language: getDefaultLocal(),
      timezone: getDefaultTimezone(),
      timeFormat24h: getDefaultTimeFormat24h(),
    }) as AppStore,
  actions: {
    toggleSidebar(): void {
      this.hideSidebar = !this.hideSidebar;
    },
    setLanguage(code: string) {
      this.language = code;
      changeLocale(code);
      i18n.global.locale.value = code;
      localStorage.setItem('language', code);
    },
    setTimezone(code: string) {
      this.timezone = code;
      localStorage.setItem('timezone', code);
    },
    setTimeFormat24h(is24h: boolean) {
      this.timeFormat24h = is24h;
      localStorage.setItem('timeFormat24h', String(is24h));
    },
  },
});
