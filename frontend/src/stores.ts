import { defineStore } from 'pinia'

export type SessionUser = {
  id: string
  fullName: string
  email: string
  role: string
  roleId?: string
  scope?: string
  siteIds: string[]
  permissions: string[]
  csrfToken: string
  organization: { id?: string; name: string } | null
  memberships?: { organizationId: string; organization: { id: string; name: string }; role: { id: string; code: string; name: string } }[]
}

export const useWorkspaceStore = defineStore('workspace', {
  state: () => ({
    session: null as SessionUser | null,
    sessionChecked: false,
    sessionRequest: null as Promise<SessionUser | null> | null,
    activeSiteId: ''
  }),
  getters: {
    organizationName: state => state.session?.organization?.name || '',
    role: state => state.session?.role || '',
    userName: state => state.session?.fullName || '',
    permissions: state => state.session?.permissions || []
  },
  actions: {
    setSession(user: SessionUser | null) {
      this.session = user
      this.sessionChecked = true
      this.sessionRequest = null
      if (user?.siteIds?.length && !user.siteIds.includes(this.activeSiteId)) this.activeSiteId = user.siteIds[0]
      if (!user) this.activeSiteId = ''
    },
    async loadSession(force = false): Promise<SessionUser | null> {
      if (!force && this.sessionChecked) return this.session
      if (this.sessionRequest) return this.sessionRequest
      this.sessionRequest = fetch('/api/v1/auth/me', { credentials: 'same-origin', cache: 'no-store' })
        .then(async response => {
          if (!response.ok) return null
          const payload = await response.json()
          return (payload.data || null) as SessionUser | null
        })
        .catch(() => null)
      const user = await this.sessionRequest
      this.setSession(user)
      return user
    },
    hasAnyPermission(required?: string[]) {
      if (!required?.length) return true
      const granted = this.session?.permissions || []
      return granted.includes('*') || required.some(permission => granted.includes(permission))
    }
  }
})
