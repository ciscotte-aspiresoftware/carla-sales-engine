import { useEffect, useState } from 'react'
import { IconCheck, IconAlertCircle, IconX } from '@tabler/icons-react'
import { cn } from '@/lib/utils'

export interface ToastMessage {
  id: string
  type: 'success' | 'error' | 'info'
  message: string
  duration?: number
}

const toastQueue: ToastMessage[] = []
const listeners: Set<(messages: ToastMessage[]) => void> = new Set()

export function addToast(message: string, type: 'success' | 'error' | 'info' = 'info', duration = 4000) {
  const id = `${Date.now()}-${Math.random()}`
  const toast: ToastMessage = { id, type, message, duration }
  toastQueue.push(toast)
  notifyListeners()

  if (duration > 0) {
    setTimeout(() => {
      removeToast(id)
    }, duration)
  }
}

export function removeToast(id: string) {
  const idx = toastQueue.findIndex(t => t.id === id)
  if (idx >= 0) {
    toastQueue.splice(idx, 1)
    notifyListeners()
  }
}

function notifyListeners() {
  listeners.forEach(listener => listener([...toastQueue]))
}

export function useToasts() {
  const [messages, setMessages] = useState<ToastMessage[]>([])

  useEffect(() => {
    listeners.add(setMessages)
    return () => {
      listeners.delete(setMessages)
    }
  }, [])

  return messages
}

export function ToastContainer() {
  const messages = useToasts()

  return (
    <div className="fixed top-4 right-4 z-50 space-y-2 pointer-events-none">
      {messages.map(toast => (
        <div
          key={toast.id}
          className={cn(
            'flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg pointer-events-auto animate-in fade-in slide-in-from-top-2 duration-300',
            {
              'bg-emerald-500/90 text-white': toast.type === 'success',
              'bg-red-500/90 text-white': toast.type === 'error',
              'bg-blue-500/90 text-white': toast.type === 'info',
            }
          )}
        >
          {toast.type === 'success' && <IconCheck className="w-5 h-5 flex-shrink-0" />}
          {toast.type === 'error' && <IconAlertCircle className="w-5 h-5 flex-shrink-0" />}
          <span className="text-sm font-medium">{toast.message}</span>
          <button
            onClick={() => removeToast(toast.id)}
            className="ml-auto flex-shrink-0 hover:opacity-70 transition-opacity"
          >
            <IconX className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>
  )
}
