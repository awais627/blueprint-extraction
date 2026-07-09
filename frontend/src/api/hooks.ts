import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api, ApiError } from './client'
import type {
  BBox,
  DashboardData,
  Document,
  DocumentDetail,
  ExtractedField,
  FieldDefinitionInput,
  Meta,
  PartType,
  PromptPreview,
  PromptVersion,
  StandardRule,
  Correction,
} from './types'

// ---- meta ------------------------------------------------------------------

export const useMeta = () =>
  useQuery({ queryKey: ['meta'], queryFn: () => api.get<Meta>('/api/meta'), staleTime: Infinity })

// ---- documents -------------------------------------------------------------

const anyActive = (docs: Document[] | undefined) =>
  (docs ?? []).some((d) => d.status === 'queued' || d.status === 'processing')

export const useDocuments = () =>
  useQuery({
    queryKey: ['documents'],
    queryFn: () => api.get<Document[]>('/api/documents'),
    refetchInterval: (query) => (anyActive(query.state.data) ? 1500 : 8000),
  })

export const useDocument = (id: string | undefined) =>
  useQuery({
    queryKey: ['documents', id],
    queryFn: () => api.get<DocumentDetail>(`/api/documents/${id}`),
    enabled: !!id,
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status === 404) && failureCount < 1,
    refetchInterval: (query) => {
      const d = query.state.data
      return d && (d.status === 'queued' || d.status === 'processing') ? 1200 : false
    },
  })

export const useUploadDocuments = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ files, partTypeId }: { files: File[]; partTypeId: number }) => {
      const form = new FormData()
      files.forEach((f) => form.append('files', f))
      form.append('part_type_id', String(partTypeId))
      return api.postForm<Document[]>('/api/documents', form)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['documents'] }),
  })
}

export const useProcessDocument = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post<Document>(`/api/documents/${id}/process`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['documents'] }),
  })
}

export const useProcessPending = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<Document[]>('/api/documents/process-pending'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['documents'] }),
  })
}

export const useDeleteDocument = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/documents/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['documents'] }),
  })
}

// ---- fields & corrections --------------------------------------------------

export const useSetFieldStatus = (documentId: string) => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ fieldId, status }: { fieldId: number; status: 'verified' | 'unverified' }) =>
      api.patch<ExtractedField>(`/api/fields/${fieldId}`, { status }),
    onMutate: async ({ fieldId, status }) => {
      await qc.cancelQueries({ queryKey: ['documents', documentId] })
      const previous = qc.getQueryData<DocumentDetail>(['documents', documentId])
      if (previous) {
        qc.setQueryData<DocumentDetail>(['documents', documentId], {
          ...previous,
          fields: previous.fields.map((f) => (f.id === fieldId ? { ...f, status } : f)),
        })
      }
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        qc.setQueryData(['documents', documentId], context.previous)
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['documents', documentId] })
      qc.invalidateQueries({ queryKey: ['documents'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

export const useCreateCorrection = (documentId: string) => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: {
      field_id: number
      corrected_value: string
      reason: string
      category?: string
      bbox?: BBox | null
    }) => api.post<Correction>('/api/corrections', payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['documents', documentId] })
      qc.invalidateQueries({ queryKey: ['documents'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
      qc.invalidateQueries({ queryKey: ['prompt'] })
    },
  })
}

/** Printed text under an engineer's marked box, for previewing the reason that will
    feed into the extraction prompt. Same OCR lookup the backend uses when saving. */
export const useRegionSnippet = () =>
  useMutation({
    mutationFn: ({ fieldId, bbox }: { fieldId: number; bbox: BBox }) =>
      api.post<{ source_snippet: string | null }>('/api/corrections/preview-snippet', {
        field_id: fieldId,
        bbox,
      }),
  })

// ---- part types --------------------------------------------------------------

export const usePartTypes = () =>
  useQuery({ queryKey: ['part-types'], queryFn: () => api.get<PartType[]>('/api/part-types') })

export const useCreatePartType = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: { name: string; description: string }) =>
      api.post<PartType>('/api/part-types', payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['part-types'] }),
  })
}

export const useUpdatePartType = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...payload }: { id: number; name: string; description: string }) =>
      api.patch<PartType>(`/api/part-types/${id}`, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['part-types'] }),
  })
}

export const useDeletePartType = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api.delete(`/api/part-types/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['part-types'] }),
  })
}

export const useSaveFields = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ partTypeId, fields }: { partTypeId: number; fields: FieldDefinitionInput[] }) =>
      api.put<PartType>(`/api/part-types/${partTypeId}/fields`, fields),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['part-types'] })
      qc.invalidateQueries({ queryKey: ['prompt'] })
    },
  })
}

// ---- standards ---------------------------------------------------------------

export const useStandards = () =>
  useQuery({ queryKey: ['standards'], queryFn: () => api.get<StandardRule[]>('/api/standards') })

export const useCreateStandard = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: { title: string; rule: string; context: string; active: boolean }) =>
      api.post<StandardRule>('/api/standards', payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['standards'] })
      qc.invalidateQueries({ queryKey: ['prompt'] })
    },
  })
}

export const useUpdateStandard = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...payload }: { id: number } & Partial<Omit<StandardRule, 'id' | 'sort_order' | 'updated_at'>>) =>
      api.patch<StandardRule>(`/api/standards/${id}`, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['standards'] })
      qc.invalidateQueries({ queryKey: ['prompt'] })
    },
  })
}

export const useDeleteStandard = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api.delete(`/api/standards/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['standards'] })
      qc.invalidateQueries({ queryKey: ['prompt'] })
    },
  })
}

// ---- prompt ------------------------------------------------------------------

export const usePromptPreview = (partTypeId: number | undefined) =>
  useQuery({
    queryKey: ['prompt', 'preview', partTypeId],
    queryFn: () => api.get<PromptPreview>(`/api/prompt/preview?part_type_id=${partTypeId}`),
    enabled: !!partTypeId,
  })

export const usePromptVersions = () =>
  useQuery({ queryKey: ['prompt', 'versions'], queryFn: () => api.get<PromptVersion[]>('/api/prompt/versions') })

export const usePublishVersion = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: { label?: string; notes: string }) =>
      api.post<PromptVersion>('/api/prompt/versions', payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['prompt'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

// ---- dashboard ---------------------------------------------------------------

export const useDashboard = () =>
  useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardData>('/api/dashboard'),
    refetchInterval: 10000,
  })
