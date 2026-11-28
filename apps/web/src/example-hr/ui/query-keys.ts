import { EXAMPLE_HR_LEAVE_ENTITY } from '@rocketflare/shared/example-hr/index'

export const leaveKeys = {
  all: [EXAMPLE_HR_LEAVE_ENTITY] as const,
  list: (page: number) => [EXAMPLE_HR_LEAVE_ENTITY, 'list', page] as const,
}

export const exampleHrQueryKeys = { [EXAMPLE_HR_LEAVE_ENTITY]: leaveKeys } as const
