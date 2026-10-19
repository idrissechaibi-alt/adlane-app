// Le serveur n'a pas d'interface : seules les quelques valeurs lues par src/core existent.
export const Platform = { OS: 'android' as const, select: <T,>(o: { android?: T; default?: T }) => o.android ?? o.default };
export const AppState = { currentState: 'background', addEventListener: () => ({ remove() {} }) };
export const Linking = { openURL: async () => {} };
export const Share = { share: async () => ({ action: 'dismissedAction' }) };
export const Alert = { alert: (...args: unknown[]) => console.log('[Alerte]', ...args) };
export const InteractionManager = { runAfterInteractions: (fn: () => void) => { fn(); return { cancel() {} }; } };
