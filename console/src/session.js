// Who is signed in. ConsoleApp provides it, pages read it with useSession().
import { createContext, useContext } from 'react'

export const SessionContext = createContext({ user: null, role: null, can: () => false, signOut: () => {} })

// { user, role, can(ability), signOut }
export function useSession() {
  return useContext(SessionContext)
}
