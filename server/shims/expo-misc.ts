// Modules du téléphone sans équivalent sur le serveur : notifications locales, tâches de fond Android, écran allumé.
// Les notifications du serveur passent par Telegram (déjà géré par src/core/telegram.ts).
export const requireOptionalNativeModule = (_name: string) => null;
export const AndroidImportance = { MAX: 5, HIGH: 4, DEFAULT: 3 };
export const SchedulableTriggerInputTypes = { TIME_INTERVAL: 'timeInterval', DATE: 'date' };
export async function setNotificationChannelAsync() {}
export async function getPermissionsAsync() { return { status: 'denied', granted: false }; }
export async function requestPermissionsAsync() { return { status: 'denied', granted: false }; }
export async function scheduleNotificationAsync(req: any) { console.log('[Notification]', req?.content?.title ?? '', req?.content?.body ?? ''); return 'server'; }
export function setNotificationHandler() {}
export function addNotificationResponseReceivedListener() { return { remove() {} }; }
export async function cancelAllScheduledNotificationsAsync() {}
// expo-task-manager / expo-background-task : le serveur a sa propre boucle (server/main.ts).
export function defineTask() {}
export async function isTaskRegisteredAsync() { return false; }
export async function registerTaskAsync() {}
export async function unregisterTaskAsync() {}
export async function getStatusAsync() { return 1; }
export const BackgroundTaskResult = { Success: 1, Failed: 2 };
export const BackgroundTaskStatus = { Available: 1, Restricted: 2 };
