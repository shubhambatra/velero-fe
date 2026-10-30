<template>
  <Header />
  <div class="flex overflow-hidden">
    <Sidebar v-if="!onClusters" />
    <div
      :class="{ 'lg:ml-64': hideSidebar && !onClusters }"
      class="relative w-full mt-16 h-[calc(100vh-4rem)] overflow-y-auto"
    >
      <BreadCrumb v-if="!onClusters" />
      <router-view />
    </div>
  </div>
  <Toasts />
</template>
<script lang="ts" setup>
import Header from '@velero-ui-app/layouts/default/components/Header.vue';
import Sidebar from '@velero-ui-app/layouts/default/components/Sidebar.vue';
import BreadCrumb from '@velero-ui-app/layouts/default/components/BreadCrumb.vue';
import Toasts from '@velero-ui-app/components/Toasts/Toasts.vue';
import { useAppStore } from '@velero-ui-app/stores/app.store';
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { Pages } from '@velero-ui-app/utils/constants.utils';

const appStore = useAppStore();
const { hideSidebar } = storeToRefs(appStore);
const route = useRoute();
// The cluster dashboard sits outside any one cluster, so it has no cluster sidebar.
const onClusters = computed(() => route.name === Pages.CLUSTERS.name);
</script>
