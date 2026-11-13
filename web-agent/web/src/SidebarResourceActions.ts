import {createContext} from 'react';

/** ResourceTree retains its menu state while its actions share the tab row. */
export const SidebarResourceActions = createContext<HTMLElement|null>(null);
