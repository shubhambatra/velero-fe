import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import type { AxiosInstance } from 'axios';
import { inject } from 'vue';

export interface ClusterSummary {
  name: string;
  server: string;
  isDefault: boolean;
  connected: boolean;
  version?: string;
}

export interface ClustersResponse {
  managed: boolean;
  clusters: ClusterSummary[];
}

const CLUSTERS_KEY = ['clusters'];

export const useClusters = () => {
  const axiosInstance: AxiosInstance = inject('axios') as AxiosInstance;

  return useQuery<ClustersResponse>({
    queryKey: CLUSTERS_KEY,
    queryFn: async () => (await axiosInstance.get('/clusters')).data,
    refetchInterval: 30_000,
  });
};

export const useAddCluster = () => {
  const axiosInstance: AxiosInstance = inject('axios') as AxiosInstance;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (kubeconfig: string) =>
      (await axiosInstance.post('/clusters', { kubeconfig })).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CLUSTERS_KEY }),
  });
};

export const useDeleteCluster = () => {
  const axiosInstance: AxiosInstance = inject('axios') as AxiosInstance;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (name: string) =>
      await axiosInstance.delete(`/clusters/${encodeURIComponent(name)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CLUSTERS_KEY }),
  });
};
