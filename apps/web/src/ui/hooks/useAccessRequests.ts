/** The requester's side of gated sign-up (D9): `POST /api/access-requests` from /pending. */
import { accessRequestSchema, type CreateAccessRequest } from '@rocketflare/shared/access-requests'
import { useMutation } from '@tanstack/react-query'
import { useAuth } from '@/ui/hooks/useAuth'
import { api } from '@/ui/lib/api-client'

export function useCreateAccessRequest() {
  const { refresh } = useAuth()
  return useMutation({
    mutationFn: (body: CreateAccessRequest) =>
      api.post('/api/access-requests', body, {
        schema: accessRequestSchema,
        showSuccessToast: true,
        successMessage: 'Request sent',
      }),
    onSuccess: () => refresh(),
  })
}
