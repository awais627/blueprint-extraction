const BASE = import.meta.env.VITE_API_BASE_URL ?? ''

class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      detail = body.detail ?? JSON.stringify(body)
    } catch {
      /* keep statusText */
    }
    throw new ApiError(res.status, detail)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const api = {
  get: <T>(path: string) => fetch(`${BASE}${path}`).then((r) => handle<T>(r)),

  post: <T>(path: string, body?: unknown) =>
    fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then((r) => handle<T>(r)),

  postForm: <T>(path: string, form: FormData) =>
    fetch(`${BASE}${path}`, { method: 'POST', body: form }).then((r) => handle<T>(r)),

  patch: <T>(path: string, body: unknown) =>
    fetch(`${BASE}${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => handle<T>(r)),

  put: <T>(path: string, body: unknown) =>
    fetch(`${BASE}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => handle<T>(r)),

  delete: (path: string) => fetch(`${BASE}${path}`, { method: 'DELETE' }).then((r) => handle<void>(r)),
}

export { ApiError }
