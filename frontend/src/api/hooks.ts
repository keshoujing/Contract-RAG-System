import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { askQuestion, createQaConversation, deleteQaConversation, getConfig, getConflicts, getContract, getContracts, getProcessingRows, getQaConversation, getQaConversations, resolveConflict, retryContractSync } from "./client";
import type { ProcessingRow } from "./types";

interface ContractQuery {
  q?: string;
  department?: string;
  status?: string;
  year?: string;
  sort?: string;
}

export function useContracts(query: ContractQuery = {}) {
  return useQuery({ queryKey: ["contracts", query], queryFn: () => getContracts(query), retry: false });
}

export function useContract(contractId?: string) {
  return useQuery({
    queryKey: ["contracts", contractId],
    queryFn: () => getContract(contractId ?? ""),
    enabled: Boolean(contractId),
    retry: false
  });
}

export function useProcessingRows() {
  return useQuery({
    queryKey: ["processing"],
    queryFn: getProcessingRows,
    retry: false,
    refetchInterval: (query) => shouldPollProcessingRows(query.state.data as ProcessingRow[] | undefined) ? 5000 : false
  });
}

function shouldPollProcessingRows(rows?: ProcessingRow[]) {
  return Boolean(rows?.some((row) =>
    row.ingest.status !== "done" ||
    row.sync.state === "pending" ||
    row.sync.state === "retrying" ||
    row.sync.state === "conflict"
  ));
}

export function useRetryContractSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: retryContractSync,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["processing"] })
  });
}

export function useConflicts(contractId: string) {
  return useQuery({ queryKey: ["conflicts", contractId], queryFn: () => getConflicts(contractId), retry: false });
}

export function useResolveConflict() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: resolveConflict,
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ["conflicts", variables.contractId] });
      queryClient.invalidateQueries({ queryKey: ["processing"] });
    }
  });
}

export function useConfig() {
  return useQuery({ queryKey: ["config"], queryFn: getConfig });
}

export function useAskQuestion() {
  return useMutation({ mutationFn: askQuestion });
}

export function useQaConversations() {
  return useQuery({ queryKey: ["qa-conversations"], queryFn: getQaConversations });
}

export function useQaConversation(conversationId?: string | null) {
  return useQuery({
    queryKey: ["qa-conversations", conversationId],
    queryFn: () => getQaConversation(conversationId ?? ""),
    enabled: Boolean(conversationId),
    retry: false
  });
}

export function useCreateQaConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createQaConversation,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["qa-conversations"] })
  });
}

export function useDeleteQaConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteQaConversation,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["qa-conversations"] })
  });
}
