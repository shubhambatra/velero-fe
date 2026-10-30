<template>
  <div class="min-h-full px-4 pb-6 bg-gray-50 dark:bg-gray-900">
    <div class="flex items-center justify-between pb-4">
      <div>
        <h1
          class="text-xl font-semibold text-gray-900 sm:text-2xl dark:text-white"
        >
          {{ t('clusters.title') }}
        </h1>
        <p class="text-sm text-gray-500 dark:text-gray-400">
          {{ t('clusters.subtitle') }}
        </p>
      </div>
      <button
        v-if="canManage"
        :disabled="!data?.managed"
        :title="data?.managed ? '' : t('clusters.add.readOnly')"
        class="text-white bg-blue-600 hover:bg-blue-800 focus:ring-4 focus:ring-blue-300 disabled:opacity-50 font-medium rounded-lg text-sm inline-flex items-center px-3 py-2.5 dark:focus:ring-blue-800"
        type="button"
        @click="showAdd = true"
      >
        <FontAwesomeIcon :icon="faPlus" class="!w-4 !h-4 mr-2" />
        {{ t('clusters.add.button') }}
      </button>
    </div>

    <p v-if="isError" class="text-sm text-red-600">
      {{ t('clusters.error.load') }}
    </p>
    <p
      v-else-if="data && data.clusters.length === 0"
      class="text-sm text-gray-500 dark:text-gray-400"
    >
      {{ t('clusters.empty') }}
    </p>

    <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      <div
        v-for="cluster in data?.clusters"
        :key="cluster.name"
        class="p-4 bg-white border border-gray-200 rounded-lg shadow-sm cursor-pointer hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700"
        role="button"
        tabindex="0"
        @click="open(cluster.name)"
        @keydown.enter="open(cluster.name)"
      >
        <div class="flex items-start justify-between">
          <div class="min-w-0">
            <h3
              class="flex items-center text-lg font-bold text-gray-900 dark:text-white"
            >
              <FontAwesomeIcon :icon="faServer" class="!w-4 !h-4 mr-2" />
              <span class="truncate">{{ cluster.name }}</span>
            </h3>
            <div
              class="mt-1 text-sm text-gray-500 truncate dark:text-gray-400"
              :title="cluster.server"
            >
              {{ cluster.server }}
            </div>
            <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {{ cluster.version }}
            </div>
          </div>
          <button
            v-if="canManage && data?.managed"
            :aria-label="t('clusters.delete.button')"
            class="p-2 text-gray-400 rounded-lg hover:text-red-600 hover:bg-gray-100 dark:hover:bg-gray-600"
            type="button"
            @click.stop="toDelete = cluster.name"
          >
            <FontAwesomeIcon :icon="faTrash" class="!w-4 !h-4" />
          </button>
        </div>
        <div class="flex items-center mt-3 space-x-3 text-xs">
          <span class="inline-flex items-center">
            <span
              :class="cluster.connected ? 'bg-green-400' : 'bg-red-500'"
              class="h-2.5 w-2.5 rounded-full mr-2"
            />
            {{
              cluster.connected
                ? t('clusters.connected')
                : t('clusters.unreachable')
            }}
          </span>
          <span
            v-if="cluster.isDefault"
            class="px-2 py-0.5 text-gray-700 bg-gray-100 rounded dark:bg-gray-600 dark:text-gray-200"
          >
            {{ t('clusters.default') }}
          </span>
        </div>
      </div>
    </div>

    <div v-if="showAdd" class="relative z-20">
      <div class="fixed inset-0 bg-gray-500/75" />
      <div class="fixed inset-0 flex items-center justify-center p-4">
        <form
          class="w-full max-w-2xl p-6 bg-white rounded-lg shadow dark:bg-gray-800"
          @submit.prevent="submitAdd"
        >
          <h3 class="mb-2 text-lg font-semibold text-gray-900 dark:text-white">
            {{ t('clusters.add.title') }}
          </h3>
          <p class="mb-3 text-sm text-gray-500 dark:text-gray-400">
            {{ t('clusters.add.help') }}
          </p>
          <textarea
            v-model="kubeconfig"
            :placeholder="t('clusters.add.placeholder')"
            class="w-full h-64 p-2 font-mono text-xs text-gray-900 border border-gray-300 rounded-lg bg-gray-50 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            required
            spellcheck="false"
          />
          <p v-if="addError" class="mt-2 text-sm text-red-600">
            {{ addError }}
          </p>
          <div class="flex justify-end mt-4 space-x-2">
            <button
              class="text-gray-900 bg-white border border-gray-200 hover:bg-gray-100 font-medium rounded-lg text-sm px-3 py-2.5 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-600 dark:hover:bg-gray-700"
              type="button"
              @click="closeAdd"
            >
              {{ t('modal.button.no.title') }}
            </button>
            <button
              :disabled="addCluster.isPending.value"
              class="text-white bg-blue-600 hover:bg-blue-800 disabled:opacity-50 font-medium rounded-lg text-sm px-3 py-2.5"
              type="submit"
            >
              {{ t('clusters.add.submit') }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <ModalConfirmation
      v-if="toDelete"
      :icon="faTrash"
      :text="t('clusters.delete.confirm', { name: toDelete })"
      @on-cancel="toDelete = null"
      @on-close="toDelete = null"
      @on-confirm="confirmDelete"
    />
  </div>
</template>

<script lang="ts" setup>
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useQueryClient } from '@tanstack/vue-query';
import { useI18n } from 'vue-i18n';
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome';
import { faPlus, faServer, faTrash } from '@fortawesome/free-solid-svg-icons';
import { Action, type AppPublicConfig } from '@velero-ui/shared-types';
import { inject } from 'vue';
import ModalConfirmation from '@velero-ui-app/components/Modals/ModalConfirmation.vue';
import {
  useAddCluster,
  useClusters,
  useDeleteCluster,
} from '@velero-ui-app/composables/cluster/useClusters';
import { Pages } from '@velero-ui-app/utils/constants.utils';
import {
  getSelectedCluster,
  setSelectedCluster,
} from '@velero-ui-app/utils/cluster.utils';
import { getUser } from '@velero-ui-app/utils/jwt.utils';
import { canAbility } from '@velero-ui-app/utils/policy.utils';
import { resetSocketIOConnection } from '@velero-ui-app/plugins/socket.plugin';
import { ToastType, useToastsStore } from '@velero-ui-app/stores/toasts.store';

const { t } = useI18n();
const router = useRouter();
const queryClient = useQueryClient();
const toastsStore = useToastsStore();
const { noAuthRequired } = inject('config') as AppPublicConfig;

const { data, isError } = useClusters();
const addCluster = useAddCluster();
const deleteCluster = useDeleteCluster();

const showAdd = ref(false);
const kubeconfig = ref('');
const addError = ref('');
const toDelete = ref<string | null>(null);

const canManage = computed(() => {
  if (noAuthRequired) {
    return true;
  }
  const token = localStorage.getItem('access_token');
  return !!token && canAbility(getUser(token).permissions, Action.Manage, 'all');
});

const open = async (name: string) => {
  // Drop everything cached for the previous cluster before any page reads it.
  if (getSelectedCluster() !== name) {
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'clusters' });
    setSelectedCluster(name);
    resetSocketIOConnection();
  }
  await router.push(Pages.HOME.path);
};

const closeAdd = () => {
  showAdd.value = false;
  kubeconfig.value = '';
  addError.value = '';
};

const submitAdd = () => {
  addError.value = '';
  addCluster.mutate(kubeconfig.value, {
    onSuccess: () => {
      toastsStore.push(t('clusters.add.success'), ToastType.SUCCESS);
      closeAdd();
    },
    onError: (e: any) => {
      addError.value = e?.response?.data?.message ?? t('clusters.error.add');
    },
  });
};

const confirmDelete = () => {
  const name = toDelete.value;
  toDelete.value = null;
  if (!name) {
    return;
  }
  deleteCluster.mutate(name, {
    onSuccess: () => {
      if (getSelectedCluster() === name) {
        setSelectedCluster(null);
      }
      toastsStore.push(t('clusters.delete.success'), ToastType.SUCCESS);
    },
    onError: () => toastsStore.push(t('clusters.error.delete'), ToastType.ERROR),
  });
};
</script>
